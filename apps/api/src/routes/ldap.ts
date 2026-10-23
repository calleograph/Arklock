import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { uuid } from '@arklock/contracts';
import type { MfaChallengeResponse, SessionResponse } from '@arklock/contracts';
import { audit } from '../audit.js';
import {
  DEFAULT_USER_FILTER,
  LdapError,
  ldapAuthenticate,
  ldapBrowse,
  ldapLookup,
  ldapTest,
} from '../auth/ldap.js';
import { isEnrolled, mfaChallenge } from '../auth/mfa.js';
import { adminGate } from '../auth/adminperm.js';
import { authOf, createSession, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { circleMembers, circles, sessions, settings, users } from '../db/schema.js';
import { AppError, parse } from '../errors.js';
import { sealSetting } from '../secretbox.js';
import { bundle } from './auth.js';
import {
  ldapBindSecret,
  ldapExternalId,
  ldapIdentityProfile,
  ldapSecretPurpose,
  readLdapProfiles,
  writeLdapProfiles,
  type LdapProfile,
} from '../auth/ldap-profiles.js';
import {
  revokeLdapProfileSessions,
  syncCirclesFor,
  syncLdapProfile,
  syncProfileFor,
} from '../auth/ldap-sync.js';
export { syncCirclesFor } from '../auth/ldap-sync.js';
export { LDAP_SETTING_KEY } from '../auth/ldap-profiles.js';

const profileId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

const putSchema = z.object({
  enabled: z.boolean(),
  name: z.string().trim().min(1).max(100).default('LDAP'),
  syncEnabled: z.boolean().default(false),
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
  titleAttr: z.string().trim().max(100).default('title'),
  departmentAttr: z.string().trim().max(100).default('department'),
  phoneAttr: z.string().trim().max(100).default('telephoneNumber'),
  groups: z
    .array(z.object({ dn: z.string().trim().min(1).max(500), circleId: uuid }))
    .max(200)
    .default([]),
  autoProvision: z.boolean().default(true),
});

const loginSchema = z.object({
  profileId: profileId.optional(),
  username: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(512),
});

const ipOf = (req: FastifyRequest) => req.ip ?? null;

export const registerLdapRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, config } = ctx;
  const auth = requireAuth(ctx);

  async function stored(id = 'default'): Promise<LdapProfile | null> {
    return (await readLdapProfiles(db)).find((p) => p.id === id) ?? null;
  }
  const bindSecret = (s: LdapProfile) => ldapBindSecret(s, config.APP_SECRET);
  const queryId = (req: FastifyRequest) =>
    parse(z.object({ profileId: profileId.default('default') }), req.query).profileId;
  const failure = (e: unknown) =>
    e instanceof LdapError
      ? { ok: false as const, code: e.code, message: e.message }
      : { ok: false as const, code: 'error', message: e instanceof Error ? e.message : String(e) };

  const adminOnly = [
    auth,
    async (req: FastifyRequest) => {
      await adminGate(ctx, req);
    },
  ];

  // ------------------------------------------------------------------ настройка (администратор)

  app.get('/admin/ldap', { preHandler: adminOnly }, async () => {
    const s = await stored();
    if (!s) return { configured: false };
    const { bindPasswordCipher, ...rest } = s;
    return { configured: true, ...rest, hasBindPassword: !!bindPasswordCipher };
  });

  app.get('/admin/ldap/profiles', { preHandler: adminOnly }, async () => {
    const profiles = await readLdapProfiles(db);
    const syncs = await db.select().from(settings);
    return {
      profiles: profiles.map(({ bindPasswordCipher, ...profile }) => ({
        ...profile,
        hasBindPassword: !!bindPasswordCipher,
        lastSync: syncs.find((r) => r.key === `ldap.sync.${profile.id}`)?.value ?? null,
      })),
      circles: await db.select({ id: circles.id, name: circles.name }).from(circles),
    };
  });

  async function saveProfile(req: FastifyRequest, id: string) {
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
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('arklock.ldap.profiles'))`);
      const profiles = await readLdapProfiles(tx);
      if (!profiles.some((p) => p.id === id) && profiles.length >= 20)
        throw new AppError(
          409,
          'ldap_profile_limit',
          'At most 20 directory profiles are supported',
        );
      const prev = profiles.find((p) => p.id === id);
      const cipher =
        body.bindPassword === undefined
          ? (prev?.bindPasswordCipher ?? '')
          : body.bindPassword === ''
            ? ''
            : sealSetting(config.APP_SECRET, ldapSecretPurpose(id), body.bindPassword);
      const { bindPassword: _omit, ...rest } = body;
      void _omit;
      const value: LdapProfile = { ...rest, id, bindPasswordCipher: cipher };
      const removedCircles = [...new Set((prev?.groups ?? []).map((g) => g.circleId))].filter(
        (cid) => !value.groups.some((g) => g.circleId === cid),
      );
      const linkedIds = removedCircles.length
        ? (
            await tx
              .select({ id: users.id, externalId: users.externalId })
              .from(users)
              .where(eq(users.authSource, 'ldap'))
          )
            .filter((u) => ldapIdentityProfile(u.externalId) === id)
            .map((u) => u.id)
        : [];
      await writeLdapProfiles(
        tx,
        prev ? profiles.map((p) => (p.id === id ? value : p)) : [...profiles, value],
        user.id,
      );
      if (removedCircles.length && linkedIds.length)
        await tx
          .delete(circleMembers)
          .where(
            and(
              inArray(circleMembers.circleId, removedCircles),
              inArray(circleMembers.userId, linkedIds),
            ),
          );
      if (!value.enabled || (prev && (prev.url !== value.url || prev.baseDn !== value.baseDn)))
        await revokeLdapProfileSessions(tx, id);
      await audit(tx, `user:${user.id}`, 'admin.ldap.save', `ldap:${id}`, {
        url: body.url,
        enabled: body.enabled,
      });
    });
    return { ok: true };
  }
  app.put('/admin/ldap', { preHandler: adminOnly }, async (req) => saveProfile(req, 'default'));
  app.put('/admin/ldap/profiles/:id', { preHandler: adminOnly }, async (req) => {
    const { id } = parse(z.object({ id: profileId }), req.params);
    return saveProfile(req, id);
  });
  app.delete('/admin/ldap/profiles/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: profileId }), req.params);
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('arklock.ldap.profiles'))`);
      const profiles = await readLdapProfiles(tx);
      if (!profiles.some((p) => p.id === id))
        throw new AppError(404, 'not_found', 'Directory profile not found');
      const linked = await tx
        .select({ externalId: users.externalId })
        .from(users)
        .where(eq(users.authSource, 'ldap'));
      if (linked.some((u) => ldapIdentityProfile(u.externalId) === id))
        throw new AppError(
          409,
          'ldap_profile_in_use',
          'Disable this profile instead: enrolled users still depend on it',
        );
      await writeLdapProfiles(
        tx,
        profiles.filter((p) => p.id !== id),
        user.id,
      );
      await tx.delete(settings).where(eq(settings.key, `ldap.sync.${id}`));
      await audit(tx, `user:${user.id}`, 'admin.ldap.delete', `ldap:${id}`);
    });
    return reply.status(204).send();
  });

  app.post('/admin/ldap/test', { preHandler: adminOnly }, async (req) => {
    const s = await stored(queryId(req));
    if (!s) throw new AppError(409, 'ldap_not_configured', 'LDAP is not configured');
    try {
      return await ldapTest(s, bindSecret(s));
    } catch (e) {
      return failure(e);
    }
  });

  app.post('/admin/ldap/lookup', { preHandler: adminOnly }, async (req) => {
    const body = parse(z.object({ username: z.string().trim().min(1).max(256) }), req.body);
    const s = await stored(queryId(req));
    if (!s) throw new AppError(409, 'ldap_not_configured', 'LDAP is not configured');
    try {
      const u = await ldapLookup(s, bindSecret(s), body.username);
      return u ? { ok: true as const, found: true, user: u } : { ok: true as const, found: false };
    } catch (e) {
      return failure(e);
    }
  });

  app.post('/admin/ldap/browse', { preHandler: adminOnly }, async (req) => {
    const body = parse(
      z.object({
        kind: z.enum(['users', 'groups', 'ous']),
        baseDn: z.string().trim().max(500).optional(),
        q: z.string().trim().max(200).default(''),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      req.body,
    );
    const s = await stored(queryId(req));
    if (!s) throw new AppError(409, 'ldap_not_configured', 'LDAP is not configured');
    try {
      return { ok: true, ...(await ldapBrowse(s, bindSecret(s), body)) };
    } catch (e) {
      return failure(e);
    }
  });

  /** Сверка со справочником: учётные записи, исчезнувшие из каталога или отключённые в нём, блокируются; круги обновляются. */
  app.post('/admin/ldap/sync', { preHandler: adminOnly }, async (req) => {
    const { user } = authOf(req);
    const s = await stored(queryId(req));
    if (!s || !s.enabled) throw new AppError(409, 'ldap_not_configured', 'LDAP is not enabled');
    return syncLdapProfile(db, config.APP_SECRET, s, `user:${user.id}`);
  });

  // ------------------------------------------------------------------ вход пользователей

  app.get('/auth/ldap', async () => {
    const profiles = (await readLdapProfiles(db)).filter((p) => p.enabled);
    return {
      enabled: profiles.length > 0,
      autoProvision: profiles.some((p) => p.autoProvision),
      profiles: profiles.map((p) => ({ id: p.id, name: p.name, autoProvision: p.autoProvision })),
    };
  });

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
      const s = await stored(body.profileId ?? 'default');
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
        const disabled = await ldapLookup(s, bindSecret(s), body.username).catch(() => null);
        if (disabled?.disabled) {
          const [linked] = await db
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                eq(users.authSource, 'ldap'),
                eq(users.externalId, ldapExternalId(s.id, disabled.dn)),
              ),
            );
          if (linked) {
            await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, linked.id));
            await db
              .update(sessions)
              .set({ revokedAt: new Date() })
              .where(eq(sessions.userId, linked.id));
          }
        }
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
        .where(
          and(eq(users.authSource, 'ldap'), eq(users.externalId, ldapExternalId(s.id, ident.dn))),
        );
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
        const token = ctx.enroll.issue({
          source: 'ldap',
          externalId: ldapExternalId(s.id, ident.dn),
          directoryId: s.id,
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
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('arklock.ldap.profiles'))`);
        const current = (await readLdapProfiles(tx)).find((p) => p.id === s.id);
        if (!current?.enabled || JSON.stringify(current) !== JSON.stringify(s))
          throw new AppError(
            403,
            'not_provisioned',
            'The directory configuration changed; start sign-in again',
          );
        await syncCirclesFor(tx, linked.id, current, ident.groups);
        await syncProfileFor(tx, linked.id, ident);
      });
      if (await isEnrolled(ctx, linked.id)) {
        reply.status(200);
        return mfaChallenge(ctx, linked.id);
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
      return {
        token: sess.token,
        expiresAt: sess.expiresAt.toISOString(),
        user: await bundle(ctx, linked),
      };
    },
  );
};
