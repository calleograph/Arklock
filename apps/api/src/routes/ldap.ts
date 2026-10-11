import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertKdfParams } from '@arklock/crypto';
import { registerRequest, uuid } from '@arklock/contracts';
import type { MfaChallengeResponse, SessionResponse } from '@arklock/contracts';
import { audit } from '../audit.js';
import {
  DEFAULT_USER_FILTER,
  LdapError,
  circlesFor,
  ldapAuthenticate,
  ldapLookup,
  ldapTest,
  type LdapConfig,
} from '../auth/ldap.js';
import { isEnrolled } from '../auth/mfa.js';
import { authOf, createSession, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { circleMembers, circles, sessions, settings, users } from '../db/schema.js';
import { AppError, forbidden, parse } from '../errors.js';
import { openSetting, sealSetting } from '../secretbox.js';
import { bundle, insertAccount } from './auth.js';

const KEY = 'ldap.config';
const PURPOSE = 'ldap-bind-password';

interface Stored extends LdapConfig {
  bindPasswordCipher: string;
}

const putSchema = z.object({
  enabled: z.boolean(),
  url: z
    .string()
    .trim()
    .regex(/^ldaps?:\/\/[^\s/]+(:\d{1,5})?$/i, 'ldap://host:port or ldaps://host:port'),
  startTls: z.boolean().default(false),
  caPem: z.string().max(20_000).default(''),
  insecureTls: z.boolean().default(false),
  /** Явное согласие передавать пароли без шифрования (только изолированная сеть). */
  allowPlaintext: z.boolean().default(false),
  bindDn: z.string().trim().max(500).default(''),
  /** Не передан — прежний пароль сохраняется; пустая строка — удаляется. */
  bindPassword: z.string().max(500).optional(),
  baseDn: z.string().trim().min(1).max(500),
  userFilter: z.string().trim().max(500).default(DEFAULT_USER_FILTER),
  emailAttr: z.string().trim().min(1).max(100).default('mail'),
  nameAttr: z.string().trim().min(1).max(100).default('cn'),
  groups: z
    .array(z.object({ dn: z.string().trim().min(1).max(500), circleId: uuid }))
    .max(200)
    .default([]),
  autoProvision: z.boolean().default(true),
});

const loginSchema = z.object({
  username: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(512),
});
const enrollSchema = registerRequest
  .omit({ email: true, displayName: true, setupToken: true })
  .extend({ enrollToken: z.string().min(10).max(100) });

/** Идентичность из каталога, ожидающая создания учётной записи (клиент задаёт мастер-пароль и присылает ключи). */
class EnrollStore {
  private readonly items = new Map<string, { id: Ident; expiresAt: number }>();
  issue(id: Ident, now = Date.now()): string {
    for (const [k, v] of this.items) if (v.expiresAt <= now) this.items.delete(k);
    const token = `ae_${randomBytes(24).toString('base64url')}`;
    this.items.set(token, { id, expiresAt: now + 15 * 60_000 });
    return token;
  }
  take(token: string, now = Date.now()): Ident | null {
    const r = this.items.get(token);
    this.items.delete(token);
    return r && r.expiresAt > now ? r.id : null;
  }
}
interface Ident {
  dn: string;
  email: string;
  name: string;
  groups: string[];
}
const enroll = new EnrollStore();

const ipOf = (req: FastifyRequest) => req.ip ?? null;

export const registerLdapRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, config } = ctx;
  const auth = requireAuth(ctx);

  async function stored(): Promise<Stored | null> {
    const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
    return (row?.value as Stored | undefined) ?? null;
  }
  const bindSecret = (s: Stored) =>
    s.bindPasswordCipher ? openSetting(config.APP_SECRET, PURPOSE, s.bindPasswordCipher) : '';
  const failure = (e: unknown) =>
    e instanceof LdapError
      ? { ok: false as const, code: e.code, message: e.message }
      : { ok: false as const, code: 'error', message: e instanceof Error ? e.message : String(e) };

  const adminOnly = [
    auth,
    async (req: FastifyRequest) => {
      if (authOf(req).user.role !== 'admin') throw forbidden();
    },
  ];

  // ------------------------------------------------------------------ настройка (администратор)

  app.get('/admin/ldap', { preHandler: adminOnly }, async () => {
    const s = await stored();
    if (!s) return { configured: false };
    const { bindPasswordCipher, ...rest } = s;
    return { configured: true, ...rest, hasBindPassword: !!bindPasswordCipher };
  });

  app.put('/admin/ldap', { preHandler: adminOnly }, async (req) => {
    const { user } = authOf(req);
    const body = parse(putSchema, req.body);
    if (!body.userFilter.includes('{u}'))
      throw new AppError(400, 'validation_error', 'The user filter must contain {u}');
    // пароли пользователей пойдут по сети открытым текстом: запрещено, если администратор явно не принял риск
    if (/^ldap:\/\//i.test(body.url) && !body.startTls && !body.allowPlaintext)
      throw new AppError(
        400,
        'insecure_ldap',
        'Use ldaps:// or enable StartTLS: user passwords must not travel in clear',
      );
    const known = new Set((await db.select({ id: circles.id }).from(circles)).map((c) => c.id));
    for (const g of body.groups)
      if (!known.has(g.circleId))
        throw new AppError(400, 'validation_error', 'Unknown circle in group mapping');
    const prev = await stored();
    const cipher =
      body.bindPassword === undefined
        ? (prev?.bindPasswordCipher ?? '')
        : body.bindPassword === ''
          ? ''
          : sealSetting(config.APP_SECRET, PURPOSE, body.bindPassword);
    const { bindPassword: _omit, ...rest } = body;
    void _omit;
    const value: Stored = { ...rest, bindPasswordCipher: cipher };
    await db
      .insert(settings)
      .values({ key: KEY, value: value as never, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: value as never, updatedAt: new Date(), updatedBy: user.id },
      });
    await audit(db, `user:${user.id}`, 'admin.ldap.save', null, {
      url: body.url,
      enabled: body.enabled,
    });
    return { ok: true };
  });

  app.post('/admin/ldap/test', { preHandler: adminOnly }, async () => {
    const s = await stored();
    if (!s) throw new AppError(409, 'ldap_not_configured', 'LDAP is not configured');
    try {
      return await ldapTest(s, bindSecret(s));
    } catch (e) {
      return failure(e);
    }
  });

  app.post('/admin/ldap/lookup', { preHandler: adminOnly }, async (req) => {
    const body = parse(z.object({ username: z.string().trim().min(1).max(256) }), req.body);
    const s = await stored();
    if (!s) throw new AppError(409, 'ldap_not_configured', 'LDAP is not configured');
    try {
      const u = await ldapLookup(s, bindSecret(s), body.username);
      return u ? { ok: true as const, found: true, user: u } : { ok: true as const, found: false };
    } catch (e) {
      return failure(e);
    }
  });

  /** Сверка со справочником: учётные записи, исчезнувшие из каталога или отключённые в нём, блокируются; круги обновляются. */
  app.post('/admin/ldap/sync', { preHandler: adminOnly }, async (req) => {
    const { user } = authOf(req);
    const s = await stored();
    if (!s || !s.enabled) throw new AppError(409, 'ldap_not_configured', 'LDAP is not enabled');
    const linked = await db.select().from(users).where(eq(users.authSource, 'ldap'));
    let disabled = 0;
    let updated = 0;
    const errors: string[] = [];
    for (const u of linked) {
      try {
        const found = await ldapLookup(s, bindSecret(s), u.email);
        if (!found || found.disabled) {
          if (!u.disabledAt) {
            await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id));
            await db
              .update(sessions)
              .set({ revokedAt: new Date() })
              .where(eq(sessions.userId, u.id));
            disabled++;
          }
        } else {
          await syncCircles(u.id, s, found.groups);
          updated++;
        }
      } catch (e) {
        errors.push(`${u.email}: ${(e as Error).message}`.slice(0, 200));
      }
    }
    await audit(db, `user:${user.id}`, 'admin.ldap.sync', null, {
      disabled,
      updated,
      errors: errors.length,
    });
    return { total: linked.length, disabled, updated, errors };
  });

  // ------------------------------------------------------------------ вход пользователей

  app.get('/auth/ldap', async () => {
    const s = await stored();
    return { enabled: !!s?.enabled, autoProvision: !!s?.autoProvision };
  });

  async function syncCircles(userId: string, s: LdapConfig, groups: string[]): Promise<void> {
    const { want, managed } = circlesFor(s, groups);
    if (!managed.length) return;
    const existing = await db
      .select({ id: circles.id })
      .from(circles)
      .where(inArray(circles.id, managed));
    const valid = new Set(existing.map((c) => c.id));
    await db.transaction(async (tx) => {
      for (const cid of managed) {
        if (!valid.has(cid)) continue;
        if (want.includes(cid))
          await tx.insert(circleMembers).values({ circleId: cid, userId }).onConflictDoNothing();
        else
          await tx
            .delete(circleMembers)
            .where(and(eq(circleMembers.circleId, cid), eq(circleMembers.userId, userId)));
      }
    });
  }

  function throttle(req: FastifyRequest, username: string): string {
    const key = `ldap:${username.toLowerCase()}`;
    const wait = Math.max(
      ctx.attempts.byEmail.retryAfter(key),
      ctx.attempts.byIp.retryAfter(ipOf(req) ?? 'unknown'),
    );
    if (wait > 0)
      throw new AppError(429, 'too_many_attempts', 'Too many attempts, try again later', {
        retryAfterSeconds: wait,
      });
    return key;
  }

  app.post(
    '/auth/ldap/login',
    async (
      req,
      reply,
    ): Promise<
      | SessionResponse
      | MfaChallengeResponse
      | { enroll: true; enrollToken: string; email: string; name: string }
    > => {
      const body = parse(loginSchema, req.body);
      const s = await stored();
      if (!s?.enabled) throw new AppError(404, 'ldap_disabled', 'LDAP sign-in is not enabled');
      const key = throttle(req, body.username);
      let ident;
      try {
        ident = await ldapAuthenticate(s, bindSecret(s), body.username, body.password);
      } catch (e) {
        // недоступность каталога — не ошибка пароля и не должна копить неудачные попытки
        throw new AppError(
          503,
          'ldap_unavailable',
          e instanceof LdapError ? e.message : 'Directory is unavailable',
        );
      }
      if (!ident) {
        ctx.attempts.byEmail.fail(key);
        ctx.attempts.byIp.fail(ipOf(req) ?? 'unknown');
        await audit(db, 'anonymous', 'auth.ldap.failed', null, { ip: ipOf(req) });
        throw new AppError(401, 'invalid_credentials', 'Invalid username or password');
      }
      ctx.attempts.byEmail.reset(key);
      if (!ident.email)
        throw new AppError(403, 'ldap_no_email', 'The directory entry has no e-mail address');

      const [linked] = await db
        .select()
        .from(users)
        .where(and(eq(users.authSource, 'ldap'), eq(users.externalId, ident.dn)));
      if (!linked) {
        const [clash] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, ident.email));
        if (clash)
          throw new AppError(
            409,
            'account_exists_local',
            'A local account with this e-mail already exists',
          );
        if (!s.autoProvision)
          throw new AppError(
            403,
            'ldap_not_provisioned',
            'Your account has not been created yet — contact an administrator',
          );
        const token = enroll.issue({
          dn: ident.dn,
          email: ident.email,
          name: ident.name,
          groups: ident.groups,
        });
        return {
          enroll: true,
          enrollToken: token,
          email: ident.email,
          name: ident.name || ident.email,
        };
      }
      if (linked.disabledAt)
        throw new AppError(401, 'invalid_credentials', 'Invalid username or password');
      await syncCircles(linked.id, s, ident.groups);
      if (await isEnrolled(ctx, linked.id)) {
        reply.status(200);
        return { mfaRequired: true, challenge: ctx.mfa.issue(linked.id) };
      }
      const sess = await createSession(
        ctx,
        linked.id,
        ipOf(req),
        req.headers['user-agent'] ?? null,
      );
      await audit(db, `user:${linked.id}`, 'auth.login', `session:${sess.id}`, {
        ip: ipOf(req),
        via: 'ldap',
      });
      reply.status(200);
      return { token: sess.token, expiresAt: sess.expiresAt.toISOString(), user: bundle(linked) };
    },
  );

  /** Создание учётной записи для пользователя каталога: клиент задаёт мастер-пароль и присылает зашифрованные ключи. */
  app.post('/auth/ldap/enroll', async (req, reply): Promise<SessionResponse> => {
    const body = parse(enrollSchema, req.body);
    const ident = enroll.take(body.enrollToken);
    if (!ident) throw new AppError(401, 'invalid_enroll', 'The sign-in step expired, start again');
    try {
      assertKdfParams(body.kdf, ctx.config.kdfFloor);
    } catch {
      throw new AppError(400, 'weak_kdf', 'Key derivation parameters are weaker than allowed');
    }
    const s = await stored();
    if (!s?.enabled || !s.autoProvision)
      throw new AppError(403, 'ldap_not_provisioned', 'Account creation is disabled');
    const full = { ...body, email: ident.email, displayName: ident.name || ident.email };
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(7001)`);
      const [dupe] = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`${users.email} = ${ident.email} or ${users.id} = ${body.userId}`)
        .limit(1);
      if (dupe) throw new AppError(409, 'already_exists', 'Account already exists');
      await insertAccount(tx, full, { role: 'member', authSource: 'ldap', externalId: ident.dn });
    });
    await syncCircles(body.userId, s, ident.groups);
    const [u] = await db.select().from(users).where(eq(users.id, body.userId));
    const sess = await createSession(
      ctx,
      body.userId,
      ipOf(req),
      req.headers['user-agent'] ?? null,
    );
    await audit(db, `user:${body.userId}`, 'auth.ldap.enroll', `user:${body.userId}`);
    reply.status(201);
    return { token: sess.token, expiresAt: sess.expiresAt.toISOString(), user: bundle(u!) };
  });
};
