import { afterAll, beforeAll, expect, it } from 'vitest';
import { settings } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';
let app: Awaited<ReturnType<typeof createTestApp>>['app'];
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let member: TestClient;
let groupId: string;
beforeAll(async () => {
  fixture = await createTestApp();
  ({ app } = fixture);
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  await admin.register();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  member = new TestClient(app, 'member@example.com', 'member-password-123');
  await member.register();
  await admin.login();
  await member.login();
  const created = await admin.req('POST', '/admin/circles', { name: 'Operations' });
  expect(created.statusCode).toBe(201);
  groupId = created.json().id;
});
afterAll(async () => app.close());

it('requires administration rights, validates the whole batch and reports actual changes', async () => {
  const url = `/admin/circles/${groupId}/members`;
  expect((await member.req('PATCH', url, { add: [member.userId] })).statusCode).toBe(403);
  expect(
    (await admin.req('PATCH', url, { add: [member.userId, crypto.randomUUID()] })).statusCode,
  ).toBe(404);
  expect((await admin.req('GET', url)).json()).toEqual([]);
  expect(
    (await admin.req('PATCH', url, { add: [member.userId, member.userId, admin.userId] })).json(),
  ).toEqual({ added: 2, removed: 0 });
  expect((await admin.req('PATCH', url, { add: [member.userId] })).json()).toEqual({
    added: 0,
    removed: 0,
  });
  expect(
    (await admin.req('PATCH', url, { add: [member.userId], remove: [member.userId] })).statusCode,
  ).toBe(400);
  expect((await admin.req('PATCH', url, { remove: [member.userId, admin.userId] })).json()).toEqual(
    { added: 0, removed: 2 },
  );
});

it('shows assigned vault permissions without giving a group administrator vault keys', async () => {
  const vault = await admin.createSharedVault('Operations vault');
  expect(
    (await admin.req('PUT', `/vaults/${vault.id}/circles/${groupId}`, { role: 'reader' }))
      .statusCode,
  ).toBe(204);
  const assigned = await admin.req('GET', `/admin/circles/${groupId}/vaults`);
  expect(assigned.statusCode).toBe(200);
  expect(assigned.json()).toMatchObject([
    { id: vault.id, name: 'Operations vault', role: 'reader' },
  ]);
  expect(JSON.stringify(assigned.json())).not.toContain('sealedKey');
  expect((await member.req('GET', `/admin/circles/${groupId}/vaults`)).statusCode).toBe(403);
});
