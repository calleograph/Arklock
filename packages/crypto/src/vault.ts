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
