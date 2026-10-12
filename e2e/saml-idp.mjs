import 'reflect-metadata';
// Учебный провайдер идентификации SAML для проверок: формирует и подписывает ответы так же, как корпоративные IdP.
// Используется тестами API и сценарием в браузере; в продукт не входит.
import { createHash, randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';
import * as x509 from '@peculiar/x509';

const ALG = {
  rsa256: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  rsa1: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  sha256: 'http://www.w3.org/2001/04/xmlenc#sha256',
  sha1: 'http://www.w3.org/2000/09/xmldsig#sha1',
};
const EXC = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENV = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

const esc = (s) =>
  String(s).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c],
  );
const iso = (ms) => new Date(ms).toISOString();
/** PEM-оболочка вокруг base64 (64 знака в строке). */
const pem = (label, b64) =>
  `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
const id = () => '_' + randomBytes(16).toString('hex');

/** Пара ключей и самоподписанный сертификат подписи провайдера. */
export async function createIdp(
  entityId,
  { validDays = 365, notBeforeDays = 0, bits = 2048 } = {},
) {
  const alg = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    publicExponent: new Uint8Array([1, 0, 1]),
    modulusLength: bits,
  };
  const keys = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(8).toString('hex'),
    name: 'CN=Test IdP',
    notBefore: new Date(now - notBeforeDays * 86_400_000 - 60_000),
    notAfter: new Date(now + validDays * 86_400_000),
    signingAlgorithm: alg,
    keys,
  });
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString(
    'base64',
  );
  return {
    entityId,
    certPem: cert.toString('pem') + '\n',
    keyPem: pem('PRIVATE KEY', pkcs8),
  };
}

function sign(xml, refId, idp, { sha1 = false, afterIssuerOf }) {
  const sig = new SignedXml({
    privateKey: idp.keyPem,
    publicCert: idp.certPem,
    signatureAlgorithm: sha1 ? ALG.rsa1 : ALG.rsa256,
    canonicalizationAlgorithm: EXC,
  });
  sig.addReference({
    xpath: `//*[@ID='${refId}']`,
    transforms: [ENV, EXC],
    digestAlgorithm: sha1 ? ALG.sha1 : ALG.sha256,
  });
  sig.computeSignature(xml, {
    location: {
      reference: `//*[@ID='${afterIssuerOf}']/*[local-name(.)='Issuer']`,
      action: 'after',
    },
  });
  return sig.getSignedXml();
}

/**
 * Ответ провайдера. Параметры позволяют воспроизводить и ошибки: чужая подпись, истёкшее утверждение,
 * другая аудитория, подмена после подписания, отсутствие подписи, SHA-1.
 */
