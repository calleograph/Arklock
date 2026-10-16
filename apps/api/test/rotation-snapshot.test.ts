import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createVaultKey,
  encryptBranchName,
  encryptEntry,
  rewrapBranchName,
  rewrapEntry,
} from '@arklock/crypto';
import type { BranchRecord, EntryRecord, RevisionRecord } from '@arklock/contracts';
import { createTestApp, TestClient } from './helpers.js';

let app: Awaited<ReturnType<typeof createTestApp>>['app'];
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
beforeAll(async () => {
  fixture = await createTestApp();
  ({ app } = fixture);
  admin = new TestClient(app, 'admin@example.com', 'admin-password-12345');
  expect((await admin.register()).statusCode).toBe(201);
  await admin.login();
});
afterAll(async () => {
  await app.close();
});

async function setup() {
  const vault = await admin.createSharedVault('Rotation conflicts');
  const branch = await admin.createBranch(vault.id, vault.key, 'Before');
  const entry = await admin.createEntry(
    { title: 'Before' },
    { vaultId: vault.id, vaultKey: vault.key, branchId: branch.id },
  );
  return { vaultId: vault.id, key: vault.key, branchId: branch.id, entryId: entry.entryId };
}

async function prepare(vaultId: string, oldKey: Uint8Array) {
  const newKey = createVaultKey();
  const tree = (await admin.req('GET', `/vaults/${vaultId}/tree`)).json() as {
    entries: EntryRecord[];
    branches: BranchRecord[];
  };
  const entries = [];
  const revisions = [];
  const branches = [];
  for (const entry of tree.entries) {
    const encrypted = await rewrapEntry(entry, oldKey, newKey, vaultId, entry.id, 2);
    entries.push({ id: entry.id, expectedVersion: entry.version, ...encrypted });
    const history = (
      await admin.req('GET', `/vaults/${vaultId}/entries/${entry.id}/revisions`)
    ).json() as RevisionRecord[];
    for (const revision of history)
      revisions.push({
        id: revision.id,
        ...(await rewrapEntry(revision, oldKey, newKey, vaultId, entry.id, 2)),
      });
  }
  for (const branch of tree.branches)
    branches.push({
      id: branch.id,
      expectedVersion: branch.version,
      nameCipher: await rewrapBranchName(
        branch.nameCipher,
        oldKey,
        newKey,
        vaultId,
        branch.id,
        1,
        2,
      ),
    });
  return {
    newKey,
    body: {
      newKeyVersion: 2,
      entries,
      revisions,
      branches,
      keys: [{ userId: admin.userId, ...(await admin.keyFor(admin, vaultId, newKey, 2)) }],
    },
  };
}

it('rejects stale entry and branch snapshots without overwriting newer encrypted values', async () => {
  const { vaultId, key, entryId, branchId } = await setup();
  const stale = await prepare(vaultId, key);
  const edit = await encryptEntry({ title: 'Newer secret' }, key, vaultId, entryId, 1);
  expect(
    (
      await admin.req('PUT', `/vaults/${vaultId}/entries/${entryId}`, {
        ...edit,
        expectedVersion: 1,
      })
    ).statusCode,
  ).toBe(200);
  expect((await admin.req('POST', `/vaults/${vaultId}/rotate`, stale.body)).json().error.code).toBe(
    'version_conflict',
  );
  expect(await admin.readEntry(vaultId, entryId, key)).toEqual({ title: 'Newer secret' });
  const staleBranch = await prepare(vaultId, key);
  const nameCipher = await encryptBranchName('Newer folder', key, vaultId, branchId, 1);
  expect(
    (
      await admin.req('PATCH', `/vaults/${vaultId}/branches/${branchId}`, {
        nameCipher,
        keyVersion: 1,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await admin.req('POST', `/vaults/${vaultId}/rotate`, staleBranch.body)).json().error.code,
  ).toBe('version_conflict');
  const tree = (await admin.req('GET', `/vaults/${vaultId}/tree`)).json();
  expect(tree.branches.find((branch: BranchRecord) => branch.id === branchId)).toMatchObject({
    nameCipher,
    keyVersion: 1,
    version: 2,
  });
});

it('rejects a rotation whose snapshot misses newly created ciphertext', async () => {
  const { vaultId, key } = await setup();
  const snapshot = await prepare(vaultId, key);
  const added = await admin.createEntry(
    { title: 'Added after snapshot' },
    { vaultId, vaultKey: key },
  );
  expect(added.res.statusCode).toBe(201);
  expect(
    (await admin.req('POST', `/vaults/${vaultId}/rotate`, snapshot.body)).json().error.code,
  ).toBe('incomplete_rotation');
  expect(await admin.readEntry(vaultId, added.entryId, key)).toEqual({
    title: 'Added after snapshot',
  });
});

it('serializes ciphertext creation and edits against rotation instead of accepting stale-key writes', async () => {
  const createdVault = await setup();
  const snapshot = await prepare(createdVault.vaultId, createdVault.key);
  const [rotated, created] = await Promise.all([
    admin.req('POST', `/vaults/${createdVault.vaultId}/rotate`, snapshot.body),
    admin.createEntry(
      { title: 'Concurrent create' },
      { vaultId: createdVault.vaultId, vaultKey: createdVault.key },
    ),
  ]);
  expect([200, 409]).toContain(rotated.statusCode);
  expect([201, 409]).toContain(created.res.statusCode);
  expect(rotated.statusCode === 200 && created.res.statusCode === 201).toBe(false);
  if (created.res.statusCode === 201)
    expect(await admin.readEntry(createdVault.vaultId, created.entryId, createdVault.key)).toEqual({
      title: 'Concurrent create',
    });

  const editedVault = await setup();
  const editSnapshot = await prepare(editedVault.vaultId, editedVault.key);
  const encrypted = await encryptEntry(
    { title: 'Concurrent edit' },
    editedVault.key,
    editedVault.vaultId,
    editedVault.entryId,
    1,
  );
  const [rotation, edit] = await Promise.all([
    admin.req('POST', `/vaults/${editedVault.vaultId}/rotate`, editSnapshot.body),
    admin.req('PUT', `/vaults/${editedVault.vaultId}/entries/${editedVault.entryId}`, {
      ...encrypted,
      expectedVersion: 1,
    }),
  ]);
  expect([200, 409]).toContain(rotation.statusCode);
  expect([200, 409]).toContain(edit.statusCode);
  expect(rotation.statusCode === 200 && edit.statusCode === 200).toBe(false);
  expect(
    await admin.readEntry(
      editedVault.vaultId,
      editedVault.entryId,
      rotation.statusCode === 200 ? editSnapshot.newKey : editedVault.key,
    ),
  ).toEqual({ title: edit.statusCode === 200 ? 'Concurrent edit' : 'Before' });
});
