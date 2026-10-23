import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createVaultKey,
  decryptBranchMeta,
  encryptBranchMeta,
  encryptBranchName,
  rewrapBranchMeta,
  rewrapBranchName,
} from '@arklock/crypto';
import type { BranchRecord } from '@arklock/contracts';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let owner: TestClient;
let reader: TestClient;
beforeAll(async () => {
  fixture = await createTestApp();
  owner = new TestClient(fixture.app, 'icons@example.com', 'icons-password-12345');
  await owner.register();
  await owner.login();
  reader = new TestClient(fixture.app, 'icons-reader@example.com', 'icons-password-12345');
  await fixture.database.db.execute(
    (await import('drizzle-orm'))
      .sql`insert into settings (key, value) values ('registration.mode', '"open"')`,
  );
  await reader.register();
  await reader.login();
});
afterAll(async () => fixture.app.close());

const tree = async (c: TestClient, vaultId: string) =>
  ((await c.req('GET', `/vaults/${vaultId}/tree`)).json() as { branches: BranchRecord[] }).branches;

it('a folder keeps an encrypted appearance that the server cannot read; it survives rotation', async () => {
  const vault = await owner.createSharedVault('Appearance');
  const id = crypto.randomUUID();
  const meta = JSON.stringify({ name: 'bank', color: 'green' });
  const made = await owner.req('POST', `/vaults/${vault.id}/branches`, {
    id,
    parentId: null,
    nameCipher: await encryptBranchName('Банки', vault.key, vault.id, id, 1),
    metaCipher: await encryptBranchMeta(meta, vault.key, vault.id, id, 1),
    keyVersion: 1,
  });
  expect(made.statusCode).toBe(201);
  // на сервере — только шифртекст: ни названия значка, ни цвета в открытом виде
  const rows = await fixture.database.db.execute(
    (await import('drizzle-orm')).sql`select meta_cipher from branches where id = ${id}`,
  );
  expect(JSON.stringify(rows)).not.toMatch(/bank|green/);
  let [b] = await tree(owner, vault.id);
  expect(await decryptBranchMeta(b!.metaCipher!, vault.key, vault.id, id, 1)).toBe(meta);

  // смена значка без ключа сейфа отклоняется; сброс к значку по умолчанию — null
  const other = JSON.stringify({ name: 'server', color: 'blue' });
  expect(
    (
      await owner.req('PATCH', `/vaults/${vault.id}/branches/${id}`, {
        metaCipher: await encryptBranchMeta(other, vault.key, vault.id, id, 1),
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await owner.req('PATCH', `/vaults/${vault.id}/branches/${id}`, {
        metaCipher: await encryptBranchMeta(other, vault.key, vault.id, id, 1),
        keyVersion: 1,
      })
    ).statusCode,
  ).toBe(200);
  [b] = await tree(owner, vault.id);
  expect(await decryptBranchMeta(b!.metaCipher!, vault.key, vault.id, id, 1)).toBe(other);
  // читатель сейфа значок не меняет
  expect((await owner.addMember(vault.id, reader, 'reader', vault.key)).statusCode).toBe(204);
  expect(
    (
      await reader.req('PATCH', `/vaults/${vault.id}/branches/${id}`, {
        metaCipher: null,
      })
    ).statusCode,
  ).toBe(403);

  // ротация: перешифрованное оформление сохраняется
  const next = createVaultKey();
  const rotate = await owner.req('POST', `/vaults/${vault.id}/rotate`, {
    newKeyVersion: 2,
    entries: [],
    revisions: [],
    branches: [
      {
        id,
        expectedVersion: b!.version,
        nameCipher: await rewrapBranchName(b!.nameCipher, vault.key, next, vault.id, id, 1, 2),
        metaCipher: await rewrapBranchMeta(b!.metaCipher!, vault.key, next, vault.id, id, 1, 2),
      },
    ],
    keys: [
      { userId: owner.userId, ...(await owner.keyFor(owner, vault.id, next, 2)) },
      { userId: reader.userId, ...(await owner.keyFor(reader, vault.id, next, 2)) },
    ],
  });
  expect(rotate.statusCode).toBe(200);
  [b] = await tree(owner, vault.id);
  expect(await decryptBranchMeta(b!.metaCipher!, next, vault.id, id, 2)).toBe(other);
  expect(
    (await owner.req('PATCH', `/vaults/${vault.id}/branches/${id}`, { metaCipher: null }))
      .statusCode,
  ).toBe(200);
  [b] = await tree(owner, vault.id);
  expect(b!.metaCipher).toBeNull();
});

it('a favourite folder is personal: only its owner sees it pinned, and only with access to the folder', async () => {
  const vault = await owner.createSharedVault('Favourites');
  const made = await owner.createBranch(vault.id, vault.key, 'Bank');
  expect(made.res.statusCode).toBe(201);
  const pin = (c: TestClient, method: 'PUT' | 'DELETE') =>
    c.req(method, `/vaults/${vault.id}/branches/${made.id}/pin`);
  // без доступа к сейфу закрепить нельзя
  expect((await pin(reader, 'PUT')).statusCode).toBe(404);
  expect((await owner.addMember(vault.id, reader, 'reader', vault.key)).statusCode).toBe(204);
  expect((await pin(owner, 'PUT')).statusCode).toBe(204);
  expect((await pin(owner, 'PUT')).statusCode).toBe(204); // повтор не ошибка
  expect((await tree(owner, vault.id))[0]!.pinned).toBe(true);
  expect((await tree(reader, vault.id))[0]!.pinned).toBe(false);
  expect((await pin(owner, 'DELETE')).statusCode).toBe(204);
  expect((await tree(owner, vault.id))[0]!.pinned).toBe(false);
  // удалённая папка уходит из избранного вместе с отметкой
  expect((await pin(reader, 'PUT')).statusCode).toBe(204);
  expect((await owner.req('DELETE', `/vaults/${vault.id}/branches/${made.id}`)).statusCode).toBe(
    204,
  );
  expect((await pin(reader, 'PUT')).statusCode).toBe(404);
});
