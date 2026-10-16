#!/usr/bin/env node
/**
 * Интеграционная проверка запущенного стенда (контейнеры или процесс) «глазами клиента»:
 *   node scripts/smoke-container.mjs write   — регистрация, вход, сохранение и чтение зашифрованной записи
 *   node scripts/smoke-container.mjs verify  — вход тем же пользователем и чтение записи (после пересоздания контейнеров)
 * Переменные: BASE_URL (по умолчанию http://127.0.0.1:8080), STATE_FILE (по умолчанию ./smoke-state.json).
 * Требует собранный packages/crypto. Все ключи создаются здесь, как в браузере; тестовые данные синтетические.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  createVaultKey,
  decryptEntry,
  deriveMasterKeys,
  deriveRecoveryProof,
  encryptEntry,
  fromBase64Url,
  generateAccountKeyPair,
  generateRecoveryKey,
  generateSalt,
  generateSigningKeyPair,
  signKeyGrant,
  wrapSignPrivateKey,
  unwrapSignPrivateKey,
  openVaultKey,
  openAttachmentFile,
  sealAttachment,
  sealVaultKeyFor,
  toBase64Url,
  unwrapAccountPrivateKey,
  wrapAccountPrivateKey,
  wrapPrivateKeyForRecovery,
} from '../packages/crypto/dist/index.js';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
const STATE_FILE = process.env.STATE_FILE ?? 'smoke-state.json';
// Минимально допустимые для продукта параметры: проверка идёт с настоящим производственным порогом.
const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 };

async function call(method, path, body, token) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function must(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

async function login(email, password) {
  const params = await call('GET', `/auth/params?email=${encodeURIComponent(email)}`);
  must(params.status === 200, 'auth/params');
  const keys = await deriveMasterKeys(
    password,
    fromBase64Url(params.json.salt),
    params.json.userId,
    params.json.kdf,
  );
  const session = await call('POST', '/auth/login', { email, authKey: toBase64Url(keys.authKey) });
  must(session.status === 200, `login (${session.status})`);
  const user = session.json.user;
  const privateKey = await unwrapAccountPrivateKey(keys.wrapKey, user.wrappedPrivateKey, user.id);
  void unwrapSignPrivateKey;
  return { token: session.json.token, user, privateKey, publicKey: fromBase64Url(user.publicKey) };
}

async function lockerKey(s) {
  const vaults = await call('GET', '/vaults', null, s.token);
  must(vaults.status === 200, 'list vaults');
  const locker = vaults.json.find((v) => v.key?.sealedKey);
  must(locker, 'an accessible vault with its current key exists');
  const key = await openVaultKey(
    locker.key.sealedKey,
    s.privateKey,
    s.publicKey,
    locker.id,
    s.user.id,
    locker.key.keyVersion,
  );
  return { locker, key };
}

async function write() {
  const email = `smoke-${Date.now()}@example.com`;
  const password = `smoke-${crypto.randomUUID()}`;
  const secret = { title: 'Smoke', password: `secret-${crypto.randomUUID()}` };

  const userId = crypto.randomUUID();
  const salt = generateSalt();
  const keys = await deriveMasterKeys(password, salt, userId, KDF);
  const kp = await generateAccountKeyPair();
  const sk = await generateSigningKeyPair();
  const recovery = await generateRecoveryKey();
  const lockerId = crypto.randomUUID();
  const lockerSealed = await sealVaultKeyFor(createVaultKey(), kp.publicKey, lockerId, userId, 1);
  const reg = await call('POST', '/auth/register', {
    userId,
    email,
    displayName: 'Smoke Test',
    setupToken: process.env.SETUP_TOKEN,
    kdf: KDF,
    salt: toBase64Url(salt),
    authKey: toBase64Url(keys.authKey),
    publicKey: toBase64Url(kp.publicKey),
    signPublicKey: toBase64Url(sk.publicKey),
    wrappedPrivateKey: await wrapAccountPrivateKey(keys.wrapKey, kp.privateKey, userId),
    wrappedSignPrivateKey: await wrapSignPrivateKey(keys.wrapKey, sk.privateKey, userId),
    recoveryProof: toBase64Url(await deriveRecoveryProof(recovery.key, userId)),
    recoveryWrappedPrivateKey: await wrapPrivateKeyForRecovery(recovery.key, kp.privateKey, userId),
    recoveryWrappedSignPrivateKey: await wrapPrivateKeyForRecovery(
      recovery.key,
      sk.privateKey,
      userId,
    ),
    locker: {
      vaultId: lockerId,
      sealedKey: lockerSealed,
      signature: await signKeyGrant(sk.privateKey, lockerId, userId, 1, lockerSealed),
    },
  });
  must(reg.status === 201, `register (${reg.status} ${JSON.stringify(reg.json)})`);

  const s = await login(email, password);
  const { locker, key } = await lockerKey(s);
  const entryId = crypto.randomUUID();
  const enc = await encryptEntry(secret, key, locker.id, entryId, locker.keyVersion);
  const created = await call(
    'POST',
    `/vaults/${locker.id}/entries`,
    { id: entryId, ...enc },
    s.token,
  );
  must(created.status === 201, `create entry (${created.status})`);
  must(!JSON.stringify(created.json).includes(secret.password), 'server response has no plaintext');

  const got = await call('GET', `/vaults/${locker.id}/entries/${entryId}`, null, s.token);
  const plain = await decryptEntry(got.json, key, locker.id, entryId);
  must(plain.password === secret.password, 'entry round-trip');

  // вложение: шифруется здесь, на сервер уходит только шифртекст
  const fileText = `file-${crypto.randomUUID()}`;
  const sealed = await sealAttachment(
    key,
    locker.id,
    locker.keyVersion,
    { name: 'smoke.txt', type: 'text/plain', size: fileText.length },
    new globalThis.TextEncoder().encode(fileText),
  );
  const reg2 = await call(
    'POST',
    `/vaults/${locker.id}/entries/${entryId}/attachments`,
    {
      id: sealed.id,
      wrappedKey: sealed.wrappedKey,
      metaCipher: sealed.metaCipher,
      keyVersion: sealed.keyVersion,
      size: sealed.file.length,
    },
    s.token,
  );
  must(reg2.status === 201, `register attachment (${reg2.status} ${JSON.stringify(reg2.json)})`);
  const up = await fetch(`${BASE}/api/v1/vaults/${locker.id}/attachments/${sealed.id}/content`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/octet-stream' },
    body: sealed.file,
  });
  must(up.status === 204, `upload attachment (${up.status})`);

  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      email,
      password,
      entryId,
      vaultId: locker.id,
      secret,
      attachmentId: sealed.id,
      fileText,
    }),
  );
  console.log('OK write: user registered, entry stored and decrypted');
}

async function verify() {
  const st = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const s = await login(st.email, st.password);
  const { locker, key } = await lockerKey(s);
  must(locker.id === st.vaultId, 'same vault');
  const got = await call('GET', `/vaults/${locker.id}/entries/${st.entryId}`, null, s.token);
  must(got.status === 200, `entry still present (${got.status})`);
  const plain = await decryptEntry(got.json, key, locker.id, st.entryId);
  must(plain.password === st.secret.password, 'entry content unchanged');
  const list = await call(
    'GET',
    `/vaults/${locker.id}/entries/${st.entryId}/attachments`,
    null,
    s.token,
  );
  must(list.status === 200 && list.json.length === 1, 'attachment listed');
  const dl = await fetch(
    `${BASE}/api/v1/vaults/${locker.id}/attachments/${st.attachmentId}/content`,
    {
      headers: { authorization: `Bearer ${s.token}` },
    },
  );
  must(dl.status === 200, `attachment download (${dl.status})`);
  const bytes = new Uint8Array(await dl.arrayBuffer());
  const opened = await openAttachmentFile(key, locker.id, list.json[0], bytes);
  must(new globalThis.TextDecoder().decode(opened) === st.fileText, 'attachment content unchanged');
  console.log('OK verify: data survived, entry and attachment decrypt');
}

const mode = process.argv[2];
if (mode === 'write') await write();
else if (mode === 'verify') await verify();
else {
  console.error('usage: smoke-container.mjs write|verify');
  process.exit(2);
}
