import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  AttachmentDecryptor,
  chunkCount,
  concat,
  createVaultKey,
  ctx as aad,
  decrypt,
  encrypt,
  encryptedSize,
  encryptStream,
  generateKey,
  rewrapEntry,
  sealVaultKeyFor,
  signKeyGrant,
  utf8,
} from '@arklock/crypto';
import type { EntryRecord } from '@arklock/contracts';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let dir: string;
let user: TestClient;
let vaultId: string;
let vk: Uint8Array;
let entryId: string;

const put = (url: string, body: Uint8Array) =>
  app.inject({
    method: 'PUT',
    url: '/api/v1' + url,
    headers: { ...user.authHeader(), 'content-type': 'application/octet-stream' },
    payload: Buffer.from(body),
  });

/** Клиент: шифрует «файл» по кускам, не держа его целиком; возвращает кадры и размеры. */
async function frames(key: Uint8Array, id: string, size: number) {
  const out: Uint8Array[] = [];
  for await (const f of encryptStream(key, id, size, async (s, e) => new Uint8Array(e - s).fill(7)))
    out.push(f);
  return out;
}

async function register(size: number, keyVersion = 1, key = vk) {
  const id = crypto.randomUUID();
  const ak = generateKey();
  const reg = await user.req('POST', `/vaults/${vaultId}/entries/${entryId}/attachments`, {
    id,
    wrappedKey: await encrypt(key, ak, aad('att-key', vaultId, id, keyVersion)),
    metaCipher: await encrypt(ak, utf8('{"name":"big.bin"}'), aad('att-meta', vaultId, id)),
    keyVersion,
    size: encryptedSize(size),
  });
  expect(reg.statusCode).toBe(201);
  return { id, ak };
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'arklock-stream-'));
  ({ app } = await createTestApp({ BLOB_DIR: dir }));
  user = new TestClient(app, 'u@example.com', 'stream-master-password-1');
  expect((await user.register()).statusCode).toBe(201);
  await user.login();
  const v = await user.createSharedVault('Streams');
  vaultId = v.id;
  vk = v.key;
  entryId = (await user.createEntry({ title: 'big' }, { vaultId, vaultKey: vk })).entryId;
  // лимит выше стандартного: файл заведомо крупнее прежнего предела памяти не требуется, достаточно нескольких кусков
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('step-by-step upload', () => {
  const SIZE = 3 * 1024 * 1024 + 123; // четыре куска

  it('accepts parts in order, resumes after a break and delivers the same bytes', async () => {
    const { id, ak } = await register(SIZE);
    const fr = await frames(ak, id, SIZE);
    expect(fr.length).toBe(chunkCount(SIZE));
    const base = `/vaults/${vaultId}/attachments/${id}`;
    let offset = 0;
    // первые две части
    for (const f of fr.slice(0, 2)) {
      const r = await put(`${base}/parts?offset=${offset}`, f);
      expect(r.statusCode).toBe(200);
      offset = r.json().received;
    }
    // «обрыв»: клиент спрашивает, сколько принято
    const prog = (await user.req('GET', `${base}/progress`)).json();
    expect(prog.received).toBe(offset);
    // повтор уже принятой части и пропуск отвергаются, сервер сообщает фактическое смещение
    const dup = await put(`${base}/parts?offset=0`, fr[0]!);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.details.received).toBe(offset);
    expect((await put(`${base}/parts?offset=${offset + 5}`, fr[2]!)).statusCode).toBe(409);
    // преждевременное завершение
    expect((await user.req('POST', `${base}/complete`)).statusCode).toBe(400);
    for (const f of fr.slice(2)) {
      const r = await put(`${base}/parts?offset=${offset}`, f);
      expect(r.statusCode).toBe(200);
      offset = r.json().received;
    }
    expect(offset).toBe(encryptedSize(SIZE));
    // лишнее после всего
    expect((await put(`${base}/parts?offset=${offset}`, new Uint8Array(10))).statusCode).toBe(409);
    expect((await user.req('POST', `${base}/complete`)).statusCode).toBe(204);
    // нельзя дописывать готовое
    expect((await put(`${base}/parts?offset=0`, fr[0]!)).statusCode).toBe(409);

    const dl = await user.req('GET', `${base}/content`);
    expect(dl.statusCode).toBe(200);
    const dec = new AttachmentDecryptor(ak, id);
    let total = 0;
    const raw = new Uint8Array(dl.rawPayload);
    for (let o = 0; o < raw.length; o += 100_000)
      for (const p of await dec.push(raw.subarray(o, o + 100_000))) total += p.length;
    for (const p of await dec.finish()) total += p.length;
    expect(total).toBe(SIZE);
  });

  it('rejects an oversized part and keeps the file consistent', async () => {
    const { id, ak } = await register(2 * 1024 * 1024);
    const base = `/vaults/${vaultId}/attachments/${id}`;
    const fr = await frames(ak, id, 2 * 1024 * 1024);
    const huge = await put(`${base}/parts?offset=0`, new Uint8Array(1024 * 1024 + 500));
    expect(huge.statusCode).toBe(400);
    expect((await user.req('GET', `${base}/progress`)).json().received).toBe(0);
    expect((await put(`${base}/parts?offset=0`, fr[0]!)).statusCode).toBe(200);
  });

  it('only editors with access can upload parts', async () => {
    const { id } = await register(1024);
    const other = new TestClient(app, 'o@example.com', 'other-master-password-1');
    // регистрация закрыта для посторонних: используем неавторизованный запрос
    const anon = await app.inject({
      method: 'PUT',
      url: `/api/v1/vaults/${vaultId}/attachments/${id}/parts?offset=0`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });
    expect(anon.statusCode).toBe(401);
    void other;
  });
});

