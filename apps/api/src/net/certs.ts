import { X509Certificate } from 'node:crypto';

/**
 * Загрузка сертификатов центров сертификации: файл .cer, .crt или .pem, в кодировке PEM или DER (формат определяется
 * по содержимому, расширение — только подсказка). Закрытые ключи и контейнеры с ключом (PKCS#12) отклоняются целиком.
 * Результат — сведения о каждом сертификате, проверка цепочки внутри загруженного набора и нормализованный PEM.
 */

export const CERT_MAX_BYTES = 256 * 1024;
export const CERT_MAX_COUNT = 20;

export type CertProblem =
  'empty' | 'too_large' | 'private_key' | 'not_certificate' | 'too_many' | 'all_expired' | 'not_ca';

export class CertError extends Error {
  constructor(readonly problem: CertProblem) {
    super(problem);
  }
}

export interface CertInfo {
  subject: string;
  issuer: string;
  serial: string;
  validFrom: string;
  validTo: string;
  daysLeft: number;
  fingerprint256: string;
  isCa: boolean;
  selfSigned: boolean;
  /** root — самоподписанный центр, intermediate — промежуточный, leaf — сертификат сервера (не центр). */
  kind: 'root' | 'intermediate' | 'leaf';
  expired: boolean;
  notYetValid: boolean;
  /** Кем подписан в этом наборе: отпечаток издателя или null (издатель не загружен). */
  issuedBy: string | null;
  /** Цепочка от этого сертификата доходит до корневого в загруженном наборе. */
  chainToRoot: boolean;
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const PRIVATE = /PRIVATE KEY|BEGIN PKCS12|BEGIN PGP|BEGIN OPENSSH/i;

/** Тело PKCS#12: внешняя SEQUENCE, версия 3 и данные PKCS#7 — такой файл (.pfx/.p12) содержит закрытый ключ. */
function looksLikePkcs12(der: Buffer): boolean {
  const i = der[1]! & 0x80 ? 2 + (der[1]! & 0x7f) : 2;
  return der[0] === 0x30 && der[i] === 0x02 && der[i + 1] === 0x01 && der[i + 2] === 0x03;
}

function readCerts(data: Buffer): X509Certificate[] {
  if (!data.length || !data.toString('latin1').trim()) throw new CertError('empty');
  if (data.length > CERT_MAX_BYTES) throw new CertError('too_large');
  const text = data.toString('latin1');
  if (PRIVATE.test(text)) throw new CertError('private_key');
  const blocks = text.match(PEM_BLOCK);
  try {
    if (blocks) {
      if (blocks.length > CERT_MAX_COUNT) throw new CertError('too_many');
      return blocks.map((b) => new X509Certificate(b));
    }
    // DER, а также DER в base64 без заголовков (так выгружают некоторые центры)
    const compact = text.replace(/\s+/g, '');
    const der =
      data[0] === 0x30
        ? data
        : /^[A-Za-z0-9+/]+=*$/.test(compact) && compact.length >= 64
          ? Buffer.from(compact, 'base64')
          : null;
    if (!der) throw new CertError('not_certificate');
    if (looksLikePkcs12(der)) throw new CertError('private_key');
    return [new X509Certificate(der)];
  } catch (e) {
    if (e instanceof CertError) throw e;
    throw new CertError('not_certificate');
  }
}

const name = (s: string) => s.replace(/\n/g, ', ').slice(0, 500);

/** Разбор и проверка набора. `requireCa` — для доверенных центров: сертификат сервера (не центр) отклоняется. */
export function parseCertificates(
  data: Buffer,
  opts: { requireCa?: boolean; now?: number } = {},
): { certs: CertInfo[]; pem: string } {
  const now = opts.now ?? Date.now();
  const seen = new Set<string>();
  const certs = readCerts(data).filter(
    (c) => !seen.has(c.fingerprint256) && seen.add(c.fingerprint256),
  );
  const issuerOf = (c: X509Certificate) =>
    certs.find((p) => p !== c && c.checkIssued(p) && c.verify(p.publicKey)) ?? null;
  const info = certs.map((c): CertInfo => {
    const from = Date.parse(c.validFrom);
    const to = Date.parse(c.validTo);
    const selfSigned = c.checkIssued(c) && c.verify(c.publicKey);
    let chainToRoot = selfSigned;
    for (let cur: X509Certificate | null = c, hops = 0; !chainToRoot && cur && hops < 10; hops++) {
      cur = issuerOf(cur);
      if (cur && cur.checkIssued(cur)) chainToRoot = true;
    }
    return {
      subject: name(c.subject),
      issuer: name(c.issuer),
      serial: c.serialNumber,
      validFrom: new Date(from).toISOString(),
      validTo: new Date(to).toISOString(),
      daysLeft: Math.floor((to - now) / 86_400_000),
      fingerprint256: c.fingerprint256,
      isCa: c.ca,
      selfSigned,
      kind: !c.ca ? 'leaf' : selfSigned ? 'root' : 'intermediate',
      expired: to < now,
      notYetValid: from > now,
      issuedBy: issuerOf(c)?.fingerprint256 ?? null,
      chainToRoot,
    };
  });
  if (info.every((c) => c.expired)) throw new CertError('all_expired');
  if (opts.requireCa && !info.some((c) => c.isCa)) throw new CertError('not_ca');
  const pem = certs.map((c) => c.toString().trim()).join('\n') + '\n';
  return { certs: info, pem };
}

/** Тело запроса загрузки: файл (base64, в том числе DER) или вставленный текст PEM. */
export function certUploadBytes(body: { data?: string; pem?: string }): Buffer {
  if (body.data) return Buffer.from(body.data, 'base64');
  return Buffer.from(body.pem ?? '', 'utf8');
}
