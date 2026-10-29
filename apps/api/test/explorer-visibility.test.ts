import { afterAll, beforeAll, expect, it } from 'vitest';
import { settings } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

// Проводник в центре строится из дерева сейфа: сотрудник с доступом к вложенной папке не получает
// ни названий, ни записей уровней выше неё — скрытие в интерфейсе здесь ни при чём.
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let owner: TestClient;
let staff: TestClient;
let vaultId: string;
let vaultKey: Uint8Array;
const ids: Record<string, string> = {};

beforeAll(async () => {
  fixture = await createTestApp();
  owner = new TestClient(fixture.app, 'ex-owner@example.com', 'ex-owner-password-1');
  await owner.register();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  staff = new TestClient(fixture.app, 'ex-staff@example.com', 'ex-staff-password-1');
  await staff.register();
  await owner.login();
  await staff.login();
  const vault = await owner.createSharedVault('Corporate');
  vaultId = vault.id;
  vaultKey = vault.key;
  ids.infra = (await owner.createBranch(vaultId, vaultKey, 'Infrastructure')).id;
  ids.servers = (await owner.createBranch(vaultId, vaultKey, 'Servers', ids.infra)).id;
  ids.linux = (await owner.createBranch(vaultId, vaultKey, 'Linux', ids.servers)).id;
  ids.finance = (await owner.createBranch(vaultId, vaultKey, 'Finance')).id;
  ids.rootEntry = (
    await owner.createEntry({ password: 'a' }, { vaultId, vaultKey, branchId: ids.infra })
  ).entryId;
  ids.deepEntry = (
    await owner.createEntry({ password: 'b' }, { vaultId, vaultKey, branchId: ids.linux })
  ).entryId;
  expect((await owner.addMember(vaultId, staff, 'limited', vaultKey)).statusCode).toBe(204);
});
afterAll(async () => fixture.app.close());

it('access to a nested folder does not reveal the folders and entries above it', async () => {
  const grant = await owner.req('PUT', `/vaults/${vaultId}/grants`, {
    targetType: 'branch',
    targetId: ids.servers,
    subjectType: 'user',
    subjectId: staff.userId,
    role: 'reader',
  });
  expect(grant.statusCode).toBe(200);
  const tree = (await staff.req('GET', `/vaults/${vaultId}/tree`)).json() as {
    branches: { id: string }[];
    entries: { id: string }[];
  };
  expect(tree.branches.map((b) => b.id).sort()).toEqual([ids.linux, ids.servers].sort());
  expect(tree.entries.map((e) => e.id)).toEqual([ids.deepEntry]);
  // прямые обращения к скрытому — «не найдено», как будто его нет
  for (const url of [
    `/vaults/${vaultId}/entries/${ids.rootEntry}`,
    `/vaults/${vaultId}/branches/${ids.infra}/access`,
    `/vaults/${vaultId}/branches/${ids.finance}/access`,
  ])
    expect((await staff.req('GET', url)).statusCode, url).toBe(404);
});

it('a reader cannot create a folder in the visible branch', async () => {
  const { res } = await staff.createBranch(vaultId, vaultKey, 'Intruder', ids.servers);
  expect([403, 404]).toContain(res.statusCode);
  const tree = (await owner.req('GET', `/vaults/${vaultId}/tree`)).json() as {
    branches: unknown[];
  };
  expect(tree.branches).toHaveLength(4);
});
