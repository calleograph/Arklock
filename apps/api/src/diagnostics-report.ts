import { and, count, desc, gte, inArray, sql } from 'drizzle-orm';
import { ldapBindSecret, readLdapProfiles, type LdapProfile } from './auth/ldap-profiles.js';
import { ldapDiagnose, type LdapStage } from './auth/ldap-diagnose.js';
import type { AppContext } from './context.js';
import { ledger, securityEvents, users } from './db/schema.js';

/**
 * Отчёт для разбора проблем: настройки без секретов, найденные недочёты, этапы проверки каталога, причины отказов при входе
 * и только важные события. Паролей, ключей, сертификатов, токенов и содержимого сейфов в отчёте нет: из настроек берутся
 * признаки («задан», «не задан») и несекретные значения (адрес, фильтр, имена атрибутов). Текст на языке пользователя строит
 * интерфейс по кодам.
 */

export interface Finding {
  level: 'fail' | 'warn' | 'info';
  area: 'directory' | 'signin' | 'system';
  code: string;
  params?: Record<string, string | number | boolean>;
}

export interface SigninGroup {
  kind: 'directory' | 'local';
  login: string;
  reason: string;
  n: number;
  first: string;
  last: string;
  /** Сколько групп каталога у человека и сколько разрешено (только для отказа «не в группе»). */
  groups?: number;
  allowed?: number;
}

export interface DirectoryReport {
  id: string;
  name: string;
  enabled: boolean;
  config: {
    url: string;
    directoryType: string;
    startTls: boolean;
    insecureTls: boolean;
    allowPlaintext: boolean;
    customCa: boolean;
    pinned: boolean;
    bindDn: string;
    baseDn: string;
    userFilter: string;
    emailAttr: string;
    nameAttr: string;
    access: string;
    allowedGroups: string[];
    mappedGroups: number;
    autoProvision: boolean;
  };
  stages: LdapStage[] | null;
  stagesError: string | null;
}

export interface DiagnosticReport {
  at: string;
  app: {
    version: string;
    commit: string | null;
    builtAt: string | null;
    node: string;
    uptimeSec: number;
  };
  publicUrl: string | null;
  findings: Finding[];
  directories: DirectoryReport[];
  accounts: { total: number; directory: number; waiting: number; blockedByDirectory: number };
  signin: SigninGroup[];
  events: { source: 'ledger' | 'security'; key: string; level: string; n: number; last: string }[];
  checks: { id: string; level: string; state: string; params?: Record<string, string | number> }[];
}

const DAYS = 14;
const SIGNIN_ACTIONS = ['auth.ldap.denied', 'auth.login.failed'];

/** Адрес без учётных данных, пути и параметров. */
function scrubUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return raw.replace(/\/\/[^@/]*@/, '//').slice(0, 200);
  }
}

async function directoryOf(ctx: AppContext, p: LdapProfile): Promise<DirectoryReport> {
  const config = {
    url: scrubUrl(p.url),
    directoryType: p.directoryType ?? 'ldap',
    startTls: !!p.startTls,
    insecureTls: !!p.insecureTls,
    allowPlaintext: !!p.allowPlaintext,
    customCa: !!p.caPem,
    pinned: !!p.pinnedFingerprint,
    bindDn: p.bindDn,
    baseDn: p.baseDn,
    userFilter: p.userFilter,
    emailAttr: p.emailAttr,
    nameAttr: p.nameAttr,
    access: p.access ?? 'all',
    allowedGroups: p.allowedGroups ?? [],
    mappedGroups: p.groups?.length ?? 0,
    autoProvision: !!p.autoProvision,
  };
  let stages: LdapStage[] | null = null;
  let stagesError: string | null = null;
  if (p.enabled) {
    try {
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('timeout')), 40_000).unref(),
      );
      stages = (
        await Promise.race([ldapDiagnose(p, ldapBindSecret(p, ctx.config.APP_SECRET)), timeout])
      ).stages;
    } catch (e) {
      stagesError = String((e as Error)?.message ?? e).slice(0, 200);
    }
  }
  return { id: p.id, name: p.name, enabled: p.enabled, config, stages, stagesError };
}

