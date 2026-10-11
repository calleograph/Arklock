import { decrypt, encrypt, generateKey } from './aead.js';
import { argon2id } from 'hash-wasm';
import { CryptoFormatError, concat, fromBase64Url, fromUtf8, toBase64Url, utf8 } from './bytes.js';
import { ctx } from './context.js';
import { hkdf } from './kdf.js';

/**
 * Безопасная передача секрета по ссылке (Handoff). Ключ ссылки создаётся в браузере отправителя и находится только
 * во фрагменте URL (#…), который браузер не отправляет серверу. Сервер хранит лишь шифртекст, срок и счётчик просмотров.
 * Необязательная парольная фраза добавляется в вывод ключа (Argon2id): без неё одной ссылки недостаточно.
 */
const PASS_KDF = { memorySize: 19456, iterations: 2, parallelism: 1 } as const;

async function derive(
  linkKey: Uint8Array,
  passphrase: string | undefined,
  id: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!passphrase) return hkdf(linkKey, utf8(id), 'arklock/v1/handoff');
  const stretched = await argon2id({
    password: passphrase.normalize('NFKC'),
    salt: concat(linkKey.slice(0, 16), utf8(id)),
    hashLength: 32,
    outputType: 'binary',
    ...PASS_KDF,
  });
  return hkdf(concat(linkKey, stretched), utf8(id), 'arklock/v1/handoff-pass');
}

export interface HandoffPackage {
  /** Ключ для фрагмента ссылки (base64url). */
  fragment: string;
  /** Шифртекст для сервера. */
  ciphertext: string;
}

export async function createHandoff(
  id: string,
  payload: unknown,
  passphrase?: string,
): Promise<HandoffPackage> {
  const linkKey = generateKey();
  const key = await derive(linkKey, passphrase, id);
  const ciphertext = await encrypt(
    key,
    utf8(JSON.stringify(payload)),
    ctx('handoff', id, passphrase ? 1 : 0),
  );
  key.fill(0);
  return { fragment: toBase64Url(linkKey), ciphertext };
}

export async function openHandoff<T = unknown>(
  id: string,
  ciphertext: string,
  fragment: string,
  passphrase?: string,
): Promise<T> {
  const linkKey = fromBase64Url(fragment);
  if (linkKey.length !== 32) throw new CryptoFormatError('invalid handoff key');
  const key = await derive(linkKey, passphrase, id);
  try {
    const plain = await decrypt(key, ciphertext, ctx('handoff', id, passphrase ? 1 : 0));
    return JSON.parse(fromUtf8(plain)) as T;
  } finally {
    key.fill(0);
  }
}
