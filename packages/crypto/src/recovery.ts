import { decrypt, encrypt } from './aead.js';
import { CryptoFormatError, randomBytes, utf8 } from './bytes.js';
import { ctx } from './context.js';
import { hkdf } from './kdf.js';

/**
 * Ключ восстановления: случайные 256 бит, показываются пользователю один раз в виде кода и
 * хранятся только у него. Сервер хранит закрытый ключ аккаунта, зашифрованный этим ключом, —
 * это единственный способ вернуть доступ при потере мастер-пароля без участия сервера.
 * Администратор сбросить мастер-пароль и прочитать данные не может.
 *
 * Код: Crockford Base32 по 5 знаков через дефис; в конце 2 байта контрольной суммы SHA-256
 * (ловит опечатки до обращения к серверу).
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

async function checksum(key: Uint8Array): Promise<Uint8Array> {
  const h = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', key as Uint8Array<ArrayBuffer>),
  );
  return h.slice(0, 2);
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(s: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new CryptoFormatError('invalid recovery code character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export async function generateRecoveryKey(): Promise<{ key: Uint8Array; code: string }> {
  const key = randomBytes(32);
  const payload = new Uint8Array(34);
  payload.set(key);
  payload.set(await checksum(key), 32);
  const raw = base32(payload);
  return { key, code: raw.match(/.{1,5}/g)!.join('-') };
}

export async function parseRecoveryCode(code: string): Promise<Uint8Array> {
  const normalized = code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  const bytes = fromBase32(normalized);
  if (bytes.length < 34) throw new CryptoFormatError('recovery code is too short');
  const key = bytes.slice(0, 32);
  const sum = await checksum(key);
  if (sum[0] !== bytes[32] || sum[1] !== bytes[33]) {
    throw new CryptoFormatError('recovery code checksum mismatch');
  }
  return key;
}

async function recoveryWrapKey(recoveryKey: Uint8Array, accountId: string) {
  return hkdf(recoveryKey, utf8(accountId), 'arklock/v1/recovery');
}

export async function wrapPrivateKeyForRecovery(
  recoveryKey: Uint8Array,
  privateKey: Uint8Array,
  accountId: string,
): Promise<string> {
  const k = await recoveryWrapKey(recoveryKey, accountId);
  try {
    return await encrypt(k, privateKey, ctx('account-key-recovery', accountId));
  } finally {
    k.fill(0);
  }
}

export async function unwrapPrivateKeyWithRecovery(
  recoveryKey: Uint8Array,
  wrapped: string,
  accountId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const k = await recoveryWrapKey(recoveryKey, accountId);
  try {
    return await decrypt(k, wrapped, ctx('account-key-recovery', accountId));
  } finally {
    k.fill(0);
  }
}

/**
 * Доказательство владения ключом восстановления при сбросе пароля. Выводится отдельной меткой HKDF,
 * поэтому сервер, получив его, не может вывести ключ обёртки закрытого ключа.
 */
export function deriveRecoveryProof(
  recoveryKey: Uint8Array,
  accountId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return hkdf(recoveryKey, utf8(accountId), 'arklock/v1/recovery-proof');
}
