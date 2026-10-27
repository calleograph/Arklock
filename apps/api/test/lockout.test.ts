import { afterAll, beforeAll, expect, it } from 'vitest';
import { settings } from '../src/db/schema.js';
import { cheapCaptcha, createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let bob: TestClient;

beforeAll(async () => {
  fixture = await createTestApp({ LOGIN_MAX_ATTEMPTS: '3' });
  await cheapCaptcha(fixture.app, fixture.database);
  admin = new TestClient(fixture.app, 'lock-admin@example.com', 'lock-admin-password-1');
  await admin.register();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  bob = new TestClient(fixture.app, 'lock-bob@example.com', 'lock-bob-password-12');
  await bob.register();
  await admin.login();
});
afterAll(async () => fixture.app.close());

it('an administrator sees a temporary sign-in lockout and can lift it', async () => {
  // пара «адрес + учётная запись» ограничивается после 10 ошибок; ошибок и решений проверки здесь накапливается много
  let last = 0;
  for (let i = 0; i < 40 && last !== 429; i++)
    last = (
      await bob.loginRaw('wrong-password-000', { headers: { 'x-forwarded-for': '198.51.100.77' } })
    ).statusCode;
  expect(last).toBe(429);
  expect(
    (await bob.loginRaw(undefined, { headers: { 'x-forwarded-for': '198.51.100.77' } })).statusCode,
  ).toBe(429);
  const row = async () =>
    (
      (await admin.req('GET', '/admin/users')).json() as { email: string; lockedFor: number }[]
    ).find((u) => u.email === 'lock-bob@example.com')!;
  expect((await row()).lockedFor).toBeGreaterThan(0);
  expect((await bob.req('POST', `/admin/users/${bob.userId}/unlock`)).statusCode).toBe(401);
  expect((await admin.req('POST', `/admin/users/${bob.userId}/unlock`)).statusCode).toBe(204);
  expect((await row()).lockedFor).toBe(0);
  expect(
    (await bob.loginRaw(undefined, { headers: { 'x-forwarded-for': '198.51.100.77' } })).statusCode,
  ).toBe(200);
});
