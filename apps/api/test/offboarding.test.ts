import { afterAll, beforeAll, expect, it } from 'vitest';
import { settings } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

let app: Awaited<ReturnType<typeof createTestApp>>['app'];
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let leaver: TestClient;
let heir: TestClient;
let nokey: TestClient;
let vaultId: string;
beforeAll(async () => {
  fixture = await createTestApp();
  ({ app } = fixture);
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  await admin.register();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  leaver = new TestClient(app, 'leaver@example.com', 'leaver-password-123');
  heir = new TestClient(app, 'heir@example.com', 'heir-password-12345');
  nokey = new TestClient(app, 'nokey@example.com', 'nokey-password-123');
  for (const c of [leaver, heir, nokey]) await c.register();
  for (const c of [admin, leaver, heir, nokey]) await c.login();
  const created = await admin.createSharedVault('Finance');
  vaultId = created.id;
  expect((await admin.addMember(vaultId, leaver, 'admin', created.key)).statusCode).toBe(204);
  expect((await admin.addMember(vaultId, heir, 'editor', created.key)).statusCode).toBe(204);
  expect((await admin.addMember(vaultId, nokey, 'editor')).statusCode).toBe(204);
  expect(
    (await admin.req('POST', `/vaults/${vaultId}/transfer-ownership`, { userId: leaver.userId }))
      .statusCode,
  ).toBe(200);
});
afterAll(async () => app.close());

it('offboarding is for administrators only and previews the holdings without content', async () => {
  expect((await heir.req('GET', `/admin/users/${leaver.userId}/offboarding`)).statusCode).toBe(403);
  expect((await heir.req('POST', `/admin/users/${leaver.userId}/offboard`, {})).statusCode).toBe(
    403,
  );
  const p = (await admin.req('GET', `/admin/users/${leaver.userId}/offboarding`)).json();
  expect(p.vaults).toEqual([
    expect.objectContaining({ id: vaultId, role: 'owner', lastOwner: true, otherOwners: 0 }),
  ]);
  expect(JSON.stringify(p)).not.toContain('sealedKey');
});

it('the user card shows groups, live sessions and vaults in one answer, for administrators only', async () => {
  expect((await heir.req('GET', `/admin/users/${leaver.userId}/profile`)).statusCode).toBe(403);
  const g = (await admin.req('POST', '/admin/circles', { name: 'Бухгалтерия' })).json()
    .id as string;
  await admin.req('PUT', `/admin/circles/${g}/members/${leaver.userId}`);
  const p = (await admin.req('GET', `/admin/users/${leaver.userId}/profile`)).json();
  expect(p.user).toMatchObject({ email: 'leaver@example.com', role: 'member', disabled: false });
  expect(p.groups).toEqual([expect.objectContaining({ id: g, name: 'Бухгалтерия' })]);
  expect(p.sessionList.length).toBeGreaterThan(0);
  expect(p.vaults[0]).toMatchObject({ id: vaultId, role: 'owner' });
  expect(JSON.stringify(p)).not.toMatch(/sealedKey|tokenHash|authHash/);
});

it('refuses to leave a vault without an owner and to hand it to someone without the key', async () => {
  const r = await admin.req('POST', `/admin/users/${leaver.userId}/offboard`, {});
  expect(r.statusCode).toBe(409);
  expect(r.json().error.code).toBe('last_owner');
  const bad = await admin.req('POST', `/admin/users/${leaver.userId}/offboard`, {
    transfers: [{ vaultId, toUserId: nokey.userId }],
  });
  expect(bad.statusCode).toBe(409);
  expect(bad.json().error.code).toBe('key_missing');
  expect((await leaver.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(200);
  expect((await admin.req('POST', `/admin/users/${admin.userId}/offboard`, {})).statusCode).toBe(
    409,
  );
});

it('transfers ownership, blocks the account, ends sessions and lists vaults to rotate', async () => {
  const r = await admin.req('POST', `/admin/users/${leaver.userId}/offboard`, {
    transfers: [{ vaultId, toUserId: heir.userId }],
  });
  expect(r.statusCode).toBe(200);
  expect(r.json().rotateVaults).toEqual([{ id: vaultId, name: 'Finance', entries: 0 }]);
  expect((await leaver.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(401);
  const users = (await admin.req('GET', '/admin/users')).json() as {
    id: string;
    disabled: boolean;
    disabledReason: string | null;
  }[];
  expect(users.find((u) => u.id === leaver.userId)).toMatchObject({
    disabled: true,
    disabledReason: 'offboarding',
  });
  const members = (await admin.req('GET', `/vaults/${vaultId}/members`)).json().members as {
    userId: string;
    directRole: string;
  }[];
  expect(members.find((m) => m.userId === heir.userId)!.directRole).toBe('owner');
  expect(members.some((m) => m.userId === leaver.userId)).toBe(false);
  expect((await admin.req('POST', `/admin/users/${leaver.userId}/offboard`, {})).statusCode).toBe(
    409,
  );
});
