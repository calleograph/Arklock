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
  AuthParamsResponse,
  RegistrationStatus,
  SessionInfo,
  SessionResponse,
  UserBundle,
} from '@arklock/contracts';
import { audit } from '../audit.js';
import { authOf, createSession, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { sessions, settings, users, vaultMembers, vaults } from '../db/schema.js';
import { AppError, notFound, parse } from '../errors.js';
import { fakeBytes, fakeUuid, hashProof, randomB64url, verifyProof } from '../security.js';

type KdfIn = { memoryKiB: number; iterations: number; parallelism: number };

function checkKdf(ctx: AppContext, kdf: KdfIn): void {
  try {
    assertKdfParams(kdf, ctx.config.kdfFloor);
  } catch {
    throw new AppError(400, 'weak_kdf', 'Key derivation parameters are weaker than allowed');
  }
}

function bundle(u: typeof users.$inferSelect): UserBundle {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    publicKey: u.publicKey,
    wrappedPrivateKey: u.wrappedPrivateKey,
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

  app.get('/auth/registration', async (): Promise<RegistrationStatus> => {
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(users);
    if (n === 0) return { open: true, firstUser: true, setupTokenRequired: setupRequired() };
    const [mode] = await db.select().from(settings).where(eq(settings.key, 'registration.mode'));
    return { open: mode?.value === 'open', firstUser: false, setupTokenRequired: false };
  });

  app.post('/auth/register', async (req, reply) => {
    const body = parse(registerRequest, req.body);
    checkKdf(ctx, body.kdf);

    const userId = await db.transaction(async (tx) => {
      // Сериализуем регистрации: первый пользователь становится администратором ровно один раз.
      await tx.execute(sql`select pg_advisory_xact_lock(7001)`);
      const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(users);
      if (n === 0) checkSetupToken(req, body.setupToken);
      if (n > 0) {
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

      const authSalt = randomB64url(16);
      const recoverySalt = randomB64url(16);
      await tx.insert(users).values({
        id: body.userId,
        email: body.email,
        displayName: body.displayName,
        role: n === 0 ? 'admin' : 'member',
        kdf: body.kdf,
        kdfSalt: body.salt,
        authSalt,
        authHash: hashProof(authSalt, body.authKey),
        publicKey: body.publicKey,
        wrappedPrivateKey: body.wrappedPrivateKey,
        recoverySalt,
        recoveryHash: hashProof(recoverySalt, body.recoveryProof),
        recoveryWrappedPrivateKey: body.recoveryWrappedPrivateKey,
      });
      await tx.insert(vaults).values({ id: body.locker.vaultId, kind: 'locker', keyVersion: 1 });
      await tx.insert(vaultMembers).values({
        vaultId: body.locker.vaultId,
        userId: body.userId,
        role: 'owner',
        sealedKey: body.locker.sealedKey,
        sealedKeyVersion: 1,
      });
      return body.userId;
    });
    await audit(db, `user:${userId}`, 'auth.register', `user:${userId}`);
    return reply.status(201).send({ userId });
  });

  app.post('/auth/login', async (req, reply): Promise<SessionResponse> => {
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
        publicKey: u.publicKey,
      };
    }
    return {
      userId: fakeUuid(config.APP_SECRET, body.email),
      recoveryWrappedPrivateKey: `ak1.${fakeBytes(config.APP_SECRET, 'n', body.email, 12).toString('base64url')}.${fakeBytes(config.APP_SECRET, 'c', body.email, 154).toString('base64url')}`,
      publicKey: fakeBytes(config.APP_SECRET, 'pk', body.email, 65).toString('base64url'),
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
          recoverySalt,
          recoveryHash: hashProof(recoverySalt, body.newRecoveryProof),
          recoveryWrappedPrivateKey: body.newRecoveryWrappedPrivateKey,
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
