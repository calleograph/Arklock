import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/connect.js';
import { securityBlocks, sessions, users } from '../db/schema.js';
import { AppError } from '../errors.js';
import { acctKey, SecurityLog } from './events.js';
import { issueChallenge, pruneCaptcha, verifySolution, type Solution } from './captcha.js';
import { normalizeIp } from './ip.js';
import { DEFAULT_POLICY, loadPolicy, type ShieldPolicy } from './policy.js';

export type Scope = 'login' | 'recovery' | 'mfa' | 'directory';

/** Для восстановления доступа ограничения строже: порог проверки и блокировки вдвое ниже. */
const STRICT: Record<Scope, number> = { login: 1, directory: 1, mfa: 1, recovery: 0.5 };

interface ActiveBlock {
  id: string;
  until: number;
  rule: string;
  reason: string;
  strikes: number;
}

/**
 * Централизованная защита входа и восстановления. Состояние ошибок хранится на сервере и не зависит от cookie, вкладки,
 * режима инкогнито или User-Agent. Активные блокировки лежат в базе: переживают перезапуск и видны другим экземплярам
 * (кэш обновляется раз в 10 секунд). Счётчики ошибок скользящего окна — в памяти процесса: после перезапуска они
 * обнуляются, но уже наложенные блокировки остаются.
 *
 * Ключи: адрес, пара «адрес + учётная запись», учётная запись (по всем адресам). Учётная запись никогда не блокируется целиком:
 * ошибки с чужих адресов лишь включают дополнительную проверку для незнакомых адресов, а не отказ законному владельцу.
 */
export class Shield {
  policy: ShieldPolicy = DEFAULT_POLICY;
  private readonly fails = new Map<string, number[]>();
  private blocks = new Map<string, ActiveBlock>();
  private readonly sampled = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  /** Счётчики для обзора с момента запуска процесса. */
  counters = { rejected: 0, captchaShown: 0, captchaFailed: 0 };

  constructor(
    private readonly db: Db,
    private readonly secret: string,
    readonly log: SecurityLog,
    private readonly now: () => number = Date.now,
  ) {}

