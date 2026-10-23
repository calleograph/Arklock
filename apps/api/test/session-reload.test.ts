import { afterAll, beforeAll, expect, it } from 'vitest';
import { toBase64Url } from '@arklock/crypto';
import { sessions } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let user: TestClient;
beforeAll(async () => {
  fixture = await createTestApp();
  user = new TestClient(fixture.app, 'admin@example.com', 'admin-password-123');
  await user.register();
  await user.login();
});
afterAll(async () => fixture.app.close());

it('a session holds one reload share that only this session can read; locking erases it', async () => {
  expect((await user.req('GET', '/auth/session/reload-key')).statusCode).toBe(404);
  const made = (await user.req('PUT', '/auth/session/reload-key')).json();
  expect(made.share).toHaveLength(43);
  expect((await user.req('GET', '/auth/session/reload-key')).json().share).toBe(made.share);
  // в базе — только запечатанное значение
  const rows = await fixture.database.db.select().from(sessions);
  expect(JSON.stringify(rows)).not.toContain(made.share);
  // другой сеанс того же человека долю этого сеанса не видит
  const other = new TestClient(fixture.app, 'admin@example.com', 'admin-password-123');
  await other.login();
  expect((await other.req('GET', '/auth/session/reload-key')).statusCode).toBe(404);
  expect((await user.req('DELETE', '/auth/session/reload-key')).statusCode).toBe(204);
  expect((await user.req('GET', '/auth/session/reload-key')).statusCode).toBe(404);
});

it('API tokens cannot use it, the administrator can turn it off, and signing out ends it', async () => {
  const token = (
    await user.req('POST', '/auth/tokens', {
      name: 'ci',
      scope: 'write',
      expiresInDays: 1,
      authKey: toBase64Url((await user.derive()).keys.authKey),
    })
  ).json().token as string;
  const viaToken = await fixture.app.inject({
    method: 'PUT',
    url: '/api/v1/auth/session/reload-key',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(viaToken.statusCode).toBe(403);

  await user.req('PUT', '/admin/settings', { 'security.reloadUnlock': false });
  expect((await user.req('PUT', '/auth/session/reload-key')).statusCode).toBe(403);
  await user.req('PUT', '/admin/settings', { 'security.reloadUnlock': true });

  expect((await user.req('PUT', '/auth/session/reload-key')).statusCode).toBe(200);
  expect((await user.req('POST', '/auth/logout')).statusCode).toBe(204);
  expect((await user.req('GET', '/auth/session/reload-key')).statusCode).toBe(401);
  const rows = await fixture.database.db.select().from(sessions);
  expect(rows.every((r) => r.reloadShare === null || r.revokedAt === null)).toBe(true);
});
