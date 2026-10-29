import tls from 'node:tls';
import { Client } from 'ldapts';
import { bindAccount, ldapTransportProblem, normalizeLdapUrl } from '@arklock/contracts';

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
  /** Атрибуты карточки сотрудника; пустая строка — не брать из каталога. В прежних настройках их нет — тогда стандартные. */
  titleAttr?: string;
  departmentAttr?: string;
  phoneAttr?: string;
  /** Привязка групп каталога к кругам Arklock. */
  groups: { dn: string; circleId: string }[];
  /** Создавать учётную запись при первом входе пользователя каталога. */
  autoProvision: boolean;
  /** Вид каталога: ad — Active Directory (вложенные группы, отключённые записи по userAccountControl), ldap — другой. */
  directoryType?: 'ad' | 'ldap';
  /**
   * Кто может входить: all — все найденные фильтром действующие учётные записи (так работали подключения до 1.87.0),
   * groups — только участники перечисленных групп каталога (с учётом вложенных групп в Active Directory).
   */
  access?: 'all' | 'groups';
  allowedGroups?: string[];
  /** Сертификат контроллера домена, которому администратор доверил подключение по отпечатку (PEM и SHA-256). */
  pinnedPem?: string;
  pinnedFingerprint?: string;
}

/** Фильтр по умолчанию для Active Directory: только действующие учётные записи людей (не компьютеры и не отключённые). */
export const AD_USER_FILTER =
  '(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(|(sAMAccountName={u})(userPrincipalName={u})(mail={u})))';
/** Правило Active Directory «член группы с учётом вложенности» (LDAP_MATCHING_RULE_IN_CHAIN). */
const IN_CHAIN = '1.2.840.113556.1.4.1941';

/** Имя для входа: «ДОМЕН\\имя» → «имя» (ищется по sAMAccountName); user@domain и почта — как есть. */
export const loginName = (raw: string): string => {
  const v = raw.trim();
  const i = v.indexOf('\\');
  return i > 0 ? v.slice(i + 1) : v;
};

const normDn = (dn: string) => dn.toLowerCase().replace(/\s*,\s*/g, ',');
/** Разрешён ли вход пользователю с такими группами (правило подключения «кто может входить»). */
export function accessAllowed(
  cfg: Pick<LdapConfig, 'access' | 'allowedGroups'>,
  groups: string[],
): boolean {
  if ((cfg.access ?? 'all') === 'all') return true;
  const have = new Set(groups.map(normDn));
  return (cfg.allowedGroups ?? []).some((g) => have.has(normDn(g)));
}

export const DEFAULT_USER_FILTER =
  '(&(objectClass=person)(|(uid={u})(mail={u})(sAMAccountName={u})(userPrincipalName={u})))';

export class LdapError extends Error {
  constructor(
    message: string,
    readonly code: 'connect' | 'bind' | 'search' | 'config' | 'tls',
    /** Точная причина для интерфейса (invalid_credentials, account_locked, cert_untrusted, …). */
    readonly reason: string = code,
    /** Технические сведения для раскрывающегося блока: текст ответа сервера, без секретов. */
    readonly detail = '',
  ) {
    super(message);
  }
}

/** Коды Active Directory в ответе на вход («… data 52e …»): что именно не так с учётной записью. */
const AD_BIND_DATA: Record<string, string> = {
  '525': 'account_not_found',
  '52e': 'invalid_credentials',
  '530': 'account_restriction',
  '531': 'account_restriction',
  '532': 'password_expired',
  '533': 'account_disabled',
  '568': 'account_restriction',
  '701': 'account_expired',
  '773': 'password_must_change',
  '775': 'account_locked',
};
const LDAP_RESULT: Record<number, string> = {
  8: 'strong_auth_required',
  13: 'confidentiality_required',
  32: 'no_such_object',
  34: 'invalid_dn',
  48: 'inappropriate_auth',
  49: 'invalid_credentials',
  50: 'insufficient_access',
  51: 'unavailable',
  52: 'unavailable',
  53: 'unwilling',
  80: 'unavailable',
};
const NET_ERRORS: Record<string, [LdapError['code'], string]> = {
  ENOTFOUND: ['connect', 'dns'],
  EAI_AGAIN: ['connect', 'dns'],
  ECONNREFUSED: ['connect', 'refused'],
  ETIMEDOUT: ['connect', 'timeout'],
  EHOSTUNREACH: ['connect', 'unreachable'],
  ENETUNREACH: ['connect', 'unreachable'],
  ECONNRESET: ['connect', 'reset'],
  ERR_TLS_CERT_ALTNAME_INVALID: ['tls', 'cert_name'],
  CERT_HAS_EXPIRED: ['tls', 'cert_expired'],
  CERT_NOT_YET_VALID: ['tls', 'cert_not_yet_valid'],
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: ['tls', 'cert_untrusted'],
  UNABLE_TO_GET_ISSUER_CERT: ['tls', 'cert_untrusted'],
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: ['tls', 'cert_untrusted'],
  SELF_SIGNED_CERT_IN_CHAIN: ['tls', 'cert_untrusted'],
  DEPTH_ZERO_SELF_SIGNED_CERT: ['tls', 'cert_untrusted'],
};
export const isTlsReason = (reason: string) =>
  Object.values(NET_ERRORS).some(([c, r]) => c === 'tls' && r === reason) ||
  reason === 'tls_handshake';

