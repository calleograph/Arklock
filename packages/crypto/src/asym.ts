import { ctx } from './context.js';
import { CryptoFormatError, concat, fromBase64Url, toBase64Url } from './bytes.js';
import { decrypt, encrypt } from './aead.js';
import { hkdf } from './kdf.js';

/** Асимметричная часть: ECDH P-256. Закрытый ключ — pkcs8, открытый — raw (65 байт, несжатая точка). */
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;

export interface AccountKeyPair {
  publicKey: Uint8Array<ArrayBuffer>;
  privateKey: Uint8Array<ArrayBuffer>;
}

export async function generateAccountKeyPair(): Promise<AccountKeyPair> {
  const kp = await globalThis.crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
  const publicKey = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey));
  const privateKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey('pkcs8', kp.privateKey),
  );
  return { publicKey, privateKey };
}

function importPublic(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 65 || raw[0] !== 0x04) throw new CryptoFormatError('invalid P-256 public key');
  return globalThis.crypto.subtle.importKey(
    'raw',
    raw as Uint8Array<ArrayBuffer>,
    CURVE,
    false,
    [],
  );
}

function importPrivate(pkcs8: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'pkcs8',
    pkcs8 as Uint8Array<ArrayBuffer>,
    CURVE,
    false,
    ['deriveBits'],
  );
}

async function sharedKey(
  priv: CryptoKey,
  pub: CryptoKey,
  ephPub: Uint8Array,
  rcptPub: Uint8Array,
  context: string,
) {
  const secret = new Uint8Array(
    await globalThis.crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256),
  );
  const key = await hkdf(secret, concat(ephPub, rcptPub), `arklock/v1/seal/${context}`);
  secret.fill(0);
  return key;
}

/**
 * Запечатать данные для получателя (sealed box): эфемерная пара ECDH → HKDF → AES-256-GCM.
 * Формат: "as1." + base64url(ephemeralPublic[65]) + "." + ak1-шифртекст.
 * `context` входит и в вывод ключа, и в AAD (например "vault-key:<vaultId>:<userId>:<версия>").
 */
export async function sealTo(
  recipientPublic: Uint8Array,
  data: Uint8Array,
  context: string,
): Promise<string> {
  const rcpt = await importPublic(recipientPublic);
  const eph = await globalThis.crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
  const ephPub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', eph.publicKey));
  const key = await sharedKey(eph.privateKey, rcpt, ephPub, recipientPublic, context);
  const sealed = await encrypt(key, data, ctx('seal', context));
  key.fill(0);
  return `as1.${toBase64Url(ephPub)}.${sealed}`;
}

export async function openSealed(
  recipientPrivate: Uint8Array,
  recipientPublic: Uint8Array,
  sealed: string,
  context: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const idx = sealed.indexOf('.', 4);
  if (!sealed.startsWith('as1.') || idx < 0)
    throw new CryptoFormatError('unsupported sealed format');
  const ephPub = fromBase64Url(sealed.slice(4, idx));
  const priv = await importPrivate(recipientPrivate);
  const eph = await importPublic(ephPub);
  const key = await sharedKey(priv, eph, ephPub, recipientPublic, context);
  try {
    return await decrypt(key, sealed.slice(idx + 1), ctx('seal', context));
  } finally {
    key.fill(0);
  }
}
