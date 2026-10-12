import 'reflect-metadata';
import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import * as xmlenc from 'xml-encryption';
import xpath from 'xpath';
import * as x509 from '@peculiar/x509';
import { SAML, SamlStatusError, ValidateInResponseTo, type Profile } from '@node-saml/node-saml';
import type { LdapConfig } from './ldap.js';

export const SAML_SETTING_KEY = 'sso.saml';

export const NAMEID_FORMATS = {
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
  email: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  transient: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
} as const;

/** Настройки SAML; закрытый ключ SP хранится отдельно, в запечатанном виде. */
export interface SamlConfig {
  enabled: boolean;
  /** Идентификатор провайдера идентификации (Issuer в его ответах). */
  idpEntityId: string;
  /** Адрес входа (SingleSignOnService, HTTP-Redirect). */
  entryPoint: string;
  /** Адрес выхода (SingleLogoutService) — нужен для ответа на запросы выхода от провайдера. */
  logoutUrl: string;
  /** Сертификаты подписи провайдера (PEM); несколько — на время замены. */
  idpCerts: string[];
  /** Идентификатор Arklock как поставщика услуг; пусто — адрес метаданных. */
  spEntityId: string;
  nameIdFormat: string;
  /** Подписывать запросы на вход закрытым ключом SP. */
  signRequests: boolean;
  /** Открытый сертификат SP (подпись запросов и шифрование утверждений). */
  spCert: string;
  wantAssertionsSigned: boolean;
  wantResponseSigned: boolean;
  /** Принимать подписи SHA-1 (устарело, по умолчанию отклоняются). */
  allowSha1: boolean;
  /** Принимать ответы, начатые на стороне провайдера (без запроса Arklock). */
  allowIdpInitiated: boolean;
  forceAuthn: boolean;
  clockSkewSeconds: number;
  /** Атрибут с уникальным идентификатором; пусто — NameID. */
  idAttr: string;
  emailAttr: string;
  nameAttr: string;
  groupsAttr: string;
  groups: { name: string; circleId: string }[];
  /** Если задано, входить могут только члены хотя бы одной из этих групп. */
  requiredGroups: string[];
  autoProvision: boolean;
  buttonText: string;
  allowedDomains: string[];
  /** Предельная длительность сеанса вошедших через SAML, часов; 0 — как у остальных. */
  maxSessionHours: number;
  /** Разрешить адреса провайдера по http (только изолированная сеть и проверки). */
  allowInsecure: boolean;
}

export interface SamlStored extends SamlConfig {
  spKeyCipher: string;
}

export class SamlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- сертификаты

export interface CertInfo {
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  fingerprint256: string;
  keyType: string;
  keyBits: number | null;
  daysLeft: number;
  /** valid — действует; expiring — истекает в течение 30 дней; остальное — непригоден. */
  state: 'valid' | 'expiring' | 'expired' | 'not_yet_valid' | 'weak_key';
}

const PEM_RE = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;

/** Извлекает сертификаты из текста: PEM-блоки или голый base64 (как в метаданных). */
export function splitPems(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PEM_RE)) out.push(toPem(m[1]!));
  if (!out.length) {
    const raw = text.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/=]{100,}$/.test(raw)) out.push(toPem(raw));
  }
  return out;
}

export function toPem(base64: string, label = 'CERTIFICATE'): string {
  const body = base64.replace(/\s+/g, '');
  return `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END ${label}-----\n`;
}

export function analyzeCert(pem: string, now = Date.now()): CertInfo {
  let c: X509Certificate;
  try {
    c = new X509Certificate(pem);
  } catch {
    throw new SamlError('cert_invalid', 'The certificate cannot be read');
  }
  const from = new Date(c.validFrom).getTime();
  const to = new Date(c.validTo).getTime();
  const key = c.publicKey;
  const d = key.asymmetricKeyDetails;
  const bits = key.asymmetricKeyType === 'rsa' ? (d?.modulusLength ?? null) : null;
  const weak =
    (key.asymmetricKeyType === 'rsa' && (bits ?? 0) < 2048) ||
    (key.asymmetricKeyType === 'ec' &&
      !['prime256v1', 'secp384r1', 'secp521r1'].includes(d?.namedCurve ?? ''));
  const daysLeft = Math.floor((to - now) / 86_400_000);
  const state: CertInfo['state'] =
    now < from
      ? 'not_yet_valid'
      : now >= to
        ? 'expired'
        : weak
          ? 'weak_key'
          : daysLeft < 30
            ? 'expiring'
            : 'valid';
  return {
    subject: c.subject.replace(/\n/g, ', '),
    issuer: c.issuer.replace(/\n/g, ', '),
    notBefore: new Date(from).toISOString(),
    notAfter: new Date(to).toISOString(),
    fingerprint256: c.fingerprint256,
    keyType: key.asymmetricKeyType ?? 'unknown',
    keyBits: bits,
    daysLeft,
    state,
  };
}

