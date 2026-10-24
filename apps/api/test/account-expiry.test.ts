import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ledger, settings, users } from '../src/db/schema.js';
import { runMaintenance } from '../src/maintenance.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let bob: TestClient;
let carol: TestClient;

beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'exp-admin@example.com', 'exp-admin-password-1');
  await admin.register();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  bob = new TestClient(fixture.app, 'exp-bob@example.com', 'exp-bob-password-12');
  carol = new TestClient(fixture.app, 'exp-carol@example.com', 'exp-carol-password-1');
  await bob.register();
  await carol.register();
  await admin.login();
  await bob.login();
});
afterAll(async () => fixture.app.close());

const HOUR = 3_600_000;
const patch = (id: string, body: object) => admin.req('PATCH', `/admin/users/${id}`, body);
const expireNowInDb = (id: string) =>
  fixture.database.db
    .update(users)
    .set({ accessUntil: new Date(Date.now() - 1000) })
    .where(eq(users.id, id));
const row = async (id: string) =>
  (await fixture.database.db.select().from(users).where(eq(users.id, id)))[0]!;

it('an access end date is set for members only, in the future', async () => {
  const future = new Date(Date.now() + 24 * HOUR).toISOString();
  expect(
    (await patch(bob.userId, { accessUntil: new Date(Date.now() - HOUR).toISOString() }))
      .statusCode,
  ).toBe(400);
  expect((await patch(admin.userId, { accessUntil: future })).statusCode).toBe(409);
  expect((await patch(bob.userId, { accessUntil: future })).statusCode).toBe(200);
  const listed = (await admin.req('GET', '/admin/users')).json() as {
    id: string;
    accessUntil: string | null;
  }[];
  expect(listed.find((u) => u.id === bob.userId)!.accessUntil).toBe(future);
  // повышение до администратора при заданном сроке — отказ
  expect((await patch(bob.userId, { role: 'admin' })).statusCode).toBe(409);
});

it('after the date the open session stops, the account is disabled with the reason, sign-in is refused', async () => {
  expect((await bob.req('GET', '/auth/me')).statusCode).toBe(200);
  await expireNowInDb(bob.userId);
  expect((await bob.req('GET', '/auth/me')).statusCode).toBe(401);
  const b = await row(bob.userId);
  expect(b.disabledAt).not.toBeNull();
  expect(b.disabledReason).toBe('expired');
  expect((await bob.loginRaw()).statusCode).toBe(401);
  const events = await fixture.database.db
    .select()
    .from(ledger)
    .where(eq(ledger.action, 'admin.user.expired'));
  expect(events.map((e) => e.target)).toContain(`user:${bob.userId}`);
});

it('an expired account that made no request since is refused at sign-in too', async () => {
  await patch(carol.userId, { accessUntil: new Date(Date.now() + HOUR).toISOString() });
  await expireNowInDb(carol.userId);
  expect((await carol.loginRaw()).statusCode).toBe(401);
  expect((await row(carol.userId)).disabledReason).toBe('expired');
});

it('maintenance disables expired accounts; enabling clears the past date', async () => {
  const dave = new TestClient(fixture.app, 'exp-dave@example.com', 'exp-dave-password-12');
  await dave.register();
  await patch(dave.userId, { accessUntil: new Date(Date.now() + HOUR).toISOString() });
  expect((await runMaintenance(fixture.database.db, new Date(Date.now() + 2 * HOUR))).expired).toBe(
    1,
  );
  expect((await row(dave.userId)).disabledReason).toBe('expired');
  expect((await patch(bob.userId, { disabled: false })).statusCode).toBe(200);
  const b = await row(bob.userId);
  expect(b.disabledAt).toBeNull();
  expect(b.accessUntil).toBeNull();
  expect((await bob.loginRaw()).statusCode).toBe(200);
});
