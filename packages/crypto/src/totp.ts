import { CryptoFormatError, utf8 } from './bytes.js';

/** TOTP (RFC 6238) / HOTP (RFC 4226) на WebCrypto. Секрет — Base32 (RFC 4648). */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export type TotpAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512';

export interface TotpParams {
  secret: string;
  digits?: 6 | 7 | 8;
  period?: number;
  algorithm?: TotpAlgorithm;
}

export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new CryptoFormatError('invalid base32 secret');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

const HASH: Record<TotpAlgorithm, string> = {
  'SHA-1': 'SHA-1',
  'SHA-256': 'SHA-256',
  'SHA-512': 'SHA-512',
};

export async function hotp(
  key: Uint8Array,
  counter: bigint,
  digits: number,
  algorithm: TotpAlgorithm,
): Promise<string> {
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, counter);
  const k = await globalThis.crypto.subtle.importKey(
    'raw',
    key as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: HASH[algorithm] },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', k, msg));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export async function totp(params: TotpParams, timeMs: number = Date.now()): Promise<string> {
  const period = params.period ?? 30;
  if (period < 1 || period > 300) throw new CryptoFormatError('invalid TOTP period');
  const counter = BigInt(Math.floor(timeMs / 1000 / period));
  return hotp(
    base32Decode(params.secret),
    counter,
    params.digits ?? 6,
    params.algorithm ?? 'SHA-1',
  );
}

/** Секунд до смены кода. */
export function totpRemaining(period = 30, timeMs: number = Date.now()): number {
  return period - (Math.floor(timeMs / 1000) % period);
}

/** Проверка кода с допуском ±window шагов (для входа с MFA на сервере). */
export async function verifyTotp(
  params: TotpParams,
  code: string,
  window = 1,
  timeMs: number = Date.now(),
): Promise<boolean> {
  if (!/^\d{6,8}$/.test(code)) return false;
  const period = params.period ?? 30;
  let ok = false;
  for (let i = -window; i <= window; i++) {
    const expected = await totp(params, timeMs + i * period * 1000);
    // без раннего выхода: время проверки не зависит от того, какой шаг совпал
    if (expected === code) ok = true;
  }
  return ok;
}

export function generateTotpSecret(bytes = 20): string {
  const raw = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(raw);
  return base32Encode(raw);
}

export function otpauthUri(issuer: string, account: string, params: TotpParams): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({ secret: params.secret, issuer });
  if (params.algorithm && params.algorithm !== 'SHA-1')
    q.set('algorithm', params.algorithm.replace('-', ''));
  if (params.digits && params.digits !== 6) q.set('digits', String(params.digits));
  if (params.period && params.period !== 30) q.set('period', String(params.period));
  return `otpauth://totp/${label}?${q.toString()}`;
}

/** Разбор otpauth://totp/… или «голого» Base32-секрета. */
export function parseTotpInput(input: string): TotpParams {
  const text = input.trim();
  if (!text.toLowerCase().startsWith('otpauth://')) {
    base32Decode(text);
    return { secret: text.toUpperCase().replace(/[\s=-]/g, '') };
  }
  const url = new URL(text);
  if (url.hostname.toLowerCase() !== 'totp') throw new CryptoFormatError('only TOTP is supported');
  const secret = url.searchParams.get('secret');
  if (!secret) throw new CryptoFormatError('otpauth URI has no secret');
  base32Decode(secret);
  const algo = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase();
  const algorithm: TotpAlgorithm =
    algo === 'SHA256' ? 'SHA-256' : algo === 'SHA512' ? 'SHA-512' : 'SHA-1';
  const digits = Number(url.searchParams.get('digits') ?? 6);
  const period = Number(url.searchParams.get('period') ?? 30);
  if (![6, 7, 8].includes(digits)) throw new CryptoFormatError('unsupported digits');
  return {
    secret: secret.toUpperCase().replace(/[\s=-]/g, ''),
    digits: digits as 6 | 7 | 8,
    period,
    algorithm,
  };
}

export const _utf8 = utf8; // реэкспорт для тестов RFC (ключи заданы ASCII-строками)
