import { timingSafeEqual } from 'node:crypto';
import { and, count, eq, ne, isNull, or, sql } from 'drizzle-orm';
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
  THEME_IDS,
  DEFAULT_THEME,
  normalizeTheme,
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
import { publicUrlOf } from '../public-url.js';
import { adminPermsOf } from '../auth/adminperm.js';
import { isEnrolled, mfaChallenge } from '../auth/mfa.js';
import { notifySecurity } from '../mail/send.js';
import { authOf, createSession, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import {
  circleMembers,
  entries,
  invitations,
  keyLog,
  pinDevices,
  sessions,
  settings,
  users,
  vaultKeys,
  vaultMembers,
  vaults,
} from '../db/schema.js';
import { fromBase64Url, keyLogHash, verifyKeyGrant } from '@arklock/crypto';
import { desc } from 'drizzle-orm';
import { AppError, forbidden, notFound, parse } from '../errors.js';
import { chiefRequired } from './chief.js';
import { attachmentIdsOfVault } from './attachments.js';
import { fakeBytes, fakeUuid, hashProof, randomB64url, verifyProof } from '../security.js';
import { invitationTokenHash } from '../activation.js';
import { managedPolicy } from '../managed-vaults.js';
import { personalLockersAllowed, requirePersonalLockerAllowed } from '../personal-lockers.js';
import { DEFAULT_SPACE_ID, spaceAccess } from '../spaces.js';

type KdfIn = { memoryKiB: number; iterations: number; parallelism: number };

function checkKdf(ctx: AppContext, kdf: KdfIn): void {
  try {
    assertKdfParams(kdf, ctx.config.kdfFloor);
  } catch {
    throw new AppError(400, 'weak_kdf', 'Key derivation parameters are weaker than allowed');
  }
}

type Tx = Parameters<Parameters<AppContext['db']['transaction']>[0]>[0];

/** Создание пользователя, журнала ключей и разрешённого политикой личного сейфа. */
export async function insertAccount(
  tx: Tx,
  body: RegisterRequest,
  opts: {
    role: 'admin' | 'member';
    authSource: 'local' | 'ldap' | 'oidc' | 'saml';
    externalId: string | null;
    createCorporate?: boolean;
    /** Первая учётная запись установки — главный администратор. */
    chief?: boolean;
    /** Версия Arklock при создании: новому сотруднику не показывают примечания о прошлых обновлениях. */
    release: string;
  },
): Promise<void> {
  const authSalt = randomB64url(16);
  const recoverySalt = randomB64url(16);
  await tx.insert(users).values({
    id: body.userId,
    email: body.email,
    displayName: body.displayName,
    role: opts.role,
    chief: opts.chief ?? false,
    chiefSince: opts.chief ? new Date() : null,
    seenRelease: opts.release,
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
  if (opts.createCorporate) {
    await insertLocker(tx, body.userId, body.signPublicKey, body.locker, true);
  } else if (await personalLockersAllowed(tx, body.userId)) {
    await insertLocker(tx, body.userId, body.signPublicKey, body.locker);
  }
}

async function insertLocker(
  tx: Tx,
  userId: string,
  signPublicKey: string,
  locker: RegisterRequest['locker'],
  corporate = false,
): Promise<void> {
  const signOk = await verifyKeyGrant(
    fromBase64Url(signPublicKey),
    locker.signature,
    locker.vaultId,
    userId,
    1,
    locker.sealedKey,
  ).catch(() => false);
  if (!signOk) throw new AppError(400, 'bad_signature', 'Key grant signature is invalid');
  await tx.insert(vaults).values({
    id: locker.vaultId,
    kind: corporate ? 'shared' : 'locker',
    spaceId: corporate ? DEFAULT_SPACE_ID : null,
    name: corporate ? 'Organization' : null,
    keyVersion: 1,
    createdBy: userId,
  });
  await tx.insert(vaultMembers).values({ vaultId: locker.vaultId, userId, role: 'owner' });
  await tx.insert(vaultKeys).values({
    vaultId: locker.vaultId,
    userId,
    keyVersion: 1,
    sealedKey: locker.sealedKey,
    grantedBy: userId,
    signature: locker.signature,
  });
}

/** Тема по умолчанию для сотрудников, не выбравших свою (настройка администратора). */
async function defaultTheme(db: AppContext['db']): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'appearance.defaultTheme'));
  return normalizeTheme(row?.value) ?? DEFAULT_THEME;
}

