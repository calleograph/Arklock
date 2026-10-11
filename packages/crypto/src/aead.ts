import {
  CryptoAuthError,
  CryptoFormatError,
  fromBase64Url,
  randomBytes,
  toBase64Url,
  utf8,
} from './bytes.js';

/**
 * Формат зашифрованного значения (версионируется):
 *   "ak1." + base64url(nonce[12]) + "." + base64url(ciphertext||tag)
 * Шифр: AES-256-GCM. Nonce — случайный 96-бит на каждую операцию.
 * AAD обязателен: он привязывает шифртекст к контексту (тип объекта, id, версия схемы),
 * чтобы сервер не мог подменить один шифртекст другим.
 */
export const FORMAT_V1 = 'ak1';
const NONCE_LEN = 12;

function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (raw.length !== 32) throw new CryptoFormatError('AES-256 key must be 32 bytes');
  return globalThis.crypto.subtle.importKey(
    'raw',
    raw as Uint8Array<ArrayBuffer>,
    'AES-GCM',
    false,
    usages,
  );
}

export async function encrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: string,
): Promise<string> {
  if (!aad) throw new CryptoFormatError('aad is required');
  const nonce = randomBytes(NONCE_LEN);
  const k = await importAesKey(key, ['encrypt']);
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: utf8(aad), tagLength: 128 },
      k,
      plaintext as Uint8Array<ArrayBuffer>,
    ),
  );
  return `${FORMAT_V1}.${toBase64Url(nonce)}.${toBase64Url(ct)}`;
}

export async function decrypt(
  key: Uint8Array,
  sealed: string,
  aad: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const parts = sealed.split('.');
  if (parts.length !== 3 || parts[0] !== FORMAT_V1) {
    throw new CryptoFormatError('unsupported ciphertext format');
  }
  const nonce = fromBase64Url(parts[1] ?? '');
  const ct = fromBase64Url(parts[2] ?? '');
  if (nonce.length !== NONCE_LEN || ct.length < 16)
    throw new CryptoFormatError('malformed ciphertext');
  const k = await importAesKey(key, ['decrypt']);
  try {
    return new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: utf8(aad), tagLength: 128 },
        k,
        ct,
      ),
    );
  } catch {
    // Причину не раскрываем: неверный ключ, неверный AAD и повреждение выглядят одинаково.
    throw new CryptoAuthError();
  }
}

export function generateKey(): Uint8Array<ArrayBuffer> {
  return randomBytes(32);
}
