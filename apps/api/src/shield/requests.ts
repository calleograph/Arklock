import { createHash } from 'node:crypto';
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/connect.js';
import { securityEvents, settings } from '../db/schema.js';
import type { SecurityLog } from './events.js';
import { normalizeIp } from './ip.js';
import type { Shield } from './throttle.js';

export type RuleMode = 'observe' | 'protect';
export const WAF_KEY = 'security.waf';
export const LIMITS_KEY = 'security.limits';

export interface Rule {
  id: string;
  category: 'scan' | 'path' | 'method' | 'media' | 'injection';
  risk: 'warn' | 'critical';
  /** Режим по умолчанию: проверенные правила защищают, эвристики сначала наблюдают. */
  mode: RuleMode;
  /** Ответ при блокировке. */
  status: number;
}

/**
 * Лёгкие правила для типовых атак на веб-интерфейс и API. Они дополняют, а не заменяют серверную авторизацию, проверку
 * структуры данных и параметризованные запросы. Тела запросов НЕ просматриваются: там шифртекст и пароли, ложные срабатывания
 * и утечки недопустимы. Проверяются путь и строка запроса.
 */
export const RULES: Rule[] = [
  { id: 'scan.sensitive-path', category: 'scan', risk: 'warn', mode: 'protect', status: 404 },
  { id: 'path.traversal', category: 'path', risk: 'critical', mode: 'protect', status: 400 },
  { id: 'method.unexpected', category: 'method', risk: 'warn', mode: 'protect', status: 405 },
  { id: 'media.unexpected', category: 'media', risk: 'warn', mode: 'protect', status: 415 },
  { id: 'inject.sql-pattern', category: 'injection', risk: 'warn', mode: 'observe', status: 403 },
  { id: 'inject.xss-pattern', category: 'injection', risk: 'warn', mode: 'observe', status: 403 },
];

// у Arklock нет ни одного из этих путей: обращение к ним — сканирование
const SENSITIVE =
  /(^|\/)(\.env|\.git|\.svn|\.hg|\.aws|\.ssh|\.DS_Store|wp-admin|wp-login\.php|wp-content|xmlrpc\.php|phpmyadmin|cgi-bin|vendor\/phpunit|actuator|\.well-known\/security\.txt\.php)(\/|$|\?)|\.(php|asp|aspx|jsp|cgi|sql|bak|old|orig|swp|ini|conf|pem|key)(\?|$)|\/etc\/passwd/i;
