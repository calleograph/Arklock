import {
  MIN_KDF,
  decryptBranchName,
  decryptEntry,
  encryptEntry,
  deriveMasterKeys,
  fromBase64Url,
  keyLogHash,
  openVaultKey,
  unwrapAccountPrivateKey,
  verifyKeyGrant,
  verifyKeyLog,
  type KdfParams,
} from '@arklock/crypto';
import type { BranchRecord, EntryRecord, UserBundle, VaultInfo } from '@arklock/contracts';

export class ClientError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

/** Ошибка ответа сервера: код состояния и код ошибки доступны программно (отзыв доступа, конфликт версий). */
export class ApiError extends ClientError {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface Credentials {
  server: string;
  token: string;
}

export interface Entry {
  id: string;
  vaultId: string;
  vaultName: string;
  folder: string;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  totp: string;
  tags: string[];
  fields: { name: string; value: string; secret: boolean }[];
  kind: string;
  /** Версия записи на сервере (контроль конфликтов при изменении). */
  version: number;
  branchId: string | null;
  /** Расшифрованное содержимое целиком: поля, которых нет в форме, при изменении сохраняются. */
  raw: Record<string, unknown>;
}

export class Api {
  constructor(
    private readonly cred: Credentials,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  async call<T = unknown>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const res = await this.fetchFn(`${this.cred.server.replace(/\/$/, '')}/api/v1${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(auth ? { authorization: `Bearer ${this.cred.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    if (!res.ok) {
      const code = data?.error?.code ?? 'http_error';
      const hint =
        code === 'unauthorized'
          ? 'The token is invalid, expired or revoked. Create a new one in Security → API tokens.'
          : code === 'token_read_only'
            ? 'This token is read-only. Create a token with write access.'
            : (data?.error?.message ?? res.statusText);
      throw new ApiError(`${hint} (${res.status} ${code})`, res.status, code);
    }
    return data as T;
  }
}

export interface Opened {
  api: Api;
  user: UserBundle;
  vaults: { info: VaultInfo; key: Uint8Array | null; problem?: string }[];
  keyLogTip: { seq: number; hash: string } | null;
}

/**
 * Открывает аккаунт локально: мастер-пароль превращается в ключи на этой машине, сервер получает только токен.
 * Подписи выданных ключей хранилищ проверяются по журналу ключей; зафиксированное ранее состояние журнала
 * (`pin`) не может «откатиться» или измениться.
 */
export async function openAccount(
  cred: Credentials,
  password: string,
  opts: {
    fetchFn?: typeof fetch;
    kdfFloor?: KdfParams;
    pin?: { seq: number; hash: string } | null;
  } = {},
): Promise<Opened> {
  const api = new Api(cred, opts.fetchFn);
  const me = await api.call<{ user: UserBundle }>('GET', '/auth/me');
  const user = me.user;
  const params = await api.call<{ salt: string; kdf: KdfParams; userId: string }>(
    'GET',
    `/auth/params?email=${encodeURIComponent(user.email)}`,
    undefined,
    false,
  );
  const keys = await deriveMasterKeys(
    password,
    fromBase64Url(params.salt),
    params.userId,
    params.kdf,
    opts.kdfFloor ?? MIN_KDF,
  );
  let privateKey: Uint8Array;
  try {
    privateKey = await unwrapAccountPrivateKey(keys.wrapKey, user.wrappedPrivateKey, user.id);
  } catch {
    throw new ClientError('Wrong master password');
  } finally {
    keys.wrapKey.fill(0);
    keys.authKey.fill(0);
  }
  const publicKey = fromBase64Url(user.publicKey);

  // журнал ключей: цепочка хэшей и сверка с зафиксированным состоянием
  const log: {
    seq: number;
    userId: string;
    encPublic: string;
    signPublic: string;
    prevHash: string;
    hash: string;
  }[] = [];
  for (let after = 0; ;) {
    const page = await api.call<typeof log>('GET', `/key-log?after=${after}`);
    log.push(...page);
    if (page.length < 1000) break;
    after = page[page.length - 1]!.seq;
  }
  if (!(await verifyKeyLog(log)))
    throw new ClientError('The key log failed verification — the server may be compromised');
  if (opts.pin) {
    const at = log.find((e) => e.seq === opts.pin!.seq);
    if (!at || at.hash !== opts.pin.hash)
      throw new ClientError(
        'The key log no longer matches what this client saw before — refusing to continue',
      );
  }
  void keyLogHash;
  const signerKey = (uid: string) => log.find((e) => e.userId === uid)?.signPublic ?? null;

  const infos = await api.call<VaultInfo[]>('GET', '/vaults');
  const vaults: Opened['vaults'] = [];
  for (const v of infos) {
    if (!v.key) {
      vaults.push({ info: v, key: null, problem: 'key not issued yet' });
      continue;
    }
    const trusted = signerKey(v.key.grantedBy);
    if (!trusted || trusted !== v.key.grantedBySignKey) {
      vaults.push({ info: v, key: null, problem: 'unknown signer' });
      continue;
    }
    const ok = await verifyKeyGrant(
      fromBase64Url(trusted),
      v.key.signature,
      v.id,
      user.id,
      v.key.keyVersion,
      v.key.sealedKey,
    ).catch(() => false);
    if (!ok) {
      vaults.push({ info: v, key: null, problem: 'bad key signature' });
      continue;
    }
    try {
      const key = await openVaultKey(
        v.key.sealedKey,
        privateKey,
        publicKey,
        v.id,
        user.id,
        v.key.keyVersion,
      );
      vaults.push({
        info: v,
        key,
        problem: v.key.keyVersion === v.keyVersion ? undefined : 'key outdated',
      });
    } catch {
      vaults.push({ info: v, key: null, problem: 'cannot open key' });
    }
  }
  privateKey.fill(0);
  const tip = log[log.length - 1];
  return { api, user, vaults, keyLogTip: tip ? { seq: tip.seq, hash: tip.hash } : null };
}

/** Расшифровывает записи хранилища вместе с путём папок. */
export async function loadEntries(o: Opened, v: Opened['vaults'][number]): Promise<Entry[]> {
  if (!v.key || v.problem) return [];
  const tree = await o.api.call<{ branches: BranchRecord[]; entries: EntryRecord[] }>(
    'GET',
    `/vaults/${v.info.id}/tree`,
  );
  const names = new Map<string, string>();
  const parents = new Map<string, string | null>();
  for (const b of tree.branches) {
    try {
      names.set(b.id, await decryptBranchName(b.nameCipher, v.key, v.info.id, b.id, b.keyVersion));
      parents.set(b.id, b.parentId);
    } catch {
      names.set(b.id, '?');
    }
  }
  const pathOf = (id: string | null): string => {
    const parts: string[] = [];
    for (let cur = id, n = 0; cur && n < 64; n++) {
      parts.unshift(names.get(cur) ?? '?');
      cur = parents.get(cur) ?? null;
    }
    return parts.join('/');
  };
  const out: Entry[] = [];
  for (const e of tree.entries) {
    try {
      const d = (await decryptEntry(e, v.key, v.info.id, e.id)) as Partial<Entry> & {
        fields?: Entry['fields'];
        tags?: string[];
      };
      out.push({
        id: e.id,
        vaultId: v.info.id,
        vaultName: v.info.kind === 'locker' ? 'locker' : (v.info.name ?? ''),
        folder: pathOf(e.branchId),
        title: String(d.title ?? ''),
        username: String(d.username ?? ''),
        password: String(d.password ?? ''),
        url: String(d.url ?? ''),
        notes: String(d.notes ?? ''),
        totp: String(d.totp ?? ''),
        tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
        fields: Array.isArray(d.fields) ? d.fields : [],
        kind: String(d.kind ?? 'login'),
        version: e.version,
        branchId: e.branchId,
        raw: d as Record<string, unknown>,
      });
    } catch {
      /* запись не расшифровалась (чужая версия ключа) — пропускается */
    }
  }
  return out;
}

/** Поля, которые пользователь вводит при создании и изменении записи входа. */
export interface EntryInput {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  totp: string;
}

export type OpenedVault = Opened['vaults'][number];

/** Можно ли выполнить действие в хранилище: решение принимает сервер, здесь — только подсказка для интерфейса. */
export const canDo = (v: OpenedVault, perm: 'entry.create' | 'entry.update'): boolean =>
  !!v.key && !v.problem && v.info.permissions.includes(perm);

/**
 * Создаёт запись (existing не задан) или изменяет существующую. Содержимое шифруется здесь, на клиенте;
 * сервер получает шифртекст. При изменении сохраняются поля записи, которых нет в форме, а время смены пароля обновляется.
 */
export async function saveEntry(
  o: Opened,
  v: OpenedVault,
  input: EntryInput,
  existing?: Entry,
): Promise<string> {
  if (!v.key || v.problem) throw new ClientError('The vault is locked');
  if (!canDo(v, existing ? 'entry.update' : 'entry.create'))
    throw new ClientError('You cannot change entries in this vault');
  const title = input.title.trim();
  if (!title) throw new ClientError('Enter a title');
  const id = existing?.id ?? crypto.randomUUID();
  const payload: Record<string, unknown> = {
    ...(existing?.raw ?? { kind: 'login', fields: [], tags: [] }),
    title,
    username: input.username,
    password: input.password,
    url: input.url.trim(),
    notes: input.notes,
    totp: input.totp.trim(),
  };
  if (!existing || existing.password !== input.password)
    payload.passwordChangedAt = new Date().toISOString();
  const enc = await encryptEntry(payload, v.key, v.info.id, id, v.info.keyVersion);
  if (existing)
    await o.api.call('PUT', `/vaults/${v.info.id}/entries/${id}`, {
      ...enc,
      branchId: existing.branchId,
      expectedVersion: existing.version,
    });
  else await o.api.call('POST', `/vaults/${v.info.id}/entries`, { id, branchId: null, ...enc });
  return id;
}
