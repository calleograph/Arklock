/**
 * Правила подключения к каталогу (LDAP / Active Directory), общие для формы в браузере и для сервера:
 * одна и та же проверка адреса и учётной записи даёт одинаковый ответ до отправки формы и при сохранении.
 */

export type LdapUrlProblem =
  'empty' | 'spaces' | 'scheme' | 'credentials' | 'host' | 'port' | 'path';

export interface LdapUrl {
  /** Нормализованный адрес: схема в нижнем регистре, без завершающего «/». */
  url: string;
  secure: boolean;
  host: string;
  port: number;
}

const HOST_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^\[[0-9a-f:.]+\]$/i;

/**
 * Разбор адреса сервера каталога: `ldaps://dc01.example.com:636`, `ldap://192.0.2.5`, `ldaps://[2001:db8::5]`.
 * Однозначные отклонения исправляются (пробелы по краям, регистр схемы, один завершающий «/»), остальное — понятная причина.
 */
export function normalizeLdapUrl(
  raw: string,
): { ok: true; value: LdapUrl; changed: boolean } | { ok: false; problem: LdapUrlProblem } {
  const input = (raw ?? '').trim();
  if (!input) return { ok: false, problem: 'empty' };
  if (/\s/.test(input)) return { ok: false, problem: 'spaces' };
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(input);
  if (!m) return { ok: false, problem: 'scheme' };
  const scheme = m[1]!.toLowerCase();
  if (scheme !== 'ldap' && scheme !== 'ldaps') return { ok: false, problem: 'scheme' };
  let rest = m[2]!;
  if (rest.endsWith('/') && !rest.endsWith('//')) rest = rest.slice(0, -1);
  if (/[/?#]/.test(rest)) return { ok: false, problem: 'path' };
  if (rest.includes('@')) return { ok: false, problem: 'credentials' };
  const hp = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(rest)!;
  const host = hp[1]!.toLowerCase();
  if (!host || !(HOST_NAME.test(host) || IPV4.test(host) || IPV6.test(host)))
    return { ok: false, problem: 'host' };
  const secure = scheme === 'ldaps';
  let port = secure ? 636 : 389;
  if (hp[2] !== undefined) {
    if (!/^\d{1,5}$/.test(hp[2]) || Number(hp[2]) < 1 || Number(hp[2]) > 65535)
      return { ok: false, problem: 'port' };
    port = Number(hp[2]);
  }
  const url = `${scheme}://${host}${hp[2] !== undefined ? `:${port}` : ''}`;
  return { ok: true, value: { url, secure, host, port }, changed: url !== input };
}

export type LdapTransportProblem = 'starttls_with_ldaps' | 'plaintext';

/** Сочетание адреса и способа защиты: StartTLS только для ldap://, ldap:// без StartTLS — только с явным согласием. */
export function ldapTransportProblem(
  url: LdapUrl,
  startTls: boolean,
  allowPlaintext: boolean,
): LdapTransportProblem | null {
  if (url.secure && startTls) return 'starttls_with_ldaps';
  if (!url.secure && !startTls && !allowPlaintext) return 'plaintext';
  return null;
}

export type BindAccountKind = 'none' | 'dn' | 'upn' | 'netbios' | 'short';

/** Домен из Base DN: `OU=Staff,DC=corp,DC=example,DC=com` → `corp.example.com`. */
export function domainFromBaseDn(baseDn: string): string | null {
  const parts = [...(baseDn ?? '').matchAll(/(?:^|,)\s*dc\s*=\s*([^,]+)/gi)].map((x) =>
    x[1]!.trim().toLowerCase(),
  );
  return parts.length ? parts.join('.') : null;
}

/**
 * Служебная учётная запись для входа в каталог. Active Directory принимает при простом входе полный DN,
 * `user@domain` (UPN) и `DOMAIN\user`. Короткое имя каталог не принимает (ответ 52e): оно дополняется доменом из
 * Base DN, и форма показывает, что именно будет использовано. Без домена в Base DN короткое имя — ошибка.
 */
export function bindAccount(
  raw: string,
  baseDn: string,
):
  | { ok: true; kind: BindAccountKind; value: string; derived: boolean }
  | { ok: false; problem: 'format' | 'short_no_domain' } {
  const v = (raw ?? '').trim();
  if (!v) return { ok: true, kind: 'none', value: '', derived: false };
  if (/^[a-z][a-z0-9-]*\s*=/i.test(v)) return { ok: true, kind: 'dn', value: v, derived: false };
  if (/\s/.test(v)) return { ok: false, problem: 'format' };
  if (/^[^@\\]+@[^@\\]+$/.test(v)) return { ok: true, kind: 'upn', value: v, derived: false };
  if (/^[^@\\]+\\[^@\\]+$/.test(v)) return { ok: true, kind: 'netbios', value: v, derived: false };
  if (/^[\w.-]{1,104}$/u.test(v)) {
    const domain = domainFromBaseDn(baseDn);
    return domain
      ? { ok: true, kind: 'short', value: `${v}@${domain}`, derived: true }
      : { ok: false, problem: 'short_no_domain' };
  }
  return { ok: false, problem: 'format' };
}
