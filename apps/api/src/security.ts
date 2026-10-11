import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

export function randomB64url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Проверочное значение для входа. Клиент присылает authKey — 256 бит, выведенные Argon2id из мастер-пароля,
 * поэтому достаточно HMAC-SHA-256 с индивидуальной солью (подбор authKey эквивалентен подбору Argon2id-вывода).
 */
export function hashProof(salt: string, proof: string): string {
  return createHmac('sha256', Buffer.from(salt, 'base64url')).update(proof).digest('base64url');
}

export function verifyProof(salt: string, proof: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashProof(salt, proof));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Детерминированные «вымышленные» параметры для неизвестных адресов: ответ неотличим от настоящего,
 * поэтому по /auth/params нельзя перебирать зарегистрированные адреса.
 */
export function fakeBytes(secret: string, label: string, email: string, length: number): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  while (Buffer.concat(out).length < length) {
    out.push(createHmac('sha256', secret).update(`${label}|${i++}|${email}`).digest());
  }
  return Buffer.concat(out).subarray(0, length);
}

export function fakeUuid(secret: string, email: string): string {
  const b = fakeBytes(secret, 'uuid', email, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
