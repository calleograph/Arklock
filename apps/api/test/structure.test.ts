import { afterAll, beforeAll, expect, it } from 'vitest';
import { settings } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

// «Структура»: видеть папки и создавать в них, не читая записей (ящик для сдачи секретов)
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let owner: TestClient;
let clerk: TestClient;
let vaultId: string;
let vaultKey: Uint8Array;
let folder: string;
let sub: string;
let secret: string;

beforeAll(async () => {
  fixture = await createTestApp();
  owner = new TestClient(fixture.app, 'st-owner@example.com', 'st-owner-password-1');
  await owner.register();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  clerk = new TestClient(fixture.app, 'st-clerk@example.com', 'st-clerk-password-1');
  await clerk.register();
  await owner.login();
  await clerk.login();
  const vault = await owner.createSharedVault('Drop box');
  vaultId = vault.id;
  vaultKey = vault.key;
  folder = (await owner.createBranch(vaultId, vaultKey, 'Incoming')).id;
  sub = (await owner.createBranch(vaultId, vaultKey, 'Team', folder)).id;
  secret = (await owner.createEntry({ password: 'old' }, { vaultId, vaultKey, branchId: folder }))
    .entryId;
  expect((await owner.addMember(vaultId, clerk, 'limited', vaultKey)).statusCode).toBe(204);
});
afterAll(async () => fixture.app.close());

const grant = (targetType: 'branch' | 'entry', targetId: string, role: string) =>
  owner.req('PUT', `/vaults/${vaultId}/grants`, {
    targetType,
    targetId,
    subjectType: 'user',
    subjectId: clerk.userId,
    role,
  });
const tree = async () =>
  (await clerk.req('GET', `/vaults/${vaultId}/tree`)).json() as {
    branches: { id: string; access: string }[];
    entries: { id: string }[];
  };

it('the structure level applies to folders only', async () => {
  expect((await grant('entry', secret, 'structure')).statusCode).toBe(400);
});

it('structure shows the folders and lets the person add, but never read entries', async () => {
  expect((await grant('branch', folder, 'structure')).statusCode).toBe(200);
  let t = await tree();
  expect(new Map(t.branches.map((b) => [b.id, b.access]))).toEqual(
    new Map([
      [folder, 'structure'],
      [sub, 'structure'],
    ]),
  );
  expect(t.entries).toEqual([]);
  expect((await clerk.req('GET', `/vaults/${vaultId}/entries/${secret}`)).statusCode).toBe(404);

  // требования к паролю папки видны — по ним браузер проверяет сдаваемую запись; доступ и журнал — нет
  expect((await clerk.req('GET', `/vaults/${vaultId}/branches/${sub}/policy`)).statusCode).toBe(
    200,
  );
  expect((await clerk.req('GET', `/vaults/${vaultId}/branches/${sub}/access`)).statusCode).toBe(
    404,
  );
  expect((await clerk.req('GET', `/vaults/${vaultId}/branches/${sub}/journal`)).statusCode).toBe(
    404,
  );

  // сдать запись можно, прочитать потом — нет, в том числе свою
  const mine = await clerk.createEntry(
    { password: 'handed-in' },
    { vaultId, vaultKey, branchId: sub },
  );
  expect(mine.res.statusCode).toBe(201);
  t = await tree();
  expect(t.entries).toEqual([]);
  expect((await clerk.req('GET', `/vaults/${vaultId}/entries/${mine.entryId}`)).statusCode).toBe(
    404,
  );
  expect((await owner.req('GET', `/vaults/${vaultId}/entries/${mine.entryId}`)).statusCode).toBe(
    200,
  );

  // подпапку создать можно — она тоже «Структура»; менять и удалять папки нельзя
  const made = await clerk.createBranch(vaultId, vaultKey, 'Q4', folder);
  expect(made.res.statusCode).toBe(201);
  expect(made.res.json().access).toBe('structure');
  expect(
    (await clerk.req('PATCH', `/vaults/${vaultId}/branches/${folder}`, { parentId: null }))
      .statusCode,
  ).toBeGreaterThanOrEqual(403);
  expect(
    (await clerk.req('DELETE', `/vaults/${vaultId}/branches/${folder}`)).statusCode,
  ).toBeGreaterThanOrEqual(403);
  // в корень сейфа — нельзя: права там нет
  expect(
    (await clerk.createEntry({ p: 1 }, { vaultId, vaultKey, branchId: null })).res.statusCode,
  ).toBe(403);

  // владелец видит итог у участника: «Структура»
  const access = (await owner.req('GET', `/vaults/${vaultId}/branches/${folder}/access`)).json();
  expect(access.members.find((m: { userId: string }) => m.userId === clerk.userId).access).toBe(
    'structure',
  );
});

it('structure combines with an explicit entry grant and yields to a deny', async () => {
  expect((await grant('entry', secret, 'reader')).statusCode).toBe(200);
  expect((await tree()).entries.map((e) => e.id)).toEqual([secret]);
  // запрет на папке выше отменяет «Структуру», выданную на вложенную
  expect((await grant('branch', sub, 'structure')).statusCode).toBe(200);
  expect((await grant('branch', folder, 'none')).statusCode).toBe(200);
  const t = await tree();
  expect(t.branches.find((b) => b.id === sub)).toBeUndefined();
  expect(
    (await clerk.createEntry({ p: 2 }, { vaultId, vaultKey, branchId: sub })).res.statusCode,
  ).toBeGreaterThanOrEqual(403);
});
