export interface TestIdp {
  entityId: string;
  certPem: string;
  keyPem: string;
}
export function createIdp(
  entityId: string,
  opts?: { validDays?: number; notBeforeDays?: number; bits?: number },
): Promise<TestIdp>;
export interface ResponseOptions {
  idp: TestIdp;
  acs: string;
  audience: string;
  nameId: string;
  nameIdFormat?: string;
  inResponseTo?: string;
  attributes?: Record<string, string | string[]>;
  now?: number;
  lifetimeSec?: number;
  notBefore?: number;
  notOnOrAfter?: number;
  issuer?: string;
  recipient?: string;
  assertionId?: string;
  status?: string;
  signAssertion?: boolean;
  signResponse?: boolean;
  sha1?: boolean;
  signingIdp?: TestIdp;
  tamper?: (xml: string) => string;
}
export function buildResponse(o: ResponseOptions): string;
export function autoPost(acs: string, xml: string, relayState?: string): string;
export function parseAuthnRequest(samlRequest: string): {
  xml: string;
  id: string;
  acs: string;
  issuer: string;
  signed: boolean;
};
export function buildLogoutRequest(o: {
  idp: TestIdp;
  destination: string;
  audience?: string;
  nameId: string;
  signed?: boolean;
  signingIdp?: TestIdp;
}): string;
export function fingerprint(pem: string): string;
export function idpMetadata(
  idp: TestIdp,
  o: { sso: string; slo?: string; certs?: string[] },
): string;
export function encryptAssertion(xml: string, spCertPem: string): Promise<string>;
