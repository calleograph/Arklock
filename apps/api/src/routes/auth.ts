import { timingSafeEqual } from 'node:crypto';
import { and, count, eq, ne, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertKdfParams } from '@arklock/crypto';
import {
  authParamsQuery,
  changePasswordRequest,
  loginRequest,
  recoveryCompleteRequest,
  recoveryStartRequest,
  registerRequest,
  uuid,
} from '@arklock/contracts';
import type {
  RegisterRequest,
  AuthParamsResponse,
  MfaChallengeResponse,
  RegistrationStatus,
  SessionInfo,
  SessionResponse,
  UserBundle,
} from '@arklock/contracts';
import { audit } from '../audit.js';
import { adminPermsOf } from '../auth/adminperm.js';
import { isEnrolled, mfaChallenge } from '../auth/mfa.js';
import { notifySecurity } from '../mail/send.js';
import { authOf, createSession, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import {
  circleMembers,
  invitations,
  keyLog,
  sessions,
  settings,
  users,
  vaultKeys,
  vaultMembers,
  vaults,
} from '../db/schema.js';
import { fromBase64Url, keyLogHash, verifyKeyGrant } from '@arklock/crypto';
import { desc } from 'drizzle-orm';
import { AppError, notFound, parse } from '../errors.js';
import {
  fakeBytes,
  fakeUuid,
  hashProof,
  randomB64url,
  sha256Hex,
  verifyProof,
} from '../security.js';

type KdfIn = { memoryKiB: number; iterations: number; parallelism: number };

function checkKdf(ctx: AppContext, kdf: KdfIn): void {
  try {
    assertKdfParams(kdf, ctx.config.kdfFloor);
  } catch {
    throw new AppError(400, 'weak_kdf', 'Key derivation parameters are weaker than allowed');
  }
}

type Tx = Parameters<Parameters<AppContext['db']['transaction']>[0]>[0];

/** Создание пользователя, записи журнала ключей и личного сейфа (одна транзакция вызывающего). */
export async function insertAccount(
  tx: Tx,
  body: RegisterRequest,
  opts: {
    role: 'admin' | 'member';
    authSource: 'local' | 'ldap' | 'oidc';
    externalId: string | null;
  },
): Promise<void> {
  const authSalt = randomB64url(16);
  const recoverySalt = randomB64url(16);
  await tx.insert(users).values({
    id: body.userId,
    email: body.email,
    displayName: body.displayName,
    role: opts.role,
    authSource: opts.authSource,
    externalId: opts.externalId,
    kdf: body.kdf,
    kdfSalt: body.salt,
    authSalt,
    authHash: hashProof(authSalt, body.authKey),
    publicKey: body.publicKey,
    signPublicKey: body.signPublicKey,
    wrappedPrivateKey: body.wrappedPrivateKey,
    wrappedSignPrivateKey: body.wrappedSignPrivateKey,
    recoverySalt,
    recoveryHash: hashProof(recoverySalt, body.recoveryProof),
    recoveryWrappedPrivateKey: body.recoveryWrappedPrivateKey,
    recoveryWrappedSignPrivateKey: body.recoveryWrappedSignPrivateKey,
  });
  // Журнал привязки ключей: запись о новой идентичности включается в хэш-цепочку.
  const [last] = await tx
    .select({ hash: keyLog.hash })
    .from(keyLog)
    .orderBy(desc(keyLog.seq))
    .limit(1);
  const prevHash = last?.hash ?? '';
  await tx.insert(keyLog).values({
    userId: body.userId,
    encPublic: body.publicKey,
    signPublic: body.signPublicKey,
    prevHash,
    hash: await keyLogHash(prevHash, body.userId, body.publicKey, body.signPublicKey),
  });
  const signOk = await verifyKeyGrant(
    fromBase64Url(body.signPublicKey),
    body.locker.signature,
    body.locker.vaultId,
    body.userId,
    1,
    body.locker.sealedKey,
  ).catch(() => false);
  if (!signOk) throw new AppError(400, 'bad_signature', 'Key grant signature is invalid');
  await tx
    .insert(vaults)
    .values({ id: body.locker.vaultId, kind: 'locker', keyVersion: 1, createdBy: body.userId });
  await tx
    .insert(vaultMembers)
    .values({ vaultId: body.locker.vaultId, userId: body.userId, role: 'owner' });
  await tx.insert(vaultKeys).values({
    vaultId: body.locker.vaultId,
    userId: body.userId,
    keyVersion: 1,
    sealedKey: body.locker.sealedKey,
    grantedBy: body.userId,
    signature: body.locker.signature,
  });
}

export function bundle(u: typeof users.$inferSelect): UserBundle {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    delegated: u.role !== 'admin' && !!u.adminRoleId,
    publicKey: u.publicKey,
    signPublicKey: u.signPublicKey,
    wrappedPrivateKey: u.wrappedPrivateKey,
    wrappedSignPrivateKey: u.wrappedSignPrivateKey,
  };
}

