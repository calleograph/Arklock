import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  attachments,
  branches,
  circleMembers,
  circles,
  entries,
  grants,
  settings,
} from '../src/db/schema.js';
import { TestClient, createTestApp } from './helpers.js';

let app: Awaited<ReturnType<typeof createTestApp>>['app'];
let context: Awaited<ReturnType<typeof createTestApp>>;
let owner: TestClient;
let member: TestClient;
let vaultId: string;
let branchId: string;
let entryId: string;
let grantId: string;
let blobDir: string;

beforeAll(async () => {
  blobDir = mkdtempSync(path.join(tmpdir(), 'arklock-object-access-'));
  context = await createTestApp({ BLOB_DIR: blobDir });
  ({ app } = context);
  owner = new TestClient(app, 'owner@example.com', 'owner-password-12345');
  expect((await owner.register()).statusCode).toBe(201);
  await context.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  member = new TestClient(app, 'member@example.com', 'member-password-12345');
  expect((await member.register()).statusCode).toBe(201);
  await owner.login();
  await member.login();
  const vault = await owner.createSharedVault('Corporate');
  vaultId = vault.id;
  expect((await owner.addMember(vaultId, member, 'editor', vault.key)).statusCode).toBe(204);
  const branch = await owner.createBranch(vaultId, vault.key, 'Team');
  expect(branch.res.statusCode).toBe(201);
  branchId = branch.id;
  const entry = await owner.createEntry(
    { password: 'secret' },
    { vaultId, vaultKey: vault.key, branchId },
  );
  expect(entry.res.statusCode).toBe(201);
  entryId = entry.entryId;
});

afterAll(async () => {
  await app.close();
  rmSync(blobDir, { recursive: true, force: true });
});

