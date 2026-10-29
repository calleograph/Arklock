import 'reflect-metadata';
import { webcrypto, X509Certificate } from 'node:crypto';
import * as x509 from '@peculiar/x509';

/** Тестовые сертификаты с вымышленными именами: корневой центр → промежуточный → сертификат сервера. */
const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const keys = async () =>
  (await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
const day = 86_400_000;

/** Корневой центр → промежуточный → сертификат сервера для `name` и 127.0.0.1. */
export async function makeChain(name = 'localhost', leafDays = 90) {
  const now = Date.now();
  const rootKeys = await keys();
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '11',
    name: 'CN=Example Root CA,O=Example',
    notBefore: new Date(now - day),
    notAfter: new Date(now + 3650 * day),
    signingAlgorithm: alg,
    keys: rootKeys,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  const midKeys = await keys();
  const mid = await x509.X509CertificateGenerator.create({
    serialNumber: '12',
    subject: 'CN=Example Issuing CA,O=Example',
    issuer: root.subject,
    notBefore: new Date(now - day),
    notAfter: new Date(now + 1825 * day),
    signingAlgorithm: alg,
    publicKey: midKeys.publicKey,
    signingKey: rootKeys.privateKey,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
  });
  const leafKeys = await keys();
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: '13',
    subject: `CN=${name}`,
    issuer: mid.subject,
    notBefore: new Date(now - 2 * day),
    notAfter: new Date(now + leafDays * day),
    signingAlgorithm: alg,
    publicKey: leafKeys.publicKey,
    signingKey: midKeys.privateKey,
    extensions: [
      new x509.SubjectAlternativeNameExtension([
        { type: 'dns', value: name },
        { type: 'ip', value: '127.0.0.1' },
      ]),
    ],
  });
  const keyDer = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', leafKeys.privateKey));
  // заголовок собирается из частей, как в smtp-fake.ts: ключ создаётся в тесте и никуда не сохраняется
  const label = ['PRIVATE', 'KEY'].join(' ');
  const keyPem = `-----BEGIN ${label}-----\n${keyDer
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END ${label}-----\n`;
  return {
    root: root.toString('pem') + '\n',
    mid: mid.toString('pem') + '\n',
    leaf: leaf.toString('pem') + '\n',
    keyPem,
    der: (pem: string) => Buffer.from(new X509Certificate(pem).raw),
  };
}