const ipOf = (req: FastifyRequest) => req.ip ?? null;

/** Единый заглушечный хэш: проверка для неизвестных адресов занимает столько же времени. */
const DUMMY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA';
const DUMMY_HASH = hashProof(DUMMY_SALT, 'dummy');

function throttle(ctx: AppContext, req: FastifyRequest, email: string): void {
  const wait = Math.max(
    ctx.attempts.byEmail.retryAfter(email),
    ctx.attempts.byIp.retryAfter(ipOf(req) ?? 'unknown'),
  );
  if (wait > 0) {
    throw new AppError(429, 'too_many_attempts', 'Too many attempts, try again later', {
      retryAfterSeconds: wait,
    });
  }
}

function recordFailure(ctx: AppContext, req: FastifyRequest, email: string): void {
  ctx.attempts.byEmail.fail(email);
  ctx.attempts.byIp.fail(ipOf(req) ?? 'unknown');
}

export const registerAuthRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, config } = ctx;
  const auth = requireAuth(ctx);

  /** Первого администратора в production создаёт только владелец сервера, знающий одноразовый код установщика. */
  const setupRequired = () =>
    config.NODE_ENV === 'production' || config.BOOTSTRAP_TOKEN !== undefined;
  function checkSetupToken(req: FastifyRequest, given: string | undefined): void {
    if (!setupRequired()) return;
    throttle(ctx, req, 'setup');
    if (!config.BOOTSTRAP_TOKEN) {
      throw new AppError(403, 'setup_disabled', 'Initial setup is not enabled on this server');
    }
    const want = Buffer.from(config.BOOTSTRAP_TOKEN);
    const got = Buffer.from(given ?? '');
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      recordFailure(ctx, req, 'setup');
      throw new AppError(403, 'invalid_setup_token', 'Invalid setup code');
    }
  }

  /** Параметры получения ключей. Для неизвестных адресов — правдоподобные детерминированные значения. */
  app.get('/auth/params', async (req): Promise<AuthParamsResponse> => {
    const { email } = parse(authParamsQuery, req.query);
    const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (u) return { userId: u.id, salt: u.kdfSalt, kdf: u.kdf };
    return {
      userId: fakeUuid(config.APP_SECRET, email),
      salt: fakeBytes(config.APP_SECRET, 'salt', email, 16).toString('base64url'),
      kdf: { memoryKiB: 65536, iterations: 3, parallelism: 1 },
    };
  });

  /** Публичные для вошедших пользователей политики (нужны интерфейсу для показа доступных действий). */
  app.get('/auth/policy', { preHandler: auth }, async () => {
    const rows = await db.select().from(settings);
    const get = (k: string, d: unknown) => rows.find((r) => r.key === k)?.value ?? d;
    return {
      'vaults.creators': get('vaults.creators', 'admins'),
      'trash.retentionDays': get('trash.retentionDays', 30),
      'security.passwordMaxAgeDays': get('security.passwordMaxAgeDays', 365),
      'security.mfaRequired': get('security.mfaRequired', 'off'),
      'policy.password.minLength': get('policy.password.minLength', 0),
      'policy.password.classes': get('policy.password.classes', 0),
      'storage.enabled': config.BLOB_DIR !== '',
      'storage.attachmentMaxMiB': get('storage.attachmentMaxMiB', 1024),
    };
  });

  /** События, которые происходят только на клиенте (экспорт открытых данных), фиксируются в журнале. */
  app.post('/audit/event', { preHandler: auth }, async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(
      z.object({
        action: z.literal('export'),
        format: z.enum(['csv', 'json', 'encrypted']),
        count: z.number().int().min(0).max(1_000_000),
      }),
      req.body,
    );
    await audit(db, `user:${user.id}`, `client.${body.action}`, null, {
      format: body.format,
      count: body.count,
    });
    return reply.status(204).send();
  });

  app.get('/auth/registration', async (): Promise<RegistrationStatus> => {
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(users);
    if (n === 0) return { open: true, firstUser: true, setupTokenRequired: setupRequired() };
    const [mode] = await db.select().from(settings).where(eq(settings.key, 'registration.mode'));
    return { open: mode?.value === 'open', firstUser: false, setupTokenRequired: false };
  });

  /** Сведения о приглашении по токену (для предзаполнения формы регистрации). Недействительный токен — 404. */
  app.get('/auth/invitation', async (req) => {
    const token = String((req.query as { token?: string }).token ?? '');
    const [inv] =
      token.length >= 10
        ? await db
            .select()
            .from(invitations)
            .where(eq(invitations.tokenHash, sha256Hex(token)))
        : [];
    if (!inv || inv.usedAt || inv.revokedAt || inv.expiresAt.getTime() <= Date.now())
      throw notFound();
    return { email: inv.email };
  });

  app.post('/auth/register', async (req, reply) => {
    const body = parse(registerRequest, req.body);
    checkKdf(ctx, body.kdf);

    const userId = await db.transaction(async (tx) => {
      // Сериализуем регистрации: первый пользователь становится администратором ровно один раз.
      await tx.execute(sql`select pg_advisory_xact_lock(7001)`);
      const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(users);
      if (n === 0) checkSetupToken(req, body.setupToken);
      let invite: typeof invitations.$inferSelect | undefined;
      if (n > 0 && body.inviteToken) {
        [invite] = await tx
          .select()
          .from(invitations)
          .where(eq(invitations.tokenHash, sha256Hex(body.inviteToken)));
        if (
          !invite ||
          invite.usedAt ||
          invite.revokedAt ||
          invite.expiresAt.getTime() <= Date.now() ||
          invite.email !== body.email
        )
          throw new AppError(
            403,
            'invalid_invitation',
            'The invitation is invalid, used or expired',
          );
      }
      if (n > 0 && !invite) {
        const [mode] = await tx
          .select()
          .from(settings)
          .where(eq(settings.key, 'registration.mode'));
        if (mode?.value !== 'open') {
          throw new AppError(403, 'registration_closed', 'Registration is closed');
        }
      }
      const [dupe] = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`${users.email} = ${body.email} or ${users.id} = ${body.userId}`)
        .limit(1);
      if (dupe) throw new AppError(409, 'already_exists', 'Account already exists');

      await insertAccount(tx, body, {
        role: n === 0 ? 'admin' : 'member',
        authSource: 'local',
        externalId: null,
      });
      if (invite) {
        await tx
          .update(invitations)
          .set({ usedAt: new Date() })
          .where(eq(invitations.id, invite.id));
        for (const cid of invite.circleIds as string[])
          await tx
            .insert(circleMembers)
            .values({ circleId: cid, userId: body.userId })
            .onConflictDoNothing();
      }
      return body.userId;
    });
    await audit(db, `user:${userId}`, 'auth.register', `user:${userId}`);
    return reply.status(201).send({ userId });
  });

  app.post('/auth/login', async (req, reply): Promise<SessionResponse | MfaChallengeResponse> => {
    const body = parse(loginRequest, req.body);
    throttle(ctx, req, body.email);
    const [u] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    const ok = verifyProof(u?.authSalt ?? DUMMY_SALT, body.authKey, u?.authHash ?? DUMMY_HASH);
    if (!u || !ok || u.disabledAt) {
      recordFailure(ctx, req, body.email);
      await audit(
        db,
        u ? `user:${u.id}` : 'anonymous',
        'auth.login.failed',
        u ? `user:${u.id}` : null,
        {
          ip: ipOf(req),
        },
      );
      throw new AppError(401, 'invalid_credentials', 'Invalid email or password');
    }
    ctx.attempts.byEmail.reset(body.email);
    // Учётные записи корпоративного каталога входят только через него: отключение в каталоге должно закрывать доступ
    if (u.authSource !== 'local')
      throw new AppError(403, 'external_login_required', 'Sign in with your corporate account');
    // Второй фактор: сессия и ключевой материал выдаются только после проверки кода
    if (await isEnrolled(ctx, u.id)) {
      reply.status(200);
      return mfaChallenge(ctx, u.id);
    }
    const s = await createSession(ctx, u.id, ipOf(req), req.headers['user-agent'] ?? null);
    await audit(db, `user:${u.id}`, 'auth.login', `session:${s.id}`, { ip: ipOf(req) });
    reply.status(200);
    return { token: s.token, expiresAt: s.expiresAt.toISOString(), user: bundle(u) };
  });

  app.post('/auth/logout', { preHandler: auth }, async (req, reply) => {
    const { user, session } = authOf(req);
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id));
    await audit(db, `user:${user.id}`, 'auth.logout', `session:${session.id}`);
    return reply.status(204).send();
  });

  /** Административные полномочия текущего пользователя (для показа разделов панели). */
  app.get('/auth/admin-perms', { preHandler: auth }, async (req) => {
    const { user } = authOf(req);
    const perms = await adminPermsOf(ctx, user);
    return { full: user.role === 'admin', permissions: [...perms].sort() };
  });

  app.get('/auth/me', { preHandler: auth }, async (req) => {
    const { user, session } = authOf(req);
    return {
      user: bundle(user),
      sessionId: session.id,
      expiresAt: session.expiresAt.toISOString(),
    };
  });

  app.get('/auth/sessions', { preHandler: auth }, async (req): Promise<SessionInfo[]> => {
    const { user, session } = authOf(req);
    const rows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));
    const now = Date.now();
    return rows
      .filter((s) => s.expiresAt.getTime() > now)
      .map((s) => ({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        ip: s.ip,
        userAgent: s.userAgent,
        current: s.id === session.id,
      }));
  });

  app.delete('/auth/sessions/:id', { preHandler: auth }, async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const res = await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, id), eq(sessions.userId, user.id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    if (!res.length) throw notFound();
    await audit(db, `user:${user.id}`, 'auth.session.revoke', `session:${id}`);
    return reply.status(204).send();
  });

  app.post('/auth/sessions/revoke-others', { preHandler: auth }, async (req, reply) => {
    const { user, session } = authOf(req);
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(sessions.userId, user.id), ne(sessions.id, session.id), isNull(sessions.revokedAt)),
      );
    await audit(db, `user:${user.id}`, 'auth.session.revoke-others');
    return reply.status(204).send();
  });

  app.post('/auth/change-password', { preHandler: auth }, async (req, reply) => {
    const { user, session } = authOf(req);
    const body = parse(changePasswordRequest, req.body);
    checkKdf(ctx, body.kdf);
    throttle(ctx, req, user.email);
    if (!verifyProof(user.authSalt, body.currentAuthKey, user.authHash)) {
      recordFailure(ctx, req, user.email);
      throw new AppError(401, 'invalid_credentials', 'Current password is incorrect');
    }
    const authSalt = randomB64url(16);
    await db
      .update(users)
      .set({
        kdf: body.kdf,
        kdfSalt: body.salt,
        authSalt,
        authHash: hashProof(authSalt, body.newAuthKey),
        wrappedPrivateKey: body.wrappedPrivateKey,
        wrappedSignPrivateKey: body.wrappedSignPrivateKey,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(sessions.userId, user.id), ne(sessions.id, session.id), isNull(sessions.revokedAt)),
      );
    await audit(db, `user:${user.id}`, 'auth.password.change');
    void notifySecurity(
      ctx,
      user.id,
      'Arklock: изменён мастер-пароль',
      'Мастер-пароль вашей учётной записи изменён, остальные сеансы завершены. Если это были не вы — срочно обратитесь к администратору.\n\nThe master password of your account was changed and other sessions were ended. If this was not you, contact your administrator immediately.',
    );
    return reply.status(204).send();
  });

  /** Восстановление доступа ключом восстановления: шаг 1 — получить зашифрованный закрытый ключ. */
  app.post('/auth/recovery/start', async (req) => {
    const body = parse(recoveryStartRequest, req.body);
    throttle(ctx, req, `recovery:${body.email}`);
    ctx.attempts.byEmail.fail(`recovery:${body.email}`);
    const [u] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (u) {
      return {
        userId: u.id,
        recoveryWrappedPrivateKey: u.recoveryWrappedPrivateKey,
        recoveryWrappedSignPrivateKey: u.recoveryWrappedSignPrivateKey,
        publicKey: u.publicKey,
        signPublicKey: u.signPublicKey,
      };
    }
    return {
      userId: fakeUuid(config.APP_SECRET, body.email),
      recoveryWrappedPrivateKey: `ak1.${fakeBytes(config.APP_SECRET, 'n', body.email, 12).toString('base64url')}.${fakeBytes(config.APP_SECRET, 'c', body.email, 154).toString('base64url')}`,
      recoveryWrappedSignPrivateKey: `ak1.${fakeBytes(config.APP_SECRET, 'n2', body.email, 12).toString('base64url')}.${fakeBytes(config.APP_SECRET, 'c2', body.email, 154).toString('base64url')}`,
      publicKey: fakeBytes(config.APP_SECRET, 'pk', body.email, 65).toString('base64url'),
      signPublicKey: fakeBytes(config.APP_SECRET, 'sk', body.email, 65).toString('base64url'),
    };
  });

  /** Шаг 2 — доказать владение ключом восстановления и задать новый мастер-пароль. Все сессии завершаются. */
  app.post('/auth/recovery/complete', async (req, reply) => {
    const body = parse(recoveryCompleteRequest, req.body);
    checkKdf(ctx, body.kdf);
    throttle(ctx, req, `recovery:${body.email}`);
    const [u] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    const ok = verifyProof(
      u?.recoverySalt ?? DUMMY_SALT,
      body.recoveryProof,
      u?.recoveryHash ?? DUMMY_HASH,
    );
    if (!u || !ok || u.disabledAt) {
      recordFailure(ctx, req, `recovery:${body.email}`);
      await audit(db, u ? `user:${u.id}` : 'anonymous', 'auth.recovery.failed', null, {
        ip: ipOf(req),
      });
      throw new AppError(401, 'invalid_credentials', 'Recovery failed');
    }
    ctx.attempts.byEmail.reset(`recovery:${body.email}`);
    const authSalt = randomB64url(16);
    const recoverySalt = randomB64url(16);
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          kdf: body.kdf,
          kdfSalt: body.salt,
          authSalt,
          authHash: hashProof(authSalt, body.newAuthKey),
          wrappedPrivateKey: body.wrappedPrivateKey,
          wrappedSignPrivateKey: body.wrappedSignPrivateKey,
          recoverySalt,
          recoveryHash: hashProof(recoverySalt, body.newRecoveryProof),
          recoveryWrappedPrivateKey: body.newRecoveryWrappedPrivateKey,
          recoveryWrappedSignPrivateKey: body.newRecoveryWrappedSignPrivateKey,
          updatedAt: new Date(),
        })
        .where(eq(users.id, u.id));
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, u.id), isNull(sessions.revokedAt)));
    });
    await audit(db, `user:${u.id}`, 'auth.recovery.complete', `user:${u.id}`, { ip: ipOf(req) });
    return reply.status(204).send();
  });
};
