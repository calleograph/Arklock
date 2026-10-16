import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { settings, vaultMembers } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

let app: Awaited<ReturnType<typeof createTestApp>>['app'];
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let owner: TestClient;
let backup: TestClient;
let vaultId: string;
let vaultKey: Uint8Array;
beforeAll(async () => {
  fixture = await createTestApp();
  ({ app } = fixture);
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  await admin.register();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  owner = new TestClient(app, 'owner@example.com', 'owner-password-123');
  backup = new TestClient(app, 'backup@example.com', 'backup-password-123');
  await owner.register();
  await backup.register();
  await admin.login();
  await owner.login();
  await backup.login();
  const created = await admin.createSharedVault('Finance');
  expect(created.res.statusCode).toBe(201);
  vaultId = created.id;
  vaultKey = created.key;
  expect((await admin.addMember(vaultId, owner, 'admin', vaultKey)).statusCode).toBe(204);
  expect(
    (await admin.req('POST', `/vaults/${vaultId}/transfer-ownership`, { userId: owner.userId }))
      .statusCode,
  ).toBe(200);
  expect((await owner.req('DELETE', `/vaults/${vaultId}/members/${admin.userId}`)).statusCode).toBe(
    200,
  );
});
afterAll(async () => app.close());

it('detects the last key custodian and blocks accidental offboarding without exposing data to members', async () => {
  expect((await backup.req('GET', '/admin/continuity')).statusCode).toBe(403);
  expect((await app.inject({ url: '/api/v1/admin/continuity' })).statusCode).toBe(401);
  expect((await admin.req('GET', `/admin/users/${owner.userId}/access-risks`)).json()).toEqual([
    { id: vaultId, name: 'Finance' },
  ]);
  const blocked = await admin.req('PATCH', `/admin/users/${owner.userId}`, { disabled: true });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json().error.code).toBe('corporate_access_at_risk');
  const overview = (await admin.req('GET', '/admin/continuity')).json();
  expect(overview.find((v: { id: string }) => v.id === vaultId).custodians).toEqual([
    { userId: owner.userId, name: 'Test User' },
  ]);
  expect(JSON.stringify(overview)).not.toContain('sealedKey');
});

it('counts current keys with active managing permissions; pending and expired assignments do not count', async () => {
  expect((await owner.addMember(vaultId, backup, 'admin')).statusCode).toBe(204);
  expect((await admin.req('GET', `/admin/users/${owner.userId}/access-risks`)).json()).toHaveLength(
    1,
  );
  expect((await owner.addMember(vaultId, backup, 'admin', vaultKey)).statusCode).toBe(204);
  expect((await admin.req('GET', `/admin/users/${owner.userId}/access-risks`)).json()).toEqual([]);
  await fixture.database.db
    .update(vaultMembers)
    .set({ expiresAt: new Date(0) })
    .where(eq(vaultMembers.userId, backup.userId));
  expect((await admin.req('GET', `/admin/users/${owner.userId}/access-risks`)).json()).toHaveLength(
    1,
  );
});

it('allows urgent revocation with an explicit acknowledgement while preserving the encrypted vault', async () => {
  expect(
    (
      await admin.req('PATCH', `/admin/users/${owner.userId}`, {
        disabled: true,
        acknowledgeAccessRisk: true,
      })
    ).statusCode,
  ).toBe(200);
  expect((await owner.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(401);
  const overview = (await admin.req('GET', '/admin/continuity')).json();
  expect(overview.find((v: { id: string }) => v.id === vaultId).custodians).toEqual([]);
});
