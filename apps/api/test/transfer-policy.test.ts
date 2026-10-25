import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toBase64Url } from '@arklock/crypto';
import { settings } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

/** Импорт и экспорт паролей разрешены только главному администратору: проверка на сервере, а не только в меню. */
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let chief: TestClient;
let admin2: TestClient;
let member: TestClient;

beforeAll(async () => {
  fixture = await createTestApp();
  chief = new TestClient(fixture.app, 'tp-chief@example.com', 'chief-password-1234');
  await chief.register();
  await chief.login();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  admin2 = new TestClient(fixture.app, 'tp-admin2@example.com', 'chief-password-1234');
  member = new TestClient(fixture.app, 'tp-member@example.com', 'chief-password-1234');
  for (const c of [admin2, member]) {
    await c.register();
    await c.login();
  }
  await chief.req('PATCH', `/admin/users/${admin2.userId}`, { role: 'admin' });
  await admin2.login();
});
afterAll(async () => fixture.app.close());

const events = [
  { action: 'export', phase: 'begin' },
  { action: 'export', format: 'csv', count: 3 },
  { action: 'import', phase: 'begin' },
  { action: 'import', count: 3 },
];

describe('import and export belong to the chief administrator', () => {
  it('the chief may start and finish both operations; the ledger records them', async () => {
    for (const e of events)
      expect((await chief.req('POST', '/audit/event', e)).statusCode, JSON.stringify(e)).toBe(204);
    const actions = (await chief.req('GET', '/admin/ledger?limit=50'))
      .json()
      .items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(
      expect.arrayContaining(['client.export.begin', 'client.export', 'client.import']),
    );
  });

  it('an ordinary member and a non-chief full administrator are refused', async () => {
    for (const who of [member, admin2])
      for (const e of events)
        expect((await who.req('POST', '/audit/event', e)).statusCode, `${who.email}`).toBe(403);
  });

  it('an unauthenticated request is refused', async () => {
    const res = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/audit/event',
      payload: events[0] as never,
    });
    expect(res.statusCode).toBe(401);
  });

  it("the chief's API token cannot start a transfer", async () => {
    const auth = await chief.derive();
    const made = await chief.req('POST', '/auth/tokens', {
      name: 'transfer-probe',
      scope: 'write',
      expiresInDays: 1,
      authKey: toBase64Url(auth.keys.authKey),
    });
    expect(made.statusCode).toBe(201);
    const res = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/audit/event',
      headers: { authorization: `Bearer ${made.json().token}` },
      payload: events[0] as never,
    });
    expect(res.statusCode).toBe(403);
  });

  it('there is no bulk export endpoint for non-chiefs among the other routes', async () => {
    for (const [m, u] of [
      ['GET', '/admin/export'],
      ['POST', '/admin/export'],
      ['GET', '/export'],
      ['POST', '/import'],
    ] as const)
      expect([401, 403, 404], `${m} ${u}`).toContain((await member.req(m, u)).statusCode);
  });
});