/** Ошибка библиотеки или сети → понятная причина; текст сервера сохраняется в подробностях (секретов в нём нет). */
export function classifyLdapError(e: unknown, fallback: LdapError['code']): LdapError {
  if (e instanceof LdapError) return e;
  const err = e as { code?: unknown; message?: string; cause?: { code?: string } };
  const detail = String(err?.message ?? e).slice(0, 400);
  const sys = typeof err?.code === 'string' ? err.code : (err?.cause?.code ?? '');
  if (sys && NET_ERRORS[sys]) {
    const [code, reason] = NET_ERRORS[sys]!;
    return new LdapError(detail, code, reason, detail);
  }
  if (typeof err?.code === 'number') {
    const ad = /\bdata ([0-9a-f]{3})\b/i.exec(detail)?.[1]?.toLowerCase();
    const reason =
      (err.code === 49 && ad && AD_BIND_DATA[ad]) || LDAP_RESULT[err.code] || 'ldap_error';
    return new LdapError(detail, fallback, reason, detail);
  }
  if (/timed? ?out/i.test(detail)) return new LdapError(detail, 'connect', 'timeout', detail);
  if (/certificate|ssl|tls|self.signed/i.test(detail))
    return new LdapError(detail, 'tls', 'tls_handshake', detail);
  const reason =
    fallback === 'connect' ? 'unavailable' : fallback === 'tls' ? 'tls_handshake' : 'ldap_error';
  return new LdapError(detail, fallback, reason, detail);
}

/** Адрес сервера: проверка и нормализация (те же правила, что в форме). */
export function ldapUrlOf(cfg: Pick<LdapConfig, 'url' | 'startTls' | 'allowPlaintext'>) {
  const parsed = normalizeLdapUrl(cfg.url);
  if (!parsed.ok)
    throw new LdapError('Invalid directory address', 'config', `url_${parsed.problem}`);
  const transport = ldapTransportProblem(parsed.value, cfg.startTls, cfg.allowPlaintext);
  if (transport) throw new LdapError('Insecure directory transport', 'tls', transport);
  return parsed.value;
}

/** Учётная запись для входа сервисом: DN, user@domain, DOMAIN\\user или короткое имя с доменом из Base DN. */
export function serviceAccount(cfg: Pick<LdapConfig, 'bindDn' | 'baseDn'>): string {
  const a = bindAccount(cfg.bindDn, cfg.baseDn);
  if (!a.ok) throw new LdapError('Invalid service account', 'config', `bind_${a.problem}`);
  return a.value;
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
  /** Справочные поля карточки; пустая строка — в каталоге значения нет. */
  profile: { title: string; department: string; phone: string };
}

/** Имена атрибутов карточки (стандартные имена AD и inetOrgPerson, если не заданы). */
export const profileAttrs = (cfg: LdapConfig) => ({
  title: cfg.titleAttr ?? 'title',
  department: cfg.departmentAttr ?? 'department',
  phone: cfg.phoneAttr ?? 'telephoneNumber',
});

/** Значение атрибута без учёта регистра имени: каталоги возвращают имена по-разному. */
const pick = (e: Record<string, unknown>, name: string): unknown => {
  const k = Object.keys(e).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : e[k];
};

