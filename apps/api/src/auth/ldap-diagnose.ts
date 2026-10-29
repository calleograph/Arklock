import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import {
  buildUserFilter,
  classifyLdapError,
  LdapError,
  ldapUrlOf,
  makeClient,
  serviceAccount,
  serviceBind,
  type LdapConfig,
} from './ldap.js';

/**
 * Пошаговая проверка подключения к каталогу: адрес → DNS → TCP → TLS и сертификат → вход служебной учётной записи →
 * Base DN → фильтр пользователей → пользователи → группы из сопоставления. Каждый этап — результат и точная причина;
 * технический текст сервера — в подробностях. Пароли и ключи в ответ не попадают.
 */

export type LdapStageName =
  'config' | 'dns' | 'tcp' | 'tls' | 'bind' | 'base' | 'filter' | 'users' | 'groups';

export interface LdapStage {
  stage: LdapStageName;
  ok: boolean;
  skipped?: boolean;
  warn?: boolean;
  /** Код результата или причины: интерфейс показывает по нему понятный текст. */
  code: string;
  params?: Record<string, string | number | boolean>;
  /** Технические сведения: ответ сервера, сведения о сертификате. */
  detail?: string;
  ms?: number;
}

const TIMEOUT = 8_000;

/** Запрос StartTLS (RFC 4511, расширенная операция 1.3.6.1.4.1.1466.20037) и ответ «успех» — для проверки сертификата. */
const STARTTLS_REQ = Buffer.concat([
  Buffer.from([0x30, 0x1d, 0x02, 0x01, 0x01, 0x77, 0x18, 0x80, 0x16]),
  Buffer.from('1.3.6.1.4.1.1466.20037', 'ascii'),
]);

function connectTcp(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.setTimeout(TIMEOUT, () =>
      s.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
    );
    s.once('connect', () => {
      s.setTimeout(0);
      resolve(s);
    });
    s.once('error', reject);
  });
}

function startTlsOnSocket(s: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
      TIMEOUT,
    );
    s.once('data', (d: Buffer) => {
      clearTimeout(t);
      const i = d.indexOf(0x78);
      const rc = i >= 0 ? d.indexOf(Buffer.from([0x0a, 0x01]), i) : -1;
      if (rc >= 0 && d[rc + 2] === 0) resolve();
      else reject(new LdapError('StartTLS refused', 'tls', 'starttls_failed'));
    });
    s.once('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    s.write(STARTTLS_REQ);
  });
}

/** TLS с проверкой по набору центров (или по системным, если свой не загружен); подробности о сертификате сервера. */
function probeTls(
  socketOrNull: net.Socket | null,
  host: string,
  port: number,
  cfg: LdapConfig,
): Promise<{ ok: boolean; reason: string; detail: string; params: Record<string, string> }> {
  return new Promise((resolve) => {
    const servername = net.isIP(host) ? undefined : host.replace(/^\[|\]$/g, '');
    const ca = [cfg.caPem, cfg.pinnedPem].filter((x): x is string => !!x);
    const s = tls.connect({
      ...(socketOrNull ? { socket: socketOrNull } : { host, port }),
      servername,
      ...(ca.length ? { ca } : {}),
      rejectUnauthorized: false,
      timeout: TIMEOUT,
    });
    const done = (r: {
      ok: boolean;
      reason: string;
      detail: string;
      params: Record<string, string>;
    }) => {
      s.destroy();
      resolve(r);
    };
    s.once('secureConnect', () => {
      const peer = s.getPeerCertificate(true);
      const pem = peer?.raw
        ? `-----BEGIN CERTIFICATE-----\n${peer.raw
            .toString('base64')
            .match(/.{1,64}/g)!
            .join('\n')}\n-----END CERTIFICATE-----\n`
        : '';
      const params: Record<string, string> = {
        fingerprint256: peer?.fingerprint256 ?? '',
        pem,
        protocol: s.getProtocol() ?? '',
        subject: [peer?.subject?.CN ?? ''].flat()[0] ?? '',
        issuer: [peer?.issuer?.CN ?? ''].flat()[0] ?? '',
        validTo: peer?.valid_to ? new Date(peer.valid_to).toISOString() : '',
        names: peer?.subjectaltname ?? '',
      };
      const detail = [
        `TLS ${params.protocol}`,
        `subject CN=${params.subject}`,
        `issuer CN=${params.issuer}`,
        `valid to ${params.validTo}`,
        params.names && `SAN ${params.names}`,
        s.authorizationError ? `verify: ${String(s.authorizationError)}` : '',
      ]
        .filter(Boolean)
        .join('; ');
      const code = String(s.authorizationError ?? '');
      // администратор доверил именно этот сертификат: цепочка и имя не требуются
      if (cfg.pinnedFingerprint && peer?.fingerprint256 === cfg.pinnedFingerprint)
        return done({ ok: true, reason: 'pinned', detail, params });
      const nameError = peer && tls.checkServerIdentity(host.replace(/^\[|\]$/g, ''), peer);
      if (!s.authorized) {
        const c = classifyLdapError(Object.assign(new Error(code), { code }), 'tls');
        // любая другая ошибка проверки цепочки — сертификат не подтверждён загруженными центрами
        const reason =
          c.code === 'tls' && c.reason !== 'tls_handshake' ? c.reason : 'cert_untrusted';
        return done({ ok: false, reason, detail, params });
      }
      if (nameError) return done({ ok: false, reason: 'cert_name', detail, params });
      done({ ok: true, reason: 'ok', detail, params });
    });
    s.once('timeout', () =>
      done({ ok: false, reason: 'timeout', detail: 'TLS handshake timeout', params: {} }),
    );
    s.once('error', (e) => {
      const c = classifyLdapError(e, 'tls');
      done({
        ok: false,
        reason: c.code === 'tls' ? c.reason : 'tls_handshake',
        detail: c.detail,
        params: {},
      });
    });
  });
}

