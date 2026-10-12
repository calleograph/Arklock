import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ExternalIdentity } from './enroll.js';

/** Итог проверки внешнего провайдера: вход существующего пользователя или создание учётной записи. */
export type LoginOutcome =
  | { kind: 'user'; userId: string; via: 'oidc' | 'saml' }
  | { kind: 'enroll'; identity: ExternalIdentity };

const b64url = (b: Buffer) => b.toString('base64url');
const challengeOf = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

/** Проверочное значение должно быть случайным и достаточно длинным: 32 байта в base64url — 43 знака. */
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
export const VERIFIER_RE = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * Одноразовые билеты возврата в приложение после входа через внешнего провайдера (OIDC, SAML).
 * Билет привязан к браузеру, начавшему вход: приложение хранит проверочное значение у себя (sessionStorage) и
 * присылает его при обмене. Так чужой браузер не может «подсунуть» жертве уже подтверждённый вход (login CSRF).
 */
export class LoginTickets {
  private readonly items = new Map<
    string,
    { out: LoginOutcome; challenge: string | null; expiresAt: number }
  >();

  issue(out: LoginOutcome, challenge: string | null, ttlMs = 2 * 60_000, now = Date.now()): string {
    for (const [k, v] of this.items) if (v.expiresAt <= now) this.items.delete(k);
    const ticket = randomBytes(24).toString('base64url');
    this.items.set(ticket, { out, challenge, expiresAt: now + ttlMs });
    return ticket;
  }

  take(ticket: string, verifier: string | undefined, now = Date.now()): LoginOutcome | null {
    const t = this.items.get(ticket);
    this.items.delete(ticket);
    if (!t || t.expiresAt <= now) return null;
    if (t.challenge === null) return t.out; // вход по инициативе провайдера: привязки к браузеру нет
    if (!verifier || !VERIFIER_RE.test(verifier)) return null;
    const a = Buffer.from(challengeOf(verifier));
    const b = Buffer.from(t.challenge);
    return a.length === b.length && timingSafeEqual(a, b) ? t.out : null;
  }
}

/** Короткоживущие записи начатого входа (state → данные), каждая берётся один раз. */
export class PendingStore<T> {
  private readonly items = new Map<string, { value: T; expiresAt: number }>();

  put(value: T, ttlMs = 10 * 60_000, now = Date.now()): string {
    for (const [k, v] of this.items) if (v.expiresAt <= now) this.items.delete(k);
    const key = randomBytes(24).toString('base64url');
    this.items.set(key, { value, expiresAt: now + ttlMs });
    return key;
  }

  take(key: string, now = Date.now()): T | undefined {
    const r = this.items.get(key);
    this.items.delete(key);
    return r && r.expiresAt > now ? r.value : undefined;
  }
}