const str = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''));
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)) : v === undefined || v === null ? [] : [String(v)];

/**
 * Параметры TLS: загруженные центры и, если администратор доверил сертификат по отпечатку, сам этот сертификат;
 * для него не требуется совпадение имени — принимается ровно этот сертификат.
 */
export function ldapTlsOptions(cfg: LdapConfig): tls.ConnectionOptions {
  const ca = [cfg.caPem, cfg.pinnedPem].filter((x): x is string => !!x);
  return {
    ...(ca.length ? { ca } : {}),
    rejectUnauthorized: !cfg.insecureTls,
    ...(cfg.pinnedFingerprint
      ? {
          checkServerIdentity: (host: string, cert: tls.PeerCertificate) =>
            cert.fingerprint256 === cfg.pinnedFingerprint
              ? undefined
              : tls.checkServerIdentity(host, cert),
        }
      : {}),
  };
}

export function makeClient(cfg: LdapConfig): Client {
  const url = ldapUrlOf(cfg);
  const tlsOptions = ldapTlsOptions(cfg);
  // tlsOptions у ldapts включают TLS и для ldap://: задаём их только для ldaps:// (для StartTLS они передаются отдельно)
  const secure = url.secure;
  return new Client({
    url: url.url,
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
    if (cfg.startTls && !ldapUrlOf(cfg).secure) {
      try {
        await client.startTLS(ldapTlsOptions(cfg));
      } catch (e) {
        const c = classifyLdapError(e, 'tls');
        throw new LdapError(
          `StartTLS failed: ${c.detail}`,
          'tls',
          c.code === 'tls' ? c.reason : 'starttls_failed',
          c.detail,
        );
      }
    }
    return await fn(client);
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

export async function serviceBind(c: Client, cfg: LdapConfig, bindPassword: string): Promise<void> {
  const account = serviceAccount(cfg);
  if (!account) return; // анонимный поиск, если каталог его разрешает
  // пустой пароль каталог принял бы как анонимный вход: служебная запись «вошла» бы, ничего не проверив
  if (!bindPassword) throw new LdapError('Service password is not set', 'bind', 'password_missing');
  try {
    await c.bind(account, bindPassword);
  } catch (e) {
    const c2 = classifyLdapError(e, 'bind');
    if (c2.code === 'connect' || c2.code === 'tls') throw c2;
    throw new LdapError(`Service bind failed: ${c2.detail}`, 'bind', c2.reason, c2.detail);
  }
}

async function findUser(
  c: Client,
  cfg: LdapConfig,
  username: string,
): Promise<DirectoryUser | null> {
  // имена атрибутов в нижнем регистре: каталоги сравнивают их без учёта регистра, а некоторые реализации — только так
  const pa = profileAttrs(cfg);
  const attrs = [
    'dn',
    cfg.emailAttr,
    cfg.nameAttr,
    'memberOf',
    'userAccountControl',
    ...Object.values(pa).filter(Boolean),
  ].map((a) => a.toLowerCase());
  let res;
  try {
    res = await c.search(cfg.baseDn, {
      scope: 'sub',
      filter: buildUserFilter(cfg.userFilter, loginName(username)),
      attributes: attrs,
      // ldapts hides SizeLimitExceeded with a positive client limit; authoritative lookups must surface it.
      sizeLimit: 0,
    });
  } catch (e) {
    if (e instanceof LdapError) throw e;
    const c2 = classifyLdapError(e, 'search');
    throw new LdapError(`Search failed: ${c2.detail}`, c2.code, c2.reason, c2.detail);
  }
  if (res.searchReferences.length)
    throw new LdapError('User search has unresolved referrals', 'search');
  if (res.searchEntries.length > 1) throw new LdapError('User search is ambiguous', 'search');
  if (!res.searchEntries.length) return null;
  const e = res.searchEntries[0]!;
  const uac = Number(str(pick(e, 'userAccountControl')) || 0);
  return {
    dn: e.dn,
    email: str(pick(e, cfg.emailAttr)).toLowerCase(),
    name: str(pick(e, cfg.nameAttr)),
    groups: list(pick(e, 'memberOf')),
    disabled: (uac & 2) === 2,
    profile: {
      title: pa.title ? str(pick(e, pa.title)).trim() : '',
      department: pa.department ? str(pick(e, pa.department)).trim() : '',
      phone: pa.phone ? str(pick(e, pa.phone)).trim() : '',
    },
  };
}

/** Группы пользователя: атрибут memberOf или поиск групп, где он перечислен участником. */
async function groupsOf(c: Client, cfg: LdapConfig, user: DirectoryUser): Promise<string[]> {
  const needed = cfg.groups.length > 0 || cfg.access === 'groups';
  if (cfg.directoryType === 'ad' && needed) {
    // Active Directory: группы с учётом вложенности одним запросом; при отказе — прямые группы из memberOf
    try {
      const res = await c.search(cfg.baseDn, {
        scope: 'sub',
        filter: `(&(objectClass=group)(member:${IN_CHAIN}:=${escapeFilter(user.dn)}))`,
        attributes: ['dn'],
        sizeLimit: 0,
        paged: { pageSize: 500 },
      });
      return [...new Set([...user.groups, ...res.searchEntries.map((e) => e.dn)])];
    } catch {
      /* каталог не поддерживает правило — остаются прямые группы */
    }
  }
  if (user.groups.length || !needed) return user.groups;
  try {
    const dn = escapeFilter(user.dn);
    const res = await c.search(cfg.baseDn, {
      scope: 'sub',
      filter: `(|(member=${dn})(uniqueMember=${dn}))`,
      attributes: ['dn'],
      sizeLimit: 0,
    });
    if (res.searchReferences.length || res.searchEntries.length > 500)
      throw new LdapError('Group search is incomplete or exceeds the supported limit', 'search');
    return res.searchEntries.map((e) => e.dn);
  } catch (e) {
    // An incomplete group search must not remove existing memberships during synchronization.
    throw new LdapError(`Group search failed: ${(e as Error).message}`, 'search');
  }
}

const norm = (dn: string) => dn.toLowerCase().replace(/\s*,\s*/g, ',');

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
 * Сведения каталога из RootDSE: Base DN домена (defaultNamingContext) и имя контроллера. Служат автоматическому
 * заполнению: администратору не нужно вычислять «DC=…,DC=…» вручную.
 */
export async function ldapRootDse(
  cfg: LdapConfig,
  bindPassword: string,
): Promise<{ baseDn: string; rootDn: string; host: string; isAd: boolean }> {
  return withClient(cfg, async (c) => {
    await serviceBind(c, cfg, bindPassword);
    let entry: Record<string, unknown> | undefined;
    try {
      entry = (
        await c.search('', {
          scope: 'base',
          filter: '(objectClass=*)',
          // в нижнем регистре, как в findUser: часть каталогов иначе не возвращает значения
          attributes: [
            'defaultnamingcontext',
            'rootdomainnamingcontext',
            'dnshostname',
            'namingcontexts',
            'supportedcapabilities',
          ],
        })
      ).searchEntries[0];
    } catch (e) {
      throw classifyLdapError(e, 'search');
    }
    const first = (k: string) => str(pick(entry ?? {}, k)).trim();
    const contexts = list(pick(entry ?? {}, 'namingContexts'));
    return {
      baseDn:
        first('defaultNamingContext') || contexts.find((x) => /^dc=/i.test(x)) || contexts[0] || '',
      rootDn: first('rootDomainNamingContext'),
      host: first('dnsHostName'),
      // признак Active Directory: объявленная возможность LDAP_CAP_ACTIVE_DIRECTORY_OID
      isAd:
        list(pick(entry ?? {}, 'supportedCapabilities')).includes('1.2.840.113556.1.4.800') ||
        !!first('defaultNamingContext'),
    };
  });
}

export type LoginCheck =
  | { ok: true; user: DirectoryUser; allowed: boolean }
  | { ok: false; reason: string; detail?: string; user?: DirectoryUser };

/**
 * Проверка входа сотрудника для администратора: поиск, состояние учётной записи, вход паролем самого сотрудника и
 * правило «кто может входить». Учётная запись в Arklock не создаётся, сеанс не открывается, пароль не сохраняется.
 */
export async function ldapCheckLogin(
  cfg: LdapConfig,
  bindPassword: string,
  username: string,
  password: string,
): Promise<LoginCheck> {
  if (!password) return { ok: false, reason: 'password_missing' };
  let found: DirectoryUser | null;
  try {
    found = await withClient(cfg, async (c) => {
      await serviceBind(c, cfg, bindPassword);
      const u = await findUser(c, cfg, username);
      return u ? { ...u, groups: await groupsOf(c, cfg, u) } : null;
    });
  } catch (e) {
    const c = classifyLdapError(e, 'search');
    if (c.message.includes('ambiguous')) return { ok: false, reason: 'ambiguous_user' };
    return {
      ok: false,
      reason: c.code === 'bind' ? `service_${c.reason}` : c.reason,
      detail: c.detail,
    };
  }
  if (!found) return { ok: false, reason: 'user_not_found' };
  if (found.disabled) return { ok: false, reason: 'account_disabled', user: found };
  try {
    await withClient(cfg, async (c) => {
      await c.bind(found!.dn, password);
    });
  } catch (e) {
    const c = classifyLdapError(e, 'bind');
    return { ok: false, reason: c.reason, detail: c.detail, user: found };
  }
  if (!found.email) return { ok: false, reason: 'no_email', user: found };
  return { ok: true, user: found, allowed: accessAllowed(cfg, found.groups) };
}

/** Bounded administrative browsing; caller chooses a base/OU within the configured directory. */
export async function ldapBrowse(
  cfg: LdapConfig,
  bindPassword: string,
  query: {
    kind: 'users' | 'groups' | 'ous';
    baseDn?: string;
    q?: string;
    limit: number;
    /** Сколько записей пропустить (постранично, не дальше 500-й записи). */
    offset?: number;
    /** Только действующие учётные записи людей (для Active Directory — без компьютеров и отключённых). */
    activeOnly?: boolean;
  },
): Promise<{
  entries: { dn: string; name: string; email: string; disabled: boolean }[];
  truncated: boolean;
}> {
  const base = query.baseDn || cfg.baseDn;
  const offset = Math.min(query.offset ?? 0, 500);
  // Escaped commas belong to an RDN value and cannot forge the configured ancestor DN.
  const parts = (dn: string) =>
    dn.match(/(?:\\.|[^,])+/g)?.map((rdn) => rdn.trim().toLowerCase()) ?? [];
  const parent = parts(cfg.baseDn);
  const requested = parts(base);
  if (
    requested.length < parent.length ||
    !parent.every((rdn, i) => rdn === requested[requested.length - parent.length + i])
  )
    throw new LdapError('Browse base must be within the configured Base DN', 'config');
  const ad = cfg.directoryType === 'ad';
  const objectFilter =
    query.kind === 'users'
      ? ad && query.activeOnly !== false
        ? '(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))'
        : ad
          ? '(&(objectCategory=person)(objectClass=user))'
          : '(objectClass=person)'
      : query.kind === 'groups'
        ? '(|(objectClass=group)(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))'
        : '(objectClass=organizationalUnit)';
  const term = escapeFilter(query.q ?? '');
  const filter = term
    ? `(&${objectFilter}(|(cn=*${term}*)(ou=*${term}*)(mail=*${term}*)(uid=*${term}*)${ad ? `(sAMAccountName=*${term}*)(displayName=*${term}*)(userPrincipalName=*${term}*)` : ''}))`
    : objectFilter;
  return withClient(cfg, async (c) => {
    await serviceBind(c, cfg, bindPassword);
    try {
      const result = await c.search(base, {
        scope: 'sub',
        filter,
        // как в findUser: в нижнем регистре, иначе часть каталогов теряет userAccountControl
        // и отключённые учётные записи выглядят активными
        attributes: ['dn', cfg.nameAttr, cfg.emailAttr, 'ou', 'userAccountControl'].map((a) =>
          a.toLowerCase(),
        ),
        sizeLimit: Math.min(offset + query.limit + 1, 501),
        paged: false,
      });
      return {
        entries: result.searchEntries.slice(offset, offset + query.limit).map((e) => ({
          dn: e.dn,
          name: str(pick(e, cfg.nameAttr)) || str(pick(e, 'ou')),
          email: str(pick(e, cfg.emailAttr)),
          disabled: (Number(str(pick(e, 'userAccountControl')) || 0) & 2) === 2,
        })),
        truncated: result.searchEntries.length > offset + query.limit,
      };
    } catch (e) {
      throw classifyLdapError(e, 'search');
    }
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
