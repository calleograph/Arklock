import { CryptoFormatError, concat, fromBase64Url, toBase64Url, utf8 } from './bytes.js';
import { ctx } from './context.js';

/**
 * Подписи ECDSA P-256 для аутентификации отправителя ключей и привязки открытых ключей к идентичности.
 * Подпись покрывает контекст (хранилище, получатель, версия ключа) и хэш запечатанного ключа, поэтому сервер
 * не может подменить ключ, получателя или версию.
 */
const SIGN = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export interface SigningKeyPair {
  publicKey: Uint8Array<ArrayBuffer>;
  privateKey: Uint8Array<ArrayBuffer>;
}

export async function generateSigningKeyPair(): Promise<SigningKeyPair> {
  const kp = await globalThis.crypto.subtle.generateKey(SIGN, true, ['sign', 'verify']);
  return {
    publicKey: new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey)),
    privateKey: new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', kp.privateKey)),
  };
}

export async function sign(
  privateKey: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const k = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    privateKey as Uint8Array<ArrayBuffer>,
    SIGN,
    false,
    ['sign'],
  );
  return new Uint8Array(
    await globalThis.crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      k,
      message as Uint8Array<ArrayBuffer>,
    ),
  );
}

export async function verify(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04)
    throw new CryptoFormatError('invalid P-256 public key');
  const k = await globalThis.crypto.subtle.importKey(
    'raw',
    publicKey as Uint8Array<ArrayBuffer>,
    SIGN,
    false,
    ['verify'],
  );
  return globalThis.crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    k,
    signature as Uint8Array<ArrayBuffer>,
    message as Uint8Array<ArrayBuffer>,
  );
}

export async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>),
  );
}

/** Отпечаток пары открытых ключей пользователя: 12 групп по 4 hex-символа (сверяется вне системы). */
export async function fingerprint(encPublic: Uint8Array, signPublic: Uint8Array): Promise<string> {
  const h = await sha256(concat(encPublic, signPublic));
  const hex = [...h.slice(0, 24)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.match(/.{4}/g)!.join(' ');
}

function grantMessage(
  vaultId: string,
  memberId: string,
  keyVersion: number,
  sealedHash: Uint8Array,
) {
  return concat(utf8(ctx('vault-key-grant', vaultId, memberId, keyVersion)), sealedHash);
}

/** Подпись выдачи ключа хранилища участнику (делает отправитель — администратор хранилища). */
export async function signKeyGrant(
  senderSignPrivate: Uint8Array,
  vaultId: string,
  memberId: string,
  keyVersion: number,
  sealed: string,
): Promise<string> {
  const sig = await sign(
    senderSignPrivate,
    grantMessage(vaultId, memberId, keyVersion, await sha256(utf8(sealed))),
  );
  return toBase64Url(sig);
}

export async function verifyKeyGrant(
  senderSignPublic: Uint8Array,
  signature: string,
  vaultId: string,
  memberId: string,
  keyVersion: number,
  sealed: string,
): Promise<boolean> {
  return verify(
    senderSignPublic,
    fromBase64Url(signature),
    grantMessage(vaultId, memberId, keyVersion, await sha256(utf8(sealed))),
  );
}

/**
 * Журнал привязки ключей (хэш-цепочка, «прозрачность ключей»): каждая запись связывает идентичность с парой открытых
 * ключей и включает хэш предыдущей записи. Клиент проверяет, что известная ему часть цепочки не изменена сервером.
 */
export async function keyLogHash(
  prevHash: string,
  userId: string,
  encPublic: string,
  signPublic: string,
): Promise<string> {
  return toBase64Url(await sha256(utf8(ctx('key-log', prevHash, userId, encPublic, signPublic))));
}

export async function verifyKeyLog(
  entries: {
    userId: string;
    encPublic: string;
    signPublic: string;
    prevHash: string;
    hash: string;
  }[],
): Promise<boolean> {
  let prev = '';
  for (const e of entries) {
    if (e.prevHash !== prev) return false;
    if ((await keyLogHash(e.prevHash, e.userId, e.encPublic, e.signPublic)) !== e.hash)
      return false;
    prev = e.hash;
  }
  return true;
}
