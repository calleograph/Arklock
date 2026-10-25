import os from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sampleMetrics } from '../src/metrics.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;

beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'metrics-admin@example.com', 'metrics-password-1234');
  await admin.register();
  await admin.login();
});
afterAll(async () => fixture.app.close());

it('keeps a light history of server resources, newest points only for two weeks, thinned for charts', async () => {
  const db = fixture.database.db;
  const now = new Date();
  // 15 дней назад (будет удалено) и 300 точек за последние 25 часов
  await sampleMetrics(db, [os.tmpdir()], new Date(now.getTime() - 15 * 86_400_000));
  for (let i = 0; i < 300; i++)
    await sampleMetrics(db, [os.tmpdir()], new Date(now.getTime() - (300 - i) * 5 * 60_000));
  const day = (await admin.req('GET', '/admin/resources/history?hours=24')).json();
  expect(day.hours).toBe(24);
  expect(day.points.length).toBeGreaterThan(100);
  expect(day.points.length).toBeLessThanOrEqual(240);
  expect(day.points[0]).toMatchObject({ cpu: expect.any(Number), mem: expect.any(Number) });
  const all = (await admin.req('GET', '/admin/resources/history?hours=336')).json();
  // точка старше срока хранения удалена при следующей записи
  expect(Date.parse(all.points[0].at)).toBeGreaterThan(now.getTime() - 14 * 86_400_000);
  expect((await admin.req('GET', '/admin/resources/history?hours=0')).statusCode).toBe(400);
});
