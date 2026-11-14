import { afterAll, beforeAll, expect, it } from 'vitest';
import { toBase64Url } from '@arklock/crypto';
import { entries, vaultMembers, vaults } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

/**
 * Личных сейфов больше нет. Сейф, оставшийся от прежних версий, не открывается никому, а владелец видит, сколько в нём
 * записей, и может удалить его сам, подтвердив мастер-паролем.
 */
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let owner: TestClient;
const lockerId = crypto.randomUUID();

beforeAll(async () => {
  fixture = await createTestApp({}, false);
  owner = new TestClient(fixture.app, 'leftover@example.com', 'leftover-password-12345');
  expect((await owner.register()).statusCode).toBe(201);
  await owner.login();
  // так выглядел личный сейф в 1.x: kind = locker, владелец — сам сотрудник
  const db = fixture.database.db;
  await db.insert(vaults).values({ id: lockerId, kind: 'locker', createdBy: owner.userId });
  await db.insert(vaultMembers).values({ vaultId: lockerId, userId: owner.userId, role: 'owner' });
  await db.insert(entries).values({
    id: crypto.randomUUID(),
    vaultId: lockerId,
    wrappedEntryKey: 'x',
    ciphertext: 'x',
    keyVersion: 1,
    createdBy: owner.userId,
  });
});
afterAll(async () => fixture.app.close());

it('a leftover personal vault is closed even to its owner, who sees the entry count', async () => {
  expect((await owner.vaults()).some((v) => v.id === lockerId)).toBe(false);
  expect((await owner.req('GET', `/vaults/${lockerId}/tree`)).statusCode).toBe(404);
  expect((await owner.req('GET', '/auth/policy')).json()).toMatchObject({
    'vaults.personalDataRestricted': true,
    'vaults.personalEntries': 1,
  });
});

it('only the owner erases it, with the master password', async () => {
  const erase = (authKey: string) =>
    owner.req('POST', '/auth/personal-vault/erase', { authKey, confirm: true });
  expect((await erase(toBase64Url(new Uint8Array(32)))).statusCode).toBe(401);
  const { keys } = await owner.derive();
  expect((await erase(toBase64Url(keys.authKey))).statusCode).toBe(204);
  expect((await owner.req('GET', '/auth/policy')).json()['vaults.personalEntries']).toBe(0);
  expect((await erase(toBase64Url(keys.authKey))).statusCode).toBe(404);
});
