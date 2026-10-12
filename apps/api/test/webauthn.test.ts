import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { toBase64Url } from '@arklock/crypto';
import { webauthnCredentials } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { TestClient, createTestApp } from './helpers.js';

const PUBLIC = 'https://arklock.example.com';
const ORIGIN = 'https://arklock.example.com';
const RP_ID = 'arklock.example.com';

// ----- минимальный CBOR для атестации «none» и ключа COSE ES256
const head = (major: number, n: number): Buffer =>
  n < 24
    ? Buffer.from([(major << 5) | n])
    : n < 256
      ? Buffer.from([(major << 5) | 24, n])
      : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
const cborBytes = (b: Buffer) => Buffer.concat([head(2, b.length), b]);
const cborText = (s: string) => Buffer.concat([head(3, Buffer.byteLength(s)), Buffer.from(s)]);
const cborInt = (n: number) => (n >= 0 ? head(0, n) : head(1, -1 - n));

/** Программный аутентификатор: создаёт учётные данные и подписывает запросы (ES256). */
class Authenticator {
  readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly credId = randomBytes(32);
  counter = 0;
  get id() {
    return toBase64Url(this.credId);
  }
  private coseKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x!, 'base64url');
    const y = Buffer.from(jwk.y!, 'base64url');
    return Buffer.concat([
      Buffer.from([0xa5]),
      cborInt(1),
      cborInt(2),
      cborInt(3),
      cborInt(-7),
      cborInt(-1),
      cborInt(1),
      cborInt(-2),
      cborBytes(x),
      cborInt(-3),
      cborBytes(y),
    ]);
  }
  private rpHash(rpId: string) {
    return createHash('sha256').update(rpId).digest();
  }
  register(challenge: string, o: { origin?: string; rpId?: string } = {}) {
    const clientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge,
        origin: o.origin ?? ORIGIN,
        crossOrigin: false,
      }),
    );
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([
      this.rpHash(o.rpId ?? RP_ID),
      Buffer.from([0x45]),
      Buffer.alloc(4),
      Buffer.alloc(16), // aaguid
      credIdLen,
      this.credId,
      this.coseKey(),
    ]);
    const attestation = Buffer.concat([
      Buffer.from([0xa3]),
      cborText('fmt'),
      cborText('none'),
      cborText('attStmt'),
      Buffer.from([0xa0]),
      cborText('authData'),
      cborBytes(authData),
    ]);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: clientData.toString('base64url'),
        attestationObject: attestation.toString('base64url'),
        transports: ['usb'],
      },
      clientExtensionResults: {},
    };
  }
  assert(
    challenge: string,
    o: { origin?: string; rpId?: string; badSignature?: boolean; counter?: number } = {},
  ) {
    this.counter = o.counter ?? this.counter + 1;
    const clientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge,
        origin: o.origin ?? ORIGIN,
        crossOrigin: false,
      }),
    );
    const c = Buffer.alloc(4);
    c.writeUInt32BE(this.counter);
    const authData = Buffer.concat([this.rpHash(o.rpId ?? RP_ID), Buffer.from([0x05]), c]);
    const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
    const sig = cryptoSign('sha256', signed, { key: this.keys.privateKey, dsaEncoding: 'der' });
    if (o.badSignature) sig[sig.length - 1] = (sig[sig.length - 1]! + 1) & 255;
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: clientData.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: sig.toString('base64url'),
      },
      clientExtensionResults: {},
    };
  }
}

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let user: TestClient;
const key1 = new Authenticator();
const key2 = new Authenticator();
const authKeyOf = async (c: TestClient) => toBase64Url((await c.derive()).keys.authKey);

async function addKey(
  a: Authenticator,
  name: string,
  opts: { origin?: string; rpId?: string } = {},
) {
  const o = await user.req('POST', '/auth/webauthn/register/options', {
    authKey: await authKeyOf(user),
  });
  expect(o.statusCode).toBe(200);
  return user.req('POST', '/auth/webauthn/register/verify', {
    name,
    response: a.register(o.json().challenge, opts),
  });
}

/** Начало входа: пароль принят, сервер вернул вызов и способы подтверждения. */
async function start() {
  const res = await user.loginRaw();
  expect(res.statusCode).toBe(200);
  return res.json() as {
    mfaRequired: true;
    challenge: string;
    methods: { totp: boolean; webauthn: boolean };
  };
}
const optionsFor = (challenge: string) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/mfa/webauthn/options', payload: { challenge } });
const verify = (challenge: string, response: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/auth/mfa/webauthn/verify',
    payload: { challenge, response },
  });

beforeAll(async () => {
  ({ app, database } = await createTestApp({ APP_PUBLIC_URL: PUBLIC }));
  user = new TestClient(app, 'pk@example.com', 'passkey-master-password-1');
  expect((await user.register()).statusCode).toBe(201);
  await user.login();
});

afterAll(async () => {
  await app.close();
});