it('object deny blocks data and related routes despite vault membership, with no partial branch deletion', async () => {
  const deny = await owner.req('PUT', `/vaults/${vaultId}/grants`, {
    targetType: 'entry',
    targetId: entryId,
    subjectType: 'user',
    subjectId: member.userId,
    role: 'none',
  });
  expect(deny.statusCode).toBe(200);
  grantId = deny.json().id;
  for (const suffix of ['', '/revisions', '/attachments', '/access', '/journal', '/policy']) {
    expect(
      (await member.req('GET', `/vaults/${vaultId}/entries/${entryId}${suffix}`)).statusCode,
    ).toBe(404);
  }
  expect(
    (
      await member.req('POST', `/vaults/${vaultId}/entries/${entryId}/events`, {
        action: 'copy',
        field: 'password',
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await member.req('POST', `/vaults/${vaultId}/entries/bulk`, {
        ids: [entryId],
        action: 'trash',
      })
    ).statusCode,
  ).toBe(404);
  expect((await member.req('DELETE', `/vaults/${vaultId}/branches/${branchId}`)).statusCode).toBe(
    404,
  );
  expect(
    (await member.req('PATCH', `/vaults/${vaultId}/branches/${branchId}`, { parentId: null }))
      .statusCode,
  ).toBe(200); // no move
  const destination = await owner.createBranch(
    vaultId,
    await owner.openVault((await owner.vaults()).find((v) => v.id === vaultId)!),
    'Destination',
  );
  expect(
    (
      await member.req('PATCH', `/vaults/${vaultId}/branches/${branchId}`, {
        parentId: destination.id,
      })
    ).statusCode,
  ).toBe(404);
  const nested = (await owner.req('GET', `/vaults/${vaultId}/tree`)).json();
  expect(nested.entries.some((e: { id: string }) => e.id === entryId)).toBe(true);
  expect((await member.req('GET', `/vaults/${vaultId}/tree`)).json().entries).toEqual([]);
  expect((await owner.req('DELETE', `/vaults/${vaultId}/grants/${grantId}`)).statusCode).toBe(204);
});

it('group folder deny dominates an explicit entry allow, and expires without deleting stored grants', async () => {
  const circleId = crypto.randomUUID();
  await context.database.db.insert(circles).values({ id: circleId, name: 'Team' });
  await context.database.db.insert(circleMembers).values({ circleId, userId: member.userId });
  expect(
    (
      await owner.req('PUT', `/vaults/${vaultId}/grants`, {
        targetType: 'entry',
        targetId: entryId,
        subjectType: 'user',
        subjectId: member.userId,
        role: 'manager',
      })
    ).statusCode,
  ).toBe(200);
  const deny = await owner.req('PUT', `/vaults/${vaultId}/grants`, {
    targetType: 'branch',
    targetId: branchId,
    subjectType: 'circle',
    subjectId: circleId,
    role: 'none',
  });
  expect(deny.statusCode).toBe(200);
  expect((await member.req('GET', `/vaults/${vaultId}/entries/${entryId}`)).statusCode).toBe(404);
  const access = (await owner.req('GET', `/vaults/${vaultId}/entries/${entryId}/access`)).json();
  expect(access.cryptoScope).toBe('vault');
  expect(access.members.find((m: { userId: string }) => m.userId === member.userId)).toMatchObject({
    access: null,
    hasKey: true,
  });
  expect(access.grants.find((g: { id: string }) => g.id === deny.json().id)).toMatchObject({
    role: 'none',
    inherited: true,
  });
  const branchAccess = (
    await owner.req('GET', `/vaults/${vaultId}/branches/${branchId}/access`)
  ).json();
  expect(branchAccess.grants.find((g: { id: string }) => g.id === deny.json().id)).toMatchObject({
    role: 'none',
    inherited: false,
  });
  expect(
    (await owner.req('GET', `/vaults/${vaultId}/branches/${branchId}/journal`)).statusCode,
  ).toBe(200);
  await context.database.db
    .update(grants)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(grants.id, deny.json().id));
  expect((await member.req('GET', `/vaults/${vaultId}/entries/${entryId}`)).statusCode).toBe(200);
  expect(
    (await owner.req('DELETE', `/vaults/${vaultId}/grants/${deny.json().id}`)).statusCode,
  ).toBe(204);
  expect((await member.req('GET', `/vaults/${vaultId}/entries/${entryId}`)).statusCode).toBe(200);
  await context.database.db.delete(circleMembers).where(eq(circleMembers.circleId, circleId));
});

it('journal distinguishes client reports and refuses unbounded metadata', async () => {
  const url = `/vaults/${vaultId}/entries/${entryId}`;
  expect(
    (
      await member.req('POST', `${url}/events`, {
        action: 'copy',
        field: 'password',
        value: 'must-never-log',
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await member.req('POST', `${url}/events`, { action: 'copy', field: 'password' })).statusCode,
  ).toBe(204);
  const journal = (await owner.req('GET', `${url}/journal`)).json();
  expect(journal).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: 'entry.client.copy',
        clientReported: true,
        detail: expect.objectContaining({ field: 'password' }),
      }),
    ]),
  );
  expect(JSON.stringify(journal)).not.toContain('must-never-log');
});

