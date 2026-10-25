import { lookup } from 'node:dns/promises';
import { access, constants, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DiagnosticState } from '@arklock/contracts';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { rowsOf } from '../db/connect.js';
import { publicUrlOf } from '../public-url.js';
import { attachments, entries, handoffs, sessions, settings, users, vaults } from '../db/schema.js';
import { parse } from '../errors.js';
import type { SmtpConfig } from '../mail/smtp.js';
import { LDAP_PROFILES_KEY, readLdapProfiles } from '../auth/ldap-profiles.js';
import { SAML_SETTING_KEY } from '../auth/saml.js';
import { metricsHistory } from '../metrics.js';
import { SYSLOG_KEY } from '../syslog.js';
import { diskInfo, type Level } from '../resources.js';
import { blobSuffix, sweepBlobs } from './attachments.js';

const startedAt = Date.now();
const SMTP_KEY = 'smtp.config';

interface StoredSmtp {
  host: string;
  port: number;
  security: SmtpConfig['security'];
  user: string;
  passwordCipher: string;
  from: string;
}

export interface Check {
  id: string;
  level: Level;
  /** Код состояния; текст на языке пользователя строит интерфейс. */
  state: DiagnosticState;
  params?: Record<string, string | number>;
}

export interface CertInfo {
  target: string;
  host: string;
  port: number;
  ok: boolean;
  error?: string;
  trusted?: boolean;
  chain: {
    subject: string;
    issuer: string;
    validFrom: string;
    validTo: string;
    daysLeft: number;
    fingerprint256: string;
    /** Ключ и подпись: RSA с длиной или кривая; для разбора срока замены и совместимости. */
    key?: string;
  }[];
  level: Level;
}

/** Чтение цепочки сертификатов узла. Проверка доверия выполняется отдельно: просроченный сертификат всё равно показываем. */
export function probeCertificate(host: string, port: number, timeoutMs = 8000): Promise<CertInfo> {
  const target = `${host}:${port}`;
  return new Promise((resolve) => {
    const done = (r: Omit<CertInfo, 'target' | 'host' | 'port'>) =>
      resolve({ target, host, port, ...r });
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const out: CertInfo['chain'] = [];
      const seen = new Set<string>();
      let cur = socket.getPeerCertificate(true);
      while (cur && cur.fingerprint256 && !seen.has(cur.fingerprint256)) {
        seen.add(cur.fingerprint256);
        const to = new Date(cur.valid_to).getTime();
        out.push({
          subject: String(cur.subject?.CN ?? JSON.stringify(cur.subject ?? {})),
          issuer: String(cur.issuer?.CN ?? JSON.stringify(cur.issuer ?? {})),
          validFrom: new Date(cur.valid_from).toISOString(),
          validTo: new Date(to).toISOString(),
          daysLeft: Math.floor((to - Date.now()) / 86_400_000),
          fingerprint256: cur.fingerprint256,
          key: cur.asn1Curve ? `EC ${cur.asn1Curve}` : cur.bits ? `RSA ${cur.bits}` : undefined,
        });
        cur = cur.issuerCertificate;
      }
      const trusted = socket.authorized;
      socket.end();
      const leaf = out[0];
      const level: Level = !leaf
        ? 'fail'
        : leaf.daysLeft < 0
          ? 'fail'
          : leaf.daysLeft < 30 || !trusted
            ? 'warn'
            : 'ok';
      done({ ok: true, trusted, chain: out, level });
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      done({ ok: false, error: 'timeout', chain: [], level: 'fail' });
    });
    socket.on('error', (e) => done({ ok: false, error: e.message, chain: [], level: 'fail' }));
  });
}

