import { argon2id } from 'hash-wasm';
import { CryptoFormatError, concat, randomBytes, utf8 } from './bytes.js';

export interface KdfParams {
  /** Память в КиБ. */
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/** Параметры по умолчанию для новых учётных записей (не ниже рекомендаций OWASP: m=64 МиБ, t=3, p=1). */
export const DEFAULT_KDF: KdfParams = { memoryKiB: 65536, iterations: 3, parallelism: 1 };

/** Нижняя граница: ниже клиент отказывается работать (защита от понижения параметров сервером). */
export const MIN_KDF: KdfParams = { memoryKiB: 19456, iterations: 2, parallelism: 1 };

export function assertKdfParams(p: KdfParams, floor: KdfParams = MIN_KDF): void {
  if (
    p.memoryKiB < floor.memoryKiB ||
    p.iterations < floor.iterations ||
    p.parallelism < floor.parallelism
  ) {
    throw new CryptoFormatError('KDF parameters are weaker than the allowed minimum');
  }
}

export interface MasterKeys {
  /** Ключ обёртки закрытого ключа аккаунта. Никогда не покидает клиента. */
  wrapKey: Uint8Array<ArrayBuffer>;
  /** Доказательство знания пароля для входа. Сервер хранит только его хэш. */
  authKey: Uint8Array<ArrayBuffer>;
}

export function generateSalt(): Uint8Array<ArrayBuffer> {
  return randomBytes(16);
}

export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length = 32,
): Promise<Uint8Array<ArrayBuffer>> {
  const base = await globalThis.crypto.subtle.importKey(
    'raw',
    ikm as Uint8Array<ArrayBuffer>,
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, info: utf8(info) },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Мастер-пароль → Argon2id → мастер-материал → HKDF с разными метками:
 * ключ шифрования и ключ аутентификации независимы друг от друга.
 * В соль входит идентификатор аккаунта, чтобы одинаковые пароли давали разные ключи.
 * `floor` — нижняя граница параметров; тесты могут её снижать, продукт — нет.
 */
export async function deriveMasterKeys(
  password: string,
  salt: Uint8Array,
  accountId: string,
  params: KdfParams = DEFAULT_KDF,
  floor: KdfParams = MIN_KDF,
): Promise<MasterKeys> {
  assertKdfParams(params, floor);
  const fullSalt = concat(salt, utf8(accountId.normalize('NFKC')));
  const master = await argon2id({
    password: password.normalize('NFKC'),
    salt: fullSalt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    hashLength: 32,
    outputType: 'binary',
  });
  const [wrapKey, authKey] = await Promise.all([
    hkdf(master, salt, 'arklock/v1/wrap'),
    hkdf(master, salt, 'arklock/v1/auth'),
  ]);
  master.fill(0);
  return { wrapKey, authKey };
}
