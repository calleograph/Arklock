import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CryptoAuthError,
  createVaultKey,
  decrypt,
  decryptAttachment,
  encrypt,
  encryptAttachment,
  encryptedSize,
  generateKey,
  rewrapEntry,
  sealVaultKeyFor,
  signKeyGrant,
  ctx as aad,
  utf8,
  fromUtf8,
} from '@arklock/crypto';
import type { AttachmentRecord, EntryRecord } from '@arklock/contracts';
import { BlobStore } from '../src/blobs.js';
import { attachments, settings } from '../src/db/schema.js';
import { runMaintenance } from '../src/maintenance.js';
import { sweepBlobs } from '../src/routes/attachments.js';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let blobDir: string;
let admin: TestClient;
let bob: TestClient;
let carol: TestClient;
let vaultId: string;
let vk: Uint8Array;
let entryId: string;

const SECRET_TEXT = 'very-secret-file-content-0123456789';

/** Клиентская часть: шифрует файл новым ключом вложения и готовит метаданные. */
async function prepare(name: string, content: Uint8Array, keyVersion = 1, key = vk) {
  const id = crypto.randomUUID();
  const ak = generateKey();
  const wrappedKey = await encrypt(key, ak, aad('att-key', vaultId, id, keyVersion));
  const metaCipher = await encrypt(
    ak,
    utf8(JSON.stringify({ name, type: 'text/plain', size: content.length })),
    aad('att-meta', vaultId, id),
  );
  const file = await encryptAttachment(ak, id, content);
  return { id, ak, wrappedKey, metaCipher, file, keyVersion };
}

const put = (c: TestClient, url: string, body: Uint8Array) =>
  app.inject({
    method: 'PUT',
    url: '/api/v1' + url,
    headers: { ...c.authHeader(), 'content-type': 'application/octet-stream' },
    payload: Buffer.from(body),
  });

async function upload(c: TestClient, p: Awaited<ReturnType<typeof prepare>>, entry = entryId) {
  const reg = await c.req('POST', `/vaults/${vaultId}/entries/${entry}/attachments`, {
    id: p.id,
    wrappedKey: p.wrappedKey,
    metaCipher: p.metaCipher,
    keyVersion: p.keyVersion,
    size: p.file.length,
  });
  if (reg.statusCode !== 201) return { reg, up: undefined };
  const up = await put(c, `/vaults/${vaultId}/attachments/${p.id}/content`, p.file);
  return { reg, up };
}

beforeAll(async () => {
  blobDir = mkdtempSync(path.join(tmpdir(), 'arklock-blobs-'));
  ({ app, database } = await createTestApp({ BLOB_DIR: blobDir }));
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  expect((await admin.register()).statusCode).toBe(201);
  await database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  bob = new TestClient(app, 'bob@example.com', 'bob-password-12345');
  carol = new TestClient(app, 'carol@example.com', 'carol-password-1234');
  for (const c of [bob, carol]) expect((await c.register()).statusCode).toBe(201);
  for (const c of [admin, bob, carol]) await c.login();
  const v = await admin.createSharedVault('Files');
  vaultId = v.id;
  vk = v.key;
  await admin.addMember(vaultId, bob, 'reader', vk);
  entryId = (await admin.createEntry({ title: 'Doc' }, { vaultId, vaultKey: vk })).entryId;
});

afterAll(async () => {
  await app.close();
  rmSync(blobDir, { recursive: true, force: true });
});

