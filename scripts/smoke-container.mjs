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
  openVaultKey,
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
  return { token: session.json.token, user, privateKey, publicKey: fromBase64Url(user.publicKey) };
}

async function lockerKey(s) {
  const vaults = await call('GET', '/vaults', null, s.token);
  must(vaults.status === 200, 'list vaults');
  const locker = vaults.json.find((v) => v.kind === 'locker');
  must(locker, 'locker exists');
  const key = await openVaultKey(
    locker.sealedKey,
    s.privateKey,
    s.publicKey,
    locker.id,
    s.user.id,
    locker.sealedKeyVersion,
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
  const recovery = await generateRecoveryKey();
  const lockerId = crypto.randomUUID();
  const reg = await call('POST', '/auth/register', {
    userId,
    email,
    displayName: 'Smoke Test',
    setupToken: process.env.SETUP_TOKEN,
    kdf: KDF,
    salt: toBase64Url(salt),
    authKey: toBase64Url(keys.authKey),
    publicKey: toBase64Url(kp.publicKey),
    wrappedPrivateKey: await wrapAccountPrivateKey(keys.wrapKey, kp.privateKey, userId),
    recoveryProof: toBase64Url(await deriveRecoveryProof(recovery.key, userId)),
    recoveryWrappedPrivateKey: await wrapPrivateKeyForRecovery(recovery.key, kp.privateKey, userId),
    locker: {
      vaultId: lockerId,
      sealedKey: await sealVaultKeyFor(createVaultKey(), kp.publicKey, lockerId, userId, 1),
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

  writeFileSync(
    STATE_FILE,
    JSON.stringify({ email, password, entryId, vaultId: locker.id, secret }),
  );
  console.log('OK write: user registered, entry stored and decrypted');
}

async function verify() {
  const st = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const s = await login(st.email, st.password);
  const { locker, key } = await lockerKey(s);
  must(locker.id === st.vaultId, 'same locker');
  const got = await call('GET', `/vaults/${locker.id}/entries/${st.entryId}`, null, s.token);
  must(got.status === 200, `entry still present (${got.status})`);
  const plain = await decryptEntry(got.json, key, locker.id, st.entryId);
  must(plain.password === st.secret.password, 'entry content unchanged');
  console.log('OK verify: data survived, entry decrypts');
}

const mode = process.argv[2];
if (mode === 'write') await write();
else if (mode === 'verify') await verify();
else {
  console.error('usage: smoke-container.mjs write|verify');
  process.exit(2);
}