it('entry policies inherit strictest requirements and resetting restores inheritance', async () => {
  await context.database.db
    .insert(settings)
    .values({ key: 'security.passwordMaxAgeDays', value: 14 });
  expect(
    (
      await owner.req('PATCH', `/vaults/${vaultId}/policy`, {
        policy: { minLength: 16, classes: 3, maxAgeDays: 90 },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await owner.req('PATCH', `/vaults/${vaultId}/branches/${branchId}/policy`, {
        policy: { minLength: 20, maxAgeDays: 30 },
      })
    ).statusCode,
  ).toBe(200);
  const url = `/vaults/${vaultId}/entries/${entryId}/policy`;
  const own = await owner.req('PATCH', url, { policy: { minLength: 8, maxAgeDays: 60 } });
  expect(own.json()).toMatchObject({
    effective: { minLength: 20, classes: 3, maxAgeDays: 14 },
    clientEnforced: true,
  });
  expect((await owner.req('PATCH', url, { policy: { minLength: 129 } })).statusCode).toBe(400);
  expect((await owner.req('PATCH', url, { policy: null })).json().own).toBeNull();
});

it('an owner can revoke a denial even when their own object data is denied', async () => {
  expect(
    (
      await owner.req('POST', `/vaults/${vaultId}/signals`, {
        items: [{ entryId, type: 'weak' }],
        checkedTypes: ['weak'],
      })
    ).statusCode,
  ).toBe(200);
  const signal = (await owner.req('GET', `/vaults/${vaultId}/signals`)).json()[0];
  const attachmentId = crypto.randomUUID();
  const [entry] = await context.database.db.select().from(entries).where(eq(entries.id, entryId));
  await context.database.db.insert(attachments).values({
    id: attachmentId,
    vaultId,
    entryId,
    wrappedKey: entry!.wrappedEntryKey,
    metaCipher: entry!.ciphertext,
    keyVersion: 1,
    size: 32,
    status: 'ready',
    createdBy: owner.userId,
  });
  const deny = await owner.req('PUT', `/vaults/${vaultId}/grants`, {
    targetType: 'entry',
    targetId: entryId,
    subjectType: 'user',
    subjectId: owner.userId,
    role: 'none',
  });
  expect(deny.statusCode).toBe(200);
  expect((await owner.req('GET', `/vaults/${vaultId}/entries/${entryId}`)).statusCode).toBe(404);
  expect((await owner.req('GET', `/vaults/${vaultId}/signals`)).json()).toEqual([]);
  expect(
    (await owner.req('PATCH', `/vaults/${vaultId}/signals/${signal.id}`, { status: 'resolved' }))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await owner.req(
        'GET',
        `/vaults/${vaultId}/attachments/${attachmentId}/progress?rotation=1&rotationId=${crypto.randomUUID()}`,
      )
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await owner.req(
        'POST',
        `/vaults/${vaultId}/attachments/${attachmentId}/complete?rotation=1&rotationId=${crypto.randomUUID()}`,
      )
    ).statusCode,
  ).toBe(404);
  expect((await owner.req('GET', `/vaults/${vaultId}/members`)).statusCode).toBe(200);
  expect(
    (await owner.req('DELETE', `/vaults/${vaultId}/grants/${deny.json().id}`)).statusCode,
  ).toBe(204);
  expect((await owner.req('GET', `/vaults/${vaultId}/entries/${entryId}`)).statusCode).toBe(200);
});

it('restoring an entry preserves unrelated legacy orphans and their inherited ACL', async () => {
  const key = await owner.openVault((await owner.vaults()).find((v) => v.id === vaultId)!);
  const parent = await owner.createBranch(vaultId, key, 'Legacy parent');
  const orphan = await owner.createEntry(
    { title: 'Legacy' },
    { vaultId, vaultKey: key, branchId: parent.id },
  );
  await context.database.db
    .update(branches)
    .set({ deletedAt: new Date() })
    .where(eq(branches.id, parent.id));
  const restored = await owner.createEntry({ title: 'Restorable' }, { vaultId, vaultKey: key });
  expect(
    (await owner.req('DELETE', `/vaults/${vaultId}/entries/${restored.entryId}?expectedVersion=1`))
      .statusCode,
  ).toBe(204);
  expect(
    (await owner.req('POST', `/vaults/${vaultId}/entries/${restored.entryId}/restore`)).statusCode,
  ).toBe(204);
  const [unchanged] = await context.database.db
    .select()
    .from(entries)
    .where(eq(entries.id, orphan.entryId));
  expect(unchanged!.branchId).toBe(parent.id);
});

it('bulk and cascading deletion enforce role denials', async () => {
  const role = await owner.req('POST', '/admin/roles', {
    name: 'No deletes',
    scope: 'vault',
    allow: ['entry.read', 'entry.update', 'branch.manage'],
    deny: ['entry.delete', 'attachment.read'],
    parents: [],
  });
  expect(role.statusCode).toBe(201);
  expect(
    (
      await owner.req('PUT', `/vaults/${vaultId}/members/${member.userId}`, {
        customRoleId: role.json().id,
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (
      await member.req('POST', `/vaults/${vaultId}/entries/bulk`, {
        ids: [entryId],
        action: 'trash',
      })
    ).statusCode,
  ).toBe(403);
  expect((await member.req('DELETE', `/vaults/${vaultId}/branches/${branchId}`)).statusCode).toBe(
    403,
  );
  expect((await member.req('GET', `/vaults/${vaultId}/attachments`)).statusCode).toBe(403);
});
