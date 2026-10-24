import { afterAll, beforeAll, expect, it } from 'vitest';
import { settings } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let bob: TestClient;

beforeAll(async () => {
  fixture = await createTestApp({ LOGIN_MAX_ATTEMPTS: '3' });
  admin = new TestClient(fixture.app, 'lock-admin@example.com', 'lock-admin-password-1');
  await admin.register();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  bob = new TestClient(fixture.app, 'lock-bob@example.com', 'lock-bob-password-12');
  await bob.register();
  await admin.login();
});
afterAll(async () => fixture.app.close());

it('an administrator sees a temporary sign-in lockout and can lift it', async () => {
  for (let i = 0; i < 3; i++)
    expect((await bob.loginRaw('wrong-password-000')).statusCode).toBe(401);
  expect((await bob.loginRaw()).statusCode).toBe(429);
  const row = async () =>
    (
      (await admin.req('GET', '/admin/users')).json() as { email: string; lockedFor: number }[]
    ).find((u) => u.email === 'lock-bob@example.com')!;
  expect((await row()).lockedFor).toBeGreaterThan(0);
  expect((await bob.req('POST', `/admin/users/${bob.userId}/unlock`)).statusCode).toBe(401);
  expect((await admin.req('POST', `/admin/users/${bob.userId}/unlock`)).statusCode).toBe(204);
  expect((await row()).lockedFor).toBe(0);
  expect((await bob.loginRaw()).statusCode).toBe(200);
});