/** Состояние системы для администратора: обзор, ресурсы, хранилища, диагностика, сертификаты, почта. */
export const registerAdminSystemRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db, config, blobs } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', async (req: FastifyRequest) => {
    await adminGate(ctx, req);
  });

  const num = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;

  async function dbSize(): Promise<number | null> {
    try {
      const r = await db.execute(sql`select pg_database_size(current_database())::float8 as n`);
      return Number(rowsOf<{ n: number }>(r)[0]?.n ?? 0);
    } catch {
      return null;
    }
  }

  async function migrations(): Promise<number | null> {
    try {
      const r = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
      return Number(rowsOf<{ n: number }>(r)[0]?.n ?? 0);
    } catch {
      return null;
    }
  }

  async function blobStats() {
    const files = (await blobs.scan()).filter((f) => !f.suffix.endsWith('.part'));
    const rows = await db.select().from(attachments);
    const byId = new Map(rows.map((r) => [r.id, r]));
    let bytes = 0;
    let orphans = 0;
    const present = new Set<string>();
    for (const f of files) {
      bytes += f.size;
      const row = byId.get(f.id);
      if (row && f.suffix === blobSuffix(row.keyVersion)) present.add(f.id);
      else orphans++;
    }
    const missing = rows.filter((r) => r.status === 'ready' && !present.has(r.id)).length;
    return {
      files: files.length,
      bytes,
      registered: rows.length,
      registeredBytes: rows.reduce((s, r) => s + r.size, 0),
      orphans,
      missing,
    };
  }

  // ------------------------------------------------------------------ обзор

  app.get('/admin/overview', async () => {
    const now = new Date();
    const [u, shared, lockers, ent, att, sess, hand, migs] = await Promise.all([
      num(db.select({ n: count() }).from(users)),
      num(db.select({ n: count() }).from(vaults).where(eq(vaults.kind, 'shared'))),
      num(db.select({ n: count() }).from(vaults).where(eq(vaults.kind, 'locker'))),
      num(db.select({ n: count() }).from(entries).where(isNull(entries.deletedAt))),
      num(db.select({ n: count() }).from(attachments).where(eq(attachments.status, 'ready'))),
      num(
        db
          .select({ n: count() })
          .from(sessions)
          .where(sql`${sessions.revokedAt} is null and ${sessions.expiresAt} > ${now}`),
      ),
      num(
        db
          .select({ n: count() })
          .from(handoffs)
          .where(sql`${handoffs.revokedAt} is null and ${handoffs.expiresAt} > ${now}`),
      ),
      migrations(),
    ]);
    const upd = ctx.updater.configured
      ? await ctx.updater.overview({
          version: config.APP_VERSION,
          commit: config.APP_GIT_COMMIT,
          builtAt: config.APP_BUILT_AT,
          channel: config.UPDATE_CHANNEL,
        })
      : null;
    return {
      version: config.APP_VERSION,
      commit: config.APP_GIT_COMMIT,
      builtAt: config.APP_BUILT_AT,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      database: { ok: migs !== null, migrations: migs },
      counts: {
        users: u,
        sharedVaults: shared,
        lockers,
        entries: ent,
        attachments: att,
        activeSessions: sess,
        activeLinks: hand,
      },
      helper: upd
        ? { configured: true, alive: upd.helper.alive }
        : { configured: false, alive: false },
      lastUpdate: upd?.history[0] ?? null,
      updateAvailable: upd?.remote?.latest ?? null,
    };
  });

  // ------------------------------------------------------------------ ресурсы

  app.get('/admin/resources', async () => {
    const cores = os.cpus().length || 1;
    const [l1, l5, l15] = os.loadavg();
    const disks = (
      await Promise.all([
        blobs.enabled ? diskInfo('attachments', blobs.dir) : null,
        diskInfo('temp', os.tmpdir()),
      ])
    ).filter((d): d is NonNullable<typeof d> => !!d);
    const [dbBytes, files] = await Promise.all([dbSize(), blobStats()]);
    const mem = process.memoryUsage();
    return {
      cpu: {
        cores,
        load1: l1,
        load5: l5,
        load15: l15,
        loadPct: Math.round(((l1 ?? 0) / cores) * 100),
      },
      memory: {
        totalBytes: os.totalmem(),
        freeBytes: os.freemem(),
        processRssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
      },
      disks,
      database: { sizeBytes: dbBytes },
      attachments: { files: files.files, bytes: files.bytes },
    };
  });

  app.get('/admin/resources/history', async (req) => {
    const { hours } = parse(
      z.object({ hours: z.coerce.number().int().min(1).max(336).default(24) }),
      req.query,
    );
    return { hours, points: await metricsHistory(db, hours) };
  });

  // ------------------------------------------------------------------ хранилища

  app.get('/admin/storage', async () => {
    const [dbBytes, files] = await Promise.all([dbSize(), blobStats()]);
    return {
      categories: [
        { id: 'database', bytes: dbBytes, status: dbBytes === null ? 'fail' : 'ok' },
        {
          id: 'attachments',
          bytes: files.bytes,
          files: files.files,
          registered: files.registered,
          registeredBytes: files.registeredBytes,
          orphans: files.orphans,
          missing: files.missing,
          enabled: blobs.enabled,
          status: !blobs.enabled
            ? 'warn'
            : files.missing > 0
              ? 'fail'
              : files.orphans > 0
                ? 'warn'
                : 'ok',
        },
      ],
    };
  });

  /** Сверка метаданных и файлов. Без `apply` только отчёт; с `apply` удаляются файлы-сироты (записи без файла не трогаются). */
  app.post('/admin/storage/reconcile', async (req) => {
    const { user } = authOf(req);
    const body = parse(z.object({ apply: z.boolean().default(false) }), req.body ?? {});
    const before = await blobStats();
    let removed = { orphans: 0, pending: 0 };
    if (body.apply) {
      removed = await sweepBlobs(ctx, new Date(), 3_600_000);
      await audit(db, `user:${user.id}`, 'admin.storage.reconcile', null, removed);
    }
    return { before, removed, applied: body.apply };
  });

  // ------------------------------------------------------------------ диагностика

  app.get('/admin/diagnostics', async () => {
    const checks: Check[] = [];
    const add = (
      id: string,
      level: Level,
      state: DiagnosticState,
      params?: Record<string, string | number>,
    ) => checks.push({ id, level, state, ...(params ? { params } : {}) });

    const migs = await migrations();
    if (migs === null) add('database', 'fail', 'database.unreadable');
    else add('database', 'ok', 'database.ok', { n: migs });

    for (const d of (
      await Promise.all([
        blobs.enabled ? diskInfo('attachments', blobs.dir) : null,
        diskInfo('temp', os.tmpdir()),
      ])
    ).filter((x): x is NonNullable<typeof x> => !!x))
      add(`disk-${d.id}`, d.level, d.level === 'ok' ? 'disk.ok' : 'disk.low', {
        name: d.id,
        pct: d.usedPct,
        freeMb: Math.round(d.freeBytes / 1024 ** 2),
      });

    if (!blobs.enabled) add('blobs', 'warn', 'blobs.off');
    else {
      const probe = path.join(blobs.dir, `.probe-${process.pid}`);
      try {
        await access(blobs.dir, constants.W_OK);
        await writeFile(probe, 'x');
        await rm(probe, { force: true });
        add('blobs', 'ok', 'blobs.ok');
      } catch {
        add('blobs', 'fail', 'blobs.readonly');
      }
      const s = await blobStats();
      if (s.missing > 0)
        add('blobs-consistency', 'fail', 'blobs-consistency.missing', { n: s.missing });
      else if (s.orphans > 0)
        add('blobs-consistency', 'warn', 'blobs-consistency.orphans', { n: s.orphans });
      else add('blobs-consistency', 'ok', 'blobs-consistency.ok', { n: s.files });
    }

    const pub = publicUrlOf(ctx);
    if (!pub) add('public-url', 'warn', 'public-url.unset');
    else if (!pub.startsWith('https://'))
      add('public-url', 'fail', 'public-url.http', { url: pub });
    else add('public-url', 'ok', 'public-url.ok', { url: pub });

    const upd = ctx.updater.configured
      ? await ctx.updater.overview({
          version: config.APP_VERSION,
          commit: config.APP_GIT_COMMIT,
          builtAt: config.APP_BUILT_AT,
          channel: config.UPDATE_CHANNEL,
        })
      : null;
    if (!upd) add('helper', 'warn', 'helper.none');
    else if (upd.helper.alive) add('helper', 'ok', 'helper.ok');
    else add('helper', 'warn', 'helper.down');

    const [row] = await db.select().from(settings).where(eq(settings.key, SMTP_KEY));
    if (row) add('smtp', 'ok', 'smtp.ok', { host: (row.value as StoredSmtp).host });
    else add('smtp', 'warn', 'smtp.none');

    const [mfa] = await db.select().from(settings).where(eq(settings.key, 'security.mfaRequired'));
    if (mfa?.value === 'all' || mfa?.value === 'admins')
      add('mfa-policy', 'ok', 'mfa-policy.ok', { scope: String(mfa.value) });
    else add('mfa-policy', 'warn', 'mfa-policy.off');

    // интеграции: «не используется» не проблема, поэтому уровень всегда «в порядке»
    const integ = await db
      .select()
      .from(settings)
      .where(inArray(settings.key, [LDAP_PROFILES_KEY, 'sso.oidc', SAML_SETTING_KEY, SYSLOG_KEY]));
    const on = (key: string, test: (v: unknown) => boolean) =>
      integ.some((r) => r.key === key && test(r.value));
    const used = [
      on(
        LDAP_PROFILES_KEY,
        (v) => Array.isArray(v) && v.some((p) => (p as { enabled?: boolean }).enabled),
      ) && 'LDAP',
      on('sso.oidc', (v) => !!(v as { enabled?: boolean }).enabled) && 'SSO',
      on(SAML_SETTING_KEY, (v) => !!(v as { enabled?: boolean }).enabled) && 'SAML',
      on(SYSLOG_KEY, (v) => !!(v as { enabled?: boolean }).enabled) && 'syslog',
    ].filter(Boolean);
    add('integrations', 'ok', 'integrations.ok', { n: used.length, list: used.join(', ') });

    // копии: нужна свежая (не старше недели) — иначе при сбое восстанавливать нечего
    if (upd?.helper.alive) {
      const last = (await ctx.updater.backups())?.items
        .map((i) => Date.parse(i.createdAt))
        .filter((n) => !Number.isNaN(n))
        .sort((a, b) => b - a)[0];
      if (last === undefined) add('backups', 'warn', 'backups.none');
      else {
        const days = Math.floor((Date.now() - last) / 86_400_000);
        if (days > 7) add('backups', 'warn', 'backups.old', { days });
        else add('backups', 'ok', 'backups.ok', { days });
      }
    }

    // публичный адрес: имя должно разрешаться, сертификат — действовать и быть доверенным
    if (pub?.startsWith('https://')) {
      const u = new URL(pub);
      try {
        await lookup(u.hostname);
        add('dns', 'ok', 'dns.ok', { host: u.hostname });
      } catch {
        add('dns', 'warn', 'dns.fail', { host: u.hostname });
      }
      const cert = await probeCertificate(u.hostname, Number(u.port) || 443, 3000);
      const leaf = cert.chain[0];
      if (!cert.ok || !leaf) add('cert', 'warn', 'cert.unreachable', { host: u.hostname });
      else if (leaf.daysLeft < 0) add('cert', 'fail', 'cert.expired', { host: u.hostname });
      else if (!cert.trusted) add('cert', 'warn', 'cert.untrusted', { host: u.hostname });
      else if (leaf.daysLeft < 30) add('cert', 'warn', 'cert.soon', { days: leaf.daysLeft });
      else add('cert', 'ok', 'cert.ok', { days: leaf.daysLeft });
    }

    // веб-интерфейс: собранные файлы на месте (иначе страница не откроется)
    if (config.WEB_DIST) {
      try {
        await access(path.join(config.WEB_DIST, 'index.html'), constants.R_OK);
        add('static', 'ok', 'static.ok');
      } catch {
        add('static', 'fail', 'static.missing');
      }
    }

    const worst = checks.some((c) => c.level === 'fail')
      ? 'fail'
      : checks.some((c) => c.level === 'warn')
        ? 'warn'
        : 'ok';
    return { level: worst, checks, at: new Date().toISOString() };
  });

  // ------------------------------------------------------------------ сертификаты

  type CertTarget = { label: string; purpose: string; host: string; port: number };
  /**
   * Адреса, чьи сертификаты Arklock проверяет: публичный HTTPS, LDAPS каталога, защищённая почта, провайдер единого входа и
   * журнал syslog по TLS. Только узлы, настроенные в системе, а не произвольные.
   */
  async function certTargets(stored: StoredSmtp | null): Promise<CertTarget[]> {
    const out: CertTarget[] = [];
    const pub = publicUrlOf(ctx);
    if (pub?.startsWith('https://')) {
      const u = new URL(pub);
      out.push({
        label: 'public',
        purpose: 'https',
        host: u.hostname,
        port: Number(u.port || 443),
      });
    }
    for (const p of await readLdapProfiles(db)) {
      try {
        const u = new URL(p.url);
        if (u.protocol === 'ldaps:')
          out.push({
            label: p.name,
            purpose: 'ldaps',
            host: u.hostname,
            port: Number(u.port || 636),
          });
      } catch {
        /* адрес профиля неверен: его покажет сам раздел каталога */
      }
    }
    if (stored && stored.security === 'tls')
      out.push({ label: 'smtp', purpose: 'smtp', host: stored.host, port: stored.port });
    const [oidc] = await db.select().from(settings).where(eq(settings.key, 'sso.oidc'));
    const issuer = (oidc?.value as { issuer?: string; enabled?: boolean } | undefined)?.issuer;
    if (issuer?.startsWith('https://')) {
      const u = new URL(issuer);
      out.push({ label: 'sso', purpose: 'sso', host: u.hostname, port: Number(u.port || 443) });
    }
    const [sys] = await db.select().from(settings).where(eq(settings.key, SYSLOG_KEY));
    const sv = sys?.value as
      { enabled?: boolean; protocol?: string; host?: string; port?: number } | undefined;
    if (sv?.enabled && sv.protocol === 'tls' && sv.host)
      out.push({ label: 'syslog', purpose: 'syslog', host: sv.host, port: sv.port ?? 6514 });
    const seen = new Set<string>();
    return out.filter(
      (t) =>
        !seen.has(`${t.purpose}|${t.host}:${t.port}`) &&
        seen.add(`${t.purpose}|${t.host}:${t.port}`),
    );
  }

  app.get('/admin/certificates', async () => {
    const [row] = await db.select().from(settings).where(eq(settings.key, SMTP_KEY));
    // Проверяются только адреса, известные системе (публичный адрес и настроенные серверы), а не произвольные узлы
    const targets = await certTargets((row?.value as StoredSmtp | undefined) ?? null);
    const items = await Promise.all(
      targets.map(async (t) => ({
        label: t.label,
        purpose: t.purpose,
        ...(await probeCertificate(t.host, t.port)),
      })),
    );
    return { items, publicUrl: publicUrlOf(ctx) || null };
  });
};