export function buildResponse(o) {
  const now = o.now ?? Date.now();
  const respId = id();
  const asrId = o.assertionId ?? id();
  const issuer = o.issuer ?? o.idp.entityId;
  const life = (o.lifetimeSec ?? 300) * 1000;
  const attrs = Object.entries(o.attributes ?? {})
    .map(
      ([name, v]) =>
        `<saml:Attribute Name="${esc(name)}">${[]
          .concat(v)
          .map((x) => `<saml:AttributeValue xsi:type="xs:string">${esc(x)}</saml:AttributeValue>`)
          .join('')}</saml:Attribute>`,
    )
    .join('');
  const irt = o.inResponseTo ? ` InResponseTo="${esc(o.inResponseTo)}"` : '';
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema" ID="${asrId}" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${esc(o.nameIdFormat ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified')}">${esc(o.nameId)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(now + life)}" Recipient="${esc(o.recipient ?? o.acs)}"${irt}/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(o.notBefore ?? now - 60_000)}" NotOnOrAfter="${iso(o.notOnOrAfter ?? now + life)}"><saml:AudienceRestriction><saml:Audience>${esc(o.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${id()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    (attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : '') +
    `</saml:Assertion>`;
  const status = o.status ?? 'urn:oasis:names:tc:SAML:2.0:status:Success';
  let xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${respId}" Version="2.0" IssueInstant="${iso(now)}" Destination="${esc(o.acs)}"${irt}>` +
    `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${status}"/></samlp:Status>` +
    assertion +
    `</samlp:Response>`;
  const signWith = o.signingIdp ?? o.idp;
  if (o.signAssertion !== false)
    xml = sign(xml, asrId, signWith, { sha1: o.sha1, afterIssuerOf: asrId });
  if (o.signResponse) xml = sign(xml, respId, signWith, { sha1: o.sha1, afterIssuerOf: respId });
  if (o.tamper) xml = o.tamper(xml);
  return xml;
}

/** HTML-страница, которая сама отправляет ответ на ACS (как делают провайдеры). */
export function autoPost(acs, xml, relayState) {
  const b64 = Buffer.from(xml, 'utf8').toString('base64');
  return (
    `<!doctype html><html><body onload="document.forms[0].submit()"><form method="post" action="${esc(acs)}">` +
    `<input type="hidden" name="SAMLResponse" value="${b64}"/>` +
    (relayState ? `<input type="hidden" name="RelayState" value="${esc(relayState)}"/>` : '') +
    `<noscript><button>Continue</button></noscript></form></body></html>`
  );
}

/** Разбор запроса на вход (HTTP-Redirect): идентификатор запроса, адрес ACS, издатель. */
export function parseAuthnRequest(samlRequest) {
  const xml = inflateRawSync(Buffer.from(samlRequest, 'base64')).toString('utf8');
  const get = (re) => re.exec(xml)?.[1] ?? '';
  return {
    xml,
    id: get(/\bID="([^"]+)"/),
    acs: get(/AssertionConsumerServiceURL="([^"]+)"/),
    issuer: get(/<(?:\w+:)?Issuer[^>]*>([^<]+)</),
    signed: /Signature=/.test(samlRequest) || /<(?:\w+:)?Signature\b/.test(xml),
  };
}

/** Запрос выхода от провайдера (подписывается внутри документа — привязка HTTP-POST). */
export function buildLogoutRequest({
  idp,
  destination,
  audience,
  nameId,
  signed = true,
  signingIdp,
}) {
  const rid = id();
  let xml =
    `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${rid}" Version="2.0" IssueInstant="${iso(Date.now())}" Destination="${esc(destination)}">` +
    `<saml:Issuer>${esc(idp.entityId)}</saml:Issuer>` +
    `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${esc(nameId)}</saml:NameID>` +
    `</samlp:LogoutRequest>`;
  void audience;
  if (signed) xml = sign(xml, rid, signingIdp ?? idp, { afterIssuerOf: rid });
  return xml;
}

export const fingerprint = (pem) => createHash('sha256').update(pem).digest('hex');

/** Метаданные провайдера (для проверки импорта). */
export function idpMetadata(idp, { sso, slo, certs } = {}) {
  const body = (pem) => pem.replace(/-----[A-Z ]+-----|\s+/g, '');
  return (
    `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${esc(idp.entityId)}">` +
    `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
    (certs ?? [idp.certPem])
      .map(
        (c) =>
          `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${body(c)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`,
      )
      .join('') +
    (slo
      ? `<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${esc(slo)}"/>`
      : '') +
    `<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>` +
    `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${esc(sso)}"/>` +
    `</md:IDPSSODescriptor></md:EntityDescriptor>`
  );
}

/**
 * Шифрует подписанное утверждение открытым ключом поставщика услуг (EncryptedAssertion),
 * как это делают провайдеры, настроенные на шифрование.
 */
export async function encryptAssertion(xml, spCertPem) {
  const xmlenc = await import('xml-encryption');
  const m = /<saml:Assertion\b[\s\S]*<\/saml:Assertion>/.exec(xml);
  if (!m) throw new Error('no assertion');
  const pub = new (await import('node:crypto')).X509Certificate(spCertPem).publicKey.export({
    type: 'spki',
    format: 'pem',
  });
  const enc = await new Promise((resolve, reject) =>
    xmlenc.encrypt(
      m[0],
      {
        rsa_pub: pub,
        pem: spCertPem,
        encryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#aes256-cbc',
        keyEncryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
        disallowEncryptionWithInsecureAlgorithm: true,
      },
      (e, r) => (e ? reject(e) : resolve(r)),
    ),
  );
  return xml.replace(m[0], `<saml:EncryptedAssertion>${enc}</saml:EncryptedAssertion>`);
}
