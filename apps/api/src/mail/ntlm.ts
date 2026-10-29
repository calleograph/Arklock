import { createHmac, randomBytes } from 'node:crypto';

/**
 * NTLMv2 для SMTP AUTH NTLM (Microsoft Exchange, MS-NLMP). Только NTLMv2: ответ NTLMv1 и LM никогда не
 * строится, а готовое сообщение проверяется перед отправкой. Привязка к каналу (EPA) и Kerberos не
 * поддерживаются. Пароль и данные обмена наружу не выходят: модуль не пишет в журнал и не кладёт их в ошибки.
 *
 * MD4 нужен, потому что NT-хеш пароля — это MD4(UTF-16LE(пароль)), а OpenSSL 3 в Node его не отдаёт.
 */

const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1');
const F_UNICODE = 0x00000001;
const F_REQUEST_TARGET = 0x00000004;
const F_NTLM = 0x00000200;
const F_ALWAYS_SIGN = 0x00008000;
const F_EXTENDED_SESSIONSECURITY = 0x00080000;
const F_TARGET_INFO = 0x00800000;
const F_128 = 0x20000000;
const F_56 = 0x80000000;
const AV_EOL = 0;
const AV_FLAGS = 6;
const AV_TIMESTAMP = 7;

export class NtlmError extends Error {
  constructor(
    message: string,
    readonly code: 'ntlm_start' | 'ntlm_challenge' | 'ntlm_v1',
  ) {
    super(message);
  }
}

/** MD4 (RFC 1320). */
export function md4(input: Buffer): Buffer {
  const len = input.length;
  const padded = Buffer.alloc((((len + 8) >> 6) << 6) + 64);
  input.copy(padded);
  padded[len] = 0x80;
  padded.writeUInt32LE((len * 8) >>> 0, padded.length - 8);
  padded.writeUInt32LE(Math.floor((len * 8) / 0x100000000), padded.length - 4);
  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const rol = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const f = (x: number, y: number, z: number) => ((x & y) | (~x & z)) >>> 0;
  const g = (x: number, y: number, z: number) => ((x & y) | (x & z) | (y & z)) >>> 0;
  const h = (x: number, y: number, z: number) => (x ^ y ^ z) >>> 0;
  for (let off = 0; off < padded.length; off += 64) {
    const x = Array.from({ length: 16 }, (_, i) => padded.readUInt32LE(off + i * 4));
    const [aa, bb, cc, dd] = [a, b, c, d];
    for (const i of [0, 4, 8, 12]) {
      a = rol((a + f(b, c, d) + x[i]!) >>> 0, 3);
      d = rol((d + f(a, b, c) + x[i + 1]!) >>> 0, 7);
      c = rol((c + f(d, a, b) + x[i + 2]!) >>> 0, 11);
      b = rol((b + f(c, d, a) + x[i + 3]!) >>> 0, 19);
    }
    for (const i of [0, 1, 2, 3]) {
      a = rol((a + g(b, c, d) + x[i]! + 0x5a827999) >>> 0, 3);
      d = rol((d + g(a, b, c) + x[i + 4]! + 0x5a827999) >>> 0, 5);
      c = rol((c + g(d, a, b) + x[i + 8]! + 0x5a827999) >>> 0, 9);
      b = rol((b + g(c, d, a) + x[i + 12]! + 0x5a827999) >>> 0, 13);
    }
    for (const i of [0, 2, 1, 3]) {
      a = rol((a + h(b, c, d) + x[i]! + 0x6ed9eba1) >>> 0, 3);
      d = rol((d + h(a, b, c) + x[i + 8]! + 0x6ed9eba1) >>> 0, 9);
      c = rol((c + h(d, a, b) + x[i + 4]! + 0x6ed9eba1) >>> 0, 11);
      b = rol((b + h(c, d, a) + x[i + 12]! + 0x6ed9eba1) >>> 0, 15);
    }
    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }
  const out = Buffer.alloc(16);
  [a, b, c, d].forEach((v, i) => out.writeUInt32LE(v, i * 4));
  return out;
}

const hmacMd5 = (key: Buffer, data: Buffer) => createHmac('md5', key).update(data).digest();
const utf16 = (s: string) => Buffer.from(s, 'utf16le');

/** NTOWFv2 = HMAC_MD5(MD4(UTF-16LE(пароль)), UTF-16LE(ИМЯ в верхнем регистре + домен)). */
export function ntowfV2(user: string, domain: string, password: string): Buffer {
  return hmacMd5(md4(utf16(password)), utf16(user.toUpperCase() + domain));
}

/** «ДОМЕН\логин» → домен и логин; «логин@домен» остаётся целиком логином (UPN), домен пустой. */
export function splitAccount(account: string): { user: string; domain: string } {
  const i = account.indexOf('\\');
  return i > 0
    ? { domain: account.slice(0, i), user: account.slice(i + 1) }
    : { domain: '', user: account };
}

function secBuf(len: number, offset: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(len, 0);
  b.writeUInt16LE(len, 2);
  b.writeUInt32LE(offset, 4);
  return b;
}

/** Type 1 (Negotiate). */
export function ntlmNegotiate(): Buffer {
  const flags =
    F_UNICODE |
    F_REQUEST_TARGET |
    F_NTLM |
    F_ALWAYS_SIGN |
    F_EXTENDED_SESSIONSECURITY |
    F_TARGET_INFO |
    F_128 |
    F_56;
  const b = Buffer.alloc(32);
  SIGNATURE.copy(b, 0);
  b.writeUInt32LE(1, 8);
  b.writeUInt32LE(flags >>> 0, 12);
  secBuf(0, 32).copy(b, 16);
  secBuf(0, 32).copy(b, 24);
  return b;
}

