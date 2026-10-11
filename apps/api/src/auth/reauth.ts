import { createHash, randomBytes } from 'node:crypto';

/**
 * Повторное подтверждение личности для опасных операций (обновление, откат, восстановление).
 * Токен действует 5 минут, привязан к сеансу и хранится только в памяти процесса (в виде SHA-256).
 */
const TTL_MS = 5 * 60_000;

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
