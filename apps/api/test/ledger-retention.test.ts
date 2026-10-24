import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ledger } from '../src/db/schema.js';
import { runMaintenance } from '../src/maintenance.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;

beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'ret-admin@example.com', 'ret-admin-password-1');
  await admin.register();
  await admin.login();
});
afterAll(async () => fixture.app.close());

const DAY = 86_400_000;

it('the journal is kept forever by default; with a period old events go in batches and the removal is recorded', async () => {
  const db = fixture.database.db;
  const count = async () => (await db.select({ id: ledger.id }).from(ledger)).length;
  const later = new Date(Date.now() + 400 * DAY);
  const before = await count();
  expect((await runMaintenance(db, later)).journal).toBe(0);
  expect(await count()).toBe(before);
  // обслуживание «через 400 дней» удалило и истёкший сеанс администратора
  await admin.login();

  const put = (v: unknown) => admin.req('PUT', '/admin/settings', { 'ledger.retentionDays': v });
  expect((await put(10)).statusCode).toBe(400);
  expect((await put(30)).statusCode).toBe(200);

  // больше одной пачки старых событий и одно свежее относительно «сейчас» обслуживания
  const old = new Date(Date.now() - DAY);
  for (let i = 0; i < 5; i++)
    await db
      .insert(ledger)
      .values(
        Array.from({ length: 2010 }, () => ({ at: old, actor: 'system', action: 'test.old' })),
      );
  const now = new Date(Date.now() + 40 * DAY);
  await db
    .insert(ledger)
    .values({ at: new Date(now.getTime() - DAY), actor: 'system', action: 'test.recent' });
  const total = await count();

  const removed = (await runMaintenance(db, now)).journal;
  expect(removed).toBe(total - 1);
  const left = await db.select().from(ledger);
  expect(left.map((r) => r.action).sort()).toEqual(['ledger.pruned', 'test.recent']);
  const [pruned] = await db.select().from(ledger).where(eq(ledger.action, 'ledger.pruned'));
  expect(pruned!.detail).toMatchObject({ count: removed, days: 30 });
});
