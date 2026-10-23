import { decrypt, encrypt, generateKey } from './aead.js';
import { openSealed, sealTo } from './asym.js';
import { CryptoFormatError, fromUtf8, utf8 } from './bytes.js';
import { ctx } from './context.js';

/**
 * Иерархия ключей:
 *   мастер-пароль ─Argon2id/HKDF→ wrapKey ─шифрует→ закрытый ключ аккаунта (ECDH P-256)
 *   ключ хранилища (VK, 256 бит) ─запечатан открытым ключом каждого участника→ sealedVaultKey
 *   ключ записи (EK, 256 бит) ─шифруется VK→ wrappedEntryKey;  данные записи ─шифруются EK
 * Версия ключа хранилища (keyVersion) входит в контекст и растёт при ротации.
 */

export function wrapAccountPrivateKey(
  wrapKey: Uint8Array,
  privateKey: Uint8Array,
  accountId: string,
): Promise<string> {
  return encrypt(wrapKey, privateKey, ctx('account-key', accountId));
}

export function unwrapAccountPrivateKey(wrapKey: Uint8Array, wrapped: string, accountId: string) {
  return decrypt(wrapKey, wrapped, ctx('account-key', accountId));
}

/**
 * Смена мастер-пароля: закрытый ключ аккаунта остаётся прежним, меняется только его обёртка.
 * Хранилища и записи перешифровывать не нужно.
 */
export async function rewrapAccountPrivateKey(
  oldWrapKey: Uint8Array,
  newWrapKey: Uint8Array,
  wrapped: string,
  accountId: string,
): Promise<string> {
  const priv = await unwrapAccountPrivateKey(oldWrapKey, wrapped, accountId);
  try {
    return await wrapAccountPrivateKey(newWrapKey, priv, accountId);
  } finally {
    priv.fill(0);
  }
}

export function createVaultKey(): Uint8Array<ArrayBuffer> {
  return generateKey();
}

const vaultKeyContext = (vaultId: string, memberId: string, keyVersion: number) =>
  ctx('vault-key', vaultId, memberId, keyVersion);

export function sealVaultKeyFor(
  vaultKey: Uint8Array,
  memberPublicKey: Uint8Array,
  vaultId: string,
  memberId: string,
  keyVersion: number,
): Promise<string> {
  return sealTo(memberPublicKey, vaultKey, vaultKeyContext(vaultId, memberId, keyVersion));
}

export function openVaultKey(
  sealed: string,
  memberPrivateKey: Uint8Array,
  memberPublicKey: Uint8Array,
  vaultId: string,
  memberId: string,
  keyVersion: number,
) {
  return openSealed(
    memberPrivateKey,
    memberPublicKey,
    sealed,
    vaultKeyContext(vaultId, memberId, keyVersion),
  );
}

export interface EncryptedEntry {
  wrappedEntryKey: string;
  ciphertext: string;
  keyVersion: number;
}

export async function encryptEntry(
  payload: unknown,
  vaultKey: Uint8Array,
  vaultId: string,
  entryId: string,
  keyVersion: number,
): Promise<EncryptedEntry> {
  const entryKey = generateKey();
  try {
    const ciphertext = await encrypt(
      entryKey,
      utf8(JSON.stringify(payload)),
      ctx('entry', vaultId, entryId, keyVersion),
    );
    const wrappedEntryKey = await encrypt(
      vaultKey,
      entryKey,
      ctx('entry-key', vaultId, entryId, keyVersion),
    );
    return { wrappedEntryKey, ciphertext, keyVersion };
  } finally {
    entryKey.fill(0);
  }
}

export async function decryptEntry<T = unknown>(
  enc: EncryptedEntry,
  vaultKey: Uint8Array,
  vaultId: string,
  entryId: string,
): Promise<T> {
  const entryKey = await decrypt(
    vaultKey,
    enc.wrappedEntryKey,
    ctx('entry-key', vaultId, entryId, enc.keyVersion),
  );
  try {
    const plain = await decrypt(
      entryKey,
      enc.ciphertext,
      ctx('entry', vaultId, entryId, enc.keyVersion),
    );
    try {
      return JSON.parse(fromUtf8(plain)) as T;
    } catch {
      throw new CryptoFormatError('decrypted entry is not valid JSON');
    } finally {
      plain.fill(0);
    }
  } finally {
    entryKey.fill(0);
  }
}

/**
 * Ротация ключа хранилища (после отзыва доступа): ключ каждой записи заменяется новым,
 * тело перешифровывается. Прежний EK, который мог остаться у отозванного участника, бесполезен.
 * Запечатывание нового VK для оставшихся участников выполняет вызывающий код.
 */