export async function ldapDiagnose(
  cfg: LdapConfig,
  bindPassword: string,
): Promise<{ ok: boolean; stages: LdapStage[] }> {
  const stages: LdapStage[] = [];
  const add = (st: LdapStage) => (stages.push(st), st.ok || !!st.skipped);
  const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
    const t = Date.now();
    const r = await fn();
    return [r, Date.now() - t];
  };
  const stop = () => ({ ok: false, stages });

  // 1. настройки: адрес, способ защиты, учётная запись
  let url;
  try {
    url = ldapUrlOf(cfg);
    const account = serviceAccount(cfg);
    add({
      stage: 'config',
      ok: true,
      code: 'ok',
      params: { url: url.url, account, insecure: cfg.insecureTls },
      warn: cfg.insecureTls || (!url.secure && !cfg.startTls),
    });
  } catch (e) {
    const c = e as LdapError;
    add({ stage: 'config', ok: false, code: c.reason });
    return stop();
  }
  const host = url.host.replace(/^\[|\]$/g, '');

  // 2. DNS
  try {
    const [addrs, ms] = await timed(() =>
      net.isIP(host) ? Promise.resolve([{ address: host }]) : dns.lookup(host, { all: true }),
    );
    add({
      stage: 'dns',
      ok: true,
      code: 'ok',
      params: { host, address: addrs.map((a) => a.address).join(', ') },
      ms,
    });
  } catch (e) {
    add({
      stage: 'dns',
      ok: false,
      code: 'dns',
      params: { host },
      detail: String((e as Error).message).slice(0, 300),
    });
    return stop();
  }

  // 3. TCP
  let sock: net.Socket;
  try {
    const [s, ms] = await timed(() => connectTcp(host, url.port));
    sock = s;
    add({ stage: 'tcp', ok: true, code: 'ok', params: { host, port: url.port }, ms });
  } catch (e) {
    const c = classifyLdapError(e, 'connect');
    add({
      stage: 'tcp',
      ok: false,
      code: c.reason,
      params: { host, port: url.port },
      detail: c.detail,
    });
    return stop();
  }

  // 4. TLS и сертификат (для ldap:// без StartTLS — пропуск с предупреждением)
  if (!url.secure && !cfg.startTls) {
    sock.destroy();
    add({ stage: 'tls', ok: true, skipped: true, warn: true, code: 'plaintext' });
  } else {
    try {
      if (!url.secure) await startTlsOnSocket(sock);
      const [r, ms] = await timed(() => probeTls(url.secure ? null : sock, host, url.port, cfg));
      if (url.secure) sock.destroy();
      if (!r.ok && !cfg.insecureTls) {
        add({
          stage: 'tls',
          ok: false,
          code: r.reason,
          params: { ...r.params, host, customCa: !!cfg.caPem },
          detail: r.detail,
          ms,
        });
        return stop();
      }
      add({
        stage: 'tls',
        ok: true,
        warn: !r.ok,
        code: r.ok ? (r.reason === 'pinned' ? 'pinned' : 'ok') : 'unverified',
        params: { ...r.params, host, customCa: !!cfg.caPem, problem: r.ok ? '' : r.reason },
        detail: r.detail,
        ms,
      });
    } catch (e) {
      sock.destroy();
      const c = classifyLdapError(e, 'tls');
      add({
        stage: 'tls',
        ok: false,
        code: c.code === 'tls' ? c.reason : 'starttls_failed',
        detail: c.detail,
      });
      return stop();
    }
  }

  // 5–9. вход и поиск — одним соединением
  const client = makeClient(cfg);
  try {
    if (cfg.startTls && !url.secure)
      await client.startTLS({
        ...(cfg.caPem ? { ca: [cfg.caPem] } : {}),
        rejectUnauthorized: !cfg.insecureTls,
      });
    try {
      const [, ms] = await timed(() => serviceBind(client, cfg, bindPassword));
      add({
        stage: 'bind',
        ok: true,
        code: serviceAccount(cfg) ? 'ok' : 'anonymous',
        warn: !serviceAccount(cfg),
        params: { account: serviceAccount(cfg) },
        ms,
      });
    } catch (e) {
      const c = classifyLdapError(e, 'bind');
      add({
        stage: 'bind',
        ok: false,
        code: c.reason,
        params: { account: serviceAccount(cfg) },
        detail: c.detail,
      });
      return stop();
    }

    if (!cfg.baseDn) {
      add({ stage: 'base', ok: false, code: 'required' });
      return stop();
    }
    try {
      const [, ms] = await timed(() =>
        client.search(cfg.baseDn, { scope: 'base', filter: '(objectClass=*)', attributes: ['dn'] }),
      );
      add({ stage: 'base', ok: true, code: 'ok', params: { baseDn: cfg.baseDn }, ms });
    } catch (e) {
      const c = classifyLdapError(e, 'search');
      add({
        stage: 'base',
        ok: false,
        code: c.reason,
        params: { baseDn: cfg.baseDn },
        detail: c.detail,
      });
      return stop();
    }

    try {
      const filter = buildUserFilter(cfg.userFilter, '*').replace(/\\2a/g, '*');
      const [r, ms] = await timed(() =>
        client.search(cfg.baseDn, {
          scope: 'sub',
          filter,
          attributes: ['dn'],
          sizeLimit: 5,
          paged: false,
        }),
      );
      add({ stage: 'filter', ok: true, code: 'ok', params: { count: r.searchEntries.length }, ms });
      add({
        stage: 'users',
        ok: true,
        warn: r.searchEntries.length === 0,
        code: r.searchEntries.length ? 'ok' : 'none',
        params: { count: r.searchEntries.length, sample: r.searchEntries[0]?.dn ?? '' },
      });
    } catch (e) {
      const c = classifyLdapError(e, 'search');
      // ограничение размера ответа значит, что фильтр работает и пользователи есть
      if (c.reason === 'ldap_error' && /size ?limit/i.test(c.detail)) {
        add({ stage: 'filter', ok: true, code: 'ok', params: { count: 5 } });
        add({ stage: 'users', ok: true, code: 'ok', params: { count: 5, sample: '' } });
      } else {
        add({
          stage: 'filter',
          ok: false,
          code: c.reason === 'ldap_error' ? 'filter_invalid' : c.reason,
          detail: c.detail,
        });
        return stop();
      }
    }

    if (!cfg.groups.length) add({ stage: 'groups', ok: true, skipped: true, code: 'none_mapped' });
    else {
      const missing: string[] = [];
      for (const g of cfg.groups.slice(0, 50)) {
        try {
          await client.search(g.dn, {
            scope: 'base',
            filter: '(objectClass=*)',
            attributes: ['dn'],
          });
        } catch {
          missing.push(g.dn);
        }
      }
      add({
        stage: 'groups',
        ok: missing.length === 0,
        code: missing.length ? 'missing' : 'ok',
        params: { total: cfg.groups.length, missing: missing.length },
        detail: missing.join('\n'),
      });
    }
  } finally {
    await client.unbind().catch(() => undefined);
  }
  return { ok: stages.every((s) => s.ok || s.skipped), stages };
}
