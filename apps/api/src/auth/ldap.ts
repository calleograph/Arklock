import { Client } from 'ldapts';

export interface LdapConfig {
  enabled: boolean;
  /** ldap://host:389 или ldaps://host:636 */
  url: string;
  /** Повысить обычное соединение до TLS командой StartTLS (для ldap://). */
  startTls: boolean;
  /** Дополнительный корневой сертификат (PEM), например, внутреннего центра сертификации. */
  caPem: string;
  /** Не проверять сертификат сервера. Только для стенда: пароли пользователей идут на этот сервер. */
  insecureTls: boolean;
  allowPlaintext: boolean;
  bindDn: string;
  baseDn: string;
  /** Фильтр поиска пользователя; {u} заменяется на экранированное введённое имя. */
  userFilter: string;
  emailAttr: string;
  nameAttr: string;
  /** Привязка групп каталога к кругам Arklock. */
  groups: { dn: string; circleId: string }[];
  /** Создавать учётную запись при первом входе пользователя каталога. */
  autoProvision: boolean;
}

export const DEFAULT_USER_FILTER =
  '(&(objectClass=person)(|(uid={u})(mail={u})(sAMAccountName={u})(userPrincipalName={u})))';

export class LdapError extends Error {
  constructor(
    message: string,
    readonly code: 'connect' | 'bind' | 'search' | 'config' | 'tls',
  ) {
    super(message);
  }
}

/** Экранирование значения в фильтре LDAP (RFC 4515): исключает внедрение условий через имя пользователя. */
export function escapeFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

export function buildUserFilter(template: string, username: string): string {
  if (!template.includes('{u}')) throw new LdapError('The user filter must contain {u}', 'config');
  return template.split('{u}').join(escapeFilter(username));
}

export interface DirectoryUser {
  dn: string;
  email: string;
  name: string;
  groups: string[];
  /** Для Active Directory: учётная запись отключена (бит 2 в userAccountControl). */
  disabled: boolean;
}

/** Значение атрибута без учёта регистра имени: каталоги возвращают имена по-разному. */
const pick = (e: Record<string, unknown>, name: string): unknown => {
  const k = Object.keys(e).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : e[k];
};

const str = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''));
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)) : v === undefined || v === null ? [] : [String(v)];

