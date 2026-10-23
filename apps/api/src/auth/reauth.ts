import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { authOf } from './session.js';

/**
 * Повышенное подтверждение (step-up) для разрушительных операций: откат версии, восстановление и удаление копий,
 * выгрузка копии, изменение удалённого хранилища. Одно подтверждение действует 15 минут на все такие операции сеанса;
 * токен привязан к сеансу и хранится только в памяти процесса (в виде SHA-256). Штатное обновление его не требует.
 */
export const REAUTH_TTL_MS = 15 * 60_000;
const TTL_MS = REAUTH_TTL_MS;

export class ReauthStore {
  private readonly tokens = new Map<string, { sessionId: string; expiresAt: number }>();

  issue(sessionId: string, now = Date.now()): { token: string; expiresAt: Date } {
    this.sweep(now);
    const token = `ra_${randomBytes(24).toString('base64url')}`;
    const expiresAt = now + TTL_MS;
    this.tokens.set(this.key(token), { sessionId, expiresAt });
    return { token, expiresAt: new Date(expiresAt) };
  }

  check(token: string | undefined, sessionId: string, now = Date.now()): boolean {
    if (!token) return false;
    const rec = this.tokens.get(this.key(token));
    return !!rec && rec.sessionId === sessionId && rec.expiresAt > now;
  }

  private key(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private sweep(now: number): void {
    for (const [k, v] of this.tokens) if (v.expiresAt <= now) this.tokens.delete(k);
  }
}

/** Отказ, если в этом сеансе нет действующего подтверждения мастер-паролем (заголовок X-Reauth-Token). */
export function requireReauth(ctx: AppContext, req: FastifyRequest): void {
  const token = req.headers['x-reauth-token'];
  if (!ctx.reauth.check(typeof token === 'string' ? token : undefined, authOf(req).session.id))
    throw new AppError(403, 'reauth_required', 'Confirm your master password to continue');
}