describe('security keys (WebAuthn)', () => {
  it('registration needs the master password and a configured public address', async () => {
    const bad = await user.req('POST', '/auth/webauthn/register/options', {
      authKey: toBase64Url(new Uint8Array(32)),
    });
    expect(bad.statusCode).toBe(401);
    const t = await createTestApp();
    const c = new TestClient(t.app, 'x@example.com', 'x-master-password-12345');
    await c.register();
    await c.login();
    const r = await c.req('POST', '/auth/webauthn/register/options', {
      authKey: await authKeyOf(c),
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('public_url_required');
    await t.app.close();
  });

  it('a registration from another origin or for another site is rejected', async () => {
    expect((await addKey(key1, 'evil', { origin: 'https://evil.example.net' })).statusCode).toBe(
      400,
    );
    expect((await addKey(key1, 'wrong-rp', { rpId: 'evil.example.net' })).statusCode).toBe(400);
    expect((await user.req('GET', '/auth/webauthn')).json().credentials).toEqual([]);
  });

  it('registers keys, lists them without key material, refuses duplicates', async () => {
    expect((await addKey(key1, 'YubiKey')).statusCode).toBe(201);
    const list = (await user.req('GET', '/auth/webauthn')).json();
    expect(list.available).toBe(true);
    expect(list.credentials).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('publicKey');
    expect((await addKey(key1, 'again')).statusCode).toBe(409);
  });

  it('login now asks for the key; the password alone gives no session', async () => {
    const s = await start();
    expect(s.methods).toEqual({ totp: false, webauthn: true });
    expect((s as unknown as Record<string, unknown>).token).toBeUndefined();
  });

  it('a valid assertion completes the sign-in and advances the counter; replay fails', async () => {
    const s = await start();
    const opts = (await optionsFor(s.challenge)).json();
    expect(opts.rpId).toBe(RP_ID);
    expect(opts.allowCredentials[0].id).toBe(key1.id);
    const done = await verify(s.challenge, key1.assert(opts.challenge));
    expect(done.statusCode).toBe(200);
    expect(done.json().token).toMatch(/^aks_/);
    const [row] = await database.db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.id, key1.id));
    expect(row!.counter).toBe(key1.counter);
    expect(row!.lastUsedAt).not.toBeNull();
    // тот же вызов повторно использовать нельзя
    expect((await verify(s.challenge, key1.assert(opts.challenge))).statusCode).toBe(401);
  });

  it('forged answers are refused: bad signature, wrong origin, wrong site, stale counter, foreign key', async () => {
    const s = await start();
    const opts = (await optionsFor(s.challenge)).json();
    const cases = [
      key1.assert(opts.challenge, { badSignature: true }),
      key1.assert(opts.challenge, { origin: 'https://evil.example.net' }),
      key1.assert(opts.challenge, { rpId: 'evil.example.net' }),
      key1.assert(opts.challenge, { counter: 1 }), // не больше сохранённого
      key2.assert(opts.challenge), // ключ, не принадлежащий пользователю
    ];
    for (const c of cases) {
      const r = await verify(s.challenge, c);
      expect(r.statusCode).toBe(401);
    }
    // пять неудач уничтожили вызов, даже правильный ответ уже не принимается
    const after = await verify(s.challenge, key1.assert(opts.challenge, { counter: 99 }));
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('invalid_challenge');
  });

  it('API tokens cannot be created with a passkey alone (an authenticator app is needed)', async () => {
    const r = await user.req('POST', '/auth/tokens', {
      name: 't',
      scope: 'read',
      expiresInDays: 1,
      authKey: await authKeyOf(user),
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('totp_required_for_tokens');
  });

  it('removal needs the password; the last key cannot be removed under a mandatory policy unless TOTP exists', async () => {
    expect((await addKey(key2, 'Backup key')).statusCode).toBe(201);
    const noPw = await user.req('POST', `/auth/webauthn/${key2.id}/delete`, {
      authKey: toBase64Url(new Uint8Array(32)),
    });
    expect(noPw.statusCode).toBe(401);
    expect(
      (
        await user.req('POST', `/auth/webauthn/${key2.id}/delete`, {
          authKey: await authKeyOf(user),
        })
      ).statusCode,
    ).toBe(204);
    expect((await user.req('GET', '/auth/webauthn')).json().credentials).toHaveLength(1);
    // обязательная политика: последний ключ удалить нельзя
    const admin = user; // единственный пользователь — администратор
    expect(
      (await admin.req('PUT', '/admin/settings', { 'security.mfaRequired': 'all' })).statusCode,
    ).toBe(200);
    const last = await user.req('POST', `/auth/webauthn/${key1.id}/delete`, {
      authKey: await authKeyOf(user),
    });
    expect(last.statusCode).toBe(403);
    expect(last.json().error.code).toBe('mfa_required_by_policy');
    await admin.req('PUT', '/admin/settings', { 'security.mfaRequired': 'off' });
  });

  it('the policy accepts a security key as the second factor', async () => {
    await user.req('PUT', '/admin/settings', { 'security.mfaRequired': 'all' });
    expect((await user.req('GET', '/vaults')).statusCode).toBe(200);
    await user.req('PUT', '/admin/settings', { 'security.mfaRequired': 'off' });
  });
});
