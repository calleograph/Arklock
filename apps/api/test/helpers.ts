import type { FastifyInstance } from 'fastify';
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
} from '@arklock/crypto';
import type { EntryRecord, SessionResponse, VaultInfo } from '@arklock/contracts';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect } from '../src/db/connect.js';

export const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 };
const LOW_FLOOR = { memoryKiB: 8, iterations: 1, parallelism: 1 };
export const APP_SECRET = 'test-secret-test-secret-test-secret-123';

export async function createTestApp(env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite:memory',
    LOG_LEVEL: 'silent',
    APP_SECRET,
    ...env,
  });
  const database = await connect(config.DATABASE_URL);
  await database.migrate();
  const app = await buildApp({ config, database });
  return { app, database };
}

/** Имитация клиента: все ключи создаются и используются здесь, сервер получает только то, что получил бы от браузера. */
export class TestClient {
  token = '';
  userId = '';
  privateKey!: Uint8Array;
  publicKey!: Uint8Array;
  lockerId = '';
  recoveryCode = '';

  constructor(
    readonly app: FastifyInstance,
    readonly email: string,
    public password: string,
  ) {}

  authHeader() {
    return { authorization: `Bearer ${this.token}` };
  }

  async register() {
    const userId = crypto.randomUUID();
    const salt = generateSalt();
    const keys = await deriveMasterKeys(this.password, salt, userId, FAST, LOW_FLOOR);
    const kp = await generateAccountKeyPair();
    const recovery = await generateRecoveryKey();
    const lockerId = crypto.randomUUID();
    const sealedKey = await sealVaultKeyFor(createVaultKey(), kp.publicKey, lockerId, userId, 1);
    const res = await this.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        userId,
        email: this.email,
        displayName: 'Test User',
        kdf: FAST,
        salt: toBase64Url(salt),
        authKey: toBase64Url(keys.authKey),
        publicKey: toBase64Url(kp.publicKey),
        wrappedPrivateKey: await wrapAccountPrivateKey(keys.wrapKey, kp.privateKey, userId),
        recoveryProof: toBase64Url(await deriveRecoveryProof(recovery.key, userId)),
        recoveryWrappedPrivateKey: await wrapPrivateKeyForRecovery(
          recovery.key,
          kp.privateKey,
          userId,
        ),
        locker: { vaultId: lockerId, sealedKey },
      },
    });
    if (res.statusCode === 201) {
      this.userId = userId;
      this.lockerId = lockerId;
      this.recoveryCode = recovery.code;
    }
    return res;
  }

  async derive(password = this.password) {
    const params = (
      await this.app.inject({ url: `/api/v1/auth/params?email=${encodeURIComponent(this.email)}` })
    ).json();
    const keys = await deriveMasterKeys(
      password,
      fromBase64Url(params.salt),
      params.userId,
      params.kdf,
      LOW_FLOOR,
    );
    return { params, keys };
  }

  async loginRaw(password = this.password) {
    const { keys } = await this.derive(password);
    return this.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: this.email, authKey: toBase64Url(keys.authKey) },
    });
  }

  /** Вход и расшифровка закрытого ключа мастер-паролем, как делает браузер. */
  async login(password = this.password) {
    const res = await this.loginRaw(password);
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    const body = res.json() as SessionResponse;
    const { keys } = await this.derive(password);
    this.token = body.token;
    this.userId = body.user.id;
    this.publicKey = fromBase64Url(body.user.publicKey);
    this.privateKey = await unwrapAccountPrivateKey(
      keys.wrapKey,
      body.user.wrappedPrivateKey,
      body.user.id,
    );
    return body;
  }

  async vaults(): Promise<VaultInfo[]> {
    const res = await this.app.inject({ url: '/api/v1/vaults', headers: this.authHeader() });
    return res.json();
  }

  async lockerKey() {
    const locker = (await this.vaults()).find((v) => v.kind === 'locker')!;
    const key = await openVaultKey(
      locker.sealedKey,
      this.privateKey,
      this.publicKey,
      locker.id,
      this.userId,
      locker.sealedKeyVersion,
    );
    return { locker, key };
  }

  async createEntry(payload: unknown, vaultId?: string, vaultKey?: Uint8Array) {
    const { locker, key } = await this.lockerKey();
    const vId = vaultId ?? locker.id;
    const entryId = crypto.randomUUID();
    const enc = await encryptEntry(payload, vaultKey ?? key, vId, entryId, locker.keyVersion);
    const res = await this.app.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vId}/entries`,
      headers: this.authHeader(),
      payload: { id: entryId, ...enc },
    });
    return { res, entryId, vaultId: vId, key };
  }

  async readEntry(vaultId: string, entryId: string, key: Uint8Array) {
    const res = await this.app.inject({
      url: `/api/v1/vaults/${vaultId}/entries/${entryId}`,
      headers: this.authHeader(),
    });
    const rec = res.json() as EntryRecord;
    return decryptEntry(rec, key, vaultId, entryId);
  }
}
