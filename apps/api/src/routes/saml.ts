import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateServiceProviderMetadata } from '@node-saml/node-saml';
import { uuid } from '@arklock/contracts';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import {
  NAMEID_FORMATS,
  SAML_SETTING_KEY,
  SamlError,
  SamlRuntime,
  analyzeCert,
  expandEncrypted,
  generateSpCertificate,
  groupAllowed,
  identityFrom,
  inspectResponse,
  parseIdpMetadata,
  samlErrorCode,
  samlGroupMap,
  spUrls,
  splitPems,
  usableCerts,
  usesSha1,
  type SamlConfig,
  type SamlStored,
} from '../auth/saml.js';
import { CHALLENGE_RE, PendingStore, type LoginOutcome } from '../auth/tickets.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { publicUrlOf } from '../public-url.js';
import { circles, sessions, settings, users } from '../db/schema.js';
import { AppError, parse } from '../errors.js';
import { openSetting, sealSetting } from '../secretbox.js';
import { syncCirclesFor } from './ldap.js';

const PURPOSE = 'saml-sp-key';
const SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
const httpUrl = (allowInsecure: boolean) =>
  z
    .string()
    .trim()
    .max(1000)
    .refine((v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'https:' || (allowInsecure && u.protocol === 'http:');
      } catch {
        return false;
      }
    }, 'https URL required');

const putSchema = z.object({
  enabled: z.boolean(),
  idpEntityId: z.string().trim().max(500).default(''),
  entryPoint: z.string().trim().max(1000).default(''),
  logoutUrl: z.string().trim().max(1000).default(''),
  /** Один или несколько сертификатов (PEM или base64) одним текстом. */
  idpCerts: z.string().max(40_000).default(''),
  spEntityId: z.string().trim().max(500).default(''),
  nameIdFormat: z
    .enum([
      NAMEID_FORMATS.unspecified,
      NAMEID_FORMATS.email,
      NAMEID_FORMATS.persistent,
      NAMEID_FORMATS.transient,
    ])
    .default(NAMEID_FORMATS.unspecified),
  signRequests: z.boolean().default(false),
  wantAssertionsSigned: z.boolean().default(true),
  wantResponseSigned: z.boolean().default(false),
  allowSha1: z.boolean().default(false),
  allowIdpInitiated: z.boolean().default(false),
  forceAuthn: z.boolean().default(false),
  clockSkewSeconds: z.number().int().min(0).max(600).default(120),
  idAttr: z.string().trim().max(300).default(''),
  emailAttr: z.string().trim().max(300).default('email'),
  nameAttr: z.string().trim().max(300).default('displayName'),
  groupsAttr: z.string().trim().max(300).default(''),
  groups: z
    .array(z.object({ name: z.string().trim().min(1).max(500), circleId: uuid }))
    .max(200)
    .default([]),
  requiredGroups: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  autoProvision: z.boolean().default(true),
  buttonText: z.string().trim().min(1).max(60).default('SSO'),
  allowedDomains: z.array(z.string().trim().toLowerCase().min(3).max(253)).max(50).default([]),
  maxSessionHours: z.number().int().min(0).max(8760).default(0),
  allowInsecure: z.boolean().default(false),
});

const emptyConfig = (): SamlStored => ({
  enabled: false,
  idpEntityId: '',
  entryPoint: '',
  logoutUrl: '',
  idpCerts: [],
  spEntityId: '',
  nameIdFormat: NAMEID_FORMATS.unspecified,
  signRequests: false,
  spCert: '',
  wantAssertionsSigned: true,
  wantResponseSigned: false,
  allowSha1: false,
  allowIdpInitiated: false,
  forceAuthn: false,
  clockSkewSeconds: 120,
  idAttr: '',
  emailAttr: 'email',
  nameAttr: 'displayName',
  groupsAttr: '',
  groups: [],
  requiredGroups: [],
  autoProvision: true,
  buttonText: 'SSO',
  allowedDomains: [],
  maxSessionHours: 0,
  allowInsecure: false,
  spKeyCipher: '',
});

const ipOf = (req: FastifyRequest) => req.ip ?? null;
const decodeB64 = (v: string) => Buffer.from(v, 'base64').toString('utf8');

interface Check {
  id: string;
  level: 'ok' | 'warn' | 'error';
  message: string;
}

