import { afterAll, beforeAll, expect, it } from 'vitest';
import { settings } from '../src/db/schema.js';
import { DEFAULT_SPACE_ID } from '../src/spaces.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let finHead: TestClient;
let devHead: TestClient;
let developer: TestClient;

beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'dept-admin@example.com', 'dept-password-1234');
  await admin.register();
  await admin.login();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  finHead = new TestClient(fixture.app, 'dept-fin@example.com', 'dept-password-1234');
  devHead = new TestClient(fixture.app, 'dept-devhead@example.com', 'dept-password-1234');
  developer = new TestClient(fixture.app, 'dept-dev@example.com', 'dept-password-1234');
  for (const c of [finHead, devHead, developer]) {
    await c.register();
    await c.login();
  }
});
afterAll(async () => fixture.app.close());

it('an employee of one department learns nothing about another department', async () => {
  const space = async (name: string) =>
    (await admin.req('POST', '/spaces', { name, description: `${name} department` })).json()
      .id as string;
  const finance = await space('Finance-Treasury');
  const dev = await space('Development');
  // руководители подразделений — администраторы своих пространств, сотрудник — участник
  for (const [s, c, role] of [
    [finance, finHead, 'admin'],
    [dev, devHead, 'admin'],
    [dev, developer, 'member'],
  ] as const)
    expect((await admin.req('PUT', `/spaces/${s}/users/${c.userId}`, { role })).statusCode).toBe(
      204,
    );

  const made = await admin.createSharedVault('Treasury-Bank-Keys');
  const vaultId = made.id;
  expect(
    (
      await admin.req('PUT', `/spaces/${DEFAULT_SPACE_ID}/vaults/${vaultId}`, {
        targetSpaceId: finance,
      })
    ).statusCode,
  ).toBe(200);
  expect((await admin.addMember(vaultId, finHead, 'editor', made.key)).statusCode).toBe(204);
  const { entryId } = await admin.createEntry({ title: 'swift' }, { vaultId, vaultKey: made.key });
  const branch = await admin.createBranch(vaultId, made.key, 'Payments');

  // руководитель финансов видит своё подразделение и сейф в нём
  expect((await finHead.req('GET', '/spaces')).json().map((s: { id: string }) => s.id)).toContain(
    finance,
  );
  expect((await finHead.vaults()).map((v) => v.id)).toContain(vaultId);

  const secretWords = [finance, vaultId, entryId, branch.id, 'Finance-Treasury', 'Treasury-Bank'];
  const urls = [
    '/spaces',
    '/spaces?manage=1',
    `/spaces/${finance}`,
    '/vaults',
    `/vaults/${vaultId}/tree`,
    `/vaults/${vaultId}/members`,
    `/vaults/${vaultId}/grants`,
    `/vaults/${vaultId}/signals`,
    `/vaults/${vaultId}/pending-keys`,
    `/vaults/${vaultId}/attachments`,
    `/vaults/${vaultId}/recovery`,
    `/vaults/${vaultId}/entries/${entryId}`,
    `/vaults/${vaultId}/entries/${entryId}/revisions`,
    `/vaults/${vaultId}/entries/${entryId}/journal`,
    `/vaults/${vaultId}/entries/${entryId}/access`,
    `/vaults/${vaultId}/branches/${branch.id}/journal`,
    `/vaults/${vaultId}/branches/${branch.id}/access`,
    '/key-log',
    '/notifications',
    '/handoffs',
  ];
  // и сотрудник, и руководитель другого подразделения: ни по списку, ни по прямой ссылке
  for (const outsider of [developer, devHead])
    for (const url of urls) {
      const res = await outsider.req('GET', url);
      if (res.statusCode !== 200) {
        expect([403, 404], `${url}: ${res.statusCode}`).toContain(res.statusCode);
        continue;
      }
      for (const word of secretWords)
        expect(res.body, `${url} reveals ${word}`).not.toContain(word);
    }

  // руководитель разработки не может забрать чужой сейф к себе и не управляет чужим пространством
  expect(
    (await devHead.req('PUT', `/spaces/${finance}/vaults/${vaultId}`, { targetSpaceId: dev }))
      .statusCode,
  ).toBe(403);
  expect(
    (await devHead.req('PUT', `/spaces/${finance}/users/${developer.userId}`, { role: 'member' }))
      .statusCode,
  ).toBe(403);
  expect((await devHead.req('PATCH', `/spaces/${finance}`, { archived: true })).statusCode).toBe(
    403,
  );
});
