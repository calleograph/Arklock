import { afterAll, beforeAll, expect, it } from 'vitest';
import { settings } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
const crew: TestClient[] = [];

beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'ps-admin@example.com', 'ps-password-1234');
  await admin.register();
  await admin.login();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  for (let i = 1; i <= 9; i++) {
    const c = new TestClient(fixture.app, `ps-user${i}@example.com`, 'ps-password-1234');
    await c.register();
    crew.push(c);
  }
});
afterAll(async () => fixture.app.close());

it('searches people on the server, a page at a time', async () => {
  const page = (await admin.req('GET', '/admin/people?q=ps-user&limit=4&offset=0')).json();
  expect(page.total).toBe(9);
  expect(page.items).toHaveLength(4);
  const rest = (await admin.req('GET', '/admin/people?q=ps-user&limit=4&offset=8')).json();
  expect(rest.items).toHaveLength(1);
  // подстановочные знаки LIKE ищутся как обычные символы
  expect((await admin.req('GET', '/admin/people?q=%25')).json().total).toBe(0);
  expect((await admin.req('GET', '/admin/people?q=ps-user3')).json().items[0].email).toBe(
    'ps-user3@example.com',
  );
});

it('keeps the plain list for old callers and pages it on request', async () => {
  expect((await admin.req('GET', '/admin/users')).json()).toHaveLength(10);
  const p = (await admin.req('GET', '/admin/users?limit=3&offset=3&sort=name&dir=desc')).json();
  expect(p.total).toBe(10);
  expect(p.items).toHaveLength(3);
  const c = (await admin.req('GET', '/admin/circles?limit=2&q=zzz')).json();
  expect(c).toEqual({ items: [], total: 0 });
});

it('does not give people search to an employee', async () => {
  await crew[0]!.login();
  expect((await crew[0]!.req('GET', '/admin/people?q=ps')).statusCode).toBe(403);
});
