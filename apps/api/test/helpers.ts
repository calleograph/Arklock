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
  generateSigningKeyPair,
  signKeyGrant,
  openVaultKey,
  sealVaultKeyFor,
  toBase64Url,
  unwrapAccountPrivateKey,
  wrapAccountPrivateKey,
  wrapPrivateKeyForRecovery,
  wrapSignPrivateKey,
  unwrapSignPrivateKey,
  verifyKeyGrant,
  encryptBranchName,
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
  signPrivateKey!: Uint8Array;
  signPublicKey!: Uint8Array;
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

  async register(setupToken?: string, kdf: typeof FAST = FAST) {
    const userId = crypto.randomUUID();
    const salt = generateSalt();
    const keys = await deriveMasterKeys(this.password, salt, userId, kdf, LOW_FLOOR);
    const kp = await generateAccountKeyPair();
    const sk = await generateSigningKeyPair();
    const recovery = await generateRecoveryKey();
    const lockerId = crypto.randomUUID();
    const sealedKey = await sealVaultKeyFor(createVaultKey(), kp.publicKey, lockerId, userId, 1);
    const lockerSig = await signKeyGrant(sk.privateKey, lockerId, userId, 1, sealedKey);
    const res = await this.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        userId,
        email: this.email,
        displayName: 'Test User',
        setupToken,
        kdf,
        salt: toBase64Url(salt),
        authKey: toBase64Url(keys.authKey),
        publicKey: toBase64Url(kp.publicKey),
        signPublicKey: toBase64Url(sk.publicKey),
        wrappedPrivateKey: await wrapAccountPrivateKey(keys.wrapKey, kp.privateKey, userId),
        wrappedSignPrivateKey: await wrapSignPrivateKey(keys.wrapKey, sk.privateKey, userId),
        recoveryProof: toBase64Url(await deriveRecoveryProof(recovery.key, userId)),
        recoveryWrappedPrivateKey: await wrapPrivateKeyForRecovery(
          recovery.key,
          kp.privateKey,
          userId,
        ),
        recoveryWrappedSignPrivateKey: await wrapPrivateKeyForRecovery(
          recovery.key,
          sk.privateKey,
          userId,
        ),
        locker: { vaultId: lockerId, sealedKey, signature: lockerSig },
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
    this.signPublicKey = fromBase64Url(body.user.signPublicKey);
    this.signPrivateKey = await unwrapSignPrivateKey(
      keys.wrapKey,
      body.user.wrappedSignPrivateKey,
      body.user.id,
    );
    this.privateKey = await unwrapAccountPrivateKey(
      keys.wrapKey,
      body.user.wrappedPrivateKey,
      body.user.id,
    );
    return body;
  }

  async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
    return this.app.inject({
      method,
      url: '/api/v1' + url,
      headers: this.authHeader(),
      payload: payload as never,
    });
  }

  async vaults(): Promise<VaultInfo[]> {
    return (await this.req('GET', '/vaults')).json();
  }

  /** Расшифровывает ключ хранилища, проверяя подпись выдавшего (как делает клиент). */
  async openVault(v: VaultInfo): Promise<Uint8Array> {
    if (!v.key) throw new Error('vault key is not issued yet');
    const ok = await verifyKeyGrant(
      fromBase64Url(v.key.grantedBySignKey),
      v.key.signature,
      v.id,
      this.userId,
      v.key.keyVersion,
      v.key.sealedKey,
    );
    if (!ok) throw new Error('bad key grant signature');
    return openVaultKey(
      v.key.sealedKey,
      this.privateKey,
      this.publicKey,
      v.id,
      this.userId,
      v.key.keyVersion,
    );
  }

  async lockerKey() {
    const locker = (await this.vaults()).find((v) => v.kind === 'locker')!;
    return { locker, key: await this.openVault(locker) };
  }

  /** Создаёт общее хранилище (клиент генерирует ключ, запечатывает и подписывает его для себя). */
  async createSharedVault(name: string) {
    const id = crypto.randomUUID();
    const vk = createVaultKey();
    const sealedKey = await sealVaultKeyFor(vk, this.publicKey, id, this.userId, 1);
    const signature = await signKeyGrant(this.signPrivateKey, id, this.userId, 1, sealedKey);
    const res = await this.req('POST', '/vaults', { id, name, sealedKey, signature });
    return { res, id, key: vk };
  }

  /** Выдаёт участнику ключ хранилища (запечатывает его открытым ключом получателя и подписывает). */
  async keyFor(other: TestClient, vaultId: string, vaultKey: Uint8Array, keyVersion = 1) {
    const sealedKey = await sealVaultKeyFor(
      vaultKey,
      other.publicKey,
      vaultId,
      other.userId,
      keyVersion,
    );
    const signature = await signKeyGrant(
      this.signPrivateKey,
      vaultId,
      other.userId,
      keyVersion,
      sealedKey,
    );
    return { keyVersion, sealedKey, signature };
  }

  async addMember(
    vaultId: string,
    other: TestClient,
    role: string,
    vaultKey?: Uint8Array,
    keyVersion = 1,
  ) {
    const key = vaultKey ? await this.keyFor(other, vaultId, vaultKey, keyVersion) : undefined;
    return this.req('PUT', `/vaults/${vaultId}/members/${other.userId}`, { role, key });
  }

  async createEntry(
    payload: unknown,
    opts: {
      vaultId?: string;
      vaultKey?: Uint8Array;
      branchId?: string | null;
      keyVersion?: number;
    } = {},
  ) {
    const locker = opts.vaultId ? null : await this.lockerKey();
    const vId = opts.vaultId ?? locker!.locker.id;
    const key = opts.vaultKey ?? locker!.key;
    const keyVersion = opts.keyVersion ?? locker?.locker.keyVersion ?? 1;
    const entryId = crypto.randomUUID();
    const enc = await encryptEntry(payload, key, vId, entryId, keyVersion);
    const res = await this.req('POST', `/vaults/${vId}/entries`, {
      id: entryId,
      branchId: opts.branchId ?? null,
      ...enc,
    });
    return { res, entryId, vaultId: vId, key };
  }

  async createBranch(
    vaultId: string,
    vaultKey: Uint8Array,
    name: string,
    parentId: string | null = null,
    keyVersion = 1,
  ) {
    const id = crypto.randomUUID();
    const nameCipher = await encryptBranchName(name, vaultKey, vaultId, id, keyVersion);
    const res = await this.req('POST', `/vaults/${vaultId}/branches`, {
      id,
      parentId,
      nameCipher,
      keyVersion,
    });
    return { res, id };
  }

  async readEntry(vaultId: string, entryId: string, key: Uint8Array) {
    const res = await this.req('GET', `/vaults/${vaultId}/entries/${entryId}`);
    const rec = res.json() as EntryRecord;
    return decryptEntry(rec, key, vaultId, entryId);
  }
}
