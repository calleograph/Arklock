import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lt } from 'drizzle-orm';
import type { Db } from '../db/connect.js';
import { captchaUsed } from '../db/schema.js';

/**
 * Проверка подбором (proof of work): сервер выдаёт подписанное задание, клиент подбирает число, при котором
 * SHA-256(salt + число) начинается с заданного числа нулевых бит. Работает без внешних сервисов, без картинок и без
 * действий пользователя (доступна для программ экранного доступа). Стоимость растёт вместе с числом ошибок.
 * Это не отличает человека от программы, а удорожает перебор; поэтому проверка дополняет, а не заменяет ограничения.
 */
export interface Challenge {
  id: string;
  salt: string;
  bits: number;
  exp: number;
  sig: string;
}
export interface Solution extends Challenge {
  number: number;
}

export const CHALLENGE_TTL_MS = 5 * 60_000;

const sign = (secret: string, c: Omit<Challenge, 'sig'>, scope: string): string =>
  createHmac('sha256', createHash('sha256').update(`captcha|${secret}`).digest())
    .update(`${c.id}.${c.salt}.${c.bits}.${c.exp}.${scope}`)
    .digest('base64url');

export function issueChallenge(secret: string, scope: string, bits: number): Challenge {
  const c = {
    id: randomBytes(12).toString('base64url'),
    salt: randomBytes(12).toString('base64url'),
    bits,
    exp: Date.now() + CHALLENGE_TTL_MS,
  };
  return { ...c, sig: sign(secret, c, scope) };
}

export function leadingZeroBits(buf: Buffer): number {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

/** Решение верно, подпись и срок действительны, задание ещё не использовано. */
export async function verifySolution(
  db: Db,
  secret: string,
  scope: string,
  s: Solution,
  minBits: number,
): Promise<boolean> {
  if (!s || typeof s.number !== 'number' || !Number.isSafeInteger(s.number) || s.number < 0)
    return false;
  if (typeof s.id !== 'string' || typeof s.salt !== 'string' || typeof s.sig !== 'string')
    return false;
  if (!Number.isInteger(s.bits) || s.bits < minBits || s.bits > 24) return false;
  if (!Number.isFinite(s.exp) || s.exp < Date.now() || s.exp > Date.now() + CHALLENGE_TTL_MS + 5000)
    return false;
  const expected = Buffer.from(sign(secret, s, scope));
  const given = Buffer.from(s.sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  const digest = createHash('sha256').update(`${s.salt}${s.number}`).digest();
  if (leadingZeroBits(digest) < s.bits) return false;
  // одноразовость: повторная вставка того же идентификатора отклоняется базой (и на другом экземпляре)
  const inserted = await db
    .insert(captchaUsed)
    .values({ id: s.id, expiresAt: new Date(s.exp + 60_000) })
    .onConflictDoNothing()
    .returning({ id: captchaUsed.id });
  return inserted.length === 1;
}

export async function pruneCaptcha(db: Db): Promise<void> {
  await db.delete(captchaUsed).where(lt(captchaUsed.expiresAt, new Date()));
}