const TRAVERSAL = /(^|[/\\])\.\.([/\\]|$)|\.\.%2f|%2f\.\.|\.\.%5c|%2e%2e|%252e|%00|%5c|\\/i;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const SQLI =
  /(\bunion\b[\s/*+]+(all[\s/*+]+)?\bselect\b|['"]\s*(or|and)\s+['"]?\w+['"]?\s*=\s*['"]?\w|;\s*(drop|delete|truncate|insert|update)\s+\w|\b(sleep|benchmark|pg_sleep|waitfor\s+delay)\s*\(|\binformation_schema\b|--\s*$)/i;
const XSS =
  /(<\s*\/?\s*(script|img|svg|iframe|object|embed|body|link|meta)\b|javascript\s*:|\bon(error|load|click|mouseover|focus)\s*=)/i;
const JSON_BODY =
  /^(application\/(json|octet-stream|x-www-form-urlencoded)|text\/plain|multipart\/form-data)/i;

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

// ---------------------------------------------------------------- классы ограничений API

export type LimitClass = 'auth' | 'secrets' | 'keys' | 'admin' | 'integrations';
/** Запросов в минуту. Нижняя граница настройки — 60: ограничение нельзя свести к нулю. */
export const DEFAULT_LIMITS: Record<LimitClass, number> = {
  auth: 240,
  secrets: 6000,
  keys: 900,
  admin: 900,
  integrations: 1800,
};
export const MIN_LIMIT = 60;

/** Класс запроса по методу и пути; null — не ограничивается (проверки работоспособности, обновления, потоковые вложения, статика). */
export function classify(method: string, url: string): LimitClass | null {
  const path = url.split('?')[0] ?? '';
  if (!path.startsWith('/api/v1/')) return null;
  const p = path.slice(7);
  if (/^\/(health|ready|version|openapi\.json)$/.test(p)) return null;
  // обновление, копии и потоковая передача крупных зашифрованных файлов: у них свои ограничения размера и очереди
  if (/^\/admin\/(updates|backups)(\/|$)/.test(p) || /\/attachments\/[^/]+\/content$/.test(p))
    return null;
  if (
    /^\/auth\/(login|recovery|register|params|registration|mfa|webauthn|pin|ldap|sso|saml|oidc|activate|invitation)/.test(
      p,
    )
  )
    return 'auth';
  if (
    /^\/admin\/(webhooks|ldap|sso|saml|smtp|syslog|tokens)/.test(p) ||
    /^\/(tokens|api-tokens)/.test(p)
  )
    return 'integrations';
  if (p.startsWith('/admin')) return 'admin';
  if (
    /^\/vaults\/[^/]+\/(keys|members|key-grants|rotate|corporate|circles)|^\/corporate|^\/chief/.test(
      p,
    )
  )
    return 'keys';
  void method;
  return 'secrets';
}

interface Window {
  start: number;
  n: number;
}

/**
 * Защитный слой запросов: правила (наблюдение/защита), классы ограничений частоты, обнаружение перебора идентификаторов.
 * Счётчики — в памяти процесса (скользящее окно в минуту); события — в журнал безопасности.
 */
export class RequestGuard {
  modes = new Map<string, RuleMode>(RULES.map((r) => [r.id, r.mode]));
  limits: Record<LimitClass, number> = { ...DEFAULT_LIMITS };
  /** Пороги перебора идентификаторов: ответов 404/403 за 5 минут для предупреждения и для временного ограничения. */
  probing = { warn: 40, block: 150 };
  private readonly windows = new Map<string, Window>();
  private readonly probes = new Map<string, { start: number; n: number }>();
  private readonly throttled = new Map<string, number>();
  private readonly sampled = new Map<string, number>();
  private readonly scan = new Map<string, number[]>();
  hits = new Map<string, number>();
  rateLimited = 0;

  constructor(
    private readonly db: Db,
    private readonly log: SecurityLog,
    private readonly shield: Shield,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    const [waf] = await this.db.select().from(settings).where(eq(settings.key, WAF_KEY));
    const modes = (waf?.value as { modes?: Record<string, RuleMode> } | undefined)?.modes ?? {};
    for (const r of RULES) {
      const m = modes[r.id];
      this.modes.set(r.id, m === 'observe' || m === 'protect' ? m : r.mode);
    }
    const [lim] = await this.db.select().from(settings).where(eq(settings.key, LIMITS_KEY));
    const stored = (lim?.value as Partial<Record<LimitClass, number>> | undefined) ?? {};
    for (const c of Object.keys(DEFAULT_LIMITS) as LimitClass[]) {
      const v = stored[c];
      this.limits[c] = typeof v === 'number' && v >= MIN_LIMIT ? Math.floor(v) : DEFAULT_LIMITS[c];
    }
  }

  private sample(key: string, ms = 60_000): boolean {
    if (this.now() - (this.sampled.get(key) ?? 0) < ms) return false;
    this.sampled.set(key, this.now());
    if (this.sampled.size > 5000) this.sampled.clear();
    return true;
  }

  private hit(rule: Rule, req: FastifyRequest, blocked: boolean): void {
    this.hits.set(rule.id, (this.hits.get(rule.id) ?? 0) + 1);
    const ip = normalizeIp(req.ip);
    if (this.sample(`waf:${rule.id}:${ip}`, 30_000))
      this.log.record({
        kind: blocked ? 'waf_blocked' : 'waf_observed',
        level: rule.risk,
        result: blocked ? 'blocked' : 'observed',
        ip,
        rule: rule.id,
        source: 'waf',
        requestId: req.id,
        // строка запроса не сохраняется: в ней могут быть токены; только путь без параметров
        detail: { method: req.method, path: (req.url.split('?')[0] ?? '').slice(0, 120) },
      });
    // много срабатываний с одного адреса — это сканирование: адрес получает временное ограничение
    if (rule.category === 'scan' || rule.category === 'path') {
      const list = (this.scan.get(ip) ?? []).filter((t) => t > this.now() - 10 * 60_000);
      list.push(this.now());
      this.scan.set(ip, list);
      if (this.scan.size > 5000) this.scan.clear();
      if (list.length >= 15 && !this.shield.blockedFor(ip))
        void this.shield.autoBlock(
          `ip:${ip}`,
          'scan.requests',
          `${list.length} запросов к служебным путям`,
          ip,
        );
    }
  }

  private verdict(rule: Rule, req: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
    const protect = this.modes.get(rule.id) === 'protect';
    this.hit(rule, req, protect);
    if (!protect) return undefined;
    const code = rule.status === 404 ? 'not_found' : 'request_blocked';
    return reply
      .status(rule.status)
      .send({ error: { code, message: 'Request blocked', requestId: req.id } });
  }

  /** Проверка запроса до обработки: правила и ограничение частоты. Возвращает ответ, если запрос отклонён. */
  check(req: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
    const url = req.url;
    const rule = (id: string) => RULES.find((r) => r.id === id)!;
    if (!METHODS.has(req.method.toUpperCase())) {
      const r = this.verdict(rule('method.unexpected'), req, reply);
      if (r) return r;
    }
    if (TRAVERSAL.test(url)) {
      const r = this.verdict(rule('path.traversal'), req, reply);
      if (r) return r;
    }
    if (SENSITIVE.test(url.split('?')[0] ?? '')) {
      const r = this.verdict(rule('scan.sensitive-path'), req, reply);
      if (r) return r;
    }
    const isApi = url.startsWith('/api/');
    if (isApi) {
      const q = safeDecode(url);
      if (SQLI.test(q)) {
        const r = this.verdict(rule('inject.sql-pattern'), req, reply);
        if (r) return r;
      }
      if (XSS.test(q)) {
        const r = this.verdict(rule('inject.xss-pattern'), req, reply);
        if (r) return r;
      }
      const ct = req.headers['content-type'];
      if (
        ['POST', 'PUT', 'PATCH'].includes(req.method) &&
        typeof ct === 'string' &&
        !JSON_BODY.test(ct) &&
        Number(req.headers['content-length'] ?? 0) > 0
      ) {
        const r = this.verdict(rule('media.unexpected'), req, reply);
        if (r) return r;
      }
    }
    return this.rate(req, reply);
  }

  private keyOf(req: FastifyRequest): string {
    const a = req.headers.authorization;
    return typeof a === 'string' && a.length > 12
      ? `t:${createHash('sha256').update(a).digest('hex').slice(0, 16)}`
      : `i:${normalizeIp(req.ip)}`;
  }

  private rate(req: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
    const cls = classify(req.method, req.url);
    if (!cls) return undefined;
    const key = this.keyOf(req);
    const until = this.throttled.get(key);
    if (until && until > this.now())
      return this.reject(
        req,
        reply,
        'probing.throttle',
        Math.ceil((until - this.now()) / 1000),
        cls,
      );
    const wkey = `${cls}|${key}`;
    const t = this.now();
    let w = this.windows.get(wkey);
    if (!w || t - w.start >= 60_000) {
      w = { start: t, n: 0 };
      this.windows.set(wkey, w);
      if (this.windows.size > 20_000) this.sweep(t);
    }
    w.n += 1;
    if (w.n > this.limits[cls])
      return this.reject(
        req,
        reply,
        `rate.${cls}`,
        Math.max(1, Math.ceil((w.start + 60_000 - t) / 1000)),
        cls,
      );
    return undefined;
  }

  private sweep(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= 60_000) this.windows.delete(k);
  }

  private reject(
    req: FastifyRequest,
    reply: FastifyReply,
    rule: string,
    seconds: number,
    cls: LimitClass,
  ): FastifyReply {
    this.rateLimited += 1;
    const ip = normalizeIp(req.ip);
    if (this.sample(`rate:${rule}:${this.keyOf(req)}`))
      this.log.record({
        kind: 'rate_limited',
        level: 'warn',
        result: 'rejected',
        ip,
        rule,
        seconds,
        source: cls,
        requestId: req.id,
      });
    return reply
      .status(429)
      .header('Retry-After', String(seconds))
      .send({
        error: {
          code: 'too_many_requests',
          message: 'Too many requests',
          requestId: req.id,
          details: { retryAfterSeconds: seconds },
        },
      });
  }

  /** Ответ уже отправлен: считаем 404/403 по объектам — признак перебора идентификаторов. */
  observeResponse(req: FastifyRequest, status: number): void {
    if (status !== 404 && status !== 403) return;
    const path = req.url.split('?')[0] ?? '';
    if (!/^\/api\/v1\/(vaults|handoffs|admin|entries|attachments)\b/.test(path)) return;
    const key = this.keyOf(req);
    const t = this.now();
    let p = this.probes.get(key);
    if (!p || t - p.start > 5 * 60_000) {
      p = { start: t, n: 0 };
      this.probes.set(key, p);
      if (this.probes.size > 10_000) this.probes.clear();
    }
    p.n += 1;
    if (p.n === this.probing.warn)
      this.log.record({
        kind: 'object_probing',
        level: 'warn',
        result: 'warned',
        ip: normalizeIp(req.ip),
        rule: 'probing.ids',
        requestId: req.id,
        detail: { responses: p.n },
      });
    if (p.n >= this.probing.block && !this.throttled.has(key)) {
      this.throttled.set(key, t + 5 * 60_000);
      this.log.record({
        kind: 'object_probing',
        level: 'critical',
        result: 'throttled',
        ip: normalizeIp(req.ip),
        rule: 'probing.ids',
        seconds: 300,
        requestId: req.id,
        detail: { responses: p.n },
      });
    }
    if (this.throttled.size > 5000)
      for (const [k, u] of this.throttled) if (u < t) this.throttled.delete(k);
  }

  /** Подсчёт срабатываний за сутки из журнала (для таблицы правил). */
  async stats(): Promise<Map<string, { n: number; last: string }>> {
    const rows = await this.db
      .select({
        rule: securityEvents.rule,
        n: count(),
        last: sql<string>`max(${securityEvents.at})`,
      })
      .from(securityEvents)
      .where(
        and(
          gte(securityEvents.at, new Date(this.now() - 86_400_000)),
          sql`${securityEvents.kind} in ('waf_observed','waf_blocked','rate_limited','object_probing')`,
        ),
      )
      .groupBy(securityEvents.rule)
      .orderBy(desc(count()));
    return new Map(
      rows.filter((r) => r.rule).map((r) => [r.rule!, { n: Number(r.n), last: r.last }]),
    );
  }
}

export function installRequestGuard(app: FastifyInstance, guard: RequestGuard): void {
  app.addHook('onRequest', async (req, reply) => {
    const r = guard.check(req, reply);
    if (r) return r;
    return undefined;
  });
  app.addHook('onResponse', async (req, reply) => {
    guard.observeResponse(req, reply.statusCode);
  });
}
