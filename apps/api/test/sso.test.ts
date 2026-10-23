import { createHash, createHmac, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { parseTotpInput, totp } from '@arklock/crypto';
import { settings, users } from '../src/db/schema.js';
import { TestClient, awayFromTotpStepEdge, createTestApp } from './helpers.js';

const PUBLIC = 'https://arklock.example.com';
// Привязка входа к браузеру: приложение хранит verifier, серверу уходит только его хэш
const VERIFIER = randomBytes(32).toString('base64url');
const START = `/api/v1/auth/sso/start?c=${createHash('sha256').update(VERIFIER).digest('base64url')}`;
const CLIENT = 'arklock-web';
const SECRET = 'idp-client-secret-for-tests';

type Tamper = 'none' | 'badsig' | 'aud' | 'expired' | 'nonce' | 'alg-none' | 'hs256' | 'iss';
const idp = {
  issuer: '',
  tamper: 'none' as Tamper,
  user: {
    sub: 'u-1',
    email: 'sam@example.com',
    name: 'Sam Sso',
    email_verified: true as boolean | undefined,
  },
  seenVerifiers: 0,
  codes: new Map<string, { nonce: string; challenge: string; redirect: string }>(),
};
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const b64 = (o: unknown) =>
  Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

function makeIdToken(nonce: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: idp.tamper === 'iss' ? 'https://evil.example.com' : idp.issuer,
    aud: idp.tamper === 'aud' ? 'someone-else' : CLIENT,
    sub: idp.user.sub,
    email: idp.user.email,
    name: idp.user.name,
    ...(idp.user.email_verified === undefined ? {} : { email_verified: idp.user.email_verified }),
    iat: now,
    exp: idp.tamper === 'expired' ? now - 3600 : now + 600,
    nonce: idp.tamper === 'nonce' ? 'another-nonce' : nonce,
  };
  const alg = idp.tamper === 'alg-none' ? 'none' : idp.tamper === 'hs256' ? 'HS256' : 'RS256';
  const head = b64({ alg, typ: 'JWT', kid: 'k1' });
  const body = b64(claims);
  if (alg === 'none') return `${head}.${body}.`;
  if (alg === 'HS256') {
    // атака подмены алгоритма: подпись HMAC, ключом служит открытый ключ
    const hmac = createHmac;
    const sig = hmac('sha256', JSON.stringify(jwk)).update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
  }
  const signer = createSign('RSA-SHA256').update(`${head}.${body}`);
  const key = idp.tamper === 'badsig' ? other.privateKey : privateKey;
  return `${head}.${body}.${signer.sign(key).toString('base64url')}`;
}

