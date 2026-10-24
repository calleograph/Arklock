import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { circleMembers, ledger, sessions, settings, users } from '../src/db/schema.js';
import {
  buildLogoutRequest,
  buildResponse,
  createIdp,
  encryptAssertion,
  idpMetadata,
  parseAuthnRequest,
  type ResponseOptions,
  type TestIdp,
} from '../../../e2e/saml-idp.mjs';
import { TestClient, createTestApp } from './helpers.js';

const PUBLIC = 'https://arklock.example.com';
const ACS = `${PUBLIC}/api/v1/auth/saml/acs`;
const SP = `${PUBLIC}/api/v1/auth/saml/metadata`;
const API = '/api/v1';

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let admin: TestClient;
let idp: TestIdp;
let rogue: TestIdp;
let ssoUrl = '';
let server: http.Server;
let circleId = '';

const VERIFIER = randomBytes(32).toString('base64url');
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const frag = (loc: string) => new URLSearchParams(loc.split('#')[1] ?? '');

interface Login {
  ticket?: string;
  error?: string;
  /** Ответ провайдера и состояние — для повторной отправки. */
  samlResponse: string;
  relay: string;
}
type Opts = Partial<Omit<ResponseOptions, 'idp' | 'acs' | 'audience' | 'nameId'>> & {
  nameId?: string;
  attributes?: Record<string, string | string[]>;
  /** Не передавать RelayState (ответ по инициативе провайдера). */
  unsolicited?: boolean;
  encrypt?: string;
  xml?: (xml: string, req: { id: string }) => string;
};

/** «Браузер»: /start → провайдер подписывает ответ → ACS. */
async function browserLogin(o: Opts = {}): Promise<Login> {
  const start = await app.inject({ url: `${API}/auth/saml/start?c=${CHALLENGE}` });
  expect(start.statusCode).toBe(302);
  const to = new URL(start.headers.location as string);
  const req = parseAuthnRequest(to.searchParams.get('SAMLRequest')!);
  const relay = o.unsolicited ? '' : to.searchParams.get('RelayState')!;
  const { unsolicited: _u, encrypt, xml: mutate, ...rest } = o;
  void _u;
  let xml = buildResponse({
    idp,
    acs: ACS,
    audience: SP,
    nameId: 'sam-1',
    attributes: { email: 'sam@example.com', displayName: 'Sam Saml' },
    ...(o.unsolicited ? {} : { inResponseTo: req.id }),
    ...rest,
  });
  if (mutate) xml = mutate(xml, req);
  if (encrypt) xml = await encryptAssertion(xml, encrypt);
  return post(Buffer.from(xml).toString('base64'), relay);
}
async function post(samlResponse: string, relay: string): Promise<Login> {
  const r = await app.inject({
    method: 'POST',
    url: `${API}/auth/saml/acs`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ SAMLResponse: samlResponse, ...(relay ? { RelayState: relay } : {}) }),
  });
  expect(r.statusCode, r.body).toBe(303);
  const f = frag(r.headers.location as string);
  return {
    ticket: f.get('ticket') ?? undefined,
    error: f.get('error') ?? undefined,
    samlResponse,
    relay,
  };
}
const exchange = (ticket: string, verifier: string | undefined = VERIFIER) =>
  app.inject({
    method: 'POST',
    url: `${API}/auth/sso/exchange`,
    payload: { ticket, ...(verifier ? { verifier } : {}) },
  });

const cfg = (extra: object = {}) => ({
  enabled: true,
  idpEntityId: idp.entityId,
  entryPoint: ssoUrl,
  idpCerts: idp.certPem,
  allowInsecure: true,
  emailAttr: 'email',
  nameAttr: 'displayName',
  groupsAttr: 'groups',
  allowedDomains: ['example.com'],
  buttonText: 'Corporate SAML',
  ...extra,
});

async function enroll(ex: { enrollToken: string }, c: TestClient) {
  const { payload } = await c.registerBody();
  const { email: _e, displayName: _d, setupToken: _s, ...rest } = payload;
  void _e;
  void _d;
  void _s;
  const done = await app.inject({
    method: 'POST',
    url: `${API}/auth/external/enroll`,
    payload: { ...rest, enrollToken: ex.enrollToken },
  });
  expect(done.statusCode, done.body).toBe(201);
  await c.adopt(done.json());
}

