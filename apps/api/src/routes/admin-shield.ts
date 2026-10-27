import { and, count, desc, eq, gte, ilike, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { uuid } from '@arklock/contracts';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import { requireReauth } from '../auth/reauth.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { ipRules, securityBlocks, securityEvents, settings, users } from '../db/schema.js';
import { AppError, notFound, parse } from '../errors.js';
import { ACCESS_KEY, CONFIRM_SECONDS, PROXIES_KEY, type AccessState } from '../shield/access.js';
import { CidrSet, normalizeIp, parseCidr } from '../shield/ip.js';
import { SHIELD_KEY, shieldPolicy } from '../shield/policy.js';
import { chiefRequired } from './chief.js';

const DAY = 86_400_000;

/** «Защита веб-приложения»: только главный администратор. Изменения защиты требуют повторного подтверждения пароля. */
export const registerAdminShieldRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db, shield, access } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', async (req: FastifyRequest) => {
    await adminGate(ctx, req);
    if (!authOf(req).user.chief) throw chiefRequired();
  });

  const put = (key: string, value: unknown, by: string) =>
    db
      .insert(settings)
      .values({ key, value: value as never, updatedBy: by })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: value as never, updatedAt: new Date(), updatedBy: by },
      });
  const actor = (req: FastifyRequest) => `user:${authOf(req).user.id}`;
  /** Изменение защиты: журнал действий и журнал событий безопасности (оповещение главным администраторам). */
  const changed = async (
    req: FastifyRequest,
    what: string,
    weakens: boolean,
    detail: Record<string, string | number | boolean | null> = {},
  ) => {
    await audit(db, actor(req), `shield.${what}`, null, detail);
    ctx.securityLog.record({
      kind: 'protection_changed',
      level: weakens ? 'critical' : 'warn',
      result: 'changed',
      ip: normalizeIp(req.ip),
      userId: authOf(req).user.id,
      rule: what,
      source: 'admin',
      requestId: req.id,
      detail,
    });
  };

  // ---------------------------------------------------------------- обзор
  app.get('/admin/shield/overview', async () => {
    const since = new Date(Date.now() - DAY);
    const unknown: string[] = [];
    const safe = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch {
        unknown.push(name);
        return fallback;
      }
    };
    const kinds = await safe(
      'events',
      () =>
        db
          .select({ kind: securityEvents.kind, level: securityEvents.level, n: count() })
          .from(securityEvents)
          .where(gte(securityEvents.at, since))
          .groupBy(securityEvents.kind, securityEvents.level),
      [] as { kind: string; level: string; n: number }[],
    );
    const sum = (...k: string[]) =>
      kinds.filter((r) => k.includes(r.kind)).reduce((a, r) => a + Number(r.n), 0);
    const rules = await safe(
      'rules',
      () =>
        db
          .select({
            rule: securityEvents.rule,
            n: count(),
            last: sql<string>`max(${securityEvents.at})`,
          })
          .from(securityEvents)
          .where(and(gte(securityEvents.at, since), sql`${securityEvents.rule} is not null`))
          .groupBy(securityEvents.rule)
          .orderBy(desc(count()))
          .limit(6),
      [] as { rule: string | null; n: number; last: string }[],
    );
    const hourly = await safe(
      'chart',
      async () => {
        const rows = (await db.execute(sql`
          select to_char(date_trunc('hour', at), 'YYYY-MM-DD"T"HH24:00:00"Z"') as h,
                 count(*) filter (where kind in ('login_failed','recovery_failed','captcha_invalid')) as failed,
                 count(*) filter (where kind in ('request_rejected','ip_not_allowed','ip_blocked')) as rejected
          from security_events where at >= ${since} group by 1 order by 1`)) as unknown as {
          rows?: { h: string; failed: string; rejected: string }[];
        };
        const list =
          rows.rows ?? (rows as unknown as { h: string; failed: string; rejected: string }[]) ?? [];
        return list.map((r) => ({
          at: r.h,
          failed: Number(r.failed),
          rejected: Number(r.rejected),
        }));
      },
      [] as { at: string; failed: number; rejected: number }[],
    );
    const lastChange = await safe(
      'changes',
      async () =>
        (
          await db
            .select({ at: securityEvents.at, rule: securityEvents.rule })
            .from(securityEvents)
            .where(eq(securityEvents.kind, 'protection_changed'))
            .orderBy(desc(securityEvents.at))
            .limit(1)
        )[0] ?? null,
      null,
    );
    const chiefsNoMfa = await safe(
      'mfa',
      async () => {
        const r = (await db.execute(sql`
          select count(*) as n from users u where u.chief and u.disabled_at is null
          and not exists (select 1 from mfa_factors f where f.user_id = u.id)
          and not exists (select 1 from webauthn_credentials w where w.user_id = u.id)`)) as unknown as {
          rows?: { n: string }[];
        };
        return Number((r.rows ?? (r as unknown as { n: string }[]))[0]?.n ?? 0);
      },
      -1,
    );
    const logOk = ctx.securityLog.failures === 0;
    return {
      unknown,
      loginProtection: { active: true, mode: 'always' },
      captchaMode: 'adaptive',
      accessRestriction: {
        enabled: access.state.enabled,
        rules: access.allowed.size,
        pendingConfirm: access.state.confirmBy ?? null,
      },
      proxies: { cidrs: access.proxyCidrs, hops: ctx.config.TRUSTED_PROXY_HOPS },
      mfaChiefsWithout: chiefsNoMfa,
      log: { ok: logOk, failures: ctx.securityLog.failures },
      last24h: {
        failedLogins: sum('login_failed', 'recovery_failed', 'directory_failed'),
        captchaShown: sum('captcha_required'),
        captchaFailed: sum('captcha_invalid'),
        rejected: sum('request_rejected', 'ip_not_allowed', 'waf_blocked'),
        suspicious: kinds
          .filter((r) => r.level === 'warn' || r.level === 'critical')
          .reduce((a, r) => a + Number(r.n), 0),
        blocksCreated: sum('ip_blocked'),
      },
      activeBlocks: shield.activeBlocks(),
      topRules: rules.map((r) => ({ rule: r.rule, count: Number(r.n), last: r.last })),
      hourly,
      lastChange: lastChange ? { at: lastChange.at.toISOString(), what: lastChange.rule } : null,
    };
  });

  app.get('/admin/shield/whoami', async (req) => ({
    ip: normalizeIp(req.ip),
    socket: normalizeIp(req.socket.remoteAddress),
    forwardedFor: String(req.headers['x-forwarded-for'] ?? '').slice(0, 200) || null,
    permitted: access.permits(req.ip),
    accessEnabled: access.state.enabled,
    trustedProxies: access.proxyCidrs,
    hops: ctx.config.TRUSTED_PROXY_HOPS,
  }));

  // ---------------------------------------------------------------- вход: политика
  const settingsSchema = shieldPolicy;
  const loadSettings = async () => {
    const [row] = await db.select().from(settings).where(eq(settings.key, SHIELD_KEY));
    return settingsSchema.parse(row?.value ?? {});
  };
  app.get('/admin/shield/settings', async () => ({
    ...(await loadSettings()),
    defaults: settingsSchema.parse({}),
  }));
  app.put('/admin/shield/settings', async (req) => {
    requireReauth(ctx, req);
    const before = await loadSettings();
    const next = settingsSchema.parse({ ...before, ...parse(settingsSchema.partial(), req.body) });
    // защиту нельзя ослабить до практического отсутствия: допустимые границы заданы в схеме, а порог проверки — не выше блокировки
    if (next.captchaAfter >= next.blockPairAfter + next.blockIpAfter)
      throw new AppError(400, 'validation_error', 'Thresholds are inconsistent');
    if (next.captchaMaxBits < next.captchaBits) next.captchaMaxBits = next.captchaBits;
    await put(SHIELD_KEY, next, actor(req));
    await shield.reloadPolicy();
    const weakens =
      next.captchaAfter > before.captchaAfter ||
      next.blockIpAfter > before.blockIpAfter ||
      next.blockPairAfter > before.blockPairAfter ||
      next.blockMinutes < before.blockMinutes;
    await changed(req, 'settings', weakens, { weakens });
    return next;
  });

  // ---------------------------------------------------------------- IP-адреса и подсети
  const ruleRows = () => db.select().from(ipRules).orderBy(ipRules.createdAt);
  app.get('/admin/shield/access', async (req) => ({
    enabled: access.state.enabled,
    confirmBy: access.state.confirmBy ?? null,
    changedAt: access.state.changedAt ?? null,
    changedBy: access.state.changedBy ?? null,
    confirmSeconds: CONFIRM_SECONDS,
    yourIp: normalizeIp(req.ip),
    yourIpAllowed: new CidrSet((await ruleRows()).filter((r) => r.enabled).map((r) => r.cidr)).has(
      req.ip,
    ),
    rules: (await ruleRows()).map((r) => ({
      id: r.id,
      cidr: r.cidr,
      comment: r.comment,
      enabled: r.enabled,
      updatedAt: r.updatedAt.toISOString(),
      updatedBy: r.updatedBy,
    })),
  }));

  /** Администратор не должен отрезать себя: после изменения его адрес обязан проходить по включённым правилам. */
  const assertNotLockedOut = async (req: FastifyRequest, cidrs: string[]) => {
    if (!access.state.enabled) return;
    const ip = normalizeIp(req.ip);
    if (ip === '::1' || ip.startsWith('127.')) return;
    if (!new CidrSet(cidrs).has(ip))
      throw new AppError(409, 'would_lock_out', 'This change would block your own address', { ip });
  };
  const enabledCidrs = async (except?: string, extra?: string) =>
    (await ruleRows())
      .filter((r) => r.enabled && r.id !== except)
      .map((r) => r.cidr)
      .concat(extra ? [extra] : []);

  const ruleBody = z.object({
    cidr: z.string().trim().min(2).max(64),
    comment: z.string().trim().max(200).default(''),
  });
  app.post('/admin/shield/access/rules', async (req, reply) => {
    requireReauth(ctx, req);
    const body = parse(ruleBody, req.body);
    const p = parseCidr(body.cidr);
    if (!p)
      throw new AppError(400, 'validation_error', 'Not an IP address or subnet', [
        { path: 'cidr', code: 'invalid' },
      ]);
    const [dup] = await db.select().from(ipRules).where(eq(ipRules.cidr, p.cidr));
    if (dup) throw new AppError(409, 'already_exists', 'The rule already exists');
    const [row] = await db
      .insert(ipRules)
      .values({ cidr: p.cidr, comment: body.comment, updatedBy: actor(req) })
      .returning();
    await access.reload();
    await changed(req, 'access.rule.add', false, { cidr: p.cidr });
    return reply.status(201).send({ id: row!.id });
  });
  app.patch('/admin/shield/access/rules/:id', async (req, reply) => {
    requireReauth(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({ enabled: z.boolean().optional(), comment: z.string().trim().max(200).optional() }),
      req.body,
    );
    const [row] = await db.select().from(ipRules).where(eq(ipRules.id, id));
    if (!row) throw notFound();
    if (body.enabled === false) await assertNotLockedOut(req, await enabledCidrs(id));
    await db
      .update(ipRules)
      .set({ ...body, updatedAt: new Date(), updatedBy: actor(req) })
      .where(eq(ipRules.id, id));
    await access.reload();
    await changed(req, 'access.rule.edit', body.enabled === false, { cidr: row.cidr });
    return reply.status(204).send();
  });
  app.delete('/admin/shield/access/rules/:id', async (req, reply) => {
    requireReauth(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [row] = await db.select().from(ipRules).where(eq(ipRules.id, id));
    if (!row) throw notFound();
    await assertNotLockedOut(req, await enabledCidrs(id));
    await db.delete(ipRules).where(eq(ipRules.id, id));
    await access.reload();
    await changed(req, 'access.rule.delete', true, { cidr: row.cidr });
    return reply.status(204).send();
  });

  const saveAccess = async (req: FastifyRequest, state: AccessState) => {
    await put(ACCESS_KEY, state, actor(req));
    await access.reload();
  };
  /** Включение в режиме подтверждения: если за две минуты администратор не подтвердит доступ, сервер сам откатит настройку. */
  app.post('/admin/shield/access/enable', async (req) => {
    requireReauth(ctx, req);
    parse(z.object({ acknowledge: z.literal(true) }), req.body);
    const cidrs = await enabledCidrs();
    if (!cidrs.length)
      throw new AppError(409, 'rules_required', 'Add at least one allowed address or subnet first');
    const ip = normalizeIp(req.ip);
    const loopback = ip === '::1' || ip.startsWith('127.');
    if (!loopback && !new CidrSet(cidrs).has(ip))
      throw new AppError(409, 'would_lock_out', 'Your own address is not in the allowed list', {
        ip,
      });
    const confirmBy = Date.now() + CONFIRM_SECONDS * 1000;
    await saveAccess(req, {
      enabled: true,
      confirmBy,
      changedAt: new Date().toISOString(),
      changedBy: actor(req),
    });
    await changed(req, 'access.enable', false, { rules: cidrs.length });
    return { confirmBy, confirmSeconds: CONFIRM_SECONDS };
  });
  app.post('/admin/shield/access/confirm', async (req) => {
    if (!access.state.enabled || !access.state.confirmBy) return { confirmed: true };
    await saveAccess(req, {
      enabled: true,
      changedAt: new Date().toISOString(),
      changedBy: actor(req),
    });
    await audit(db, actor(req), 'shield.access.confirm');
    return { confirmed: true };
  });
  app.post('/admin/shield/access/disable', async (req) => {
    requireReauth(ctx, req);
    await saveAccess(req, {
      enabled: false,
      changedAt: new Date().toISOString(),
      changedBy: actor(req),
    });
    await changed(req, 'access.disable', true);
    return { enabled: false };
  });

  // доверенные reverse proxy (отдельно от разрешённых подсетей)
  app.get('/admin/shield/proxies', async () => ({
    cidrs: access.proxyCidrs,
    hops: ctx.config.TRUSTED_PROXY_HOPS,
  }));
  app.put('/admin/shield/proxies', async (req) => {
    requireReauth(ctx, req);
    const body = parse(z.object({ cidrs: z.array(z.string().trim().max(64)).max(32) }), req.body);
    const list = body.cidrs.map((c) => parseCidr(c));
    if (list.some((p) => !p))
      throw new AppError(400, 'validation_error', 'Not an IP address or subnet', [
        { path: 'cidrs', code: 'invalid' },
      ]);
    // «любой адрес» в списке доверенных прокси сделал бы заголовок X-Forwarded-For подделываемым
    if (list.some((p) => p!.prefix === 0))
      throw new AppError(400, 'validation_error', 'A catch-all subnet cannot be a trusted proxy', [
        { path: 'cidrs', code: 'too_broad' },
      ]);
    await put(PROXIES_KEY, { cidrs: list.map((p) => p!.cidr) }, actor(req));
    await access.reload();
    await changed(req, 'proxies', true, { count: list.length });
    return { cidrs: access.proxyCidrs };
  });

  // ---------------------------------------------------------------- блокировки
  app.get('/admin/shield/blocks', async () => {
    await shield.refreshBlocks();
    const rows = await shield.history(300);
    const now = Date.now();
    const ips = [
      ...new Set(
        rows
          .map((r) =>
            r.key.startsWith('ip:') ? r.key.slice(3) : (r.key.split('|')[0] ?? '').slice(5),
          )
          .filter(Boolean),
      ),
    ];
    const attempts = ips.length
      ? await db
          .select({ ip: securityEvents.ip, n: count() })
          .from(securityEvents)
          .where(and(inArray(securityEvents.ip, ips), gte(securityEvents.at, new Date(now - DAY))))
          .groupBy(securityEvents.ip)
      : [];
    const per = new Map(attempts.map((a) => [a.ip, Number(a.n)]));
    const shape = (r: (typeof rows)[number]) => {
      const ip = r.key.startsWith('ip:') ? r.key.slice(3) : (r.key.split('|')[0] ?? '').slice(5);
      return {
        id: r.id,
        ip,
        scope: r.key.startsWith('ip:') ? 'ip' : 'pair',
        source: r.source,
        reason: r.reason,
        rule: r.rule,
        strikes: r.strikes,
        risk: r.source === 'manual' ? 'warn' : r.strikes > 2 ? 'critical' : 'warn',
        attempts24h: per.get(ip) ?? 0,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        releasedAt: r.releasedAt?.toISOString() ?? null,
        releasedBy: r.releasedBy,
        active: !r.releasedAt && r.expiresAt.getTime() > now,
      };
    };
    const all = rows.map(shape);
    return {
      active: all.filter((b) => b.active),
      history: all.filter((b) => !b.active).slice(0, 100),
    };
  });
  app.post('/admin/shield/blocks', async (req, reply) => {
    requireReauth(ctx, req);
    const body = parse(
      z.object({
        ip: z.string().trim().max(64),
        minutes: z.number().int().min(1).max(10080),
        reason: z.string().trim().min(1).max(200),
      }),
      req.body,
    );
    const p = parseCidr(body.ip);
    if (!p || p.prefix !== (p.family === 'ipv4' ? 32 : 128))
      throw new AppError(400, 'validation_error', 'Enter a single IP address', [
        { path: 'ip', code: 'invalid' },
      ]);
    if (p.address === normalizeIp(req.ip) || p.address === '::1' || p.address.startsWith('127.'))
      throw new AppError(409, 'would_lock_out', 'You cannot block your own or a local address');
    const id = await shield.manualBlock(p.address, body.minutes, body.reason, actor(req));
    await audit(db, actor(req), 'shield.block.manual', `ip:${p.address}`, {
      minutes: body.minutes,
    });
    return reply.status(201).send({ id });
  });
  app.post('/admin/shield/blocks/:id/release', async (req, reply) => {
    requireReauth(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    if (!(await shield.release(id, actor(req)))) throw notFound();
    await audit(db, actor(req), 'shield.block.release', `block:${id}`);
    return reply.status(204).send();
  });
  /** «Добавить в разрешённые»: адрес попадает в правила доступа; блокировка снимается. Последствия показываются в окне подтверждения. */
  app.post('/admin/shield/blocks/:id/allow', async (req, reply) => {
    requireReauth(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    parse(z.object({ acknowledge: z.literal(true) }), req.body);
    const [row] = await db.select().from(securityBlocks).where(eq(securityBlocks.id, id));
    if (!row) throw notFound();
    const ip = row.key.startsWith('ip:')
      ? row.key.slice(3)
      : (row.key.split('|')[0] ?? '').slice(5);
    const p = parseCidr(ip);
    if (!p) throw new AppError(400, 'validation_error', 'Not an IP address');
    await db
      .insert(ipRules)
      .values({ cidr: p.cidr, comment: 'Добавлен из блокировок', updatedBy: actor(req) })
      .onConflictDoNothing();
    await shield.release(id, actor(req));
    await access.reload();
    await changed(req, 'access.rule.add', false, { cidr: p.cidr });
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- события
  const eventsQuery = z.object({
    period: z.enum(['hour', 'day', 'week', 'month', 'all']).default('day'),
    ip: z.string().trim().max(64).optional(),
    user: z.string().trim().max(256).optional(),
    kind: z.string().trim().max(60).optional(),
    level: z.enum(['info', 'warn', 'critical', 'ok']).optional(),
    result: z.string().trim().max(60).optional(),
    rule: z.string().trim().max(80).optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(10).max(100).default(50),
  });
  app.get('/admin/shield/events', async (req) => {
    const q = parse(eventsQuery, req.query);
    const span = { hour: 3_600_000, day: DAY, week: 7 * DAY, month: 30 * DAY }[q.period as 'hour'];
    const cond = [
      span ? gte(securityEvents.at, new Date(Date.now() - span)) : undefined,
      q.ip ? eq(securityEvents.ip, normalizeIp(q.ip)) : undefined,
      q.kind ? eq(securityEvents.kind, q.kind) : undefined,
      q.level ? eq(securityEvents.level, q.level) : undefined,
      q.result ? eq(securityEvents.result, q.result) : undefined,
      q.rule ? eq(securityEvents.rule, q.rule) : undefined,
    ];
    if (q.user) {
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          q.user.includes('@') ? ilike(users.email, q.user) : eq(sql`${users.id}::text`, q.user),
        );
      cond.push(eq(securityEvents.userId, u?.id ?? '00000000-0000-0000-0000-000000000000'));
    }
    const where = and(...cond.filter(Boolean));
    const [total] = await db.select({ n: count() }).from(securityEvents).where(where);
    const rows = await db
      .select()
      .from(securityEvents)
      .where(where)
      .orderBy(desc(securityEvents.at))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const ids = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
    const names = ids.length
      ? await db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(users.id, ids))
      : [];
    const email = new Map(names.map((n) => [n.id, n.email]));
    return {
      total: Number(total?.n ?? 0),
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        ip: r.ip,
        user: r.userId ? (email.get(r.userId) ?? r.userId) : null,
        account: r.account,
        kind: r.kind,
        level: r.level,
        rule: r.rule,
        result: r.result,
        seconds: r.seconds,
        source: r.source,
        requestId: r.requestId,
        detail: r.detail,
      })),
    };
  });

  // журнал не растёт бесконечно: срок хранения и верхний предел строк
  app.post('/admin/shield/events/prune', async (req) => {
    requireReauth(ctx, req);
    const s = await loadSettings();
    await ctx.securityLog.prune(s.retentionDays);
    return { retentionDays: s.retentionDays };
  });
};
