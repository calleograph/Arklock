import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseTotpInput, toBase64Url, totp } from '@arklock/crypto';
import { eq } from 'drizzle-orm';
import { mfaFactors, settings, users } from '../src/db/schema.js';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let admin: TestClient;
let bob: TestClient;
let secret = '';
let backup: string[] = [];
let adminSecret = '';

/** Код для шага времени со сдвигом: подтверждение берёт предыдущий шаг, вход — текущий (один шаг нельзя использовать дважды). */
const code = async (s = secret, stepOffset = 0) =>
  totp(parseTotpInput(s), Date.now() + stepOffset * 30_000);
const authKeyOf = async (c: TestClient) => toBase64Url((await c.derive()).keys.authKey);

/** Вход с проверкой пароля, но без второго фактора: возвращает ответ как есть. */
const rawLogin = async (c: TestClient) => (await c.loginRaw()).json();

beforeAll(async () => {
  ({ app, database } = await createTestApp());
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  expect((await admin.register()).statusCode).toBe(201);
  await database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  bob = new TestClient(app, 'bob@example.com', 'bob-password-12345');
  expect((await bob.register()).statusCode).toBe(201);
  await admin.login();
  await bob.login();
});

afterAll(async () => {
  await app.close();
});

describe('two-factor authentication', () => {
  it('enrolment: the factor does not apply until a valid code is confirmed', async () => {
    const setup = await bob.req('POST', '/auth/mfa/setup');
    expect(setup.statusCode).toBe(200);
    secret = setup.json().secret;
    expect(setup.json().uri).toContain('otpauth://totp/');
    // секрет не лежит в базе открытым текстом
    const [row] = await database.db.select().from(mfaFactors);
    expect(row!.secretCipher).not.toContain(secret);
    expect(row!.enabledAt).toBeNull();
    // пока не подтверждено — вход обычный
    expect((await rawLogin(bob)).token).toBeTruthy();
    const wrong = await bob.req('POST', '/auth/mfa/enable', { code: '000000' });
    expect(wrong.statusCode).toBe(401);
    const ok = await bob.req('POST', '/auth/mfa/enable', { code: await code(secret, -1) });
    expect(ok.statusCode).toBe(200);
    backup = ok.json().backupCodes;
    expect(backup).toHaveLength(10);
    expect(new Set(backup).size).toBe(10);
    expect((await bob.req('GET', '/auth/mfa')).json()).toMatchObject({
      enabled: true,
      backupCodesRemaining: 10,
    });
    // повторная настройка при включённом факторе отклоняется
    expect((await bob.req('POST', '/auth/mfa/setup')).statusCode).toBe(409);
  });

  it('login with the password alone yields no session and no key material', async () => {
    const res = await rawLogin(bob);
    expect(res.mfaRequired).toBe(true);
    expect(res.challenge).toMatch(/^mc_/);
    expect(res.token).toBeUndefined();
    expect(res.user).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('wrapped');
  });

  it('the app code completes the sign-in once; the same code cannot be replayed', async () => {
    const first = await rawLogin(bob);
    const c = await code(secret, 0);
    const done = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: first.challenge, code: c },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().token).toBeTruthy();
    expect(done.json().user.wrappedPrivateKey).toBeTruthy();
    // тот же код в новом входе
    const second = await rawLogin(bob);
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: second.challenge, code: c },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('invalid_code');
    // тот же вызов без вызова-челленджа
    const bogus = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: 'mc_unknown-challenge-value', code: c },
    });
    expect(bogus.statusCode).toBe(401);
    expect(bogus.json().error.code).toBe('invalid_challenge');
  });

  it('a backup code works exactly once', async () => {
    const verify = async (value: string) => {
      const ch = await rawLogin(bob);
      return app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/verify',
        payload: { challenge: ch.challenge, code: value },
      });
    };
    expect((await verify(backup[0]!)).statusCode).toBe(200);
    expect((await verify(backup[0]!)).statusCode).toBe(401);
    // регистр и разделитель не имеют значения
    expect((await verify(backup[1]!.toUpperCase().replace('-', ' '))).statusCode).toBe(200);
    await bob.login().catch(() => undefined);
  });

  it('five wrong codes destroy the challenge', async () => {
    const ch = await rawLogin(bob);
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/verify',
        payload: { challenge: ch.challenge, code: '111111' },
      });
      expect(r.statusCode).toBe(401);
    }
    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: ch.challenge, code: await code() },
    });
    expect(after.json().error.code).toBe('invalid_challenge');
  });

  it('disabling needs the master password; regenerating backup codes invalidates the old ones', async () => {
    // получаем сессию через резервный код
    const ch = await rawLogin(bob);
    const sess = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/verify',
        payload: { challenge: ch.challenge, code: backup[2]! },
      })
    ).json();
    bob.token = sess.token;

    const badPw = await bob.req('POST', '/auth/mfa/backup-codes', {
      authKey: toBase64Url(new Uint8Array(32)),
      code: backup[3]!,
    });
    expect(badPw.statusCode).toBe(401);
    const fresh = await bob.req('POST', '/auth/mfa/backup-codes', {
      authKey: await authKeyOf(bob),
      code: backup[3]!,
    });
    expect(fresh.statusCode).toBe(200);
    const next = fresh.json().backupCodes as string[];
    expect(next).toHaveLength(10);
    const ch2 = await rawLogin(bob);
    const oldCode = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: ch2.challenge, code: backup[4]! },
    });
    expect(oldCode.statusCode).toBe(401);

    const noPw = await bob.req('POST', '/auth/mfa/disable', {
      authKey: toBase64Url(new Uint8Array(32)),
      code: next[0]!,
    });
    expect(noPw.statusCode).toBe(401);
    const off = await bob.req('POST', '/auth/mfa/disable', {
      authKey: await authKeyOf(bob),
      code: next[0]!,
    });
    expect(off.statusCode).toBe(204);
    expect((await rawLogin(bob)).token).toBeTruthy();
    expect((await database.db.select().from(mfaFactors)).length).toBe(0);
  });

  it('policy: users without the factor are restricted to enrolment until they set it up', async () => {
    // администратор не может потребовать MFA, не настроив его сам
    const refused = await admin.req('PUT', '/admin/settings', { 'security.mfaRequired': 'all' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('mfa_admin_not_enrolled');
    const adminSetup = (await admin.req('POST', '/auth/mfa/setup')).json();
    adminSecret = adminSetup.secret;
    expect(
      (await admin.req('POST', '/auth/mfa/enable', { code: await code(adminSecret) })).statusCode,
    ).toBe(200);
    expect(
      (await admin.req('PUT', '/admin/settings', { 'security.mfaRequired': 'all' })).statusCode,
    ).toBe(200);
    // зарегистрированный раньше пользователь без MFA получает отказ везде, кроме настройки
    const blocked = await bob.req('GET', '/vaults');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('mfa_enrollment_required');
    expect((await bob.req('GET', '/auth/mfa')).json()).toMatchObject({
      enabled: false,
      required: true,
    });
    const setup = (await bob.req('POST', '/auth/mfa/setup')).json();
    expect((await bob.req('GET', '/vaults')).statusCode).toBe(403);
    expect(
      (await bob.req('POST', '/auth/mfa/enable', { code: await code(setup.secret) })).statusCode,
    ).toBe(200);
    expect((await bob.req('GET', '/vaults')).statusCode).toBe(200);
    // отключить нельзя, пока политика требует
    const off = await bob.req('POST', '/auth/mfa/disable', {
      authKey: await authKeyOf(bob),
      code: await code(setup.secret),
    });
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe('mfa_required_by_policy');
  });

  it('an administrator can reset a lost factor; others cannot', async () => {
    expect((await bob.req('POST', `/admin/users/${admin.userId}/mfa-reset`)).statusCode).toBe(403);
    expect((await admin.req('POST', `/admin/users/${bob.userId}/mfa-reset`)).statusCode).toBe(204);
    const left = await database.db.select().from(mfaFactors);
    expect(left.map((r) => r.userId)).toEqual([admin.userId]);
    // политика по-прежнему обязывает настроить заново
    expect((await bob.req('GET', '/vaults')).statusCode).toBe(403);
    expect(
      (await admin.req('PUT', '/admin/settings', { 'security.mfaRequired': 'off' })).statusCode,
    ).toBe(200);
    expect((await bob.req('GET', '/vaults')).statusCode).toBe(200);
  });

  it('the "admins" policy applies to administrators only', async () => {
    expect(
      (await admin.req('PUT', '/admin/settings', { 'security.mfaRequired': 'admins' })).statusCode,
    ).toBe(200);
    expect((await admin.req('GET', '/vaults')).statusCode).toBe(200);
    expect((await bob.req('GET', '/vaults')).statusCode).toBe(200);
    // новый администратор без MFA ограничен настройкой
    await database.db.update(users).set({ role: 'admin' }).where(eq(users.id, bob.userId));
    expect((await bob.req('GET', '/vaults')).statusCode).toBe(403);
    await database.db.update(users).set({ role: 'member' }).where(eq(users.id, bob.userId));
    expect((await bob.req('GET', '/vaults')).statusCode).toBe(200);
    expect(
      (await admin.req('PUT', '/admin/settings', { 'security.mfaRequired': 'off' })).statusCode,
    ).toBe(200);
  });
});
