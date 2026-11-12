import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { spaceMembers } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

/**
 * Доступ к папке или записи человеку вне подразделения: он принимается гостем (не ко всему сейфу),
 * условия задаёт политика «sharing.outside», гость без доступов выходит из подразделения.
 */
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let alice: TestClient; // администратор сейфа, но не администратор подразделения
let bob: TestClient; // вне подразделения
let carol: TestClient; // вне подразделения
let spaceId = '';
let vaultId = '';
let key: Uint8Array;
let folderId = '';
let secretFolderId = '';
let sharedEntryId = '';
let secretEntryId = '';
let circleId = '';

const guestRow = (userId: string) =>
  fixture.database.db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)));
const share = (who: TestClient, by: TestClient = admin, role = 'reader') =>
  by.req('PUT', `/vaults/${vaultId}/grants`, {
    targetType: 'branch',
    targetId: folderId,
    subjectType: 'user',
    subjectId: who.userId,
    role,
  });
const policy = (value: string) => admin.req('PUT', '/admin/settings', { 'sharing.outside': value });

beforeAll(async () => {
  fixture = await createTestApp();
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
  spaceId = (await admin.req('POST', '/spaces', { name: 'Sales', publicToOrg: false })).json().id;
  await admin.req('PUT', `/spaces/${spaceId}/circles/${circleId}`, { role: 'member' });
  const v = await admin.createSharedVault('Sales · Passwords', { spaceId });
  expect(v.res.statusCode).toBe(201);
  vaultId = v.id;
  key = v.key;
  // Алиса — член подразделения и администратор сейфа, но не администратор подразделения
  await admin.req('PUT', `/spaces/${spaceId}/users/${alice.userId}`, { role: 'member' });
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

describe('sharing a folder with a person outside the department', () => {
  it('without the policy rule the vault stays closed: no role, no space', async () => {
    expect((await bob.vaults()).some((x) => x.id === vaultId)).toBe(false);
  });

  it('a vault administrator shares one folder: the person becomes a guest and sees only that', async () => {
    const r = await share(bob, alice);
    expect(r.statusCode).toBe(200);
    expect(r.json().guest).toBe(true);
    expect((await guestRow(bob.userId))[0]).toMatchObject({ guest: true, role: 'member' });
    expect((await bob.vaults()).some((x) => x.id === vaultId)).toBe(true);
    // повторная выдача: гость уже есть
    expect((await share(bob, alice)).json().guest).toBe(false);
  });

  it('the department card lists the guest; the whole vault is still not granted to them', async () => {
    const card = (await admin.req('GET', `/admin/departments/${spaceId}`)).json();
    expect(card.guests.map((g: { email: string }) => g.email)).toEqual(['share-bob@example.com']);
    const r = await alice.req('PUT', `/vaults/${vaultId}/members/${carol.userId}`, {
      role: 'reader',
    });
    // ко всему сейфу — только члену подразделения: гость и посторонний получают отказ
    expect(r.statusCode).toBe(404);
  });

  it('a group outside the department is shared only by a department administrator', async () => {
    const other = (
      await admin.req('POST', '/admin/circles', { name: 'Outsiders', description: '' })
    ).json().id;
    const body = {
      targetType: 'branch',
      targetId: folderId,
      subjectType: 'circle',
      subjectId: other,
      role: 'reader',
    };
    const denied = await alice.req('PUT', `/vaults/${vaultId}/grants`, body);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('outside_group_admin_only');
    expect((await admin.req('PUT', `/vaults/${vaultId}/grants`, body)).statusCode).toBe(200);
  });

  it('the policy decides who may share outside: admins only, then nobody', async () => {
    expect((await policy('admins')).statusCode).toBe(200);
    // Алиса — администратор сейфа: можно
    expect((await share(carol, alice)).json().guest).toBe(true);
    await admin.req('DELETE', `/admin/departments/${spaceId}/guests/${carol.userId}`);
    expect((await policy('off')).statusCode).toBe(200);
    const off = await share(carol, alice);
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe('outside_sharing_off');
    // администратор подразделения может независимо от политики
    expect((await share(carol, admin)).json().guest).toBe(true);
    await policy('owners');
  });

  it('removing the last access removes the guest from the department; a removed guest loses everything', async () => {
    const grants = (await admin.req('GET', `/vaults/${vaultId}/grants`)).json() as {
      id: string;
      subjectId: string;
    }[];
    const g = grants.find((x) => x.subjectId === bob.userId)!;
    expect((await admin.req('DELETE', `/vaults/${vaultId}/grants/${g.id}`)).statusCode).toBe(204);
    expect(await guestRow(bob.userId)).toEqual([]);
    expect((await bob.vaults()).some((x) => x.id === vaultId)).toBe(false);
    // Кэрол убирается руководителем подразделения вместе с выданными доступами
    expect(
      (await admin.req('DELETE', `/admin/departments/${spaceId}/guests/${carol.userId}`))
        .statusCode,
    ).toBe(204);
    expect(await guestRow(carol.userId)).toEqual([]);
    const left = (await admin.req('GET', `/vaults/${vaultId}/grants`)).json() as {
      subjectId: string;
    }[];
    expect(left.some((x) => x.subjectId === carol.userId)).toBe(false);
  });

  it('adding a guest explicitly as a member makes them a full member', async () => {
    await share(bob, admin);
    expect((await guestRow(bob.userId))[0]!.guest).toBe(true);
    await admin.req('PUT', `/spaces/${spaceId}/users/${bob.userId}`, { role: 'member' });
    expect((await guestRow(bob.userId))[0]!.guest).toBe(false);
  });
});

describe('what a guest can and cannot see', () => {
  it('a guest reads only the shared folder; the rest of the vault and the roster stay closed', async () => {
    await share(carol, admin);
    expect((await carol.req('GET', `/vaults/${vaultId}/entries/${sharedEntryId}`)).statusCode).toBe(
      200,
    );
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
    // состав подразделения гостю не показывается, участников сейфа он не видит
    const space = (await carol.req('GET', `/spaces/${spaceId}`)).json();
    expect(space.members).toEqual([]);
    expect(space.circles).toEqual([]);
    expect(
      (await carol.req('GET', `/vaults/${vaultId}/members`)).statusCode,
    ).toBeGreaterThanOrEqual(403);
    // создать, изменить и поделиться дальше гость не может
    expect(
      (
        await carol.req('PUT', `/vaults/${vaultId}/grants`, {
          targetType: 'branch',
          targetId: folderId,
          subjectType: 'user',
          subjectId: bob.userId,
          role: 'reader',
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(403);
    await admin.req('DELETE', `/admin/departments/${spaceId}/guests/${carol.userId}`);
  });

  it('a guest always gets a limited term: a default one without a request, and no more than the cap', async () => {
    const r = await share(carol, admin);
    const until = Date.parse(r.json().expiresAt);
    expect(until).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(until).toBeLessThan(Date.now() + 31 * 86_400_000);
    const far = await admin.req('PUT', `/vaults/${vaultId}/grants`, {
      targetType: 'branch',
      targetId: folderId,
      subjectType: 'user',
      subjectId: carol.userId,
      role: 'reader',
      expiresAt: new Date(Date.now() + 200 * 86_400_000).toISOString(),
    });
    expect(far.statusCode).toBe(400);
    expect(far.json().error.code).toBe('outside_expiry_too_long');
    // пределы задаёт администратор; 0 — без предела
    await admin.req('PUT', '/admin/settings', { 'sharing.outsideMaxDays': 0 });
    expect(
      (
        await admin.req('PUT', `/vaults/${vaultId}/grants`, {
          targetType: 'branch',
          targetId: folderId,
          subjectType: 'user',
          subjectId: carol.userId,
          role: 'reader',
          expiresAt: new Date(Date.now() + 200 * 86_400_000).toISOString(),
        })
      ).statusCode,
    ).toBe(200);
    await admin.req('PUT', '/admin/settings', { 'sharing.outsideMaxDays': 90 });
    // член подразделения срок не обязан ограничивать
    const member = await admin.req('PUT', `/vaults/${vaultId}/grants`, {
      targetType: 'branch',
      targetId: folderId,
      subjectType: 'user',
      subjectId: alice.userId,
      role: 'reader',
    });
    expect(member.json().expiresAt).toBeNull();
  });
});