export const registerSamlRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, config } = ctx;
  const auth = requireAuth(ctx);
  const runtime = new SamlRuntime();
  const pending = new PendingStore<{ challenge: string }>();

  // Формы провайдера приходят как application/x-www-form-urlencoded (HTTP-POST binding)
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 2_000_000 },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (e) {
        done(e as Error);
      }
    },
  );

  async function stored(): Promise<SamlStored | null> {
    const [row] = await db.select().from(settings).where(eq(settings.key, SAML_SETTING_KEY));
    return row ? ({ ...emptyConfig(), ...(row.value as SamlStored) } as SamlStored) : null;
  }
  async function save(value: SamlStored, userId: string): Promise<void> {
    await db
      .insert(settings)
      .values({ key: SAML_SETTING_KEY, value: value as never, updatedBy: userId })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: value as never, updatedAt: new Date(), updatedBy: userId },
      });
    runtime.reset();
    ctx.samlPolicy = undefined;
  }
  const keyOf = (s: SamlStored) =>
    s.spKeyCipher ? openSetting(config.APP_SECRET, PURPOSE, s.spKeyCipher) : '';
  const urlsOf = (s: Pick<SamlConfig, 'spEntityId'>) => {
    const pub = publicUrlOf(ctx);
    return pub ? spUrls(pub, s) : null;
  };
  const adminOnly = [auth, async (req: FastifyRequest) => adminGate(ctx, req)];

  const certReport = (pems: string[]) =>
    pems.map((p) => {
      try {
        return analyzeCert(p);
      } catch {
        return null;
      }
    });

  // ------------------------------------------------------------------ настройка (администратор)

  app.get('/admin/saml', { preHandler: adminOnly }, async () => {
    const s = await stored();
    const urls = urlsOf(s ?? { spEntityId: '' });
    const base = { urls };
    if (!s) return { configured: false, ...base };
    const { spKeyCipher, ...rest } = s;
    return {
      configured: true,
      ...base,
      ...rest,
      hasSpKey: !!spKeyCipher,
      idpCertInfo: certReport(s.idpCerts),
      spCertInfo: s.spCert ? certReport([s.spCert])[0] : null,
    };
  });

  app.put('/admin/saml', { preHandler: adminOnly }, async (req) => {
    const { user } = authOf(req);
    const body = parse(putSchema, req.body);
    const prev = (await stored()) ?? emptyConfig();
    const pems = splitPems(body.idpCerts);
    if (body.idpCerts.trim() && !pems.length)
      throw new AppError(400, 'cert_invalid', 'No certificate found in the text');
    for (const p of pems) analyzeCert(p); // нечитаемый сертификат — ошибка настройки
    const value: SamlStored = {
      ...body,
      idpCerts: pems,
      spCert: prev.spCert,
      spKeyCipher: prev.spKeyCipher,
    };
    if (body.enabled) {
      if (!publicUrlOf(ctx))
        throw new AppError(
          409,
          'public_url_required',
          'Set the public address (APP_PUBLIC_URL) first',
        );
      if (!body.idpEntityId || !body.entryPoint)
        throw new AppError(
          400,
          'validation_error',
          'Provider identifier and sign-in address are required',
        );
      for (const u of [body.entryPoint, body.logoutUrl].filter(Boolean))
        if (!httpUrl(body.allowInsecure).safeParse(u).success)
          throw new AppError(400, 'validation_error', 'Provider addresses must use https');
      if (!usableCerts(pems).length)
        throw new AppError(
          400,
          'idp_cert_expired',
          'There is no valid signing certificate: expired, not yet valid or too weak',
          { certificates: certReport(pems) },
        );
      if (!body.wantAssertionsSigned && !body.wantResponseSigned)
        throw new AppError(
          400,
          'validation_error',
          'Require a signature on the assertion or on the response',
        );
      if (body.signRequests && !prev.spKeyCipher)
        throw new AppError(
          409,
          'sp_key_required',
          'Generate the service provider certificate first',
        );
    }
    await save(value, user.id);
    await audit(db, `user:${user.id}`, 'admin.saml.save', null, {
      idp: body.idpEntityId,
      enabled: body.enabled,
    });
    return { ok: true };
  });

  /** Новая пара ключей поставщика услуг (подпись запросов, расшифровка утверждений). Старая перестаёт действовать. */
  app.post('/admin/saml/sp-cert', { preHandler: adminOnly }, async (req) => {
    const { user } = authOf(req);
    const cur = (await stored()) ?? emptyConfig();
    const { certPem, keyPem } = await generateSpCertificate('Arklock SAML');
    await save(
      {
        ...cur,
        spCert: certPem,
        spKeyCipher: sealSetting(config.APP_SECRET, PURPOSE, keyPem),
      },
      user.id,
    );
    await audit(db, `user:${user.id}`, 'admin.saml.sp-cert', null);
    return { spCertInfo: analyzeCert(certPem), spCert: certPem };
  });

  /** Заполнение настроек из метаданных провайдера (вставленный XML или адрес). Ничего не сохраняет. */
  app.post('/admin/saml/import-metadata', { preHandler: adminOnly }, async (req) => {
    const body = parse(
      z.object({
        xml: z.string().max(1_000_000).optional(),
        url: z.string().trim().url().max(1000).optional(),
        allowInsecure: z.boolean().default(false),
      }),
      req.body,
    );
    let xml = body.xml ?? '';
    if (!xml) {
      if (!body.url)
        throw new AppError(400, 'validation_error', 'Provide metadata XML or an address');
      if (!httpUrl(body.allowInsecure).safeParse(body.url).success)
        throw new AppError(400, 'validation_error', 'The address must use https');
      try {
        const res = await fetch(body.url, {
          signal: AbortSignal.timeout(10_000),
          redirect: 'follow',
          headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const len = Number(res.headers.get('content-length') ?? 0);
        if (len > 1_000_000) throw new Error('too large');
        xml = (await res.text()).slice(0, 1_000_001);
      } catch (e) {
        throw new AppError(
          502,
          'metadata_unreachable',
          `Cannot read the metadata: ${(e as Error).message}`,
        );
      }
    }
    try {
      const md = parseIdpMetadata(xml);
      return {
        ...md,
        certInfo: certReport(md.certs),
      };
    } catch (e) {
      throw new AppError(
        400,
        e instanceof SamlError ? e.code : 'metadata_invalid',
        (e as Error).message,
      );
    }
  });

  /** Проверка настройки без входа: сертификаты, достижимость адреса входа, запрос, метаданные, круги. */
  app.post('/admin/saml/test', { preHandler: adminOnly }, async () => {
    const s = await stored();
    if (!s) throw new AppError(409, 'saml_not_configured', 'SAML is not configured');
    const checks: Check[] = [];
    const add = (id: string, level: Check['level'], message: string) =>
      checks.push({ id, level, message });
    const urls = urlsOf(s);
    if (urls) add('public_url', 'ok', urls.entityId);
    else add('public_url', 'error', 'APP_PUBLIC_URL is not set');

    if (!s.idpCerts.length) add('idp_cert', 'error', 'No provider certificate');
    for (const [i, info] of certReport(s.idpCerts).entries()) {
      const label = `#${i + 1}`;
      if (!info) add('idp_cert', 'error', `${label}: unreadable`);
      else if (info.state === 'valid')
        add('idp_cert', 'ok', `${label}: valid until ${info.notAfter}`);
      else if (info.state === 'expiring')
        add('idp_cert', 'warn', `${label}: expires in ${info.daysLeft} days (${info.notAfter})`);
      else add('idp_cert', 'error', `${label}: ${info.state}`);
    }

    if (s.entryPoint) {
      try {
        const res = await fetch(s.entryPoint, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status >= 500)
          add('entry_point', 'warn', `The provider answers with HTTP ${res.status}`);
        else add('entry_point', 'ok', `Reachable (HTTP ${res.status})`);
      } catch (e) {
        add(
          'entry_point',
          'error',
          `Not reachable: ${(e as Error).cause ? String((e as Error & { cause: unknown }).cause) : (e as Error).message}`,
        );
      }
    } else add('entry_point', 'error', 'No sign-in address');

    if (s.signRequests || s.spCert) {
      if (!s.spCert || !s.spKeyCipher) add('sp_cert', 'error', 'No service provider certificate');
      else {
        const info = analyzeCert(s.spCert);
        add(
          'sp_cert',
          info.state === 'valid' ? 'ok' : info.state === 'expiring' ? 'warn' : 'error',
          `Valid until ${info.notAfter}`,
        );
      }
    }

    if (urls && usableCerts(s.idpCerts).length && s.entryPoint) {
      try {
        const saml = runtime.get(s, keyOf(s), urls);
        const url = await saml.getAuthorizeUrlAsync('test', undefined, {});
        add('authn_request', 'ok', `The sign-in request is built (${new URL(url).host})`);
      } catch (e) {
        add('authn_request', 'error', (e as Error).message);
      }
    }

    if (s.groups.length) {
      const ids = [...new Set(s.groups.map((g) => g.circleId))];
      const have = await db
        .select({ id: circles.id })
        .from(circles)
        .where(inArray(circles.id, ids));
      if (have.length === ids.length) add('groups', 'ok', `${s.groups.length} group mapping(s)`);
      else add('groups', 'warn', `${ids.length - have.length} mapped circle(s) no longer exist`);
    }
    return { ok: !checks.some((c) => c.level === 'error'), checks };
  });

  // ------------------------------------------------------------------ метаданные поставщика услуг

  app.get('/auth/saml/metadata', async (_req, reply) => {
    const s = (await stored()) ?? emptyConfig();
    const urls = urlsOf(s);
    if (!urls) throw new AppError(409, 'public_url_required', 'The public address is not set');
    const key = keyOf(s);
    const xml = generateServiceProviderMetadata({
      issuer: urls.entityId,
      callbackUrl: urls.acs,
      logoutCallbackUrl: urls.slo,
      identifierFormat: s.nameIdFormat,
      wantAssertionsSigned: s.wantAssertionsSigned,
      ...(key && s.spCert ? { decryptionPvk: key, decryptionCert: s.spCert } : {}),
      ...(key && s.spCert && s.signRequests ? { privateKey: key, publicCerts: s.spCert } : {}),
    });
    return reply.type('application/samlmetadata+xml; charset=utf-8').send(xml);
  });

  // ------------------------------------------------------------------ вход

  app.get('/auth/saml', async () => {
    const s = await stored();
    return { enabled: !!s?.enabled, buttonText: s?.buttonText ?? 'SSO' };
  });

  const doneError = (reply: FastifyReply, code: string) =>
    reply.redirect(`/sso/done#error=${encodeURIComponent(code)}`, 303);

  app.get('/auth/saml/start', async (req, reply) => {
    const { c } = parse(z.object({ c: z.string().regex(CHALLENGE_RE) }), req.query);
    const s = await stored();
    const urls = s && urlsOf(s);
    if (!s?.enabled || !urls)
      throw new AppError(404, 'sso_disabled', 'SAML sign-in is not enabled');
    try {
      const relay = pending.put({ challenge: c });
      const url = await runtime.get(s, keyOf(s), urls).getAuthorizeUrlAsync(relay, undefined, {});
      return reply.redirect(url);
    } catch (e) {
      req.log.warn({ err: String(e) }, 'saml start failed');
      return doneError(
        reply,
        samlErrorCode(e) === 'idp_cert_expired' ? 'idp_cert_expired' : 'sso_unavailable',
      );
    }
  });

  /** Приём ответа провайдера (HTTP-POST binding). Итог возвращается приложению одноразовым билетом во фрагменте адреса. */
  app.post('/auth/saml/acs', async (req, reply) => {
    const ip = ipOf(req) ?? 'unknown';
    const key = `saml:${ip}`;
    const failWith = async (code: string, extra: object = {}) => {
      ctx.attempts.byIp.fail(key);
      await audit(db, 'anonymous', 'auth.saml.failed', null, { ip, reason: code, ...extra });
      return doneError(reply, code);
    };
    if (ctx.attempts.byIp.retryAfter(key) > 0) return doneError(reply, 'too_many_attempts');
    const form = (req.body ?? {}) as Record<string, string>;
    const samlResponse = typeof form.SAMLResponse === 'string' ? form.SAMLResponse : '';
    if (!samlResponse || samlResponse.length > 1_500_000) return failWith('invalid_response');
    const s = await stored();
    const urls = s && urlsOf(s);
    if (!s?.enabled || !urls) return failWith('sso_disabled');

    const relay = typeof form.RelayState === 'string' ? form.RelayState : '';
    const st = relay ? pending.take(relay) : undefined;
    if (!st && !s.allowIdpInitiated) return failWith('state');

    let ident;
    let profileId: string;
    try {
      const xml = decodeB64(samlResponse);
      const facts = inspectResponse(xml);
      if (facts.status !== SUCCESS)
        throw new SamlError('idp_status', 'The provider did not report success');
      if (facts.issuer && facts.issuer !== s.idpEntityId)
        throw new SamlError('issuer', 'The response comes from another provider');
      if (!s.allowSha1 && usesSha1(await expandEncrypted(xml, keyOf(s))))
        throw new SamlError('weak_algorithm', 'SHA-1 signature');
      const saml = runtime.get(s, keyOf(s), urls);
      const { profile } = await saml.validatePostResponseAsync({
        SAMLResponse: samlResponse,
        ...(relay ? { RelayState: relay } : {}),
      });
      if (!profile) throw new SamlError('invalid_response', 'Empty response');
      const assertionId =
        /<(?:[\w.-]+:)?Assertion\b[^>]*\bID\s*=\s*["']([^"']+)["']/.exec(
          profile.getAssertionXml?.() ?? '',
        )?.[1] ?? '';
      if (!assertionId) throw new SamlError('invalid_response', 'The assertion has no identifier');
      profileId = `${profile.issuer}|${assertionId}`;
      if (!runtime.rememberAssertion(profileId))
        throw new SamlError('replay', 'The assertion was already used');
      if (profile.issuer !== s.idpEntityId)
        throw new SamlError('issuer', 'The assertion comes from another provider');
      ident = identityFrom(s, profile);
    } catch (e) {
      req.log.warn(
        { reason: String((e as Error).message).slice(0, 200) },
        'saml response rejected',
      );
      return failWith(samlErrorCode(e));
    }

    if (s.allowedDomains.length) {
      const domain = ident.email.split('@')[1] ?? '';
      if (!s.allowedDomains.includes(domain)) return failWith('domain', { email: ident.email });
    }

    const [linked] = await db
      .select()
      .from(users)
      .where(and(eq(users.authSource, 'saml'), eq(users.externalId, ident.externalId)));

    // Группы проверяются при каждом входе: исключённый из группы лишается и действующих сеансов
    if (!groupAllowed(s, ident.groups)) {
      if (linked) {
        await db
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.userId, linked.id), isNull(sessions.revokedAt)));
        await audit(db, `user:${linked.id}`, 'auth.saml.revoked', `user:${linked.id}`, {
          reason: 'not_in_group',
        });
      }
      return failWith('not_in_group', { email: ident.email });
    }

    let out: LoginOutcome;
    if (linked) {
      if (linked.disabledAt) return failWith('disabled');
      await syncCirclesFor(db, linked.id, samlGroupMap(s), ident.groups);
      out = { kind: 'user', userId: linked.id, via: 'saml' };
    } else {
      const [clash] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, ident.email));
      if (clash) return failWith('account_exists');
      if (!s.autoProvision) return failWith('not_provisioned');
      out = {
        kind: 'enroll',
        identity: {
          source: 'saml',
          externalId: ident.externalId,
          email: ident.email,
          name: ident.name,
          groups: ident.groups,
        },
      };
    }
    ctx.attempts.byIp.reset(key);
    const ticket = ctx.tickets.issue(out, st?.challenge ?? null);
    return reply.redirect(`/sso/done#ticket=${ticket}`, 303);
  });

  // ------------------------------------------------------------------ выход по инициативе провайдера

  /**
   * Запрос выхода от провайдера (подписанный LogoutRequest): все сеансы пользователя завершаются.
   * Поддерживаются привязки HTTP-POST и HTTP-Redirect; ответ уходит провайдеру по HTTP-Redirect.
   */
  async function handleSlo(req: FastifyRequest, reply: FastifyReply) {
    const s = await stored();
    const urls = s && urlsOf(s);
    if (!s?.enabled || !urls)
      throw new AppError(404, 'sso_disabled', 'SAML sign-in is not enabled');
    const saml = runtime.get(s, keyOf(s), urls);
    const isPost = req.method === 'POST';
    const params = (isPost ? req.body : req.query) as Record<string, string>;
    if (typeof params?.SAMLRequest !== 'string') {
      // ответ провайдера на выход, начатый на нашей стороне, — закрывать нечего
      return reply.redirect('/', 303);
    }
    try {
      const res = isPost
        ? await saml.validatePostRequestAsync({
            SAMLRequest: params.SAMLRequest,
            ...(params.RelayState ? { RelayState: params.RelayState } : {}),
          })
        : await saml.validateRedirectAsync(
            req.query as never,
            req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '',
          );
      const profile = res.profile;
      if (!profile?.nameID) throw new SamlError('invalid_response', 'No subject');
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.authSource, 'saml'),
            eq(users.externalId, `${s.idpEntityId}|${profile.nameID}`),
          ),
        );
      let revoked = 0;
      if (u) {
        const r = await db
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.userId, u.id), isNull(sessions.revokedAt)))
          .returning({ id: sessions.id });
        revoked = r.length;
        await audit(db, `user:${u.id}`, 'auth.saml.logout', `user:${u.id}`, { revoked });
      }
      const back = await saml.getLogoutResponseUrlAsync(profile, params.RelayState ?? '', {}, true);
      return reply.redirect(back, 303);
    } catch (e) {
      await audit(db, 'anonymous', 'auth.saml.logout_failed', null, {
        ip: ipOf(req),
        reason: samlErrorCode(e),
      });
      throw new AppError(400, 'invalid_logout', 'The logout request was rejected');
    }
  }
  app.post('/auth/saml/slo', handleSlo);
  app.get('/auth/saml/slo', handleSlo);
};