/** Сертификаты, которыми сейчас можно проверять подписи (действующие, не слабые). */
export function usableCerts(pems: string[], now = Date.now()): string[] {
  return pems.filter((p) => {
    try {
      const s = analyzeCert(p, now).state;
      return s === 'valid' || s === 'expiring';
    } catch {
      return false;
    }
  });
}

/** Самоподписанный сертификат SP (RSA-2048, 10 лет) и закрытый ключ в PKCS#8 PEM. */
export async function generateSpCertificate(
  commonName: string,
): Promise<{ certPem: string; keyPem: string }> {
  const alg = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    publicExponent: new Uint8Array([1, 0, 1]),
    modulusLength: 2048,
  };
  const keys = (await crypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as CryptoKeyPair;
  const notBefore = new Date(Date.now() - 5 * 60_000);
  const notAfter = new Date(Date.now() + 10 * 365 * 86_400_000);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString('hex'),
    name: `CN=${commonName.replace(/[,=+<>#;"\\]/g, ' ').slice(0, 60)}`,
    notBefore,
    notAfter,
    signingAlgorithm: alg,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
        true,
      ),
    ],
  });
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  const keyPem = toPem(pkcs8.toString('base64'), 'PRIVATE KEY');
  return { certPem: cert.toString('pem') + '\n', keyPem };
}

// ---------------------------------------------------------------- метаданные провайдера

export interface IdpMetadata {
  entityId: string;
  ssoUrl: string;
  logoutUrl: string;
  certs: string[];
  nameIdFormats: string[];
  warnings: string[];
}

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const sel = xpath.useNamespaces({ md: MD, ds: DS });
const select = (expr: string, node: Node): Element[] =>
  (sel(expr, node) as unknown as Element[]) ?? [];
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

export function parseIdpMetadata(xml: string): IdpMetadata {
  if (xml.length > 1_000_000) throw new SamlError('metadata_invalid', 'The metadata is too large');
  const errors: string[] = [];
  const doc = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: (m: string) => errors.push(m),
      fatalError: (m: string) => errors.push(m),
    },
  }).parseFromString(xml, 'text/xml');
  if (errors.length || !doc.documentElement)
    throw new SamlError('metadata_invalid', 'The metadata is not valid XML');
  let root = doc.documentElement as unknown as Element;
  if (root.localName === 'EntitiesDescriptor') {
    const first = select('//md:EntityDescriptor[md:IDPSSODescriptor]', doc)[0];
    if (!first) throw new SamlError('metadata_invalid', 'No identity provider in the metadata');
    root = first;
  }
  if (root.localName !== 'EntityDescriptor')
    throw new SamlError('metadata_invalid', 'The document is not SAML metadata');
  const idp = select('md:IDPSSODescriptor', root)[0];
  if (!idp) throw new SamlError('metadata_invalid', 'No identity provider in the metadata');
  const warnings: string[] = [];
  const attr = (n: Node, name: string) => (n as Element).getAttribute(name) ?? '';
  const sso = select('md:SingleSignOnService', idp).find((e) => attr(e, 'Binding') === REDIRECT);
  if (!sso)
    throw new SamlError('metadata_invalid', 'The provider has no HTTP-Redirect sign-in endpoint');
  const slo = select('md:SingleLogoutService', idp).find((e) => attr(e, 'Binding') === REDIRECT);
  const certs = select(
    "md:KeyDescriptor[not(@use) or @use='signing']/ds:KeyInfo/ds:X509Data/ds:X509Certificate",
    idp,
  )
    .map((e) => toPem(e.textContent ?? ''))
    .filter((p) => {
      try {
        analyzeCert(p);
        return true;
      } catch {
        warnings.push('One certificate in the metadata could not be read');
        return false;
      }
    });
  if (!certs.length)
    throw new SamlError('metadata_invalid', 'No signing certificate in the metadata');
  if (!slo) warnings.push('The provider has no HTTP-Redirect logout endpoint');
  return {
    entityId: attr(root, 'entityID'),
    ssoUrl: attr(sso, 'Location'),
    logoutUrl: slo ? attr(slo, 'Location') : '',
    certs,
    nameIdFormats: select('md:NameIDFormat', idp).map((e) => e.textContent ?? ''),
    warnings,
  };
}

// ---------------------------------------------------------------- адреса поставщика услуг

export interface SpUrls {
  entityId: string;
  acs: string;
  metadata: string;
  slo: string;
}