describe('attachments', () => {
  it('stores only ciphertext and returns it intact; the key never reaches the server', async () => {
    const content = utf8(SECRET_TEXT);
    const p = await prepare('passport.txt', content);
    const { reg, up } = await upload(admin, p);
    expect(reg.statusCode).toBe(201);
    expect(up!.statusCode).toBe(204);

    // на диске — только шифртекст
    const stored = readFileSync(path.join(blobDir, p.id.slice(0, 2), `${p.id}.k1`));
    expect(Buffer.compare(stored, Buffer.from(p.file))).toBe(0);
    expect(stored.includes(Buffer.from(SECRET_TEXT))).toBe(false);

    const list = (
      await admin.req('GET', `/vaults/${vaultId}/entries/${entryId}/attachments`)
    ).json() as AttachmentRecord[];
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('passport');
    const dl = await admin.req('GET', `/vaults/${vaultId}/attachments/${p.id}/content`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['cache-control']).toBe('no-store');

    // клиент: разворачивает ключ, читает метаданные и файл
    const ak = await decrypt(vk, list[0]!.wrappedKey, aad('att-key', vaultId, p.id, 1));
    const meta = JSON.parse(
      fromUtf8(await decrypt(ak, list[0]!.metaCipher, aad('att-meta', vaultId, p.id))),
    );
    expect(meta.name).toBe('passport.txt');
    const plain = await decryptAttachment(ak, p.id, new Uint8Array(dl.rawPayload));
    expect(fromUtf8(plain)).toBe(SECRET_TEXT);
    // перестановка файла под другим id — неуспешная проверка подлинности
    await expect(decryptAttachment(ak, crypto.randomUUID(), p.file)).rejects.toBeInstanceOf(
      CryptoAuthError,
    );
  });

  it('size must match the declaration exactly; a failed upload leaves no file and cannot be read', async () => {
    const p = await prepare('x.txt', utf8('abc'));
    const reg = await admin.req('POST', `/vaults/${vaultId}/entries/${entryId}/attachments`, {
      id: p.id,
      wrappedKey: p.wrappedKey,
      metaCipher: p.metaCipher,
      keyVersion: 1,
      size: p.file.length,
    });
    expect(reg.statusCode).toBe(201);
    const tooBig = await put(
      admin,
      `/vaults/${vaultId}/attachments/${p.id}/content`,
      new Uint8Array(p.file.length + 5),
    );
    expect(tooBig.statusCode).toBe(400);
    const short = await put(
      admin,
      `/vaults/${vaultId}/attachments/${p.id}/content`,
      p.file.slice(0, 10),
    );
    expect(short.statusCode).toBe(400);
    expect(existsSync(path.join(blobDir, p.id.slice(0, 2), `${p.id}.k1`))).toBe(false);
    expect(existsSync(path.join(blobDir, p.id.slice(0, 2), `${p.id}.k1.part`))).toBe(false);
    // не готово — не видно и не скачивается
    const list = (
      await admin.req('GET', `/vaults/${vaultId}/entries/${entryId}/attachments`)
    ).json() as AttachmentRecord[];
    expect(list.some((a) => a.id === p.id)).toBe(false);
    expect(
      (await admin.req('GET', `/vaults/${vaultId}/attachments/${p.id}/content`)).statusCode,
    ).toBe(404);
    // повторная корректная загрузка проходит
    expect(
      (await put(admin, `/vaults/${vaultId}/attachments/${p.id}/content`, p.file)).statusCode,
    ).toBe(204);
    // повторная загрузка поверх готовой отклоняется
    expect(
      (await put(admin, `/vaults/${vaultId}/attachments/${p.id}/content`, p.file)).statusCode,
    ).toBe(409);
  });

  it('enforces roles: readers download but cannot add or delete; outsiders see nothing', async () => {
    const list = (
      await admin.req('GET', `/vaults/${vaultId}/entries/${entryId}/attachments`)
    ).json() as AttachmentRecord[];
    const id = list[0]!.id;
    expect((await bob.req('GET', `/vaults/${vaultId}/attachments/${id}/content`)).statusCode).toBe(
      200,
    );
    const p = await prepare('n.txt', utf8('1'));
    expect((await upload(bob, p)).reg.statusCode).toBe(403);
    expect((await bob.req('DELETE', `/vaults/${vaultId}/attachments/${id}`)).statusCode).toBe(403);
    for (const path of [
      `/vaults/${vaultId}/entries/${entryId}/attachments`,
      `/vaults/${vaultId}/attachments/${id}/content`,
    ])
      expect((await carol.req('GET', path)).statusCode).toBe(404);
    expect((await carol.req('DELETE', `/vaults/${vaultId}/attachments/${id}`)).statusCode).toBe(
      404,
    );
    // идентификатор из другого хранилища не работает
    const other = await admin.createSharedVault('Other');
    expect(
      (await admin.req('GET', `/vaults/${other.id}/attachments/${id}/content`)).statusCode,
    ).toBe(404);
  });

  it('applies the per-file limit and the vault quota', async () => {
    await database.db
      .insert(settings)
      .values({ key: 'storage.attachmentMaxMiB', value: 1 })
      .onConflictDoNothing();
    const big = await prepare('big.bin', new Uint8Array(2 * 1024 * 1024));
    const res = await upload(admin, big);
    expect(res.reg.statusCode).toBe(413);
    expect(res.reg.json().error.code).toBe('attachment_too_large');
    expect(encryptedSize(2 * 1024 * 1024)).toBeGreaterThan(1024 * 1024);

    await database.db.delete(settings);
    await database.db.insert(settings).values([
      { key: 'registration.mode', value: 'open' },
      { key: 'storage.vaultQuotaMiB', value: 1 },
    ]);
    const quotaVault = await admin.createSharedVault('Quota');
    const e = await admin.createEntry(
      { title: 'q' },
      { vaultId: quotaVault.id, vaultKey: quotaVault.key },
    );
    const mk = async (size: number) => {
      const id = crypto.randomUUID();
      const ak = generateKey();
      return {
        id,
        wrappedKey: await encrypt(quotaVault.key, ak, aad('att-key', quotaVault.id, id, 1)),
        metaCipher: await encrypt(ak, utf8('{}'), aad('att-meta', quotaVault.id, id)),
        keyVersion: 1,
        size,
      };
    };
    const reg = (body: object) =>
      admin.req('POST', `/vaults/${quotaVault.id}/entries/${e.entryId}/attachments`, body);
    expect((await reg(await mk(700 * 1024))).statusCode).toBe(201);
    const second = await reg(await mk(700 * 1024));
    expect(second.statusCode).toBe(413);
    expect(second.json().error.code).toBe('quota_exceeded');
    await database.db.delete(settings);
    await database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  });

  it('deleting removes the file; trashing keeps it; purging the entry removes it', async () => {
    const e = await admin.createEntry({ title: 'tmp' }, { vaultId, vaultKey: vk });
    const p = await prepare('t.txt', utf8('tmp'));
    expect((await upload(admin, p, e.entryId)).up!.statusCode).toBe(204);
    const file = path.join(blobDir, p.id.slice(0, 2), `${p.id}.k1`);
    expect(existsSync(file)).toBe(true);

    const rec = (
      await admin.req('GET', `/vaults/${vaultId}/entries/${e.entryId}`)
    ).json() as EntryRecord;
    expect(
      (
        await admin.req(
          'DELETE',
          `/vaults/${vaultId}/entries/${e.entryId}?expectedVersion=${rec.version}`,
        )
      ).statusCode,
    ).toBe(204);
    expect(existsSync(file)).toBe(true);
    // из корзины файл не отдаётся
    expect(
      (await admin.req('GET', `/vaults/${vaultId}/attachments/${p.id}/content`)).statusCode,
    ).toBe(404);
    expect(
      (await admin.req('DELETE', `/vaults/${vaultId}/entries/${e.entryId}?purge=1`)).statusCode,
    ).toBe(204);
    expect(existsSync(file)).toBe(false);
    expect((await database.db.select().from(attachments)).some((a) => a.id === p.id)).toBe(false);

    const e2 = await admin.createEntry({ title: 'tmp2' }, { vaultId, vaultKey: vk });
    const p2 = await prepare('t2.txt', utf8('tmp2'));
    await upload(admin, p2, e2.entryId);
    const f2 = path.join(blobDir, p2.id.slice(0, 2), `${p2.id}.k1`);
    expect((await admin.req('DELETE', `/vaults/${vaultId}/attachments/${p2.id}`)).statusCode).toBe(
      204,
    );
    expect(existsSync(f2)).toBe(false);
  });

  it('reconciliation removes orphan files and stale pending registrations', async () => {
    const orphan = crypto.randomUUID();
    const dir = path.join(blobDir, orphan.slice(0, 2));
    const orphanFile = path.join(dir, `${orphan}.k1`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(orphanFile, 'junk');
    const p = await prepare('pending.txt', utf8('p'));
    await admin.req('POST', `/vaults/${vaultId}/entries/${entryId}/attachments`, {
      id: p.id,
      wrappedKey: p.wrappedKey,
      metaCipher: p.metaCipher,
      keyVersion: 1,
      size: p.file.length,
    });
    // сразу после создания: сирота без записи удаляется, свежая регистрация остаётся
    const r1 = await sweepBlobs({ db: database.db, blobs: new BlobStore(blobDir) });
    expect(r1.orphans).toBeGreaterThanOrEqual(1);
    expect(existsSync(orphanFile)).toBe(false);
    expect(r1.pending).toBe(0);
    // через сутки — незавершённая регистрация удаляется
    const later = new Date(Date.now() + 86_400_000);
    const r2 = await runMaintenance(database.db, later, new BlobStore(blobDir));
    expect(r2.files.pending).toBeGreaterThanOrEqual(1);
    expect((await database.db.select().from(attachments)).some((a) => a.id === p.id)).toBe(false);
  });
});

describe('attachments and key rotation', () => {
  it('rotation re-encrypts the files under new keys; the old key and old files stop working', async () => {
    const v = await admin.createSharedVault('Rot');
    const e = await admin.createEntry(
      { title: 'r', password: 'p' },
      { vaultId: v.id, vaultKey: v.key },
    );
    vaultId = v.id;
    vk = v.key;
    const content = utf8('rotating file');
    const p = await prepare('r.txt', content, 1, v.key);
    expect((await upload(admin, p, e.entryId)).up!.statusCode).toBe(204);

    const newKey = createVaultKey();
    const rec = (
      await admin.req('GET', `/vaults/${v.id}/entries/${e.entryId}`)
    ).json() as EntryRecord;
    const entry = await rewrapEntry(rec, v.key, newKey, v.id, e.entryId, 2);
    const sealedKey = await sealVaultKeyFor(newKey, admin.publicKey, v.id, admin.userId, 2);
    const keys = [
      {
        userId: admin.userId,
        sealedKey,
        signature: await signKeyGrant(admin.signPrivateKey, v.id, admin.userId, 2, sealedKey),
      },
    ];
    // клиент: новый ключ вложения, перешифрованный файл
    const ak2 = generateKey();
    const newFile = await encryptAttachment(ak2, p.id, content);
    const newWrapped = await encrypt(newKey, ak2, aad('att-key', v.id, p.id, 2));
    const newMeta = await encrypt(ak2, utf8('{"name":"r.txt"}'), aad('att-meta', v.id, p.id));
    const body = {
      newKeyVersion: 2,
      keys,
      entries: [{ id: e.entryId, ...entry }],
      revisions: [],
      branches: [],
      attachments: [{ id: p.id, wrappedKey: newWrapped, metaCipher: newMeta }],
    };

    // без подготовленного файла ротация отклоняется
    const early = await admin.req('POST', `/vaults/${v.id}/rotate`, body);
    expect(early.statusCode).toBe(409);
    // без вложения в наборе — тоже
    const noAtt = await admin.req('POST', `/vaults/${v.id}/rotate`, { ...body, attachments: [] });
    expect(noAtt.statusCode).toBe(409);
    // файл неверного размера не принимается
    expect(
      (await put(admin, `/vaults/${v.id}/attachments/${p.id}/rotation`, newFile.slice(0, 5)))
        .statusCode,
    ).toBe(400);
    // участник без прав администратора не готовит файлы
    expect(
      (await put(bob, `/vaults/${v.id}/attachments/${p.id}/rotation`, newFile)).statusCode,
    ).toBe(404);
    expect(
      (await put(admin, `/vaults/${v.id}/attachments/${p.id}/rotation`, newFile)).statusCode,
    ).toBe(204);
    // пока ротация не применена, скачивается прежняя версия
    const before = await admin.req('GET', `/vaults/${v.id}/attachments/${p.id}/content`);
    expect(Buffer.compare(before.rawPayload, Buffer.from(p.file))).toBe(0);

    expect((await admin.req('POST', `/vaults/${v.id}/rotate`, body)).statusCode).toBe(200);
    const after = await admin.req('GET', `/vaults/${v.id}/attachments/${p.id}/content`);
    expect(Buffer.compare(after.rawPayload, Buffer.from(newFile))).toBe(0);
    const list = (
      await admin.req('GET', `/vaults/${v.id}/entries/${e.entryId}/attachments`)
    ).json() as AttachmentRecord[];
    expect(list[0]!.keyVersion).toBe(2);
    const unwrapped = await decrypt(newKey, list[0]!.wrappedKey, aad('att-key', v.id, p.id, 2));
    expect(
      fromUtf8(await decryptAttachment(unwrapped, p.id, new Uint8Array(after.rawPayload))),
    ).toBe('rotating file');
    // прежний ключ вложения и прежний ключ хранилища больше не подходят
    await expect(
      decryptAttachment(p.ak, p.id, new Uint8Array(after.rawPayload)),
    ).rejects.toBeInstanceOf(CryptoAuthError);
    await expect(
      decrypt(v.key, list[0]!.wrappedKey, aad('att-key', v.id, p.id, 2)),
    ).rejects.toBeInstanceOf(CryptoAuthError);
    expect(existsSync(path.join(blobDir, p.id.slice(0, 2), `${p.id}.k1`))).toBe(false);
    expect(existsSync(path.join(blobDir, p.id.slice(0, 2), `${p.id}.k2`))).toBe(true);
  });
});

describe('attachments disabled', () => {
  it('reports that the storage is not configured', async () => {
    const t = await createTestApp();
    const c = new TestClient(t.app, 'only@example.com', 'only-password-123');
    expect((await c.register()).statusCode).toBe(201);
    await c.login();
    const { locker, key } = await c.lockerKey();
    const entry = await c.createEntry({ title: 'a' });
    const ak = generateKey();
    const id = crypto.randomUUID();
    const res = await c.req('POST', `/vaults/${locker.id}/entries/${entry.entryId}/attachments`, {
      id,
      wrappedKey: await encrypt(key, ak, aad('att-key', locker.id, id, 1)),
      metaCipher: await encrypt(ak, utf8('{}'), aad('att-meta', locker.id, id)),
      keyVersion: 1,
      size: 100,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('storage_unavailable');
    const policy = (await c.req('GET', '/auth/policy')).json();
    expect(policy['storage.enabled']).toBe(false);
    await t.app.close();
  });
});