async function signinGroups(ctx: AppContext): Promise<SigninGroup[]> {
  const since = new Date(Date.now() - DAYS * 86_400_000);
  const rows = await ctx.db
    .select({ at: ledger.at, action: ledger.action, detail: ledger.detail })
    .from(ledger)
    .where(and(gte(ledger.at, since), inArray(ledger.action, SIGNIN_ACTIONS)))
    .orderBy(desc(ledger.at))
    .limit(2000);
  const groups = new Map<string, SigninGroup>();
  for (const r of rows) {
    const d = (r.detail ?? {}) as Record<string, unknown>;
    const kind = r.action === 'auth.ldap.denied' ? 'directory' : 'local';
    const login = typeof d.login === 'string' ? d.login : '';
    const reason = typeof d.reason === 'string' ? d.reason : 'unknown';
    const key = `${kind}\u0000${login}\u0000${reason}`;
    const at = r.at.toISOString();
    const g = groups.get(key);
    if (g) {
      g.n += 1;
      g.first = at;
    } else
      groups.set(key, {
        kind,
        login,
        reason,
        n: 1,
        first: at,
        last: at,
        ...(typeof d.groups === 'number' ? { groups: d.groups } : {}),
        ...(typeof d.allowed === 'number' ? { allowed: d.allowed } : {}),
      });
  }
  return [...groups.values()].sort((a, b) => b.last.localeCompare(a.last)).slice(0, 60);
}

async function importantEvents(ctx: AppContext): Promise<DiagnosticReport['events']> {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [sec, led] = await Promise.all([
    ctx.db
      .select({
        key: sql<string>`${securityEvents.kind} || ':' || ${securityEvents.result}`,
        level: securityEvents.level,
        n: count(),
        last: sql<Date>`max(${securityEvents.at})`,
      })
      .from(securityEvents)
      .where(
        and(gte(securityEvents.at, since), inArray(securityEvents.level, ['warn', 'critical'])),
      )
      .groupBy(securityEvents.kind, securityEvents.result, securityEvents.level)
      .orderBy(desc(sql`max(${securityEvents.at})`))
      .limit(40),
    ctx.db
      .select({
        key: ledger.action,
        n: count(),
        last: sql<Date>`max(${ledger.at})`,
      })
      .from(ledger)
      .where(
        and(
          gte(ledger.at, since),
          sql`(${ledger.action} ~ '(failed|denied|error|problem|expired|blocked|rejected)')`,
          sql`${ledger.action} not in ('auth.ldap.denied', 'auth.login.failed')`,
        ),
      )
      .groupBy(ledger.action)
      .orderBy(desc(sql`max(${ledger.at})`))
      .limit(40),
  ]);
  return [
    ...sec.map((r) => ({
      source: 'security' as const,
      key: r.key,
      level: r.level,
      n: r.n,
      last: new Date(r.last).toISOString(),
    })),
    ...led.map((r) => ({
      source: 'ledger' as const,
      key: r.key,
      level: 'warn',
      n: r.n,
      last: new Date(r.last).toISOString(),
    })),
  ];
}

const top = (xs: SigninGroup[], n = 3) =>
  [...new Set(xs.map((x) => x.login).filter((l) => l && !l.startsWith('***')))]
    .slice(0, n)
    .join(', ');