export async function rewrapEntry(
  enc: EncryptedEntry,
  oldVaultKey: Uint8Array,
  newVaultKey: Uint8Array,
  vaultId: string,
  entryId: string,
  newKeyVersion: number,
): Promise<EncryptedEntry> {
  const oldEntryKey = await decrypt(
    oldVaultKey,
    enc.wrappedEntryKey,
    ctx('entry-key', vaultId, entryId, enc.keyVersion),
  );
  const body = await decrypt(
    oldEntryKey,
    enc.ciphertext,
    ctx('entry', vaultId, entryId, enc.keyVersion),
  );
  const newEntryKey = generateKey();
  try {
    const ciphertext = await encrypt(
      newEntryKey,
      body,
      ctx('entry', vaultId, entryId, newKeyVersion),
    );
    const wrappedEntryKey = await encrypt(
      newVaultKey,
      newEntryKey,
      ctx('entry-key', vaultId, entryId, newKeyVersion),
    );
    return { wrappedEntryKey, ciphertext, keyVersion: newKeyVersion };
  } finally {
    oldEntryKey.fill(0);
    newEntryKey.fill(0);
    body.fill(0);
  }
}

/** Закрытый ключ подписи аккаунта хранится так же, как ключ шифрования: под ключом обёртки мастер-пароля. */
export function wrapSignPrivateKey(
  wrapKey: Uint8Array,
  privateKey: Uint8Array,
  accountId: string,
): Promise<string> {
  return encrypt(wrapKey, privateKey, ctx('sign-key', accountId));
}

export function unwrapSignPrivateKey(wrapKey: Uint8Array, wrapped: string, accountId: string) {
  return decrypt(wrapKey, wrapped, ctx('sign-key', accountId));
}

/** Название ветви шифруется ключом хранилища и привязано к хранилищу, ветви и версии ключа. */
export async function encryptBranchName(
  name: string,
  vaultKey: Uint8Array,
  vaultId: string,
  branchId: string,
  keyVersion: number,
): Promise<string> {
  return encrypt(vaultKey, utf8(name), ctx('branch', vaultId, branchId, keyVersion));
}

export async function decryptBranchName(
  nameCipher: string,
  vaultKey: Uint8Array,
  vaultId: string,
  branchId: string,
  keyVersion: number,
): Promise<string> {
  const plain = await decrypt(vaultKey, nameCipher, ctx('branch', vaultId, branchId, keyVersion));
  return fromUtf8(plain);
}

/** Перешифрование названия ветви новым ключом хранилища (ротация). */
export async function rewrapBranchName(
  nameCipher: string,
  oldKey: Uint8Array,
  newKey: Uint8Array,
  vaultId: string,
  branchId: string,
  oldVersion: number,
  newVersion: number,
): Promise<string> {
  const name = await decryptBranchName(nameCipher, oldKey, vaultId, branchId, oldVersion);
  return encryptBranchName(name, newKey, vaultId, branchId, newVersion);
}

/**
 * Оформление ветви (значок, цвет, своё изображение) — JSON, зашифрованный ключом хранилища отдельно от названия:
 * сервер не видит, какой значок выбран. Контекст свой, поэтому шифртекст названия и оформления не взаимозаменяемы.
 */
export async function encryptBranchMeta(
  meta: string,
  vaultKey: Uint8Array,
  vaultId: string,
  branchId: string,
  keyVersion: number,
): Promise<string> {
  return encrypt(vaultKey, utf8(meta), ctx('branch-meta', vaultId, branchId, keyVersion));
}

export async function decryptBranchMeta(
  metaCipher: string,
  vaultKey: Uint8Array,
  vaultId: string,
  branchId: string,
  keyVersion: number,
): Promise<string> {
  return fromUtf8(
    await decrypt(vaultKey, metaCipher, ctx('branch-meta', vaultId, branchId, keyVersion)),
  );
}

/** Перешифрование оформления ветви новым ключом хранилища (ротация). */
export async function rewrapBranchMeta(
  metaCipher: string,
  oldKey: Uint8Array,
  newKey: Uint8Array,
  vaultId: string,
  branchId: string,
  oldVersion: number,
  newVersion: number,
): Promise<string> {
  const meta = await decryptBranchMeta(metaCipher, oldKey, vaultId, branchId, oldVersion);
  return encryptBranchMeta(meta, newKey, vaultId, branchId, newVersion);
}
