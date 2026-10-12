import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertKdfParams } from '@arklock/crypto';
import { registerRequest } from '@arklock/contracts';
import type { MfaChallengeResponse, SessionResponse } from '@arklock/contracts';
import { audit } from '../audit.js';
import {
  OidcError,
  authorizationUrl,
  clearOidcCache,
  discover,
  exchangeCode,
  identityFrom,
  pkcePair,
  verifyIdToken,
  type OidcConfig,
} from '../auth/oidc.js';
import { isEnrolled, mfaChallenge } from '../auth/mfa.js';
import { adminGate } from '../auth/adminperm.js';
import { authOf, createSession, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { settings, users } from '../db/schema.js';
import { AppError, parse } from '../errors.js';
import { openSetting, sealSetting } from '../secretbox.js';
import { bundle, insertAccount } from './auth.js';
import { LDAP_SETTING_KEY, syncCirclesFor } from './ldap.js';
import type { LdapConfig } from '../auth/ldap.js';

const KEY = 'sso.oidc';
const PURPOSE = 'oidc-client-secret';

interface Stored extends OidcConfig {
  clientSecretCipher: string;
}

const putSchema = z.object({
  enabled: z.boolean(),
  issuer: z.string().trim().url().max(500),
  clientId: z.string().trim().min(1).max(300),
  /** Не передан — прежний секрет сохраняется; пустая строка — удаляется. */
  clientSecret: z.string().max(1000).optional(),
  scopes: z.string().trim().max(300).default('openid email profile'),
  emailClaim: z.string().trim().min(1).max(100).default('email'),
  nameClaim: z.string().trim().min(1).max(100).default('name'),
  autoProvision: z.boolean().default(true),
  buttonText: z.string().trim().min(1).max(60).default('SSO'),
  allowedDomains: z.array(z.string().trim().toLowerCase().min(3).max(253)).max(50).default([]),
  allowInsecure: z.boolean().default(false),
});

const enrollSchema = registerRequest
  .omit({ email: true, displayName: true, setupToken: true })
  .extend({ enrollToken: z.string().min(10).max(100) });

type Outcome =
  { kind: 'user'; userId: string } | { kind: 'enroll'; sub: string; email: string; name: string };

const ipOf = (req: FastifyRequest) => req.ip ?? null;

export const registerSsoRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, config } = ctx;
  const auth = requireAuth(ctx);
  // Состояние входа (state → nonce и PKCE) и одноразовые билеты возврата в приложение: в памяти, коротко
  const pending = new Map<string, { nonce: string; verifier: string; expiresAt: number }>();
  const tickets = new Map<string, { out: Outcome; expiresAt: number }>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of pending) if (v.expiresAt <= now) pending.delete(k);
    for (const [k, v] of tickets) if (v.expiresAt <= now) tickets.delete(k);
  };

  async function stored(): Promise<Stored | null> {
    const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
    return (row?.value as Stored | undefined) ?? null;
  }
  const secretOf = (s: Stored) =>
    s.clientSecretCipher ? openSetting(config.APP_SECRET, PURPOSE, s.clientSecretCipher) : '';
  const redirectUri = () =>
    config.APP_PUBLIC_URL
      ? `${config.APP_PUBLIC_URL.replace(/\/$/, '')}/api/v1/auth/sso/callback`
      : '';
  const adminOnly = [
    auth,
    async (req: FastifyRequest) => {
      await adminGate(ctx, req);
    },
  ];

  // ------------------------------------------------------------------ настройка (администратор)

  app.get('/admin/sso', { preHandler: adminOnly }, async () => {
    const s = await stored();
    const base = { redirectUri: redirectUri() || null };
    if (!s) return { configured: false, ...base };
    const { clientSecretCipher, ...rest } = s;
    return { configured: true, ...base, ...rest, hasClientSecret: !!clientSecretCipher };
  });

  app.put('/admin/sso', { preHandler: adminOnly }, async (req) => {
    const { user } = authOf(req);
    const body = parse(putSchema, req.body);
    if (body.enabled && !redirectUri())
      throw new AppError(
        409,
        'public_url_required',
        'Set the public address (APP_PUBLIC_URL) first',
      );
    const prev = await stored();
    const cipher =
      body.clientSecret === undefined
        ? (prev?.clientSecretCipher ?? '')
        : body.clientSecret === ''
          ? ''
          : sealSetting(config.APP_SECRET, PURPOSE, body.clientSecret);
    const { clientSecret: _omit, ...rest } = body;
    void _omit;
    const value: Stored = { ...rest, clientSecretCipher: cipher };
    await db
      .insert(settings)
      .values({ key: KEY, value: value as never, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: value as never, updatedAt: new Date(), updatedBy: user.id },
      });
    clearOidcCache();
    await audit(db, `user:${user.id}`, 'admin.sso.save', null, {
      issuer: body.issuer,
      enabled: body.enabled,
    });
    return { ok: true };
  });

  /** Проверка: документ discovery читается, издатель совпадает, ключи подписи доступны. */
  app.post('/admin/sso/test', { preHandler: adminOnly }, async () => {
    const s = await stored();
    if (!s) throw new AppError(409, 'sso_not_configured', 'SSO is not configured');
    clearOidcCache();
    try {
      const d = await discover(s);
      const keys = await fetch(d.jwks_uri, { signal: AbortSignal.timeout(10_000) }).then((r) =>
        r.json(),
      );
      return {
        ok: true as const,
        authorizationEndpoint: d.authorization_endpoint,
        keys: (keys as { keys?: unknown[] }).keys?.length ?? 0,
      };
    } catch (e) {
      return {
        ok: false as const,
        code: e instanceof OidcError ? e.code : 'error',
        message: (e as Error).message,
      };
    }
  });

  // ------------------------------------------------------------------ вход

  app.get('/auth/sso', async () => {
    const s = await stored();
    return { enabled: !!s?.enabled, buttonText: s?.buttonText ?? 'SSO' };
  });

  app.get('/auth/sso/start', async (req, reply) => {
    const s = await stored();
    if (!s?.enabled || !redirectUri())
      throw new AppError(404, 'sso_disabled', 'SSO is not enabled');
    sweep();
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const { verifier, challenge } = pkcePair();
    let url: string;
    try {
      url = authorizationUrl(s, await discover(s), {
        redirectUri: redirectUri(),
        state,
        nonce,
        challenge,
      });
    } catch (e) {
      req.log.warn({ err: String(e) }, 'sso start failed');
      return reply.redirect('/sso/done#error=sso_unavailable');
    }
    pending.set(state, { nonce, verifier, expiresAt: Date.now() + 10 * 60_000 });
    return reply.redirect(url);
  });

  /** Возврат от IdP. Результат передаётся приложению одноразовым билетом во фрагменте адреса (в журналы сервера он не попадает). */
  app.get('/auth/sso/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const fail = (code: string) => reply.redirect(`/sso/done#error=${encodeURIComponent(code)}`);
    sweep();
    const p = q.state ? pending.get(q.state) : undefined;
    if (q.state) pending.delete(q.state); // состояние одноразовое
    if (!p) return fail('state');
    if (q.error || !q.code) return fail('denied');
    const s = await stored();
    if (!s?.enabled) return fail('sso_disabled');
    let ident;
    try {
      const d = await discover(s);
      const tok = await exchangeCode(s, d, secretOf(s), {
        code: q.code,
        redirectUri: redirectUri(),
        verifier: p.verifier,
      });
      ident = identityFrom(s, await verifyIdToken(s, d, tok.id_token, p.nonce));
    } catch (e) {
      await audit(db, 'anonymous', 'auth.sso.failed', null, {
        ip: ipOf(req),
        reason: e instanceof OidcError ? e.code : 'error',
      });
      return fail(e instanceof OidcError ? e.code : 'error');
    }
    const externalId = `${s.issuer.replace(/\/$/, '')}|${ident.sub}`;
    const [linked] = await db
      .select()
      .from(users)
      .where(and(eq(users.authSource, 'oidc'), eq(users.externalId, externalId)));
    let out: Outcome;
    if (linked) {
      if (linked.disabledAt) return fail('disabled');
      out = { kind: 'user', userId: linked.id };
    } else {
      const [clash] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, ident.email));
      if (clash) return fail('account_exists');
      if (!s.autoProvision) return fail('not_provisioned');
      out = { kind: 'enroll', sub: ident.sub, email: ident.email, name: ident.name };
    }
    const ticket = randomBytes(24).toString('base64url');
    tickets.set(ticket, { out, expiresAt: Date.now() + 2 * 60_000 });
    return reply.redirect(`/sso/done#ticket=${ticket}`);
  });

  /** Обмен билета на сессию (или шаг второго фактора, или создание учётной записи). */
  app.post(
    '/auth/sso/exchange',
    async (
      req,
      reply,
    ): Promise<
      | SessionResponse
      | MfaChallengeResponse
      | { enroll: true; enrollToken: string; email: string; name: string }
    > => {
      const body = parse(z.object({ ticket: z.string().min(10).max(100) }), req.body);
      const t = tickets.get(body.ticket);
      tickets.delete(body.ticket);
      if (!t || t.expiresAt <= Date.now())
        throw new AppError(401, 'invalid_ticket', 'The sign-in step expired, start again');
      const s = await stored();
      if (!s?.enabled) throw new AppError(404, 'sso_disabled', 'SSO is not enabled');
      if (t.out.kind === 'enroll') {
        const token = ctx.enroll.issue({
          source: 'oidc',
          externalId: `${s.issuer.replace(/\/$/, '')}|${t.out.sub}`,
          email: t.out.email,
          name: t.out.name,
          groups: [],
        });
        return { enroll: true, enrollToken: token, email: t.out.email, name: t.out.name };
      }
      const [u] = await db.select().from(users).where(eq(users.id, t.out.userId));
      if (!u || u.disabledAt) throw new AppError(401, 'invalid_ticket', 'The sign-in step expired');
      if (await isEnrolled(ctx, u.id)) {
        reply.status(200);
        return mfaChallenge(ctx, u.id);
      }
      const sess = await createSession(ctx, u.id, ipOf(req), req.headers['user-agent'] ?? null);
      await audit(db, `user:${u.id}`, 'auth.login', `session:${sess.id}`, {
        ip: ipOf(req),
        via: 'oidc',
      });
      reply.status(200);
      return { token: sess.token, expiresAt: sess.expiresAt.toISOString(), user: bundle(u) };
    },
  );

  // ------------------------------------------------------------------ создание учётной записи для внешней идентичности

  /** Общее для каталога и SSO: клиент задаёт мастер-пароль и присылает зашифрованные ключи; адрес и имя берутся от провайдера. */
  app.post('/auth/external/enroll', async (req, reply): Promise<SessionResponse> => {
    const body = parse(enrollSchema, req.body);
    const ident = ctx.enroll.take(body.enrollToken);
    if (!ident) throw new AppError(401, 'invalid_enroll', 'The sign-in step expired, start again');
    try {
      assertKdfParams(body.kdf, ctx.config.kdfFloor);
    } catch {
      throw new AppError(400, 'weak_kdf', 'Key derivation parameters are weaker than allowed');
    }
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, ident.source === 'ldap' ? LDAP_SETTING_KEY : KEY));
    const cfg = row?.value as { enabled?: boolean; autoProvision?: boolean } | undefined;
    if (!cfg?.enabled || !cfg.autoProvision)
      throw new AppError(403, 'not_provisioned', 'Account creation is disabled');
    const full = { ...body, email: ident.email, displayName: ident.name || ident.email };
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(7001)`);
      const [dupe] = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`${users.email} = ${ident.email} or ${users.id} = ${body.userId}`)
        .limit(1);
      if (dupe) throw new AppError(409, 'already_exists', 'Account already exists');
      await insertAccount(tx, full, {
        role: 'member',
        authSource: ident.source,
        externalId: ident.externalId,
      });
    });
    if (ident.source === 'ldap')
      await syncCirclesFor(db, body.userId, cfg as unknown as LdapConfig, ident.groups);
    const [u] = await db.select().from(users).where(eq(users.id, body.userId));
    const sess = await createSession(
      ctx,
      body.userId,
      ipOf(req),
      req.headers['user-agent'] ?? null,
    );
    await audit(db, `user:${body.userId}`, `auth.${ident.source}.enroll`, `user:${body.userId}`);
    reply.status(201);
    return { token: sess.token, expiresAt: sess.expiresAt.toISOString(), user: bundle(u!) };
  });
};