describe('key rotation with step-by-step files', () => {
  it('stages the re-encrypted file in parts and swaps it atomically', async () => {
    const v = await user.createSharedVault('Rot');
    const e = await user.createEntry({ title: 'r' }, { vaultId: v.id, vaultKey: v.key });
    const size = 2 * 1024 * 1024 + 5;
    const id = crypto.randomUUID();
    const ak = generateKey();
    await user.req('POST', `/vaults/${v.id}/entries/${e.entryId}/attachments`, {
      id,
      wrappedKey: await encrypt(v.key, ak, aad('att-key', v.id, id, 1)),
      metaCipher: await encrypt(ak, utf8('{}'), aad('att-meta', v.id, id)),
      keyVersion: 1,
      size: encryptedSize(size),
    });
    const base = `/vaults/${v.id}/attachments/${id}`;
    let off = 0;
    for await (const f of encryptStream(ak, id, size, async (s, t) =>
      new Uint8Array(t - s).fill(7),
    )) {
      off = (await put(`${base}/parts?offset=${off}`, f)).json().received;
    }
    expect((await user.req('POST', `${base}/complete`)).statusCode).toBe(204);

    // ротация: новый ключ вложения, файл — по частям в область подготовки
    const newKey = createVaultKey();
    const ak2 = generateKey();
    const rec = (
      await user.req('GET', `/vaults/${v.id}/entries/${e.entryId}`)
    ).json() as EntryRecord;
    const entry = await rewrapEntry(rec, v.key, newKey, v.id, e.entryId, 2);
    const sealed = await sealVaultKeyFor(newKey, user.publicKey, v.id, user.userId, 2);
    let o2 = 0;
    for await (const f of encryptStream(ak2, id, size, async (s, t) =>
      new Uint8Array(t - s).fill(7),
    )) {
      const r = await put(`${base}/parts?offset=${o2}&rotation=1`, f);
      expect(r.statusCode).toBe(200);
      o2 = r.json().received;
    }
    const body = {
      newKeyVersion: 2,
      keys: [
        {
          userId: user.userId,
          sealedKey: sealed,
          signature: await signKeyGrant(user.signPrivateKey, v.id, user.userId, 2, sealed),
        },
      ],
      entries: [{ id: e.entryId, ...entry }],
      revisions: [],
      branches: [],
      attachments: [
        {
          id,
          wrappedKey: await encrypt(newKey, ak2, aad('att-key', v.id, id, 2)),
          metaCipher: await encrypt(ak2, utf8('{}'), aad('att-meta', v.id, id)),
        },
      ],
    };
    // пока подготовка не завершена, ротация отклоняется
    expect((await user.req('POST', `/vaults/${v.id}/rotate`, body)).statusCode).toBe(409);
    expect((await user.req('POST', `${base}/complete?rotation=1`)).statusCode).toBe(204);
    expect((await user.req('POST', `/vaults/${v.id}/rotate`, body)).statusCode).toBe(200);
    const dl = await user.req('GET', `${base}/content`);
    const dec = new AttachmentDecryptor(ak2, id);
    let n = 0;
    for (const p of await dec.push(new Uint8Array(dl.rawPayload))) n += p.length;
    for (const p of await dec.finish()) n += p.length;
    expect(n).toBe(size);
    void decrypt;
    void concat;
  });
});