export function spUrls(publicUrl: string, cfg?: Pick<SamlConfig, 'spEntityId'>): SpUrls {
  const base = publicUrl.replace(/\/$/, '');
  const metadata = `${base}/api/v1/auth/saml/metadata`;
  return {
    entityId: cfg?.spEntityId || metadata,
    acs: `${base}/api/v1/auth/saml/acs`,
    metadata,
    slo: `${base}/api/v1/auth/saml/slo`,
  };
}

// ---------------------------------------------------------------- проверка ответов

/**
 * Подписи SHA-1 (в методе подписи или в дайджесте ссылки) отклоняются, пока администратор явно не разрешил.
 * Проверяются только элементы Signature: дайджест RSA-OAEP в шифровании к подписи отношения не имеет.
 */
export function usesSha1(xml: string): boolean {
  const blocks = xml.match(/<(?:[\w.-]+:)?Signature\b[\s\S]*?<\/(?:[\w.-]+:)?Signature>/g) ?? [];
  return blocks.some((b) =>
    /<(?:[\w.-]+:)?(?:SignatureMethod|DigestMethod)\b[^>]*\bAlgorithm\s*=\s*["'][^"']*sha1["']/i.test(
      b,
    ),
  );
}

/** Расшифровывает EncryptedAssertion для предварительных проверок (подпись внутри зашифрованного утверждения). */
export async function expandEncrypted(xml: string, keyPem: string): Promise<string> {
  if (!keyPem || !/EncryptedAssertion/.test(xml)) return xml;
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const nodes = select(
    "//*[local-name()='EncryptedAssertion']/*[local-name()='EncryptedData']",
    doc,
  );
  let out = xml;
  for (const n of nodes) {
    try {
      const plain = await new Promise<string>((resolve, reject) =>
        xmlenc.decrypt(n.toString(), { key: keyPem }, (e: Error | null, r: string) =>
          e ? reject(e) : resolve(r),
        ),
      );
      out += plain;
    } catch {
      /* ошибку расшифровки сообщит проверка ответа */
    }
  }
  return out;
}

export interface ResponseFacts {
  status: string;
  issuer: string;
}

/** Состояние и издатель ответа: библиотека не отвергает неуспешный статус, если приложено подписанное утверждение. */
export function inspectResponse(xml: string): ResponseFacts {
  const doc = new DOMParser({
    errorHandler: { warning: () => undefined, error: () => undefined, fatalError: () => undefined },
  }).parseFromString(xml, 'text/xml');
  const val = (expr: string): string => {
    const n = select(expr, doc)[0] as unknown as
      { value?: string; textContent?: string } | undefined;
    return (n?.value ?? n?.textContent ?? '').trim();
  };
  return {
    status: val(
      "/*[local-name()='Response']/*[local-name()='Status']/*[local-name()='StatusCode']/@Value",
    ),
    issuer: val("/*[local-name()='Response']/*[local-name()='Issuer']"),
  };
}

const ERROR_MAP: [RegExp, string][] = [
  [/signature|digest|reference/i, 'signature'],
  [/status/i, 'idp_status'],
  [/not yet valid|expired|clock|notonorafter|notbefore|too old|subject confirmation/i, 'expired'],
  [/audience/i, 'audience'],
  [/inresponseto/i, 'in_response_to'],
  [/issuer/i, 'issuer'],
  [/destination|recipient/i, 'destination'],
  [/decrypt/i, 'decrypt'],
  [/no signature|unsigned|wantassertionssigned|must be signed/i, 'unsigned'],
];

/** Приводит ошибки библиотеки и проверок к короткому коду для журнала и интерфейса (без подробностей ответа). */
export function samlErrorCode(e: unknown): string {
  if (e instanceof SamlError) return e.code;
  if (e instanceof SamlStatusError) {
    if (/AuthnFailed/.test(e.xmlStatus)) return 'idp_authn_failed';
    if (/RequestDenied|NoPassive|NoAuthnContext/.test(e.xmlStatus)) return 'idp_denied';
    return 'idp_status';
  }
  const msg = e instanceof Error ? e.message : String(e);
  return ERROR_MAP.find(([re]) => re.test(msg))?.[1] ?? 'invalid_response';
}

// ---------------------------------------------------------------- построение клиента SAML

export function buildSaml(cfg: SamlConfig, spKeyPem: string, urls: SpUrls, now = Date.now()): SAML {
  const certs = usableCerts(cfg.idpCerts, now);
  if (!certs.length) throw new SamlError('idp_cert_expired', 'No valid provider certificate');
  return new SAML({
    callbackUrl: urls.acs,
    issuer: urls.entityId,
    audience: urls.entityId,
    entryPoint: cfg.entryPoint,
    idpIssuer: cfg.idpEntityId,
    idpCert: certs,
    logoutUrl: cfg.logoutUrl || cfg.entryPoint,
    logoutCallbackUrl: urls.slo,
    identifierFormat: cfg.nameIdFormat || null,
    wantAssertionsSigned: cfg.wantAssertionsSigned,
    wantAuthnResponseSigned: cfg.wantResponseSigned,
    acceptedClockSkewMs: cfg.clockSkewSeconds * 1000,
    validateInResponseTo: cfg.allowIdpInitiated
      ? ValidateInResponseTo.ifPresent
      : ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60_000,
    disableRequestedAuthnContext: true,
    forceAuthn: cfg.forceAuthn,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    ...(spKeyPem ? { decryptionPvk: spKeyPem } : {}),
    ...(cfg.signRequests && spKeyPem ? { privateKey: spKeyPem, publicCert: cfg.spCert } : {}),
  });
}

