import { createHash } from 'node:crypto';
import { lt } from 'drizzle-orm';
import type { Db } from '../db/connect.js';
import { securityEvents } from '../db/schema.js';

export interface SecurityEventInput {
  kind: string;
  level: 'info' | 'warn' | 'critical' | 'ok';
  result: string;
  ip?: string | null;
  userId?: string | null;
  /** Хэш учётной записи (acctKey), а не адрес: неизвестные записи не раскрываются. */
  account?: string | null;
  rule?: string | null;
  seconds?: number | null;
  source?: string | null;
  requestId?: string | null;
  /** Только безопасные сведения: без паролей, кодов, токенов и тел запросов. */
  detail?: Record<string, string | number | boolean | null>;
}

/** Короткий хэш нормализованного адреса учётной записи. */
export const acctKey = (email: string): string =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);

export const MAX_EVENTS = 200_000;

/**
 * Журнал событий безопасности. Записи складываются в очередь и сохраняются пачками: проверка запроса не ждёт базу.
 * Сбой записи не прерывает запрос, но выводится в журнал процесса и виден на обзоре (failures).
 */
export class SecurityLog {
  private queue: SecurityEventInput[] = [];
  private timer: NodeJS.Timeout | null = null;
  failures = 0;
  lastFailureAt: number | null = null;
  private inFlight: Promise<void> = Promise.resolve();

  /** Подписчик на каждое событие (оповещения администраторов). */
  onRecord?: (e: SecurityEventInput) => void;

  constructor(private readonly db: Db) {}

  record(e: SecurityEventInput): void {
    this.queue.push(e);
    this.onRecord?.(e);
    if (this.queue.length >= 50) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), 1000);
      this.timer.unref();
    }
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.queue.splice(0, this.queue.length);
    if (!batch.length) return this.inFlight;
    this.inFlight = this.inFlight.then(async () => {
      try {
        await this.db.insert(securityEvents).values(
          batch.map((e) => ({
            kind: e.kind,
            level: e.level,
            result: e.result,
            ip: e.ip ?? null,
            userId: e.userId ?? null,
            account: e.account ?? null,
            rule: e.rule ?? null,
            seconds: e.seconds ?? null,
            source: e.source ?? null,
            requestId: e.requestId ?? null,
            detail: e.detail ?? {},
          })),
        );
      } catch (err) {
        this.failures += 1;
        this.lastFailureAt = Date.now();
        console.error('security log write failed', (err as Error).message);
      }
    });
    return this.inFlight;
  }

  /** Удаляет записи старше срока хранения. */
  async prune(retentionDays: number): Promise<void> {
    await this.db
      .delete(securityEvents)
      .where(lt(securityEvents.at, new Date(Date.now() - retentionDays * 86_400_000)));
  }
}