let server: http.Server;
function startIdp(): Promise<void> {
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, idp.issuer || 'http://127.0.0.1');
    const json = (o: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(o));
    };
    if (url.pathname === '/.well-known/openid-configuration')
      return json({
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
        jwks_uri: `${idp.issuer}/jwks`,
      });
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      const code = randomBytes(12).toString('hex');
      idp.codes.set(code, {
        nonce: url.searchParams.get('nonce')!,
        challenge: url.searchParams.get('code_challenge')!,
        redirect: url.searchParams.get('redirect_uri')!,
      });
      res.statusCode = 302;
      res.setHeader(
        'location',
        `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}`,
      );
      return res.end();
    }
    if (url.pathname === '/token') {
      let data = '';
      req.on('data', (d) => (data += d));
      req.on('end', () => {
        const p = new URLSearchParams(data);
        const rec = idp.codes.get(p.get('code') ?? '');
        idp.codes.delete(p.get('code') ?? '');
        const verifierOk =
          rec &&
          createHash('sha256')
            .update(p.get('code_verifier') ?? '')
            .digest('base64url') === rec.challenge;
        if (
          !rec ||
          !verifierOk ||
          p.get('client_secret') !== SECRET ||
          p.get('client_id') !== CLIENT ||
          p.get('redirect_uri') !== rec.redirect
        ) {
          res.statusCode = 400;
          return json({ error: 'invalid_grant' });
        }
        idp.seenVerifiers++;
        return json({ id_token: makeIdToken(rec.nonce), token_type: 'Bearer' });
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      idp.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let admin: TestClient;

/** «Браузер»: открывает /start, идёт к IdP, возвращается в /callback. Возвращает билет или код ошибки. */
async function browserLogin(): Promise<{ ticket?: string; error?: string }> {
  const start = await app.inject({ url: START });
  expect(start.statusCode).toBe(302);
  const authz = await fetch(start.headers.location as string, { redirect: 'manual' });
  const back = new URL(authz.headers.get('location')!);
  const cb = await app.inject({ url: `${back.pathname}${back.search}` });
  expect(cb.statusCode).toBe(302);
  const frag = new URLSearchParams((cb.headers.location as string).split('#')[1]);
  return { ticket: frag.get('ticket') ?? undefined, error: frag.get('error') ?? undefined };
}
const exchange = (ticket: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/auth/sso/exchange',
    payload: { ticket, verifier: VERIFIER },
  });

beforeAll(async () => {
  await startIdp();
  ({ app, database } = await createTestApp({ APP_PUBLIC_URL: PUBLIC }));
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  expect((await admin.register()).statusCode).toBe(201);
  await admin.login();
});

afterAll(async () => {
  await app.close();
  server.close();
});

const cfg = (extra: object = {}) => ({
  enabled: true,
  issuer: idp.issuer,
  clientId: CLIENT,
  clientSecret: SECRET,
  allowInsecure: true,
  allowedDomains: ['example.com'],
  buttonText: 'Corporate SSO',
  ...extra,
});

describe('OIDC administration', () => {
  it('only administrators configure it; the secret is sealed and never returned', async () => {
    expect((await app.inject({ url: '/api/v1/auth/sso' })).json()).toMatchObject({
      enabled: false,
    });
    const m = new TestClient(app, 'member@example.com', 'member-password-1234');
    await database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
    expect((await m.register()).statusCode).toBe(201);
    await m.login();
    expect((await m.req('PUT', '/admin/sso', cfg())).statusCode).toBe(403);
    await database.db.delete(settings).where(eq(settings.key, 'registration.mode'));

    expect((await admin.req('PUT', '/admin/sso', cfg())).statusCode).toBe(200);
    const got = (await admin.req('GET', '/admin/sso')).json();
    expect(got).toMatchObject({
      configured: true,
      hasClientSecret: true,
      redirectUri: `${PUBLIC}/api/v1/auth/sso/callback`,
    });
    expect(JSON.stringify(got)).not.toContain(SECRET);
    const [row] = await database.db.select().from(settings).where(eq(settings.key, 'sso.oidc'));
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect((await app.inject({ url: '/api/v1/auth/sso' })).json()).toEqual({
      enabled: true,
      buttonText: 'Corporate SSO',
    });
  });

  it('the test checks discovery and signing keys', async () => {
    const r = (await admin.req('POST', '/admin/sso/test')).json();
    expect(r).toMatchObject({ ok: true, keys: 1 });
  });

  it('plain http issuers are refused unless explicitly allowed', async () => {
    await admin.req('PUT', '/admin/sso', cfg({ allowInsecure: false }));
    const r = (await admin.req('POST', '/admin/sso/test')).json();
    expect(r.ok).toBe(false);
    await admin.req('PUT', '/admin/sso', cfg());
  });
});

describe('sign-in through OIDC', () => {
  let sam: TestClient;

  it('the first sign-in leads to account creation with a master password of the user’s own', async () => {
    const r = await browserLogin();
    expect(r.error).toBeUndefined();
    expect(idp.seenVerifiers).toBe(1); // IdP убедился в PKCE и секрете клиента
    const ex = await exchange(r.ticket!);
    expect(ex.json()).toMatchObject({ enroll: true, email: 'sam@example.com', name: 'Sam Sso' });
    expect(ex.json().token).toBeUndefined();
    // билет одноразовый
    expect((await exchange(r.ticket!)).statusCode).toBe(401);

    sam = new TestClient(app, 'sam@example.com', 'sam-master-password-1');
    const { payload, userId } = await sam.registerBody();
    const { email: _e, displayName: _d, setupToken: _s, ...rest } = payload;
    void _e;
    void _d;
    void _s;
    const done = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/external/enroll',
      payload: { ...rest, enrollToken: ex.json().enrollToken },
    });
    expect(done.statusCode).toBe(201);
    expect(done.json().user.email).toBe('sam@example.com');
    await sam.adopt(done.json());
    const [row] = await database.db.select().from(users).where(eq(users.id, userId));
    expect(row).toMatchObject({ authSource: 'oidc', externalId: `${idp.issuer}|u-1` });
  });

  it('later sign-ins return the session; master password alone is not accepted any more', async () => {
    const r = await browserLogin();
    const ex = await exchange(r.ticket!);
    expect(ex.json().token).toMatch(/^aks_/);
    expect(ex.json().user.wrappedPrivateKey).toBeTruthy();
    const viaMaster = await sam.loginRaw();
    expect(viaMaster.statusCode).toBe(403);
    expect(viaMaster.json().error.code).toBe('external_login_required');
  });

  it('a ticket works only in the browser that started the sign-in', async () => {
    expect((await app.inject({ url: '/api/v1/auth/sso/start' })).statusCode).toBe(400);
    const r = await browserLogin();
    const other = randomBytes(32).toString('base64url');
    const stolen = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sso/exchange',
      payload: { ticket: r.ticket, verifier: other },
    });
    expect(stolen.statusCode).toBe(401);
    // билет уничтожен неудачной попыткой
    expect((await exchange(r.ticket!)).statusCode).toBe(401);
    const r2 = await browserLogin();
    const noVerifier = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sso/exchange',
      payload: { ticket: r2.ticket },
    });
    expect(noVerifier.statusCode).toBe(401);
  });

  it('state is single-use and unknown states are rejected', async () => {
    const start = await app.inject({ url: START });
    const authz = await fetch(start.headers.location as string, { redirect: 'manual' });
    const back = new URL(authz.headers.get('location')!);
    const first = await app.inject({ url: `${back.pathname}${back.search}` });
    expect(first.headers.location).toContain('ticket=');
    const replay = await app.inject({ url: `${back.pathname}${back.search}` });
    expect(replay.headers.location).toContain('error=state');
    const forged = await app.inject({ url: '/api/v1/auth/sso/callback?code=abc&state=not-issued' });
    expect(forged.headers.location).toContain('error=state');
  });

  for (const [tamper, code] of [
    ['badsig', 'jwt'],
    ['alg-none', 'jwt'],
    ['hs256', 'jwt'],
    ['aud', 'claims'],
    ['expired', 'claims'],
    ['nonce', 'claims'],
    ['iss', 'claims'],
  ] as const) {
    it(`a forged id_token (${tamper}) is rejected with no session`, async () => {
      idp.tamper = tamper;
      try {
        const r = await browserLogin();
        expect(r.ticket).toBeUndefined();
        expect(r.error).toBe(code);
      } finally {
        idp.tamper = 'none';
      }
    });
  }

  it('unverified e-mail, foreign domain and missing e-mail are refused', async () => {
    const keep = { ...idp.user };
    try {
      idp.user = { ...keep, sub: 'u-2', email: 'unverified@example.com', email_verified: false };
      expect((await browserLogin()).error).toBe('claims');
      idp.user = { ...keep, sub: 'u-3', email: 'x@example.org' };
      expect((await browserLogin()).error).toBe('claims');
      idp.user = { ...keep, sub: 'u-4', email: '' };
      expect((await browserLogin()).error).toBe('claims');
    } finally {
      idp.user = keep;
    }
  });

  it('an existing local account is never taken over by an identity provider', async () => {
    const keep = { ...idp.user };
    try {
      idp.user = { ...keep, sub: 'u-9', email: 'admin@example.com' };
      expect((await browserLogin()).error).toBe('account_exists');
    } finally {
      idp.user = keep;
    }
  });

  it('a disabled account cannot sign in; the second factor still applies', async () => {
    const mfaSecret = (await sam.req('POST', '/auth/mfa/setup')).json().secret as string;
    await awayFromTotpStepEdge();
    expect(
      (
        await sam.req('POST', '/auth/mfa/enable', {
          code: await totp(parseTotpInput(mfaSecret), Date.now() - 30_000),
        })
      ).statusCode,
    ).toBe(200);
    const withMfa = await exchange((await browserLogin()).ticket!);
    expect(withMfa.json()).toMatchObject({ mfaRequired: true });
    expect(withMfa.json().token).toBeUndefined();

    await database.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, sam.userId));
    expect((await browserLogin()).error).toBe('disabled');
  });

  it('SSO cannot be enabled without a public address', async () => {
    const t = await createTestApp();
    const a = new TestClient(t.app, 'a@example.com', 'admin-password-1234');
    await a.register();
    await a.login();
    const r = await a.req('PUT', '/admin/sso', cfg());
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('public_url_required');
    await t.app.close();
  });
});