beforeAll(async () => {
  idp = await createIdp('https://idp.example.com/entity');
  rogue = await createIdp('https://idp.example.com/entity');
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/metadata')) {
      res.setHeader('content-type', 'application/xml');
      res.end(idpMetadata(idp, { sso: ssoUrl, slo: `${ssoUrl}/logout` }));
    } else res.end('IdP');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  ssoUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sso`;
  ({ app, database } = await createTestApp({ APP_PUBLIC_URL: PUBLIC }));
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  expect((await admin.register()).statusCode).toBe(201);
  await admin.login();
  circleId = (await admin.req('POST', '/admin/circles', { name: 'Finance' })).json().id;
});

afterAll(async () => {
  await app.close();
  server.close();
});

describe('SAML administration', () => {
  it('only administrators configure it; certificates are checked on save', async () => {
    expect((await app.inject({ url: `${API}/auth/saml` })).json()).toMatchObject({
      enabled: false,
    });
    const m = new TestClient(app, 'member@example.com', 'member-password-1234');
    await database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
    expect((await m.register()).statusCode).toBe(201);
    await m.login();
    expect((await m.req('PUT', '/admin/saml', cfg())).statusCode).toBe(403);
    expect((await m.req('GET', '/admin/saml')).statusCode).toBe(403);
    await database.db.delete(settings).where(eq(settings.key, 'registration.mode'));

    // просроченный и ещё не действующий сертификаты не принимаются
    const old = await createIdp('https://old.example.com', { validDays: -2 });
    const early = await createIdp('https://early.example.com', {
      validDays: 30,
      notBeforeDays: -5,
    });
    const expired = await admin.req('PUT', '/admin/saml', cfg({ idpCerts: old.certPem }));
    expect(expired.statusCode).toBe(400);
    expect(expired.json().error.code).toBe('idp_cert_expired');
    expect(
      (await admin.req('PUT', '/admin/saml', cfg({ idpCerts: early.certPem }))).statusCode,
    ).toBe(400);
    expect(
      (await admin.req('PUT', '/admin/saml', cfg({ idpCerts: 'not a certificate' }))).statusCode,
    ).toBe(400);
    // слабый ключ
    const weak = await createIdp('https://weak.example.com', { bits: 1024 });
    expect(
      (await admin.req('PUT', '/admin/saml', cfg({ idpCerts: weak.certPem }))).statusCode,
    ).toBe(400);

    expect((await admin.req('PUT', '/admin/saml', cfg())).statusCode).toBe(200);
    const got = (await admin.req('GET', '/admin/saml')).json();
    expect(got).toMatchObject({
      configured: true,
      idpEntityId: idp.entityId,
      urls: { acs: ACS, metadata: SP },
    });
    expect(got.idpCertInfo[0]).toMatchObject({ state: 'valid', keyType: 'rsa', keyBits: 2048 });
    expect(got.idpCertInfo[0].fingerprint256).toMatch(/^[0-9A-F:]+$/);
    expect((await app.inject({ url: `${API}/auth/saml` })).json()).toEqual({
      enabled: true,
      buttonText: 'Corporate SAML',
    });
  });

  it('unsafe settings are refused: plain http, no signature requirement, no public address', async () => {
    expect(
      (await admin.req('PUT', '/admin/saml', cfg({ allowInsecure: false }))).json().error.code,
    ).toBe('validation_error');
    expect(
      (
        await admin.req(
          'PUT',
          '/admin/saml',
          cfg({ wantAssertionsSigned: false, wantResponseSigned: false }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await admin.req('PUT', '/admin/saml', cfg({ signRequests: true }))).json().error.code,
    ).toBe('sp_key_required');
    const t = await createTestApp();
    const a = new TestClient(t.app, 'a@example.com', 'admin-password-1234');
    await a.register();
    await a.login();
    const r = await a.req('PUT', '/admin/saml', cfg());
    expect(r.json().error.code).toBe('public_url_required');
    await t.app.close();
    await admin.req('PUT', '/admin/saml', cfg());
  });

  it('provider metadata fills the form; broken metadata is explained', async () => {
    const fromXml = await admin.req('POST', '/admin/saml/import-metadata', {
      xml: idpMetadata(idp, {
        sso: 'https://idp.example.com/sso',
        slo: 'https://idp.example.com/slo',
      }),
    });
    expect(fromXml.json()).toMatchObject({
      entityId: idp.entityId,
      ssoUrl: 'https://idp.example.com/sso',
      logoutUrl: 'https://idp.example.com/slo',
    });
    expect(fromXml.json().certInfo[0].state).toBe('valid');
    const fromUrl = await admin.req('POST', '/admin/saml/import-metadata', {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/metadata`,
      allowInsecure: true,
    });
    expect(fromUrl.json().ssoUrl).toBe(ssoUrl);
    expect(
      (await admin.req('POST', '/admin/saml/import-metadata', { xml: '<not-xml' })).json().error
        .code,
    ).toBe('metadata_invalid');
    expect(
      (await admin.req('POST', '/admin/saml/import-metadata', { xml: '<a/>' })).json().error.code,
    ).toBe('metadata_invalid');
    // адрес по http без разрешения — отказ до обращения к сети
    expect(
      (
        await admin.req('POST', '/admin/saml/import-metadata', {
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/metadata`,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('the check reports certificates, reachability and the request; metadata is public', async () => {
    const r = (await admin.req('POST', '/admin/saml/test')).json();
    expect(r.ok).toBe(true);
    expect(r.checks.map((c: { id: string }) => c.id)).toEqual(
      expect.arrayContaining(['public_url', 'idp_cert', 'entry_point', 'authn_request']),
    );
    const md = await app.inject({ url: `${API}/auth/saml/metadata` });
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toContain('samlmetadata+xml');
    expect(md.body).toContain(`entityID="${SP}"`);
    expect(md.body).toContain(`Location="${ACS}"`);
    expect(md.body).toContain('WantAssertionsSigned="true"');
  });

  it('a signing certificate is generated for the service provider; the key never leaves the server', async () => {
    const r = (await admin.req('POST', '/admin/saml/sp-cert')).json();
    expect(r.spCert).toContain('BEGIN CERTIFICATE');
    expect(r.spCertInfo).toMatchObject({ state: 'valid', keyType: 'rsa', keyBits: 2048 });
    const got = JSON.stringify((await admin.req('GET', '/admin/saml')).json());
    expect(got).not.toContain('PRIVATE KEY');
    expect(JSON.parse(got)).toMatchObject({ hasSpKey: true });
    const [row] = await database.db.select().from(settings).where(eq(settings.key, 'sso.saml'));
    expect(JSON.stringify(row)).not.toContain('PRIVATE KEY');
    // ключ — только в запечатанном виде: незапечатанный PKCS#8 начинался бы с MIIE/MIIF в начале значения или строки
    // (внутри случайного шифртекста такие четыре знака встречаются сами: проверка не должна на них срабатывать)
    expect(JSON.stringify(row)).not.toMatch(/("|\\n)MII[EF]/);
    expect((row!.value as { spKeyCipher: string }).spKeyCipher).toMatch(/^s1\./);
    const md = (await app.inject({ url: `${API}/auth/saml/metadata` })).body;
    expect(md).toContain('use="encryption"');
  });
});

describe('sign-in through SAML', () => {
  let sam: TestClient;

  it('the first sign-in leads to account creation with a master password of the user’s own', async () => {
    const r = await browserLogin();
    expect(r.error).toBeUndefined();
    const ex = await exchange(r.ticket!);
    expect(ex.json()).toMatchObject({ enroll: true, email: 'sam@example.com', name: 'Sam Saml' });
    expect(ex.json().token).toBeUndefined();
    expect((await exchange(r.ticket!)).statusCode).toBe(401); // билет одноразовый
    sam = new TestClient(app, 'sam@example.com', 'sam-master-password-1');
    await enroll(ex.json(), sam);
    const [row] = await database.db.select().from(users).where(eq(users.id, sam.userId));
    expect(row).toMatchObject({ authSource: 'saml', externalId: `${idp.entityId}|sam-1` });
  });

  it('later sign-ins return the session; the master password alone is not accepted', async () => {
    const ex = await exchange((await browserLogin()).ticket!);
    expect(ex.json().token).toMatch(/^aks_/);
    expect(ex.json().user.wrappedPrivateKey).toBeTruthy();
    expect((await sam.loginRaw()).json().error.code).toBe('external_login_required');
  });

  it('a ticket works only in the browser that started the sign-in', async () => {
    expect((await app.inject({ url: `${API}/auth/saml/start` })).statusCode).toBe(400);
    const r = await browserLogin();
    expect((await exchange(r.ticket!, randomBytes(32).toString('base64url'))).statusCode).toBe(401);
    expect((await exchange(r.ticket!)).statusCode).toBe(401);
    const r2 = await browserLogin();
    expect((await exchange(r2.ticket!, '')).statusCode).toBe(401);
  });

  it('every response is single-use: state, request id and assertion id are bound', async () => {
    const r = await browserLogin();
    expect(r.ticket).toBeTruthy();
    const replay = await post(r.samlResponse, r.relay);
    expect(replay.error).toBe('state');
    // новая попытка с теми же данными ответа, но свежим состоянием: запрос другой
    const start = await app.inject({ url: `${API}/auth/saml/start?c=${CHALLENGE}` });
    const relay2 = new URL(start.headers.location as string).searchParams.get('RelayState')!;
    expect((await post(r.samlResponse, relay2)).error).toBeTruthy();
    // ответ без состояния (по инициативе провайдера) по умолчанию отвергается
    expect((await browserLogin({ unsolicited: true })).error).toBe('state');
  });

  const bad: [string, () => Opts, string][] = [
    ['an assertion signed with another key', () => ({ signingIdp: rogue }), 'signature'],
    ['an unsigned response', () => ({ signAssertion: false }), 'signature'],
    ['an expired assertion', () => ({ now: Date.now() - 3600_000, lifetimeSec: 60 }), 'expired'],
    [
      'an assertion for another audience',
      () => ({ audience: 'https://other.example.com' }),
      'audience',
    ],
    ['an assertion from another issuer', () => ({ issuer: 'https://evil.example.com' }), 'issuer'],
    ['a SHA-1 signature', () => ({ sha1: true }), 'weak_algorithm'],
    [
      'a failed authentication at the provider',
      () => ({ status: 'urn:oasis:names:tc:SAML:2.0:status:Responder' }),
      'idp_status',
    ],
    [
      'a changed subject after signing',
      () => ({ tamper: (x: string) => x.replace('sam-1', 'admin-1') }),
      'signature',
    ],
    [
      'a changed e-mail after signing',
      () => ({ tamper: (x: string) => x.replace('sam@example.com', 'admin@example.com') }),
      'signature',
    ],
    [
      'a response to a request that was never made',
      () => ({ inResponseTo: '_not-ours' }),
      'in_response_to',
    ],
  ];
  for (const [name, make, code] of bad) {
    it(`${name} is refused and no session appears`, async () => {
      const r = await browserLogin(make());
      expect(r.ticket).toBeUndefined();
      expect(r.error).toBe(code);
    });
  }

  it('a forged assertion placed beside the signed one does not change who signs in', async () => {
    const r = await browserLogin({
      xml: (x) => {
        const forged = x
          .match(/<saml:Assertion\b[\s\S]*<\/saml:Assertion>/)![0]
          .replace(/<ds:Signature[\s\S]*?<\/ds:Signature>/, '')
          .replace('sam-1', 'admin-1')
          .replace('sam@example.com', 'admin@example.com')
          .replace(/ID="[^"]+"/, 'ID="_forged"');
        return x.replace('<saml:Assertion ', forged + '<saml:Assertion ');
      },
    });
    if (r.ticket) {
      const ex = (await exchange(r.ticket)).json();
      expect(ex.token ?? ex.email).not.toBe('admin@example.com');
      expect(ex.email === undefined || ex.email === 'sam@example.com').toBe(true);
    } else expect(r.error).toBeTruthy();
  });

  it('a signed response (instead of assertion) and an encrypted assertion are accepted', async () => {
    await admin.req(
      'PUT',
      '/admin/saml',
      cfg({ wantAssertionsSigned: false, wantResponseSigned: true }),
    );
    const a = await browserLogin({ signAssertion: false, signResponse: true });
    expect(a.error).toBeUndefined();
    await admin.req('PUT', '/admin/saml', cfg());
    const spCert = (await admin.req('GET', '/admin/saml')).json().spCert as string;
    const b = await browserLogin({ encrypt: spCert });
    expect(b.error).toBeUndefined();
    expect(b.ticket).toBeTruthy();
    // зашифрованное утверждение, подписанное чужим ключом, не принимается
    const c = await browserLogin({ encrypt: spCert, signingIdp: rogue });
    expect(c.ticket).toBeUndefined();
  });

  it('foreign domain, missing e-mail and existing local accounts are refused', async () => {
    expect(
      (await browserLogin({ nameId: 'x-1', attributes: { email: 'x@example.org' } })).error,
    ).toBe('domain');
    expect((await browserLogin({ nameId: 'opaque-2', attributes: {} })).error).toBe('claims');
    expect(
      (await browserLogin({ nameId: 'a-1', attributes: { email: 'admin@example.com' } })).error,
    ).toBe('account_exists');
  });

  it('the e-mail may come from the NameID when the provider sends no attribute', async () => {
    const r = await browserLogin({
      nameId: 'tom@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      attributes: {},
    });
    expect((await exchange(r.ticket!)).json()).toMatchObject({
      enroll: true,
      email: 'tom@example.com',
    });
  });

  it('groups from the provider are mapped to circles on every sign-in', async () => {
    await admin.req('PUT', '/admin/saml', cfg({ groups: [{ name: 'Finance Team', circleId }] }));
    const members = async () =>
      (
        await database.db.select().from(circleMembers).where(eq(circleMembers.circleId, circleId))
      ).map((m) => m.userId);
    expect(await members()).not.toContain(sam.userId);
    await browserLogin({ attributes: { email: 'sam@example.com', groups: ['finance team'] } });
    expect(await members()).toContain(sam.userId); // без учёта регистра
    await browserLogin({ attributes: { email: 'sam@example.com', groups: ['Other'] } });
    expect(await members()).not.toContain(sam.userId); // исключён — членство снято
  });

  it('required groups: outsiders are refused and a known user loses the open sessions', async () => {
    await admin.req('PUT', '/admin/saml', cfg({ requiredGroups: ['Staff'] }));
    // действующий сеанс пользователя
    const ok = await exchange(
      (await browserLogin({ attributes: { email: 'sam@example.com', groups: ['Staff'] } })).ticket!,
    );
    const token = ok.json().token as string;
    expect(
      (await app.inject({ url: `${API}/auth/me`, headers: { authorization: `Bearer ${token}` } }))
        .statusCode,
    ).toBe(200);
    const denied = await browserLogin({
      attributes: { email: 'sam@example.com', groups: ['Visitors'] },
    });
    expect(denied.error).toBe('not_in_group');
    expect(
      (await app.inject({ url: `${API}/auth/me`, headers: { authorization: `Bearer ${token}` } }))
        .statusCode,
    ).toBe(401);
    // новый пользователь вне группы не получает ни билета, ни учётной записи
    const stranger = await browserLogin({
      nameId: 'z-1',
      attributes: { email: 'zed@example.com', groups: [] },
    });
    expect(stranger.error).toBe('not_in_group');
    await admin.req('PUT', '/admin/saml', cfg());
  });

  it('a session of a SAML user ends after the limit set by the administrator', async () => {
    const ok = await exchange((await browserLogin()).ticket!);
    const token = ok.json().token as string;
    const me = () =>
      app.inject({ url: `${API}/auth/me`, headers: { authorization: `Bearer ${token}` } });
    expect((await me()).statusCode).toBe(200);
    await admin.req('PUT', '/admin/saml', cfg({ maxSessionHours: 8 }));
    expect((await me()).statusCode).toBe(200);
    await database.db
      .update(sessions)
      .set({ createdAt: new Date(Date.now() - 9 * 3_600_000) })
      .where(eq(sessions.userId, sam.userId));
    expect((await me()).statusCode).toBe(401);
    // новый вход открывает новый сеанс
    const again = await exchange((await browserLogin()).ticket!);
    expect(again.json().token).toBeTruthy();
    await admin.req('PUT', '/admin/saml', cfg());
  });

  it('a provider-initiated response is accepted only when allowed, and only once', async () => {
    await admin.req('PUT', '/admin/saml', cfg({ allowIdpInitiated: true }));
    const first = await browserLogin({ unsolicited: true, assertionId: '_same-assertion' });
    expect(first.error).toBeUndefined();
    expect((await exchange(first.ticket!, '')).json().token).toMatch(/^aks_/);
    const replay = await post(first.samlResponse, '');
    expect(replay.error).toBe('replay');
    await admin.req('PUT', '/admin/saml', cfg());
  });

  it('provider logout request ends all sessions; unsigned or foreign ones are rejected', async () => {
    const ok = await exchange((await browserLogin()).ticket!);
    const token = ok.json().token as string;
    const me = () =>
      app.inject({ url: `${API}/auth/me`, headers: { authorization: `Bearer ${token}` } });
    const slo = (xml: string) =>
      app.inject({
        method: 'POST',
        url: `${API}/auth/saml/slo`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ SAMLRequest: Buffer.from(xml).toString('base64') }),
      });
    const url = `${PUBLIC}/api/v1/auth/saml/slo`;
    expect(
      (await slo(buildLogoutRequest({ idp, destination: url, nameId: 'sam-1', signed: false })))
        .statusCode,
    ).toBe(400);
    expect(
      (await slo(buildLogoutRequest({ idp, destination: url, nameId: 'sam-1', signingIdp: rogue })))
        .statusCode,
    ).toBe(400);
    expect((await me()).statusCode).toBe(200);
    const done = await slo(buildLogoutRequest({ idp, destination: url, nameId: 'sam-1' }));
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toContain('SAMLResponse=');
    expect((await me()).statusCode).toBe(401);
  });

  it('a disabled account cannot sign in', async () => {
    await database.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, sam.userId));
    expect((await browserLogin()).error).toBe('disabled');
    await database.db.update(users).set({ disabledAt: null }).where(eq(users.id, sam.userId));
  });

  it('signed sign-in requests are sent when asked for', async () => {
    await admin.req('PUT', '/admin/saml', cfg({ signRequests: true }));
    const start = await app.inject({ url: `${API}/auth/saml/start?c=${CHALLENGE}` });
    const q = new URL(start.headers.location as string).searchParams;
    expect(q.get('Signature')).toBeTruthy();
    expect(q.get('SigAlg')).toContain('rsa-sha256');
    const md = (await app.inject({ url: `${API}/auth/saml/metadata` })).body;
    expect(md).toContain('AuthnRequestsSigned="true"');
    await admin.req('PUT', '/admin/saml', cfg());
  });

  it('certificate rotation: both certificates work; once all expire sign-in stops with a clear reason', async () => {
    const next = await createIdp(idp.entityId);
    await admin.req('PUT', '/admin/saml', cfg({ idpCerts: `${idp.certPem}\n${next.certPem}` }));
    expect((await browserLogin()).error).toBeUndefined();
    expect((await browserLogin({ signingIdp: next })).error).toBeUndefined();
    // без нового сертификата ответ, подписанный новым ключом, не проходит
    await admin.req('PUT', '/admin/saml', cfg());
    expect((await browserLogin({ signingIdp: next })).error).toBe('signature');
    // сертификат истёк уже после сохранения настройки
    const [row] = await database.db.select().from(settings).where(eq(settings.key, 'sso.saml'));
    const expired = await createIdp(idp.entityId, { validDays: -1 });
    await database.db
      .update(settings)
      .set({ value: { ...(row!.value as object), idpCerts: [expired.certPem] } as never })
      .where(eq(settings.key, 'sso.saml'));
    const start = await app.inject({ url: `${API}/auth/saml/start?c=${CHALLENGE}` });
    expect(start.headers.location).toContain('error=idp_cert_expired');
    const t = (await admin.req('POST', '/admin/saml/test')).json();
    expect(t.ok).toBe(false);
    await admin.req('PUT', '/admin/saml', cfg());
  });

  it('failures are written to the audit log without response contents', async () => {
    const rows = await database.db.select().from(ledger);
    const failed = rows.filter((r) => r.action === 'auth.saml.failed');
    expect(failed.length).toBeGreaterThan(5);
    expect(failed.map((r) => (r.detail as { reason: string }).reason)).toEqual(
      expect.arrayContaining(['signature', 'audience', 'expired', 'state']),
    );
    const text = JSON.stringify(rows);
    expect(text).not.toContain('SAMLResponse');
    expect(text).not.toContain('PRIVATE KEY');
    expect(rows.some((r) => r.action === 'auth.saml.logout')).toBe(true);
    expect(rows.some((r) => r.action === 'auth.saml.revoked')).toBe(true);
  });
});
