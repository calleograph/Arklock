import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CryptoAuthError,
  decryptEntry,
  deriveMasterKeys,
  deriveRecoveryProof,
  encryptEntry,
  generateSalt,
  parseRecoveryCode,
  rewrapAccountPrivateKey,
  toBase64Url,
  unwrapPrivateKeyWithRecovery,
  wrapSignPrivateKey,
  wrapAccountPrivateKey,
  wrapPrivateKeyForRecovery,
  generateRecoveryKey,
  timingSafeEqual,
} from '@arklock/crypto';
import { entries, ledger, sessions, settings } from '../src/db/schema.js';
import { MIN_KDF } from '@arklock/crypto';
import { FAST, TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
const pw = 'correct horse battery staple';

beforeAll(async () => {
  ({ app, database } = await createTestApp({ LOGIN_MAX_ATTEMPTS: '4' }));
});
afterAll(async () => {
  await app.close();
});

const alice = () => new TestClient(app, 'alice@example.com', pw);
const bob = () => new TestClient(app, 'bob@example.com', 'bob-password-123');

describe('registration policy', () => {
  it('first account becomes admin; later registration is closed by default', async () => {
    const a = alice();
    expect((await a.register()).statusCode).toBe(201);
    const closed = await bob().register();
    expect(closed.statusCode).toBe(403);
    expect(closed.json().error.code).toBe('registration_closed');
    const body = (await a.login()).user;
    expect(body.role).toBe('admin');
  });

  it('admin can open registration; new accounts are members', async () => {
    await database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
    const b = bob();
    expect((await b.register()).statusCode).toBe(201);
    expect((await b.login()).user.role).toBe('member');
  });

  it('rejects duplicate e-mail', async () => {
    const dup = await new TestClient(app, 'alice@example.com', 'other-pass-123').register();
    expect(dup.statusCode).toBe(409);
  });

  it('rejects weak KDF parameters under production settings', async () => {
    const { app: prod } = await createTestApp({ NODE_ENV: 'production' });
    const res = await new TestClient(prod, 'weak@example.com', 'pw-12345678').register();
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('weak_kdf');
    await prod.close();
  });

  it('does not echo submitted values in validation errors', async () => {
    const marker = 'MARKER-should-not-appear-123';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'x@example.com', authKey: marker, wrappedPrivateKey: marker },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(marker);
  });
});

describe('first administrator bootstrap', () => {
  it('requires the one-time setup code in production', async () => {
    const token = 'setup-code-setup-code-setup-code-1';
    const { app: prod } = await createTestApp({ NODE_ENV: 'production', BOOTSTRAP_TOKEN: token });
    const st = (await prod.inject('/api/v1/auth/registration')).json();
    expect(st).toEqual({ open: true, firstUser: true, setupTokenRequired: true });
    const c = new TestClient(prod, 'root@example.com', 'root-password-12345');
    const wrong = await c.register('wrong-code', MIN_KDF);
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('invalid_setup_token');
    expect((await c.register(undefined, MIN_KDF)).statusCode).toBe(403);
    expect((await c.register(token, MIN_KDF)).statusCode).toBe(201);
    await prod.close();
  });

  it('refuses to create an administrator in production when no setup code is configured', async () => {
    const { app: prod } = await createTestApp({ NODE_ENV: 'production' });
    const c = new TestClient(prod, 'root2@example.com', 'root-password-12345');
    const res = await c.register('anything', MIN_KDF);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('setup_disabled');
    await prod.close();
  });

  it('accepts the correct code (relaxed KDF floor in test mode)', async () => {
    const token = 'setup-code-setup-code-setup-code-2';
    const { app: dev } = await createTestApp({ BOOTSTRAP_TOKEN: token });
    const c = new TestClient(dev, 'root3@example.com', 'root-password-12345');
    expect((await c.register('nope-nope-nope-nope-nope-1')).statusCode).toBe(403);
    expect((await c.register(token)).statusCode).toBe(201);
    await dev.close();
  });
});

