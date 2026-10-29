import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import { createVaultKey, sealVaultKeyFor, signKeyGrant } from '@arklock/crypto';
import { connect } from '../src/db/connect.js';
import { spaceMembers, spaces, settings, vaultKeys, vaults } from '../src/db/schema.js';
import { DEFAULT_SPACE_ID } from '../src/spaces.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let bob: TestClient;
let outsider: TestClient;
let vaultId: string;
let key: Uint8Array;
let entryId: string;
let privateId: string;
let originalEnvelope: string;

beforeAll(async () => {
  fixture = await createTestApp();
  const { app } = fixture;
  admin = new TestClient(app, 'spaces-admin@example.com', 'spaces-password-1234');
  await admin.register();
  await admin.login();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  bob = new TestClient(app, 'spaces-bob@example.com', 'spaces-password-1234');
  outsider = new TestClient(app, 'spaces-other@example.com', 'spaces-password-1234');
  for (const client of [bob, outsider]) {
    await client.register();
    await client.login();
  }
});
afterAll(async () => {
  const { app } = fixture;
  await app.close();
});

describe('corporate spaces', () => {
  it('keeps the default space public while vault permissions and keys remain separate', async () => {
    expect((await bob.req('GET', '/spaces')).json()).toEqual([
      expect.objectContaining({ id: DEFAULT_SPACE_ID, publicToOrg: true, isDefault: true }),
    ]);
    expect((await bob.req('POST', '/spaces', { name: 'Refused' })).statusCode).toBe(403);
    const made = await admin.createSharedVault('Legacy team');
    expect(made.res.statusCode).toBe(201);
    vaultId = made.id;
    key = made.key;
    expect((await admin.vaults()).find((v) => v.id === vaultId)?.spaceId).toBe(DEFAULT_SPACE_ID);
    expect((await bob.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(404);
    expect((await admin.addMember(vaultId, bob, 'reader', key)).statusCode).toBe(204);
    const item = await admin.createEntry({ title: 'Preserved secret' }, { vaultId, vaultKey: key });
    entryId = item.entryId;
    expect((await bob.req('GET', `/vaults/${vaultId}/entries/${entryId}`)).statusCode).toBe(200);
    originalEnvelope = JSON.stringify(
      await fixture.database.db.select().from(vaultKeys).where(eq(vaultKeys.vaultId, vaultId)),
    );
  });

  it('hides a vault with an already issued key until explicit private-space membership exists', async () => {
    const created = await admin.req('POST', '/spaces', { name: 'Private department' });
    expect(created.statusCode).toBe(201);
    privateId = created.json().id;
    expect((await admin.req('GET', `/spaces/${privateId}`)).json().publicToOrg).toBe(false);
    expect(
      (
        await admin.req('PUT', `/spaces/${DEFAULT_SPACE_ID}/vaults/${vaultId}`, {
          targetSpaceId: privateId,
        })
      ).statusCode,
    ).toBe(200);
    expect((await bob.vaults()).some((v) => v.id === vaultId)).toBe(false);
    expect((await bob.req('GET', `/vaults/${vaultId}/entries/${entryId}`)).statusCode).toBe(404);
    expect((await bob.req('GET', `/vaults/${vaultId}/attachments`)).statusCode).toBe(404);
    expect((await bob.req('GET', `/spaces/${privateId}`)).statusCode).toBe(404);
    expect(
      JSON.stringify(
        await fixture.database.db.select().from(vaultKeys).where(eq(vaultKeys.vaultId, vaultId)),
      ),
    ).toBe(originalEnvelope);
    expect(
      (await admin.req('PUT', `/spaces/${privateId}/users/${bob.userId}`, { role: 'member' }))
        .statusCode,
    ).toBe(204);
    expect((await bob.req('GET', `/vaults/${vaultId}/entries/${entryId}`)).statusCode).toBe(200);
    expect(await bob.readEntry(vaultId, entryId, key)).toEqual({ title: 'Preserved secret' });
    await admin.req('DELETE', `/spaces/${privateId}/users/${bob.userId}`);
    expect((await bob.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(404);
    expect((await admin.addMember(vaultId, outsider, 'reader', key)).statusCode).toBe(404);
  });

  it('applies live group membership and gives a space administrator metadata rights without vault keys', async () => {
    const group = (
      await admin.req('POST', '/admin/circles', { name: 'Space group', description: '' })
    ).json();
    await admin.req('PUT', `/admin/circles/${group.id}/members/${bob.userId}`);
    await admin.req('PUT', `/spaces/${privateId}/circles/${group.id}`, { role: 'admin' });
    expect(
      (await bob.req('PATCH', `/spaces/${privateId}`, { description: 'Managed by department' }))
        .statusCode,
    ).toBe(200);
    expect((await bob.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(200);
    await admin.req('PUT', `/spaces/${privateId}/users/${outsider.userId}`, { role: 'admin' });
    expect((await outsider.req('GET', `/spaces/${privateId}`)).json().canManage).toBe(true);
    expect((await outsider.req('GET', '/directory/circles')).statusCode).toBe(200);
    expect((await outsider.req('GET', '/directory/users?q=spaces')).statusCode).toBe(200);
    expect((await outsider.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(404);
    expect((await outsider.vaults()).some((v) => v.id === vaultId)).toBe(false);
    await admin.req('DELETE', `/admin/circles/${group.id}/members/${bob.userId}`);
    expect((await bob.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(404);
    await admin.req('PUT', `/spaces/${privateId}/users/${bob.userId}`, { role: 'member' });
  });

  it('archives without data loss, protects the default space, and moves vault metadata without reissuing keys', async () => {
    expect(
      (await admin.req('PATCH', `/spaces/${DEFAULT_SPACE_ID}`, { archived: true })).statusCode,
    ).toBe(409);
    expect((await admin.req('DELETE', `/spaces/${privateId}`)).statusCode).toBe(409);
    await admin.req('PATCH', `/spaces/${privateId}`, { archived: true });
    expect((await admin.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(404);
    expect((await bob.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(404);
    await admin.req('PATCH', `/spaces/${privateId}`, { archived: false });
    expect((await bob.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(200);
    await admin.req('PUT', `/spaces/${privateId}/vaults/${vaultId}`, {
      targetSpaceId: DEFAULT_SPACE_ID,
    });
    expect((await admin.req('DELETE', `/spaces/${privateId}`)).statusCode).toBe(204);
    expect(
      JSON.stringify(
        await fixture.database.db.select().from(vaultKeys).where(eq(vaultKeys.vaultId, vaultId)),
      ),
    ).toBe(originalEnvelope);
    expect(await bob.readEntry(vaultId, entryId, key)).toEqual({ title: 'Preserved secret' });
  });

  it('creates a vault in the chosen space only for its members', async () => {
    const id = (await admin.req('POST', '/spaces', { name: 'New private' })).json().id;
    const targetId = crypto.randomUUID();
    const vaultKey = createVaultKey();
    const sealedKey = await sealVaultKeyFor(vaultKey, admin.publicKey, targetId, admin.userId, 1);
    const signature = await signKeyGrant(
      admin.signPrivateKey,
      targetId,
      admin.userId,
      1,
      sealedKey,
    );
    const made = await admin.req('POST', '/vaults', {
      id: targetId,
      spaceId: id,
      name: 'Selected',
      sealedKey,
      signature,
    });
    expect(made.statusCode).toBe(201);
    expect((await admin.vaults()).find((v) => v.id === targetId)?.spaceId).toBe(id);
    await admin.req('DELETE', `/spaces/${id}/users/${admin.userId}`);
    const blockedId = crypto.randomUUID();
    const blockedKey = await sealVaultKeyFor(vaultKey, admin.publicKey, blockedId, admin.userId, 1);
    const blockedSig = await signKeyGrant(
      admin.signPrivateKey,
      blockedId,
      admin.userId,
      1,
      blockedKey,
    );
    expect(
      (
        await admin.req('POST', '/vaults', {
          id: blockedId,
          spaceId: id,
          name: 'Blocked',
          sealedKey: blockedKey,
          signature: blockedSig,
        })
      ).statusCode,
    ).toBe(404);
    expect((await admin.req('GET', `/spaces/${id}`)).json().canManage).toBe(true);
    expect((await admin.req('GET', `/vaults/${targetId}/tree`)).statusCode).toBe(404);
  });

  it('remembers the space to open after sign-in, only among spaces the person belongs to', async () => {
    const id = (await admin.req('POST', '/spaces', { name: 'Home choice' })).json().id;
    expect((await admin.req('PUT', '/auth/preferences', { homeSpace: id })).statusCode).toBe(204);
    expect((await admin.req('GET', '/auth/me')).json().user.homeSpace).toBe(id);
    const pref = (body: object) => bob.req('PUT', '/auth/preferences', body);
    expect((await pref({ homeSpace: id })).statusCode).toBe(403);
    expect((await pref({ homeSpace: 'personal' })).statusCode).toBe(204);
    expect((await bob.req('GET', '/auth/me')).json().user.homeSpace).toBe('personal');
    expect((await pref({ homeSpace: null })).statusCode).toBe(204);
    expect((await pref({ homeSpace: 'elsewhere' })).statusCode).toBe(400);
    expect((await pref({})).statusCode).toBe(400);
    // тема по-прежнему сохраняется отдельно
    expect((await pref({ theme: 'night' })).statusCode).toBe(204);
    expect((await bob.req('GET', '/auth/me')).json().user).toMatchObject({
      theme: 'night',
      homeSpace: null,
    });
  });
});

it('backfills legacy shared vaults into the public default space without changing membership or key bytes', async () => {
  const database = await connect('pglite:memory');
  const directory = new URL('../drizzle/', import.meta.url);
  try {
    const migrations = (await readdir(directory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    for (const name of migrations.filter((name) => name < '0004')) {
      for (const statement of (await readFile(new URL(name, directory), 'utf8')).split(
        '--> statement-breakpoint',
      ))
        if (statement.trim()) await database.db.execute(sql.raw(statement));
    }
    const userId = crypto.randomUUID();
    const legacyId = crypto.randomUUID();
    const personalId = crypto.randomUUID();
    await database.db.execute(
      sql`insert into users (id,email,display_name,role,kdf,kdf_salt,auth_salt,auth_hash,public_key,sign_public_key,wrapped_private_key,wrapped_sign_private_key,recovery_salt,recovery_hash,recovery_wrapped_private_key,recovery_wrapped_sign_private_key) values (${userId},'legacy@example.com','Legacy','member','{}','opaque','opaque','opaque','opaque','opaque','opaque','opaque','opaque','opaque','opaque','opaque')`,
    );
    await database.db.execute(
      sql`insert into vaults (id,kind,created_by) values (${legacyId},'shared',${userId}),(${personalId},'locker',${userId})`,
    );
    await database.db.execute(
      sql`insert into vault_members (vault_id,user_id,role) values (${legacyId},${userId},'owner')`,
    );
    await database.db.execute(
      sql`insert into vault_keys (vault_id,user_id,key_version,sealed_key,granted_by,signature) values (${legacyId},${userId},1,'opaque-sealed-key',${userId},'opaque-signature')`,
    );
    for (const name of migrations.filter((name) => name >= '0004')) {
      for (const statement of (await readFile(new URL(name, directory), 'utf8')).split(
        '--> statement-breakpoint',
      ))
        if (statement.trim()) await database.db.execute(sql.raw(statement));
    }
    expect(
      (await database.db.select().from(vaults).where(eq(vaults.id, legacyId)))[0]?.spaceId,
    ).toBe(DEFAULT_SPACE_ID);
    expect(
      (await database.db.select().from(vaults).where(eq(vaults.id, personalId)))[0]?.spaceId,
    ).toBeNull();
    expect(
      (await database.db.select().from(spaces).where(eq(spaces.id, DEFAULT_SPACE_ID)))[0]
        ?.publicToOrg,
    ).toBe(true);
    expect(
      (await database.db.select().from(vaultKeys).where(eq(vaultKeys.vaultId, legacyId)))[0],
    ).toMatchObject({ sealedKey: 'opaque-sealed-key', signature: 'opaque-signature', userId });
    expect(await database.db.select().from(spaceMembers)).toEqual([]);
  } finally {
    await database.close();
  }
});