export function ntlmType(token: Buffer): number | null {
  return token.length >= 12 && token.subarray(0, 8).equals(SIGNATURE)
    ? token.readUInt32LE(8)
    : null;
}

/**
 * Готовое сообщение Authenticate содержит ответ NTLMv2: NT-ответ длиннее 24 байт (NTLMv1 — ровно 24),
 * после 16 байт NTProofStr идёт блок версии 0x0101.
 */
export function isNtlmV2Authenticate(token: Buffer): boolean {
  if (ntlmType(token) !== 3 || token.length < 28) return false;
  const len = token.readUInt16LE(20);
  const off = token.readUInt32LE(24);
  if (len <= 24 || off + len > token.length) return false;
  return token[off + 16] === 0x01 && token[off + 17] === 0x01;
}

const filetime = (ms: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE((BigInt(ms) + 11644473600000n) * 10000n);
  return b;
};

export interface NtlmClock {
  now?: () => number;
  /** Только для проверок: фиксированный клиентский вызов. */
  clientChallenge?: Buffer;
}

/** Type 2 (Challenge) → Type 3 (Authenticate); пароль в сообщение не попадает, только ответ на вызов. */
export function ntlmAuthenticate(
  negotiate: Buffer,
  challenge: Buffer,
  account: string,
  password: string,
  workstation = 'ARKLOCK',
  clock: NtlmClock = {},
): Buffer {
  if (ntlmType(challenge) !== 2 || challenge.length < 48)
    throw new NtlmError(
      'The server sent something that is not an NTLM challenge',
      'ntlm_challenge',
    );
  const flags = challenge.readUInt32LE(20);
  const serverChallenge = challenge.subarray(24, 32);
  const tiLen = challenge.readUInt16LE(40);
  const tiOff = challenge.readUInt32LE(44);
  if (tiOff + tiLen > challenge.length)
    throw new NtlmError('The NTLM challenge is truncated', 'ntlm_challenge');
  let targetInfo = Buffer.from(challenge.subarray(tiOff, tiOff + tiLen));

  // пары AV: ищем отметку времени сервера; если она есть, добавляем признак MIC
  let timestamp: Buffer | null = null;
  const pairs: { id: number; value: Buffer }[] = [];
  for (let p = 0; p + 4 <= targetInfo.length;) {
    const id = targetInfo.readUInt16LE(p);
    const len = targetInfo.readUInt16LE(p + 2);
    if (id === AV_EOL) break;
    const value = targetInfo.subarray(p + 4, p + 4 + len);
    if (id === AV_TIMESTAMP && len === 8) timestamp = Buffer.from(value);
    if (id === AV_FLAGS && len === 4) {
      p += 4 + len;
      continue;
    }
    pairs.push({ id, value: Buffer.from(value) });
    p += 4 + len;
  }
  const useMic = timestamp !== null;
  if (useMic) {
    const f = Buffer.alloc(4);
    f.writeUInt32LE(0x2);
    pairs.push({ id: AV_FLAGS, value: f });
  }
  targetInfo = Buffer.concat([
    ...pairs.flatMap((p) => {
      const h = Buffer.alloc(4);
      h.writeUInt16LE(p.id, 0);
      h.writeUInt16LE(p.value.length, 2);
      return [h, p.value];
    }),
    Buffer.alloc(4),
  ]);

  const { user, domain } = splitAccount(account);
  const key = ntowfV2(user, domain, password);
  const clientChallenge = clock.clientChallenge ?? randomBytes(8);
  const blob = Buffer.concat([
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]),
    timestamp ?? filetime((clock.now ?? Date.now)()),
    clientChallenge,
    Buffer.alloc(4),
    targetInfo,
    Buffer.alloc(4),
  ]);
  const proof = hmacMd5(key, Buffer.concat([serverChallenge, blob]));
  const ntResponse = Buffer.concat([proof, blob]);
  const sessionBaseKey = hmacMd5(key, proof);
  // с отметкой времени LM-ответ — нули; без неё — LMv2 (HMAC от обоих вызовов)
  const lmResponse = useMic
    ? Buffer.alloc(24)
    : Buffer.concat([
        hmacMd5(key, Buffer.concat([serverChallenge, clientChallenge])),
        clientChallenge,
      ]);

  const unicode = (flags & F_UNICODE) !== 0;
  const enc = (s: string) => (unicode ? utf16(s) : Buffer.from(s, 'latin1'));
  const parts = [lmResponse, ntResponse, enc(domain), enc(user), enc(workstation), Buffer.alloc(0)];
  const headLen = 88;
  const head = Buffer.alloc(headLen);
  SIGNATURE.copy(head, 0);
  head.writeUInt32LE(3, 8);
  let off = headLen;
  [12, 20, 28, 36, 44, 52].forEach((at, i) => {
    secBuf(parts[i]!.length, off).copy(head, at);
    off += parts[i]!.length;
  });
  head.writeUInt32LE(
    (flags &
      (F_UNICODE |
        F_NTLM |
        F_ALWAYS_SIGN |
        F_EXTENDED_SESSIONSECURITY |
        F_128 |
        F_56 |
        F_TARGET_INFO)) >>>
      0,
    60,
  );
  const message = Buffer.concat([head, ...parts]);
  if (useMic)
    hmacMd5(sessionBaseKey, Buffer.concat([negotiate, challenge, message])).copy(message, 72);
  if (!isNtlmV2Authenticate(message))
    throw new NtlmError('The NTLM response is not NTLMv2; NTLMv1 is never sent', 'ntlm_v1');
  return message;
}