describe('login, params and enumeration resistance', () => {
  it('returns correct params for known and plausible stable params for unknown e-mails', async () => {
    const known = (await app.inject('/api/v1/auth/params?email=alice@example.com')).json();
    const unknown1 = (await app.inject('/api/v1/auth/params?email=nobody@example.com')).json();
    const unknown2 = (await app.inject('/api/v1/auth/params?email=nobody@example.com')).json();
    expect(Object.keys(unknown1).sort()).toEqual(Object.keys(known).sort());
    expect(unknown1).toEqual(unknown2);
    expect(unknown1.userId).not.toBe(known.userId);
  });

  it('uses the same response for wrong password and unknown account', async () => {
    const wrong = await alice().loginRaw('totally wrong password');
    const ghost = await new TestClient(app, 'ghost@example.com', 'whatever-123').loginRaw();
    expect(wrong.statusCode).toBe(401);
    expect(ghost.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe(ghost.json().error.code);
    expect(wrong.json().error.message).toBe(ghost.json().error.message);
  });
});

describe('sessions', () => {
  it('requires a valid token', async () => {
    expect((await app.inject('/api/v1/vaults')).statusCode).toBe(401);
    const bad = await app.inject({
      url: '/api/v1/vaults',
      headers: { authorization: 'Bearer aks_' + 'x'.repeat(43) },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('stores only a hash of the token', async () => {
    const a = alice();
    await a.login();
    const all = await database.db.select().from(sessions);
    expect(all.length).toBeGreaterThan(0);
    expect(JSON.stringify(all)).not.toContain(a.token);
  });

  it('logout revokes the session; sessions can be listed and revoked individually', async () => {
    const a = alice();
    await a.login();
    const second = alice();
    await second.login();
    const list = await app.inject({ url: '/api/v1/auth/sessions', headers: a.authHeader() });
    expect(list.statusCode).toBe(200);
    const sessions = list.json() as { id: string; current: boolean }[];
    expect(sessions.some((s) => s.current)).toBe(true);
    const other = sessions.find((s) => !s.current)!;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${other.id}`,
      headers: a.authHeader(),
    });
    expect(del.statusCode).toBe(204);
    await a.login(); // новая сессия
    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: a.authHeader(),
    });
    expect(out.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/v1/vaults', headers: a.authHeader() })).statusCode).toBe(
      401,
    );
  });

  it('cannot revoke another user session', async () => {
    const a = alice();
    await a.login();
    const b = bob();
    await b.login();
    const aSessions = (
      await app.inject({ url: '/api/v1/auth/sessions', headers: a.authHeader() })
    ).json() as { id: string }[];
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${aSessions[0]!.id}`,
      headers: b.authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('expires idle sessions', async () => {
    const { app: short, database: db2 } = await createTestApp({ SESSION_IDLE_HOURS: '0.0000001' });
    const c = new TestClient(short, 'idle@example.com', 'idle-password-1');
    await c.register();
    await c.login();
    await new Promise((r) => setTimeout(r, 50));
    expect(
      (await short.inject({ url: '/api/v1/vaults', headers: c.authHeader() })).statusCode,
    ).toBe(401);
    void db2;
    await short.close();
  });
});

describe('brute force protection', () => {
  it('locks out after repeated failures, also for unknown accounts, and sets Retry-After', async () => {
    const victim = new TestClient(app, 'bob@example.com', 'bob-password-123');
    for (let i = 0; i < 4; i++) {
      expect((await victim.loginRaw('wrong-password-' + i)).statusCode).toBe(401);
    }
    const blocked = await victim.loginRaw();
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    const ghost = new TestClient(app, 'ghost2@example.com', 'x-password-123');
    for (let i = 0; i < 4; i++) await ghost.loginRaw('nope' + i);
    expect((await ghost.loginRaw()).statusCode).toBe(429);
  });
});

describe('end-to-end encryption and access control', () => {
  it('stores only ciphertext and returns it intact', async () => {
    const a = alice();
    await a.login();
    const secret = { title: 'Mail', password: 'Tr0ub4dor&3-UNIQUE-MARKER' };
    const { res, entryId, vaultId, key } = await a.createEntry(secret);
    expect(res.statusCode).toBe(201);
    expect(await a.readEntry(vaultId, entryId, key)).toEqual(secret);

    const rows = await database.db.select().from(entries);
    expect(JSON.stringify(rows)).not.toContain('UNIQUE-MARKER');
    const log = await database.db.select().from(ledger);
    expect(JSON.stringify(log)).not.toContain('UNIQUE-MARKER');
  });

  it('keeps other users out of a vault (404, not 403) and out of the vault list', async () => {
    const a = alice();
    await a.login();
    const b = bob();
    // Сброс ограничителя входа не нужен: используем уже выданный токен через новый вход после окна — берём прямой вход
    const created = await a.createEntry({ title: 'private' });
    const bLogin = await new TestClient(app, 'carol@example.com', 'carol-password-1');
    expect((await bLogin.register()).statusCode).toBe(201);
    await bLogin.login();
    const vaultsOfCarol = await bLogin.vaults();
    expect(vaultsOfCarol).toHaveLength(1);
    expect(vaultsOfCarol[0]!.id).not.toBe(created.vaultId);
    for (const [method, url, payload] of [
      ['GET', `/api/v1/vaults/${created.vaultId}/entries`, undefined],
      ['GET', `/api/v1/vaults/${created.vaultId}/entries/${created.entryId}`, undefined],
      [
        'DELETE',
        `/api/v1/vaults/${created.vaultId}/entries/${created.entryId}?expectedVersion=1`,
        undefined,
      ],
    ] as const) {
      const res = await app.inject({ method, url, headers: bLogin.authHeader(), payload });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    const post = await app.inject({
      method: 'POST',
      url: `/api/v1/vaults/${created.vaultId}/entries`,
      headers: bLogin.authHeader(),
      payload: {
        id: crypto.randomUUID(),
        wrappedEntryKey: 'ak1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA',
        ciphertext: 'ak1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA',
        keyVersion: 1,
      },
    });
    expect(post.statusCode).toBe(404);
    void b;
  });

  it('detects optimistic-lock conflicts and stale key versions', async () => {
    const a = alice();
    await a.login();
    const { entryId, vaultId, key } = await a.createEntry({ v: 1 });
    const update = async (payload: unknown, expectedVersion: number, keyVersion = 1) => {
      const enc = await encryptEntry(payload, key, vaultId, entryId, keyVersion);
      return app.inject({
        method: 'PUT',
        url: `/api/v1/vaults/${vaultId}/entries/${entryId}`,
        headers: a.authHeader(),
        payload: { ...enc, expectedVersion },
      });
    };
    expect((await update({ v: 2 }, 1)).statusCode).toBe(200);
    const conflict = await update({ v: 3 }, 1);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('version_conflict');
    expect(conflict.json().error.details.currentVersion).toBe(2);
    expect((await update({ v: 3 }, 2, 7)).json().error.code).toBe('stale_key_version');
    expect(await a.readEntry(vaultId, entryId, key)).toEqual({ v: 2 });
  });

  it('a record swapped on the server fails client-side authentication', async () => {
    const a = alice();
    await a.login();
    const one = await a.createEntry({ title: 'one' });
    const two = await a.createEntry({ title: 'two' });
    const recOne = (
      await app.inject({
        url: `/api/v1/vaults/${one.vaultId}/entries/${one.entryId}`,
        headers: a.authHeader(),
      })
    ).json();
    await expect(decryptEntry(recOne, two.key, two.vaultId, two.entryId)).rejects.toBeInstanceOf(
      CryptoAuthError,
    );
  });

  it('soft-deleted entries disappear from reads', async () => {
    const a = alice();
    await a.login();
    const { entryId, vaultId } = await a.createEntry({ title: 'tmp' });
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vaultId}/entries/${entryId}?expectedVersion=1`,
      headers: a.authHeader(),
    });
    expect(del.statusCode).toBe(204);
    const get = await app.inject({
      url: `/api/v1/vaults/${vaultId}/entries/${entryId}`,
      headers: a.authHeader(),
    });
    // запись в корзине: из дерева исчезла, прямое чтение показывает отметку удаления
    expect(get.json().deletedAt).not.toBeNull();
    const tree = (await a.req('GET', `/vaults/${vaultId}/tree`)).json();
    expect(tree.entries.some((e: { id: string }) => e.id === entryId)).toBe(false);
  });
});

describe('password change and account recovery', () => {
  it('changes the password without changing the account private key and revokes other sessions', async () => {
    const c = new TestClient(app, 'dave@example.com', 'dave-old-password');
    expect((await c.register()).statusCode).toBe(201);
    await c.login();
    const other = new TestClient(app, 'dave@example.com', 'dave-old-password');
    await other.login();
    const oldPrivate = c.privateKey;

    const { keys: oldKeys, params } = await c.derive();
    const salt = generateSalt();
    const newKeys = await deriveMasterKeys('dave-new-password', salt, params.userId, FAST, FAST);
    const me = (await app.inject({ url: '/api/v1/auth/me', headers: c.authHeader() })).json();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: c.authHeader(),
      payload: {
        currentAuthKey: toBase64Url(oldKeys.authKey),
        kdf: FAST,
        salt: toBase64Url(salt),
        newAuthKey: toBase64Url(newKeys.authKey),
        wrappedPrivateKey: await rewrapAccountPrivateKey(
          oldKeys.wrapKey,
          newKeys.wrapKey,
          me.user.wrappedPrivateKey,
          params.userId,
        ),
        wrappedSignPrivateKey: await wrapSignPrivateKey(
          newKeys.wrapKey,
          c.signPrivateKey,
          params.userId,
        ),
      },
    });
    expect(res.statusCode).toBe(204);
    expect(
      (await app.inject({ url: '/api/v1/vaults', headers: other.authHeader() })).statusCode,
    ).toBe(401);
    expect((await app.inject({ url: '/api/v1/vaults', headers: c.authHeader() })).statusCode).toBe(
      200,
    );
    expect((await c.loginRaw('dave-old-password')).statusCode).toBe(401);
    const again = new TestClient(app, 'dave@example.com', 'dave-new-password');
    await again.login();
    expect(timingSafeEqual(again.privateKey, oldPrivate)).toBe(true);
  });

  it('rejects password change with a wrong current password', async () => {
    const c = new TestClient(app, 'erin@example.com', 'erin-password-12');
    await c.register();
    await c.login();
    const { params } = await c.derive();
    const wrong = await deriveMasterKeys(
      'not-erin',
      fromSalt(params.salt),
      params.userId,
      FAST,
      FAST,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: c.authHeader(),
      payload: {
        currentAuthKey: toBase64Url(wrong.authKey),
        kdf: FAST,
        salt: params.salt,
        newAuthKey: toBase64Url(wrong.authKey),
        wrappedPrivateKey: (
          await app.inject({ url: '/api/v1/auth/me', headers: c.authHeader() })
        ).json().user.wrappedPrivateKey,
        wrappedSignPrivateKey: (
          await app.inject({ url: '/api/v1/auth/me', headers: c.authHeader() })
        ).json().user.wrappedSignPrivateKey,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('recovers access with the recovery code, then retires the old code and all sessions', async () => {
    const c = new TestClient(app, 'frank@example.com', 'frank-lost-password');
    await c.register();
    await c.login();
    const oldRecovery = c.recoveryCode;
    const oldPrivate = c.privateKey;

    const start = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/recovery/start',
        payload: { email: c.email },
      })
    ).json();
    const rk = await parseRecoveryCode(oldRecovery);
    const priv = await unwrapPrivateKeyWithRecovery(
      rk,
      start.recoveryWrappedPrivateKey,
      start.userId,
    );
    expect(timingSafeEqual(priv, oldPrivate)).toBe(true);
    const signPriv = await unwrapPrivateKeyWithRecovery(
      rk,
      start.recoveryWrappedSignPrivateKey,
      start.userId,
    );

    const salt = generateSalt();
    const keys = await deriveMasterKeys('frank-brand-new-pass', salt, start.userId, FAST, FAST);
    const newRecovery = await generateRecoveryKey();
    const wrapped = await wrapAccountPrivateKey(keys.wrapKey, priv, start.userId);
    const wrappedSign = await wrapSignPrivateKey(keys.wrapKey, signPriv, start.userId);
    const send = async (proof: Uint8Array) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/recovery/complete',
        payload: {
          email: c.email,
          recoveryProof: toBase64Url(proof),
          kdf: FAST,
          salt: toBase64Url(salt),
          newAuthKey: toBase64Url(keys.authKey),
          wrappedPrivateKey: wrapped,
          wrappedSignPrivateKey: wrappedSign,
          newRecoveryProof: toBase64Url(await deriveRecoveryProof(newRecovery.key, start.userId)),
          newRecoveryWrappedPrivateKey: await wrapPrivateKeyForRecovery(
            newRecovery.key,
            priv,
            start.userId,
          ),
          newRecoveryWrappedSignPrivateKey: await wrapPrivateKeyForRecovery(
            newRecovery.key,
            signPriv,
            start.userId,
          ),
        },
      });

    expect((await send(new Uint8Array(32).fill(7))).statusCode).toBe(401);
    expect((await send(await deriveRecoveryProof(rk, start.userId))).statusCode).toBe(204);

    expect((await app.inject({ url: '/api/v1/vaults', headers: c.authHeader() })).statusCode).toBe(
      401,
    );
    expect((await c.loginRaw('frank-lost-password')).statusCode).toBe(401);
    const back = new TestClient(app, 'frank@example.com', 'frank-brand-new-pass');
    await back.login();
    expect(timingSafeEqual(back.privateKey, oldPrivate)).toBe(true);
    // старый код восстановления больше не действует
    expect((await send(await deriveRecoveryProof(rk, start.userId))).statusCode).toBe(401);
  });

  it('recovery start looks the same for unknown accounts', async () => {
    const known = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/recovery/start',
        payload: { email: 'frank@example.com' },
      })
    ).json();
    const unknown = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/recovery/start',
        payload: { email: 'nobody@example.com' },
      })
    ).json();
    expect(Object.keys(unknown).sort()).toEqual(Object.keys(known).sort());
    expect(unknown.recoveryWrappedPrivateKey.length).toBe(known.recoveryWrappedPrivateKey.length);
  });
});

function fromSalt(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, 'base64url'));
}
