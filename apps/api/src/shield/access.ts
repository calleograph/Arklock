import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/connect.js';
import { ipRules, settings } from '../db/schema.js';
import { CidrSet, normalizeIp, parseCidr } from './ip.js';

export const ACCESS_KEY = 'security.access';
export const PROXIES_KEY = 'security.proxies';
export const CONFIRM_SECONDS = 120;

export interface AccessState {
  enabled: boolean;
  /** Применено в режиме подтверждения: до этого времени администратор должен подтвердить доступ, иначе настройка откатится. */
  confirmBy?: number;
  changedAt?: string;
  changedBy?: string;
}

/**
 * Ограничение доступа по клиентским подсетям и список доверенных reverse proxy. Это два разных списка:
 * proxy — от кого принимается заголовок X-Forwarded-For; подсети — откуда пользователям разрешено обращаться.
 * Состояние читается из базы раз в 10 секунд (другие экземпляры и команда scripts/admin-reset.sh access-off подхватываются).
 */
export class AccessControl {
  state: AccessState = { enabled: false };
  allowed = new CidrSet([]);
  proxies: CidrSet | null = null;
  proxyCidrs: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly onRollback: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  async start(): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => void this.reload().catch(() => undefined), 10_000);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async reload(): Promise<void> {
    const [acc] = await this.db.select().from(settings).where(eq(settings.key, ACCESS_KEY));
    this.state = (acc?.value as AccessState | undefined) ?? { enabled: false };
    const rules = await this.db.select().from(ipRules).orderBy(asc(ipRules.createdAt));
    this.allowed = new CidrSet(rules.filter((r) => r.enabled).map((r) => r.cidr));
    const [px] = await this.db.select().from(settings).where(eq(settings.key, PROXIES_KEY));
    this.proxyCidrs = ((px?.value as { cidrs?: string[] } | undefined)?.cidrs ?? []).filter((c) =>
      parseCidr(c),
    );
    this.proxies = this.proxyCidrs.length ? new CidrSet(this.proxyCidrs) : null;
    await this.rollbackIfExpired();
  }

  /** Не подтверждённое вовремя включение откатывается на сервере, даже если администратор потерял доступ. */
  async rollbackIfExpired(): Promise<void> {
    if (this.state.enabled && this.state.confirmBy && this.state.confirmBy < this.now()) {
      this.state = { enabled: false, changedAt: new Date().toISOString(), changedBy: 'rollback' };
      await this.db
        .insert(settings)
        .values({ key: ACCESS_KEY, value: this.state, updatedBy: 'rollback' })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: this.state, updatedBy: 'rollback', updatedAt: new Date() },
        });
      this.onRollback();
    }
  }

  /** Доступ с адреса разрешён? Петля (консоль сервера) разрешена всегда. */
  permits(ipRaw: string): boolean {
    if (!this.state.enabled) return true;
    const ip = normalizeIp(ipRaw);
    if (ip === '::1' || ip.startsWith('127.')) return true;
    return this.allowed.has(ip);
  }

  /** Функция для trustProxy Fastify: при заданном списке доверяются только перечисленные адреса, иначе — число звеньев. */
  trust(hops: number): (address: string, hop: number) => boolean {
    return (address, hop) => (this.proxies ? this.proxies.has(address) : hop < hops);
  }
}