function makeClient(cfg: LdapConfig): Client {
  if (!/^ldaps?:\/\//i.test(cfg.url))
    throw new LdapError('Address must start with ldap:// or ldaps://', 'config');
  const tlsOptions = {
    ...(cfg.caPem ? { ca: [cfg.caPem] } : {}),
    rejectUnauthorized: !cfg.insecureTls,
  };
  // tlsOptions у ldapts включают TLS и для ldap://: задаём их только для ldaps:// (для StartTLS они передаются отдельно)
  const secure = cfg.url.toLowerCase().startsWith('ldaps://');
  return new Client({
    url: cfg.url,
    timeout: 10_000,
    connectTimeout: 10_000,
    ...(secure ? { tlsOptions } : {}),
    strictDN: false,
  });
}

/** Устанавливает соединение (с StartTLS при необходимости) и выполняет действие; соединение всегда закрывается. */
async function withClient<T>(cfg: LdapConfig, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = makeClient(cfg);
  try {
    if (cfg.startTls && /^ldap:\/\//i.test(cfg.url)) {
      try {
        await client.startTLS({
          ...(cfg.caPem ? { ca: [cfg.caPem] } : {}),
          rejectUnauthorized: !cfg.insecureTls,
        });
      } catch (e) {
        throw new LdapError(`StartTLS failed: ${(e as Error).message}`, 'tls');
      }
    }
    return await fn(client);
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

async function serviceBind(c: Client, cfg: LdapConfig, bindPassword: string): Promise<void> {
  if (!cfg.bindDn) return; // анонимный поиск, если каталог его разрешает
  try {
    await c.bind(cfg.bindDn, bindPassword);
  } catch (e) {
    throw new LdapError(`Service bind failed: ${(e as Error).message}`, 'bind');
  }
}

async function findUser(
  c: Client,
  cfg: LdapConfig,
  username: string,
): Promise<DirectoryUser | null> {
  // имена атрибутов в нижнем регистре: каталоги сравнивают их без учёта регистра, а некоторые реализации — только так
  const attrs = ['dn', cfg.emailAttr, cfg.nameAttr, 'memberOf', 'userAccountControl'].map((a) =>
    a.toLowerCase(),
  );
  let res;
  try {
    res = await c.search(cfg.baseDn, {
      scope: 'sub',
      filter: buildUserFilter(cfg.userFilter, username),
      attributes: attrs,
      sizeLimit: 2,
    });
  } catch (e) {
    if (e instanceof LdapError) throw e;
    // sizeLimitExceeded при двух совпадениях трактуется ниже как неоднозначность
    if (/size/i.test((e as Error).message)) return null;
    throw new LdapError(`Search failed: ${(e as Error).message}`, 'search');
  }
  if (res.searchEntries.length !== 1) return null; // нет или неоднозначно — не входим
  const e = res.searchEntries[0]!;
  const uac = Number(str(pick(e, 'userAccountControl')) || 0);
  return {
    dn: e.dn,
    email: str(pick(e, cfg.emailAttr)).toLowerCase(),
    name: str(pick(e, cfg.nameAttr)),
    groups: list(pick(e, 'memberOf')),
    disabled: (uac & 2) === 2,
  };
}

/** Группы пользователя: атрибут memberOf или поиск групп, где он перечислен участником. */
async function groupsOf(c: Client, cfg: LdapConfig, user: DirectoryUser): Promise<string[]> {
  if (user.groups.length || !cfg.groups.length) return user.groups;
  try {
    const dn = escapeFilter(user.dn);
    const res = await c.search(cfg.baseDn, {
      scope: 'sub',
      filter: `(|(member=${dn})(uniqueMember=${dn}))`,
      attributes: ['dn'],
      sizeLimit: 500,
    });
    return res.searchEntries.map((e) => e.dn);
  } catch {
    return [];
  }
}

const norm = (dn: string) => dn.toLowerCase().replace(/\s*,\s*/g, ',');

export async function ldapTest(cfg: LdapConfig, bindPassword: string): Promise<{ ok: true }> {
  return withClient(cfg, async (c) => {
    await serviceBind(c, cfg, bindPassword);
    try {
      await c.search(cfg.baseDn, { scope: 'base', filter: '(objectClass=*)', attributes: ['dn'] });
    } catch (e) {
      throw new LdapError(`Base DN is not readable: ${(e as Error).message}`, 'search');
    }
    return { ok: true as const };
  });
}

/** Поиск пользователя для проверки настроек администратором (пароли не запрашиваются). */
export async function ldapLookup(
  cfg: LdapConfig,
  bindPassword: string,
  username: string,
): Promise<DirectoryUser | null> {
  return withClient(cfg, async (c) => {
    await serviceBind(c, cfg, bindPassword);
    const u = await findUser(c, cfg, username);
    if (!u) return null;
    return { ...u, groups: await groupsOf(c, cfg, u) };
  });
}

/**
 * Проверка пароля пользователя каталога: сервисная учётная запись находит DN, затем выполняется вход самим пользователем.
 * Пустой пароль отвергается заранее: многие каталоги принимают его как анонимный вход.
 */
export async function ldapAuthenticate(
  cfg: LdapConfig,
  bindPassword: string,
  username: string,
  password: string,
): Promise<DirectoryUser | null> {
  if (!username || !password) return null;
  const found = await withClient(cfg, async (c) => {
    await serviceBind(c, cfg, bindPassword);
    const u = await findUser(c, cfg, username);
    if (!u) return null;
    return { ...u, groups: await groupsOf(c, cfg, u) };
  });
  if (!found || found.disabled) return null;
  const ok = await withClient(cfg, async (c) => {
    try {
      await c.bind(found.dn, password);
      return true;
    } catch {
      return false;
    }
  });
  return ok ? found : null;
}

/** Круги, в которых пользователь должен состоять по привязке групп. */
export function circlesFor(
  cfg: LdapConfig,
  groups: string[],
): { want: string[]; managed: string[] } {
  const have = new Set(groups.map(norm));
  const managed = [...new Set(cfg.groups.map((g) => g.circleId))];
  const want = [...new Set(cfg.groups.filter((g) => have.has(norm(g.dn))).map((g) => g.circleId))];
  return { want, managed };
}
