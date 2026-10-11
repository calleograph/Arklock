import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';

export interface OidcConfig {
  enabled: boolean;
  /** Адрес издателя (issuer), например https://idp.example.com/realms/corp */
  issuer: string;
  clientId: string;
  scopes: string;
  emailClaim: string;
  nameClaim: string;
  autoProvision: boolean;
  /** Название кнопки входа. */
  buttonText: string;
  /** Допустимые домены почты (пусто — любые): защита от чужих учётных записей в общем IdP. */
  allowedDomains: string[];
  /** Разрешить http:// (только стенд). */
  allowInsecure: boolean;
}

export class OidcError extends Error {
  constructor(
    message: string,
    readonly code: 'discovery' | 'token' | 'jwt' | 'claims' | 'config',
  ) {
    super(message);
  }
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const b64 = (b: Buffer) => b.toString('base64url');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64(randomBytes(48));
  return { verifier, challenge: b64(createHash('sha256').update(verifier).digest()) };
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as T;
}

function checkUrl(cfg: OidcConfig, url: string, what: string): void {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(cfg.allowInsecure && u.protocol === 'http:'))
    throw new OidcError(`${what} must use https`, 'config');
}

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}
export const clearOidcCache = () => cache.clear();

export async function discover(cfg: OidcConfig): Promise<Discovery> {
  checkUrl(cfg, cfg.issuer, 'Issuer');
  try {
    const d = await cached(`disc:${cfg.issuer}`, 300_000, () =>
      getJson<Discovery>(`${cfg.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`),
    );
    if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri)
      throw new Error('incomplete');
    // Издатель в документе должен совпадать с настроенным (защита от подмены документа)
    if (d.issuer.replace(/\/$/, '') !== cfg.issuer.replace(/\/$/, ''))
      throw new OidcError(
        'The issuer in the discovery document differs from the configured one',
        'discovery',
      );
    for (const e of [d.authorization_endpoint, d.token_endpoint, d.jwks_uri])
      checkUrl(cfg, e, 'Endpoint');
    return d;
  } catch (e) {
    if (e instanceof OidcError) throw e;
    throw new OidcError(`Discovery failed: ${(e as Error).message}`, 'discovery');
  }
}

export function authorizationUrl(
  cfg: OidcConfig,
  d: Discovery,
  p: { redirectUri: string; state: string; nonce: string; challenge: string },
): string {
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', cfg.scopes);
  u.searchParams.set('state', p.state);
  u.searchParams.set('nonce', p.nonce);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export async function exchangeCode(
  cfg: OidcConfig,
  d: Discovery,
  clientSecret: string,
  p: { code: string; redirectUri: string; verifier: string },
): Promise<{ id_token: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: cfg.clientId,
    code_verifier: p.verifier,
  });
  if (clientSecret) body.set('client_secret', clientSecret);
  try {
    const r = await getJson<{ id_token?: string }>(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    if (!r.id_token) throw new Error('no id_token');
    return { id_token: r.id_token };
  } catch (e) {
    throw new OidcError(`Token exchange failed: ${(e as Error).message}`, 'token');
  }
}

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

const ALGS: Record<string, { digest: string; kty: string; ieee?: boolean }> = {
  RS256: { digest: 'sha256', kty: 'RSA' },
  RS384: { digest: 'sha384', kty: 'RSA' },
  RS512: { digest: 'sha512', kty: 'RSA' },
  ES256: { digest: 'sha256', kty: 'EC', ieee: true },
  ES384: { digest: 'sha384', kty: 'EC', ieee: true },
};

const decode = (s: string) =>
  JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;

/**
 * Проверка id_token: подпись по ключам издателя (только асимметричные алгоритмы; «none» и HMAC отвергаются),
 * издатель, аудитория, срок, nonce. Возвращает утверждения.
 */
export async function verifyIdToken(
  cfg: OidcConfig,
  d: Discovery,
  token: string,
  expectedNonce: string,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new OidcError('Malformed token', 'jwt');
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decode(parts[0]!);
    claims = decode(parts[1]!);
  } catch {
    throw new OidcError('Malformed token', 'jwt');
  }
  const alg = ALGS[String(header.alg)];
  if (!alg) throw new OidcError('Unsupported signature algorithm', 'jwt');

  const loadKeys = () => getJson<{ keys: Jwk[] }>(d.jwks_uri);
  let jwks = await cached(`jwks:${d.jwks_uri}`, 300_000, loadKeys).catch(() => {
    throw new OidcError('Cannot load signing keys', 'jwt');
  });
  const find = (set: { keys: Jwk[] }) =>
    set.keys.find(
      (k) =>
        k.kty === alg.kty && (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig'),
    );
  let jwk = find(jwks);
  if (!jwk) {
    // ключи могли смениться: однократное обновление
    cache.delete(`jwks:${d.jwks_uri}`);
    jwks = await cached(`jwks:${d.jwks_uri}`, 300_000, loadKeys).catch(() => {
      throw new OidcError('Cannot load signing keys', 'jwt');
    });
    jwk = find(jwks);
  }
  if (!jwk) throw new OidcError('No matching signing key', 'jwt');
  const key = createPublicKey({ key: jwk as never, format: 'jwk' });
  const ok = cryptoVerify(
    alg.digest,
    Buffer.from(`${parts[0]}.${parts[1]}`),
    alg.ieee ? { key, dsaEncoding: 'ieee-p1363' } : key,
    Buffer.from(parts[2]!, 'base64url'),
  );
  if (!ok) throw new OidcError('Invalid token signature', 'jwt');

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (String(claims.iss).replace(/\/$/, '') !== cfg.issuer.replace(/\/$/, ''))
    throw new OidcError('Wrong token issuer', 'claims');
  if (!aud.includes(cfg.clientId))
    throw new OidcError('Token was issued for another client', 'claims');
  if (aud.length > 1 && claims.azp !== cfg.clientId)
    throw new OidcError('Wrong authorized party', 'claims');
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= now - 60_000)
    throw new OidcError('Token expired', 'claims');
  const iat = Number(claims.iat);
  if (Number.isFinite(iat) && iat * 1000 > now + 120_000)
    throw new OidcError('Token issued in the future', 'claims');
  if (claims.nonce !== expectedNonce) throw new OidcError('Nonce mismatch', 'claims');
  if (!claims.sub) throw new OidcError('Token has no subject', 'claims');
  return claims;
}

/** Почта и имя из утверждений; непроверенная почта и недопустимый домен отвергаются. */
export function identityFrom(
  cfg: OidcConfig,
  claims: Record<string, unknown>,
): { sub: string; email: string; name: string } {
  const email = String(claims[cfg.emailClaim] ?? '').toLowerCase();
  if (!email || !email.includes('@'))
    throw new OidcError('The identity provider returned no e-mail', 'claims');
  if (claims.email_verified === false)
    throw new OidcError('The e-mail address is not verified', 'claims');
  if (cfg.allowedDomains.length) {
    const domain = email.split('@')[1]!;
    if (!cfg.allowedDomains.map((x) => x.toLowerCase()).includes(domain))
      throw new OidcError('The e-mail domain is not allowed', 'claims');
  }
  return { sub: String(claims.sub), email, name: String(claims[cfg.nameClaim] ?? '') || email };
}