export async function bundle(ctx: AppContext, u: typeof users.$inferSelect): Promise<UserBundle> {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    delegated: u.role !== 'admin' && (await adminPermsOf(ctx, u)).size > 0,
    chief: u.chief,
    // пока сотрудник не выбрал тему сам, действует тема по умолчанию, заданная администратором
    theme: normalizeTheme(u.theme) ?? (await defaultTheme(ctx.db)),
    seenRelease: u.seenRelease,
    homeSpace: u.homeSpace,
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

export function throttle(ctx: AppContext, req: FastifyRequest, email: string): void {
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

export function recordFailure(ctx: AppContext, req: FastifyRequest, email: string): void {
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

  /** Записи в личном сейфе сотрудника (включая корзину); без содержимого. */
  async function personalEntryCount(userId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(entries)
      .innerJoin(vaults, eq(vaults.id, entries.vaultId))
      .where(and(eq(vaults.kind, 'locker'), eq(vaults.createdBy, userId)));
    return row?.n ?? 0;
  }

  /** Закрытое уведомление больше не показывается — в профиле на сервере, на любом устройстве. */
  app.post('/auth/notices/:id/dismiss', { preHandler: auth }, async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: z.string().regex(/^[a-z0-9.-]{1,60}$/) }), req.params);
    const list = new Set((user.dismissedNotices as string[]) ?? []);
    list.add(id);
    await db
      .update(users)
      .set({ dismissedNotices: [...list].slice(-50) })
      .where(eq(users.id, user.id));
    return reply.status(204).send();
  });

  /**
   * Сотрудник удаляет свой личный сейф (записи, вложения, ключи) даже при запрещённых личных сейфах — без включения
   * функции для всей организации. Только сам владелец и только с подтверждением мастер-паролем; необратимо.
   * Администратор этого за сотрудника сделать не может.
   */
  app.post('/auth/personal-vault/erase', { preHandler: auth }, async (req, reply) => {
    const { user } = authOf(req);
    if (authOf(req).viaToken)
      throw new AppError(403, 'forbidden', 'Not available with an API token');
    const body = parse(
      z.object({ authKey: z.string().min(20).max(100), confirm: z.literal(true) }),
      req.body,
    );
    throttle(ctx, req, `erase:${user.email}`);
    if (!verifyProof(user.authSalt, body.authKey, user.authHash)) {
      recordFailure(ctx, req, `erase:${user.email}`);
      throw new AppError(401, 'invalid_credentials', 'Master password is incorrect');
    }
    const lockers = await db
      .select({ id: vaults.id })
      .from(vaults)
      .where(and(eq(vaults.kind, 'locker'), eq(vaults.createdBy, user.id)));
    if (!lockers.length) throw notFound();
    let removed = 0;
    for (const l of lockers) {
      const [{ n } = { n: 0 }] = await db
        .select({ n: count() })
        .from(entries)
        .where(eq(entries.vaultId, l.id));
      removed += n;
      const blobIds = await attachmentIdsOfVault(db, l.id);
      await db.delete(vaults).where(eq(vaults.id, l.id));
      await ctx.blobs.remove(blobIds);
    }
    await audit(db, `user:${user.id}`, 'vault.personal.erase', `user:${user.id}`, {
      entries: removed,
    });
    return reply.status(204).send();
  });

  /** Публичные для вошедших пользователей политики (нужны интерфейсу для показа доступных действий). */
  app.get('/auth/policy', { preHandler: auth }, async (req) => {
    const { user } = authOf(req);
    const personalAllowed = await personalLockersAllowed(db, user.id);
    const managed = await managedPolicy(db);
    const rows = await db.select().from(settings);
    const get = (k: string, d: unknown) => rows.find((r) => r.key === k)?.value ?? d;
    return {
      'vaults.creators': get('vaults.creators', 'admins'),
      'vaults.personalLockers': personalAllowed,
      // персональный корпоративный сейф: условия показываются сотруднику до создания
      'vaults.managedPersonal': managed.enabled && managed.guardians.length > 0,
      'vaults.managedGuardians': managed.guardians.map((g) => g.name),
      'vaults.managedRole': managed.role,
      // о прежних личных данных сообщаем, только если они действительно есть (пустой сейф — не данные)
      'vaults.personalDataRestricted': !personalAllowed && (await personalEntryCount(user.id)) > 0,
      'vaults.personalEntries': await personalEntryCount(user.id),
      'notices.dismissed': (user.dismissedNotices as string[]) ?? [],
      'trash.retentionDays': get('trash.retentionDays', 30),
      'security.passwordMaxAgeDays': get('security.passwordMaxAgeDays', 365),
      'security.mfaRequired': get('security.mfaRequired', 'off'),
      'policy.password.minLength': get('policy.password.minLength', 0),
      'policy.password.classes': get('policy.password.classes', 0),
      'policy.password.maxRepeat': get('policy.password.maxRepeat', 0),
      'security.revealSeconds': get('security.revealSeconds', 0),
      'storage.enabled': config.BLOB_DIR !== '',
      'storage.attachmentMaxMiB': get('storage.attachmentMaxMiB', 1024),
      'links.maxMinutes': get('links.maxMinutes', 0),
      'links.maxViews': get('links.maxViews', 100),
      'generator.length': get('generator.length', 20),
      'generator.lower': get('generator.lower', true),
      'generator.upper': get('generator.upper', true),
      'generator.digits': get('generator.digits', true),
      'generator.symbols': get('generator.symbols', true),
      'generator.exclude': get('generator.exclude', ''),
    };
  });

  /** Provision only after explicit authorization; clients retain the private encryption keys. */
  app.post('/auth/locker', { preHandler: auth }, async (req, reply) => {
    const { user } = authOf(req);
    const locker = parse(registerRequest.shape.locker, req.body);
    await db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for('update');
      await requirePersonalLockerAllowed(tx, user.id);
      const [existing] = await tx
        .select({ id: vaults.id })
        .from(vaults)
        .where(
          or(
            eq(vaults.id, locker.vaultId),
            and(eq(vaults.kind, 'locker'), eq(vaults.createdBy, user.id)),
          ),
        )
        .limit(1);
      if (existing) throw new AppError(409, 'already_exists', 'Personal vault already exists');
      await insertLocker(tx, user.id, user.signPublicKey, locker);
    });
    await audit(db, `user:${user.id}`, 'vault.personal.create', `vault:${locker.vaultId}`);
    return reply.status(201).send({ id: locker.vaultId });
  });

  /**
   * Импорт и экспорт открытых данных считаются на клиенте (сервер расшифровать сейф не может), поэтому именно здесь
   * сервер даёт или не даёт на них право: только главный администратор. `begin` вызывается до чтения/записи и при
   * отказе останавливает операцию; `done` фиксирует итог (формат и число записей, без содержимого и пароля архива).
   */
  app.post('/audit/event', { preHandler: auth }, async (req, reply) => {
    const { user } = authOf(req);
    if (!user.chief || authOf(req).viaToken) throw chiefRequired();
    const body = parse(
      z.object({
        action: z.enum(['export', 'import']),
        phase: z.enum(['begin', 'done']).default('done'),
        format: z.enum(['csv', 'json', 'encrypted']).optional(),
        count: z.number().int().min(0).max(1_000_000).default(0),
      }),
      req.body,
    );
    await audit(
      db,
      `user:${user.id}`,
      body.phase === 'begin' ? `client.${body.action}.begin` : `client.${body.action}`,
      null,
      body.phase === 'begin' ? undefined : { format: body.format ?? null, count: body.count },
    );
    return reply.status(204).send();
  });

  /**
   * Как приложение видит это соединение: нужен установщику и интерфейсу, чтобы отличить «контейнеры работают» от «можно
   * войти». Ничего секретного: протокол и узел из самого запроса (с учётом доверенных прокси) и публичный адрес из настроек.
   * Адрес клиента не возвращается.
   */
  app.get('/access', async (req) => {
    const configured = publicUrlOf(ctx) ?? null;
    const protocol = req.protocol;
    const host = req.hostname;
    let publicMatches: boolean | null = null;
    if (configured) {
      try {
        const u = new URL(configured);
        publicMatches = u.protocol === `${protocol}:` && u.host === host;
      } catch {
        publicMatches = false;
      }
    }
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(users);
    return {
      // защищённый ли контекст для браузера: HTTPS по заголовкам доверенного прокси либо localhost
      protocol,
      secure:
        protocol === 'https' ||
        ['localhost', '127.0.0.1', '[::1]'].includes(host.replace(/:\d+$/, '')),
      host,
      publicUrl: configured,
      publicMatches,
      forwardedProto:
        typeof req.headers['x-forwarded-proto'] === 'string'
          ? req.headers['x-forwarded-proto'].slice(0, 20)
          : null,
      trustedProxyHops: config.TRUSTED_PROXY_HOPS,
      firstUser: n === 0,
    };
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
            .where(eq(invitations.tokenHash, invitationTokenHash(token)))
        : [];
    if (!inv || inv.usedAt || inv.revokedAt || inv.expiresAt.getTime() <= Date.now())
      throw notFound();
    return { email: inv.email, displayName: inv.displayName, role: inv.role };
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
          .where(eq(invitations.tokenHash, invitationTokenHash(body.inviteToken)));
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

      // имя и роль задаёт администратор в приглашении; при активации пользователь не может их изменить
      await insertAccount(
        tx,
        invite?.displayName ? { ...body, displayName: invite.displayName } : body,
        {
          role: n === 0 ? 'admin' : (invite?.role ?? 'member'),
          chief: n === 0,
          release: ctx.config.APP_VERSION,
          authSource: 'local',
          externalId: null,
          createCorporate: n === 0 && !(await personalLockersAllowed(tx, body.userId)),
        },
      );
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
    await ctx.shield.guard(req, 'login', body.email, body.captcha);
    const [u] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    const ok = verifyProof(u?.authSalt ?? DUMMY_SALT, body.authKey, u?.authHash ?? DUMMY_HASH);
    if (!u || !ok || u.disabledAt) {
      ctx.shield.recordFailure(req, 'login', body.email, u?.id ?? null);
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
    ctx.shield.recordSuccess(req, 'login', body.email);
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
    return { token: s.token, expiresAt: s.expiresAt.toISOString(), user: await bundle(ctx, u) };
  });

  app.post('/auth/logout', { preHandler: auth }, async (req, reply) => {
    const { user, session } = authOf(req);
    await db
      .update(sessions)
      .set({ revokedAt: new Date(), reloadShare: null })
      .where(eq(sessions.id, session.id));
    await audit(db, `user:${user.id}`, 'auth.logout', `session:${session.id}`);
    return reply.status(204).send();
  });

  /** Административные полномочия текущего пользователя (для показа разделов панели). */
  app.get('/auth/admin-perms', { preHandler: auth }, async (req) => {
    const { user } = authOf(req);
    const perms = await adminPermsOf(ctx, user);
    return { full: user.role === 'admin', permissions: [...perms].sort() };
  });

  /** Личные настройки интерфейса: цветовая тема и пространство при входе. Хранятся в профиле, а не в зашифрованных данных. */
  app.put('/auth/preferences', { preHandler: auth }, async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(
      z
        .object({
          theme: z.enum(THEME_IDS).optional(),
          homeSpace: z.union([uuid, z.literal('personal'), z.null()]).optional(),
          seenRelease: z
            .string()
            .regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/)
            .optional(),
        })
        .refine(
          (b) => b.theme !== undefined || b.homeSpace !== undefined || b.seenRelease !== undefined,
        ),
      req.body,
    );
    // открывать можно только пространство, в котором сотрудник состоит
    if (body.homeSpace && body.homeSpace !== 'personal') {
      if (!(await spaceAccess(db, body.homeSpace, user.id)).member) throw forbidden();
    }
    await db
      .update(users)
      .set({
        ...(body.theme ? { theme: body.theme } : {}),
        ...(body.homeSpace !== undefined ? { homeSpace: body.homeSpace } : {}),
        ...(body.seenRelease ? { seenRelease: body.seenRelease } : {}),
      })
      .where(eq(users.id, user.id));
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: auth }, async (req) => {
    const { user, session } = authOf(req);
    return {
      user: await bundle(ctx, user),
      sessionId: session.id,
      expiresAt: session.expiresAt.toISOString(),
    };
  });

  /** Сведения о себе для страницы «Мой профиль»: карточка сотрудника только для чтения (поля из каталога меняет каталог). */
  app.get('/auth/profile', { preHandler: auth }, async (req) => {
    const { user } = authOf(req);
    return {
      name: user.displayName,
      email: user.email,
      role: user.chief ? 'chief' : user.role,
      source: user.authSource,
      title: user.title,
      department: user.department,
      phone: user.phone,
      fromDirectory: Object.keys((user.profileSource as Record<string, string>) ?? {}),
      createdAt: user.createdAt.toISOString(),
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
    // PIN-устройства хранят ключ старого мастер-пароля: после смены они бесполезны и удаляются
    await db.delete(pinDevices).where(eq(pinDevices.userId, user.id));
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
    await ctx.shield.guard(req, 'recovery', body.email, body.captcha);
    // каждый запрос шага 1 — попытка: строгий предел восстановления считает и их
    ctx.shield.recordFailure(req, 'recovery', body.email, null, 'recovery_started');
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
    await ctx.shield.guard(req, 'recovery', body.email, body.captcha);
    const [u] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    const ok = verifyProof(
      u?.recoverySalt ?? DUMMY_SALT,
      body.recoveryProof,
      u?.recoveryHash ?? DUMMY_HASH,
    );
    if (!u || !ok || u.disabledAt) {
      ctx.shield.recordFailure(req, 'recovery', body.email, u?.id ?? null, 'recovery_failed');
      await audit(db, u ? `user:${u.id}` : 'anonymous', 'auth.recovery.failed', null, {
        ip: ipOf(req),
      });
      throw new AppError(401, 'invalid_credentials', 'Recovery failed');
    }
    ctx.shield.recordSuccess(req, 'recovery', body.email);
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
      await tx.delete(pinDevices).where(eq(pinDevices.userId, u.id));
    });
    await audit(db, `user:${u.id}`, 'auth.recovery.complete', `user:${u.id}`, { ip: ipOf(req) });
    return reply.status(204).send();
  });
};
