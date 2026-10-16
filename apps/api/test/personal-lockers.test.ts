import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createVaultKey, sealVaultKeyFor, signKeyGrant } from '@arklock/crypto';
import { entries, settings, vaultKeys, vaults } from '../src/db/schema.js';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let admin: TestClient;
let bob: TestClient;
let saved: { entryId: string; vaultId: string };
let locker: { vaultId: string; sealedKey: string; signature: string };

beforeAll(async () => {
  ({ app, database } = await createTestApp({}, false));
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  expect((await admin.register()).statusCode).toBe(201);
  await database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  bob = new TestClient(app, 'bob@example.com', 'bob-password-12345');
  expect((await bob.register()).statusCode).toBe(201);
  await bob.login();
  await admin.login();
  const vaultId = crypto.randomUUID();
  const sealedKey = await sealVaultKeyFor(createVaultKey(), bob.publicKey, vaultId, bob.userId, 1);
  locker = {
    vaultId,
    sealedKey,
    signature: await signKeyGrant(bob.signPrivateKey, vaultId, bob.userId, 1, sealedKey),
  };
});
afterAll(async () => {
  await app.close();
});

const policy = (body: Record<string, unknown>) => admin.req('PUT', '/admin/settings', body);

describe('corporate personal-vault policy', () => {
  it('defaults to corporate-only, bootstraps a shared vault, and refuses personal provisioning', async () => {
    expect((await bob.req('GET', '/auth/policy')).json()['vaults.personalLockers']).toBe(false);
    expect(await bob.vaults()).toEqual([]);
    expect((await admin.vaults()).map((v) => v.kind)).toEqual(['shared']);
    expect(await database.db.select().from(vaults).where(eq(vaults.kind, 'locker'))).toEqual([]);
    expect((await bob.req('POST', '/auth/locker', locker)).statusCode).toBe(403);
  });

  it('allows individual provisioning, validates grants, and preserves data after revocation', async () => {
    expect((await policy({ 'vaults.personalLockerUsers': [bob.userId] })).statusCode).toBe(200);
    expect(
      (await bob.req('POST', '/auth/locker', { ...locker, vaultId: crypto.randomUUID() }))
        .statusCode,
    ).toBe(400);
    expect((await bob.req('POST', '/auth/locker', locker)).statusCode).toBe(201);
    expect((await bob.req('POST', '/auth/locker', locker)).statusCode).toBe(409);
    const made = await bob.createEntry({ title: 'preserved personal data' });
    expect(made.res.statusCode).toBe(201);
    saved = made;
    expect((await policy({ 'vaults.personalLockerUsers': [] })).statusCode).toBe(200);
    expect(await bob.vaults()).toEqual([]);
    expect(
      (await bob.req('GET', `/vaults/${saved.vaultId}/entries/${saved.entryId}`)).statusCode,
    ).toBe(404);
    expect((await bob.req('GET', `/vaults/${saved.vaultId}/tree`)).statusCode).toBe(404);
    expect((await bob.req('GET', `/vaults/${saved.vaultId}/pending-keys`)).statusCode).toBe(404);
    expect((await bob.req('GET', `/vaults/${saved.vaultId}/attachments`)).statusCode).toBe(404);
    expect((await bob.createBranch(saved.vaultId, made.key, 'refused')).res.statusCode).toBe(404);
    expect((await bob.req('GET', '/auth/policy')).json()['vaults.personalDataRestricted']).toBe(
      true,
    );
    expect(
      await database.db.select().from(entries).where(eq(entries.id, saved.entryId)),
    ).toHaveLength(1);
    expect(
      await database.db.select().from(vaultKeys).where(eq(vaultKeys.vaultId, saved.vaultId)),
    ).toHaveLength(1);
  });

  it('provides admin metadata only and restores owner read after temporary permission', async () => {
    const response = await admin.req('GET', '/admin/settings/personal-lockers');
    expect(response.statusCode).toBe(200);
    const person = response.json().users.find((u: { id: string }) => u.id === bob.userId);
    expect(person.allowed).toBe(false);
    expect(person.lockers[0].entries).toBe(1);
    expect(response.body).not.toContain(locker.sealedKey);
    expect((await bob.req('GET', '/admin/settings/personal-lockers')).statusCode).toBe(403);
    await policy({ 'vaults.personalLockerUsers': [bob.userId] });
    expect(
      (await bob.req('GET', `/vaults/${saved.vaultId}/entries/${saved.entryId}`)).statusCode,
    ).toBe(200);
    expect(
      (await admin.req('GET', `/vaults/${saved.vaultId}/entries/${saved.entryId}`)).statusCode,
    ).toBe(404);
    await policy({ 'vaults.personalLockerUsers': [] });
  });

  it('recomputes group exceptions immediately and rejects nonexistent subjects', async () => {
    const group = (
      await admin.req('POST', '/admin/circles', { name: 'Personal users', description: '' })
    ).json();
    expect(
      (await admin.req('PUT', `/admin/circles/${group.id}/members/${bob.userId}`)).statusCode,
    ).toBe(204);
    await policy({ 'vaults.personalLockerCircles': [group.id] });
    expect((await bob.req('GET', '/auth/policy')).json()['vaults.personalLockers']).toBe(true);
    await admin.req('DELETE', `/admin/circles/${group.id}/members/${bob.userId}`);
    expect((await bob.req('GET', '/auth/policy')).json()['vaults.personalLockers']).toBe(false);
    expect((await policy({ 'vaults.personalLockerUsers': [crypto.randomUUID()] })).statusCode).toBe(
      400,
    );
    expect(
      (await policy({ 'vaults.personalLockerCircles': [crypto.randomUUID()] })).statusCode,
    ).toBe(400);
  });

  it('permits organization-wide opt-in without changing corporate access', async () => {
    await policy({ 'vaults.personalLockers': true });
    expect((await bob.req('GET', '/auth/policy')).json()['vaults.personalLockers']).toBe(true);
    expect((await bob.vaults()).some((v) => v.kind === 'locker')).toBe(true);
    await policy({ 'vaults.personalLockers': false });
    const corporate = (await admin.vaults())[0]!;
    const made = await admin.createEntry(
      { title: 'corporate data' },
      { vaultId: corporate.id, vaultKey: await admin.openVault(corporate) },
    );
    expect(made.res.statusCode).toBe(201);
  });
});
