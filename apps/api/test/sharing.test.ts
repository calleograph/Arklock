import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from './helpers.js';

/**
 * Кто получает доступ к сейфу: участник сейфа (лично или через группу) или тот, кому выдана папка или запись.
 * Подразделений нет: группа с ролью в сейфе открывает его всем своим участникам.
 */
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let alice: TestClient; // администратор сейфа
let bob: TestClient; // участник группы
let carol: TestClient; // получает одну папку
let vaultId = '';
let key: Uint8Array;
let folderId = '';
let secretFolderId = '';
let sharedEntryId = '';
let secretEntryId = '';
let circleId = '';

const share = (who: TestClient, by: TestClient = admin, role = 'reader') =>
  by.req('PUT', `/vaults/${vaultId}/grants`, {
    targetType: 'branch',
    targetId: folderId,
    subjectType: 'user',
    subjectId: who.userId,
    role,
  });

beforeAll(async () => {
  fixture = await createTestApp({}, false);
  admin = new TestClient(fixture.app, 'share-admin@example.com', 'share-admin-password-1234');
  expect((await admin.register()).statusCode).toBe(201);
  await admin.login();
  await admin.req('PUT', '/admin/settings', { 'registration.mode': 'open' });
  for (const [name, email] of [
    ['alice', 'share-alice@example.com'],
    ['bob', 'share-bob@example.com'],
    ['carol', 'share-carol@example.com'],
  ] as const) {
    const c = new TestClient(fixture.app, email, `${name}-password-1234567`);
    expect((await c.register()).statusCode).toBe(201);
    await c.login();
    if (name === 'alice') alice = c;
    else if (name === 'bob') bob = c;
    else carol = c;
  }
  circleId = (await admin.req('POST', '/admin/circles', { name: 'Sales', description: '' })).json()
    .id;
  const v = await admin.createSharedVault('Sales · Passwords');
  expect(v.res.statusCode).toBe(201);
  vaultId = v.id;
  key = v.key;
  expect((await admin.addMember(vaultId, alice, 'admin', key)).statusCode).toBe(204);
  folderId = (await admin.createBranch(vaultId, key, 'Shared folder', null)).id;
  secretFolderId = (await admin.createBranch(vaultId, key, 'Secret folder', null)).id;
  sharedEntryId = (
    await admin.createEntry({ title: 'shared' }, { vaultId, vaultKey: key, branchId: folderId })
  ).entryId;
  secretEntryId = (
    await admin.createEntry(
      { title: 'secret' },
      { vaultId, vaultKey: key, branchId: secretFolderId },
    )
  ).entryId;
});
afterAll(async () => fixture.app.close());

describe('access through a group', () => {
  it('a person added to a group with a role in the vault gets the vault; leaving the group closes it', async () => {
    expect(
      (await admin.req('PUT', `/vaults/${vaultId}/circles/${circleId}`, { role: 'editor' }))
        .statusCode,
    ).toBe(204);
    expect((await bob.vaults()).some((v) => v.id === vaultId)).toBe(false);
    expect(
      (await admin.req('PUT', `/admin/circles/${circleId}/members/${bob.userId}`)).statusCode,
    ).toBe(204);
    // роль есть сразу; ключ ждёт администратора сейфа (в строгом режиме его выдаёт браузер администратора)
    const pending = (await bob.vaults()).find((v) => v.id === vaultId)!;
    expect(pending).toMatchObject({ role: 'editor', pendingKey: true });
    const waiting = (await admin.req('GET', `/vaults/${vaultId}/pending-keys`)).json().users;
    expect(waiting.map((u: { userId: string }) => u.userId)).toEqual([bob.userId]);
    const k = await admin.keyFor(bob, vaultId, key);
    expect(
      (
        await admin.req('POST', `/vaults/${vaultId}/keys`, {
          keys: [{ userId: bob.userId, ...k }],
        })
      ).statusCode,
    ).toBeLessThan(300);
    const opened = (await bob.vaults()).find((v) => v.id === vaultId)!;
    expect(opened.pendingKey).toBe(false);
    expect(await bob.readEntry(vaultId, secretEntryId, await bob.openVault(opened))).toEqual({
      title: 'secret',
    });
    expect(
      (await admin.req('DELETE', `/admin/circles/${circleId}/members/${bob.userId}`)).statusCode,
    ).toBe(204);
    expect((await bob.vaults()).some((v) => v.id === vaultId)).toBe(false);
    expect((await bob.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(404);
  });

  it('a person added directly needs no other membership', async () => {
    expect((await admin.addMember(vaultId, carol, 'reader', key)).statusCode).toBe(204);
    expect((await carol.vaults()).find((v) => v.id === vaultId)?.role).toBe('reader');
    expect(
      (await admin.req('DELETE', `/vaults/${vaultId}/members/${carol.userId}`)).statusCode,
    ).toBeLessThan(300);
  });
});

describe('sharing one folder', () => {
  it('the person reads only the shared folder; the rest of the vault and the roster stay closed', async () => {
    expect((await share(carol, alice)).statusCode).toBe(200);
    expect(await carol.readEntry(vaultId, sharedEntryId, key)).toEqual({ title: 'shared' });
    // другая папка и запись в ней — как будто их нет
    expect((await carol.req('GET', `/vaults/${vaultId}/entries/${secretEntryId}`)).statusCode).toBe(
      404,
    );
    const tree = (await carol.req('GET', `/vaults/${vaultId}/tree`)).json() as {
      branches: { id: string }[];
      entries: { id: string }[];
    };
    expect(tree.entries.map((e) => e.id)).toEqual([sharedEntryId]);
    expect(tree.branches.some((b) => b.id === secretFolderId)).toBe(false);
    expect(
      (await carol.req('GET', `/vaults/${vaultId}/members`)).statusCode,
    ).toBeGreaterThanOrEqual(403);
    // поделиться дальше читатель папки не может
    expect((await share(bob, carol)).statusCode).toBeGreaterThanOrEqual(403);
  });

  it('a term is kept as given, and removing the grant closes the folder', async () => {
    const until = new Date(Date.now() + 200 * 86_400_000).toISOString();
    const r = await admin.req('PUT', `/vaults/${vaultId}/grants`, {
      targetType: 'branch',
      targetId: folderId,
      subjectType: 'user',
      subjectId: carol.userId,
      role: 'reader',
      expiresAt: until,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().expiresAt).toBe(until);
    expect((await admin.req('DELETE', `/vaults/${vaultId}/grants/${r.json().id}`)).statusCode).toBe(
      204,
    );
    expect((await carol.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(404);
  });
});

describe('who goes where: the access list of a vault', () => {
  it('lists the direct members, groups and shared folders, for the chief administrator only', async () => {
    await share(carol, admin);
    const r = (await admin.req('GET', `/admin/vaults/${vaultId}/access`)).json();
    expect(r.name).toBe('Sales · Passwords');
    expect(r.direct.map((d: { email: string }) => d.email)).toEqual(
      expect.arrayContaining(['share-admin@example.com', 'share-alice@example.com']),
    );
    expect(r.groups.map((g: { name: string }) => g.name)).toEqual(['Sales']);
    expect(
      r.grants.find((g: { email: string }) => g.email === 'share-carol@example.com'),
    ).toMatchObject({ rules: 1 });
    expect(
      (await alice.req('GET', `/admin/vaults/${vaultId}/access`)).statusCode,
    ).toBeGreaterThanOrEqual(403);
  });
});