/** Экземпляры клиента переиспользуются: в них живёт кэш идентификаторов выданных запросов. */
export class SamlRuntime {
  private cached: { fingerprint: string; saml: SAML } | null = null;
  private readonly seenAssertions = new Map<string, number>();

  get(cfg: SamlConfig, spKeyPem: string, urls: SpUrls): SAML {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([cfg, urls, spKeyPem ? 1 : 0]))
      .digest('hex');
    // срок действия сертификатов меняет набор пригодных, поэтому в отпечаток входит и он
    const usable = usableCerts(cfg.idpCerts).length;
    const key = `${fingerprint}:${usable}`;
    if (this.cached?.fingerprint !== key)
      this.cached = { fingerprint: key, saml: buildSaml(cfg, spKeyPem, urls) };
    return this.cached.saml;
  }

  reset(): void {
    this.cached = null;
  }

  /** Повторное предъявление того же утверждения отклоняется до истечения срока его хранения. */
  rememberAssertion(id: string, ttlMs = 60 * 60_000, now = Date.now()): boolean {
    for (const [k, until] of this.seenAssertions) if (until <= now) this.seenAssertions.delete(k);
    if (this.seenAssertions.has(id)) return false;
    this.seenAssertions.set(id, now + ttlMs);
    return true;
  }
}

// ---------------------------------------------------------------- профиль → идентичность

export interface SamlIdentity {
  externalId: string;
  email: string;
  name: string;
  groups: string[];
}

const asStrings = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
    .map((x) => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : ''))
    .map((x) => x.trim())
    .filter(Boolean);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const WELL_KNOWN = {
  email: [
    'email',
    'mail',
    'emailaddress',
    'urn:oid:0.9.2342.19200300.100.1.3',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  ],
  name: [
    'displayname',
    'name',
    'cn',
    'urn:oid:2.16.840.1.113730.3.1.241',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  ],
};

export function identityFrom(cfg: SamlConfig, profile: Profile): SamlIdentity {
  const attrs = (profile.attributes ?? {}) as Record<string, unknown>;
  const get = (name: string): string[] => {
    if (!name) return [];
    const k = Object.keys(attrs).find((x) => x.toLowerCase() === name.toLowerCase());
    return k === undefined ? [] : asStrings(attrs[k]);
  };
  const firstOf = (names: string[]) => names.map((n) => get(n)[0]).find(Boolean) ?? '';

  const emailFromNameId =
    profile.nameIDFormat === NAMEID_FORMATS.email && EMAIL_RE.test(profile.nameID ?? '')
      ? profile.nameID
      : '';
  const email = (
    get(cfg.emailAttr)[0] ||
    firstOf(WELL_KNOWN.email) ||
    emailFromNameId ||
    (EMAIL_RE.test(profile.nameID ?? '') ? profile.nameID : '')
  ).toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254)
    throw new SamlError('claims', 'The provider did not send a valid e-mail address');

  const id = cfg.idAttr ? get(cfg.idAttr)[0] : (profile.nameID ?? '').trim();
  if (!id) throw new SamlError('claims', 'The provider did not send a user identifier');

  const name = get(cfg.nameAttr)[0] || firstOf(WELL_KNOWN.name) || email;
  return {
    externalId: `${cfg.idpEntityId}|${id}`,
    email,
    name: name.slice(0, 200),
    groups: cfg.groupsAttr ? get(cfg.groupsAttr) : [],
  };
}

const norm = (s: string) => s.trim().toLowerCase();

/** Входить разрешено, если требуемых групп нет или пользователь состоит хотя бы в одной. */
export function groupAllowed(cfg: Pick<SamlConfig, 'requiredGroups'>, groups: string[]): boolean {
  if (!cfg.requiredGroups.length) return true;
  const have = new Set(groups.map(norm));
  return cfg.requiredGroups.some((g) => have.has(norm(g)));
}

/** Сопоставление групп провайдера кругам в том же виде, что использует синхронизация каталога. */
export function samlGroupMap(cfg: Pick<SamlConfig, 'groups'>): LdapConfig {
  return { groups: cfg.groups.map((g) => ({ dn: g.name, circleId: g.circleId })) } as LdapConfig;
}