/** Недочёты настройки и входа: из конфигурации, результатов проверки каталога и причин недавних отказов. */
export function findingsOf(
  dirs: DirectoryReport[],
  signin: SigninGroup[],
  accounts: DiagnosticReport['accounts'],
  checks: DiagnosticReport['checks'],
): Finding[] {
  const out: Finding[] = [];
  const active = dirs.filter((d) => d.enabled);
  for (const d of active) {
    const c = d.config;
    const p = { profile: d.name };
    if (d.stagesError)
      out.push({
        level: 'warn',
        area: 'directory',
        code: 'directory.check_failed',
        params: { ...p, error: d.stagesError },
      });
    const bad = d.stages?.find((s) => !s.ok && !s.skipped);
    if (bad)
      out.push({
        level: 'fail',
        area: 'directory',
        code: 'directory.stage_failed',
        params: {
          ...p,
          stage: bad.stage,
          reason: bad.code,
          ...(bad.detail ? { detail: bad.detail } : {}),
        },
      });
    // «ok» — просто отметка этапа, «plaintext» уже есть отдельным недочётом
    for (const w of d.stages?.filter(
      (s) => s.ok && s.warn && s.code !== 'ok' && s.code !== 'plaintext',
    ) ?? [])
      out.push({
        level: 'warn',
        area: 'directory',
        code: 'directory.stage_warn',
        params: { ...p, stage: w.stage, reason: w.code },
      });
    if (!c.userFilter.includes('{u}'))
      out.push({
        level: 'fail',
        area: 'directory',
        code: 'directory.filter_no_placeholder',
        params: p,
      });
    else if (c.directoryType === 'ad' && !/samaccountname/i.test(c.userFilter))
      out.push({
        level: 'warn',
        area: 'directory',
        code: 'directory.filter_no_login',
        params: { ...p, filter: c.userFilter },
      });
    if (c.access === 'groups' && !c.allowedGroups.length)
      out.push({ level: 'fail', area: 'directory', code: 'directory.groups_empty', params: p });
    if (!c.emailAttr)
      out.push({ level: 'warn', area: 'directory', code: 'directory.no_email_attr', params: p });
    if (c.insecureTls)
      out.push({ level: 'warn', area: 'directory', code: 'directory.insecure_tls', params: p });
    else if (c.url.startsWith('ldap://') && !c.startTls)
      out.push({ level: 'warn', area: 'directory', code: 'directory.plaintext', params: p });
    if (!c.autoProvision && !accounts.directory && !accounts.waiting)
      out.push({
        level: 'warn',
        area: 'directory',
        code: 'directory.nobody_provisioned',
        params: p,
      });
    if (!accounts.directory)
      out.push({ level: 'info', area: 'directory', code: 'directory.nobody_signed_in', params: p });
  }
  if (active.length) {
    const dir = signin.filter((s) => s.kind === 'directory');
    const by = (r: string[]) => dir.filter((s) => r.includes(s.reason));
    const rule = (
      reasons: string[],
      level: Finding['level'],
      code: string,
      extra: (xs: SigninGroup[]) => Record<string, string | number> = () => ({}),
    ) => {
      const xs = by(reasons);
      if (xs.length)
        out.push({
          level,
          area: 'signin',
          code,
          params: { n: xs.reduce((a, x) => a + x.n, 0), logins: top(xs), ...extra(xs) },
        });
    };
    rule(['user_not_found'], 'fail', 'signin.user_not_found', () => ({
      filter: active[0]!.config.userFilter,
    }));
    rule(['not_allowed'], 'fail', 'signin.not_allowed', (xs) => ({
      groups: xs[0]!.groups ?? 0,
      allowed: xs[0]!.allowed ?? 0,
    }));
    rule(['no_email'], 'fail', 'signin.no_email');
    rule(['unavailable'], 'fail', 'signin.unavailable');
    rule(['account_exists_local'], 'fail', 'signin.local_exists');
    rule(['ldap_not_provisioned', 'not_provisioned'], 'fail', 'signin.not_provisioned');
    rule(['bad_password'], 'warn', 'signin.bad_password');
    rule(['account_disabled', 'disabled_in_directory'], 'warn', 'signin.disabled');
    rule(['lookup_failed'], 'warn', 'signin.lookup_failed');
    const localDomain = signin.filter(
      (s) =>
        s.kind === 'local' &&
        s.login &&
        !s.login.includes('@') &&
        !dir.some((d) => d.login.toLowerCase() === s.login.toLowerCase()),
    );
    if (localDomain.length)
      out.push({
        level: 'warn',
        area: 'signin',
        code: 'signin.domain_on_local',
        params: { n: localDomain.reduce((a, x) => a + x.n, 0), logins: top(localDomain) },
      });
  }
  for (const c of checks)
    if (c.level === 'fail' || c.level === 'warn')
      out.push({
        level: c.level,
        area: 'system',
        code: c.state,
        params: { id: c.id, ...(c.params ?? {}) },
      });
  const rank = { fail: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

export async function buildReport(
  ctx: AppContext,
  system: { checks: DiagnosticReport['checks'] },
  publicUrl: string | null,
): Promise<DiagnosticReport> {
  const profiles = await readLdapProfiles(ctx.db);
  const [directories, signin, events, [stat]] = await Promise.all([
    Promise.all(profiles.map((p) => directoryOf(ctx, p))),
    signinGroups(ctx),
    importantEvents(ctx),
    ctx.db
      .select({
        total: count(),
        directory: sql<number>`count(*) filter (where ${users.authSource} = 'ldap' and ${users.pendingActivation} = false)::int`,
        waiting: sql<number>`count(*) filter (where ${users.pendingActivation} = true)::int`,
        blocked: sql<number>`count(*) filter (where ${users.disabledReason} = 'directory')::int`,
      })
      .from(users),
  ]);
  const accounts = {
    total: stat?.total ?? 0,
    directory: stat?.directory ?? 0,
    waiting: stat?.waiting ?? 0,
    blockedByDirectory: stat?.blocked ?? 0,
  };
  const checks = system.checks;
  return {
    at: new Date().toISOString(),
    app: {
      version: ctx.config.APP_VERSION,
      commit: ctx.config.APP_GIT_COMMIT ?? null,
      builtAt: ctx.config.APP_BUILT_AT ?? null,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
    },
    publicUrl: publicUrl ? scrubUrl(publicUrl) : null,
    findings: findingsOf(directories, signin, accounts, checks),
    directories,
    accounts,
    signin,
    events,
    checks,
  };
}