  async start(): Promise<void> {
    this.policy = await loadPolicy(this.db);
    await this.refreshBlocks();
    const every = (ms: number, fn: () => Promise<void>) => {
      const t = setInterval(() => void fn().catch(() => undefined), ms);
      t.unref();
      this.timers.push(t);
    };
    every(10_000, () => this.refreshBlocks());
    every(60 * 60_000, () => pruneCaptcha(this.db));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  async reloadPolicy(): Promise<void> {
    this.policy = await loadPolicy(this.db);
  }

  async refreshBlocks(): Promise<void> {
    const rows = await this.db
      .select()
      .from(securityBlocks)
      .where(and(isNull(securityBlocks.releasedAt), gt(securityBlocks.expiresAt, new Date())));
    this.blocks = new Map(
      rows.map((r) => [
        r.key,
        {
          id: r.id,
          until: r.expiresAt.getTime(),
          rule: r.rule,
          reason: r.reason,
          strikes: r.strikes,
        },
      ]),
    );
  }

  // ---- счётчики ----
  private windowMs(): number {
    return this.policy.windowMinutes * 60_000;
  }
  private count(key: string): number {
    const t = this.now() - this.windowMs();
    const list = (this.fails.get(key) ?? []).filter((x) => x > t);
    if (list.length) this.fails.set(key, list);
    else this.fails.delete(key);
    return list.length;
  }
  private add(key: string): number {
    this.count(key);
    const list = this.fails.get(key) ?? [];
    list.push(this.now());
    this.fails.set(key, list);
    return list.length;
  }
  /** Сводка для обзора: сколько источников сейчас под наблюдением. */
  get watched(): number {
    return this.fails.size;
  }
  activeBlocks(): number {
    const now = this.now();
    return [...this.blocks.values()].filter((b) => b.until > now).length;
  }

  private blockOf(key: string): ActiveBlock | null {
    const b = this.blocks.get(key);
    if (!b) return null;
    if (b.until <= this.now()) {
      this.blocks.delete(key);
      return null;
    }
    return b;
  }

  /** Адрес или пара под блокировкой: секунды до окончания, иначе 0. */
  blockedFor(ip: string, account?: string): { seconds: number; rule: string } | null {
    const hit =
      this.blockOf(`ip:${ip}`) ?? (account ? this.blockOf(`pair:${ip}|${account}`) : null);
    return hit
      ? { seconds: Math.max(1, Math.ceil((hit.until - this.now()) / 1000)), rule: hit.rule }
      : null;
  }

  private accountKeys(email: string): string[] {
    const h = acctKey(email);
    return (['login', 'recovery', 'directory'] as const).map((sc) => `${sc}:${h}`);
  }

  /** Самое долгое активное ограничение пары «адрес + эта учётная запись», секунд (для панели: «временная блокировка»). */
  accountBlockedFor(email: string): number {
    const now = this.now();
    let max = 0;
    for (const [key, b] of this.blocks)
      if (
        b.until > now &&
        key.startsWith('pair:') &&
        this.accountKeys(email).some((a) => key.endsWith(`|${a}`))
      )
        max = Math.max(max, Math.ceil((b.until - now) / 1000));
    return max;
  }

  /** Администратор снимает ограничения этой учётной записи: блокировки пар и счётчики ошибок. История блокировок остаётся. */
  async unlockAccount(email: string, by: string): Promise<void> {
    const keys = this.accountKeys(email);
    for (const [key, b] of [...this.blocks])
      if (key.startsWith('pair:') && keys.some((a) => key.endsWith(`|${a}`)))
        await this.release(b.id, by);
    for (const key of [...this.fails.keys()])
      if (
        keys.some((a) => key === `acct:${a}` || (key.startsWith('pair:') && key.endsWith(`|${a}`)))
      )
        this.fails.delete(key);
  }

  private sample(key: string, everyMs = 60_000): boolean {
    const last = this.sampled.get(key) ?? 0;
    if (this.now() - last < everyMs) return false;
    this.sampled.set(key, this.now());
    if (this.sampled.size > 5000) this.sampled.clear();
    return true;
  }

  /** С этого адреса уже входили в эту учётную запись (сеанс за последние 60 суток). */
  private async knownIp(email: string, ip: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(users.email, email),
          eq(sessions.ip, ip),
          gt(sessions.createdAt, new Date(this.now() - 60 * 86_400_000)),
        ),
      )
      .limit(1);
    return !!row;
  }

  private scopeKey(scope: Scope, account: string): string {
    return `${scope}:${acctKey(account)}`;
  }

  /**
   * Проверка ПЕРЕД обработкой попытки. Бросает 429 (адрес или пара ограничены) или 403 captcha_required с заданием.
   * Поведение одинаково для существующих и несуществующих учётных записей.
   */
  async guard(
    req: FastifyRequest,
    scope: Scope,
    account: string,
    solution?: Solution,
  ): Promise<void> {
    const ip = normalizeIp(req.ip);
    const acct = this.scopeKey(scope, account);
    const blocked = this.blockedFor(ip, acct);
    if (blocked) {
      this.counters.rejected += 1;
      if (this.sample(`rej:${ip}`))
        this.log.record({
          kind: 'request_rejected',
          level: 'warn',
          result: 'blocked',
          ip,
          rule: blocked.rule,
          seconds: blocked.seconds,
          source: scope,
          requestId: req.id,
        });
      throw new AppError(429, 'too_many_attempts', 'Too many attempts, try again later', {
        retryAfterSeconds: blocked.seconds,
      });
    }
    const f = STRICT[scope];
    const after = Math.max(2, Math.ceil(this.policy.captchaAfter * f));
    const ipFails = this.count(`ip:${ip}`);
    const pairFails = this.count(`pair:${ip}|${acct}`);
    const acctFails = this.count(`acct:${acct}`);
    let need = ipFails >= after || pairFails >= after;
    // распределённый подбор одной записи с множества адресов: проверка для незнакомых адресов
    if (!need && acctFails >= after * 2 && !(await this.knownIp(account.trim().toLowerCase(), ip)))
      need = true;
    if (!need) return;
    const bits = Math.min(
      this.policy.captchaMaxBits,
      this.policy.captchaBits + Math.floor(Math.max(0, Math.max(ipFails, pairFails) - after) / 2),
    );
    if (solution) {
      const ok = await verifySolution(
        this.db,
        this.secret,
        acct,
        solution,
        this.policy.captchaBits,
      );
      if (ok) return;
      this.counters.captchaFailed += 1;
      this.recordFailure(req, scope, account, null, 'captcha_invalid');
    }
    this.counters.captchaShown += 1;
    if (this.sample(`cap:${ip}|${acct}`, 30_000))
      this.log.record({
        kind: 'captcha_required',
        level: 'info',
        result: 'challenge_issued',
        ip,
        account: acctKey(account),
        rule: 'login.captcha',
        source: scope,
        requestId: req.id,
        detail: { bits },
      });
    throw new AppError(403, 'captcha_required', 'Additional verification required', {
      captcha: issueChallenge(this.secret, acct, bits),
    });
  }

  /** Учёт неудачной попытки и, при необходимости, наложение блокировки. */
  recordFailure(
    req: FastifyRequest,
    scope: Scope,
    account: string,
    userId: string | null,
    kind = 'login_failed',
  ): void {
    const ip = normalizeIp(req.ip);
    const acct = this.scopeKey(scope, account);
    const f = STRICT[scope];
    const ipFails = this.add(`ip:${ip}`);
    const pairFails = this.add(`pair:${ip}|${acct}`);
    const acctFails = this.add(`acct:${acct}`);
    const after = Math.max(2, Math.ceil(this.policy.captchaAfter * f));
    this.log.record({
      kind,
      level: Math.max(ipFails, pairFails) >= after ? 'warn' : 'info',
      result: 'failed',
      ip,
      userId,
      account: acctKey(account),
      source: scope,
      requestId: req.id,
      detail: { ipFails, pairFails, acctFails },
    });
    const ipLimit = Math.max(3, Math.ceil(this.policy.blockIpAfter * f));
    const pairLimit = Math.max(3, Math.ceil(this.policy.blockPairAfter * f));
    if (ipFails >= ipLimit && !this.blockOf(`ip:${ip}`))
      void this.autoBlock(`ip:${ip}`, 'ip.failures', `${ipFails} ошибок входа за окно`, ip);
    else if (pairFails >= pairLimit && !this.blockOf(`pair:${ip}|${acct}`))
      void this.autoBlock(
        `pair:${ip}|${acct}`,
        'pair.failures',
        `${pairFails} ошибок для одной учётной записи`,
        ip,
        acctKey(account),
      );
  }

  /** Успешный вход: счётчик пары сбрасывается (адрес и учётная запись по всем адресам — нет, чтобы подбор не «очищался» одним верным входом). */
  recordSuccess(req: FastifyRequest, scope: Scope, account: string): void {
    this.fails.delete(`pair:${normalizeIp(req.ip)}|${this.scopeKey(scope, account)}`);
  }

  async autoBlock(
    key: string,
    rule: string,
    reason: string,
    ip: string,
    account?: string,
  ): Promise<void> {
    try {
      // повторные нарушения за сутки удлиняют срок: 5, 10, 20 минут … до предела
      const prior = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(securityBlocks)
        .where(
          and(
            eq(securityBlocks.key, key),
            gt(securityBlocks.createdAt, new Date(this.now() - 86_400_000)),
          ),
        );
      const strikes = (prior[0]?.n ?? 0) + 1;
      const minutes = Math.min(
        this.policy.blockMaxMinutes,
        this.policy.blockMinutes * 2 ** (strikes - 1),
      );
      const until = new Date(this.now() + minutes * 60_000);
      const [row] = await this.db
        .insert(securityBlocks)
        .values({ key, source: 'auto', reason, rule, strikes, expiresAt: until })
        .returning({ id: securityBlocks.id });
      this.blocks.set(key, { id: row!.id, until: until.getTime(), rule, reason, strikes });
      this.log.record({
        kind: 'ip_blocked',
        level: 'critical',
        result: 'blocked',
        ip,
        account: account ?? null,
        rule,
        seconds: minutes * 60,
        source: 'auto',
        detail: { strikes },
      });
    } catch (e) {
      console.error('auto block failed', (e as Error).message);
    }
  }

  /** Ручная блокировка адреса администратором. */
  async manualBlock(ip: string, minutes: number, reason: string, by: string): Promise<string> {
    const until = new Date(this.now() + minutes * 60_000);
    const key = `ip:${ip}`;
    const [row] = await this.db
      .insert(securityBlocks)
      .values({ key, source: 'manual', reason, rule: 'manual', expiresAt: until, createdBy: by })
      .returning({ id: securityBlocks.id });
    this.blocks.set(key, {
      id: row!.id,
      until: until.getTime(),
      rule: 'manual',
      reason,
      strikes: 1,
    });
    this.log.record({
      kind: 'ip_blocked',
      level: 'warn',
      result: 'blocked',
      ip,
      rule: 'manual',
      seconds: minutes * 60,
      source: by,
      detail: {},
    });
    return row!.id;
  }

  /** Снятие блокировки: строка остаётся в истории, счётчики ошибок адреса не обнуляются. */
  async release(id: string, by: string): Promise<boolean> {
    const [row] = await this.db
      .update(securityBlocks)
      .set({ releasedAt: new Date(), releasedBy: by })
      .where(and(eq(securityBlocks.id, id), isNull(securityBlocks.releasedAt)))
      .returning();
    if (!row) return false;
    this.blocks.delete(row.key);
    this.log.record({
      kind: 'ip_unblocked',
      level: 'info',
      result: 'released',
      ip: row.key.startsWith('ip:') ? row.key.slice(3) : (row.key.split('|')[0]?.slice(5) ?? null),
      rule: row.rule,
      source: by,
    });
    return true;
  }

  async history(limit = 100) {
    return this.db
      .select()
      .from(securityBlocks)
      .orderBy(desc(securityBlocks.createdAt))
      .limit(limit);
  }
}
