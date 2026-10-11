// Тестовый провайдер OpenID Connect для браузерных тестов: discovery, authorize (сразу «входит» заданного пользователя),
// token (проверяет PKCE и секрет клиента), jwks. Подпись RS256 настоящая.
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { URL, URLSearchParams } from 'node:url';

export async function startIdp({ clientId, clientSecret, user }) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const codes = new Map();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  let issuer = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (o) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(o));
    };
    if (url.pathname === '/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      const code = randomBytes(12).toString('hex');
      codes.set(code, {
        nonce: url.searchParams.get('nonce'),
        challenge: url.searchParams.get('code_challenge'),
      });
      res.statusCode = 302;
      res.setHeader(
        'location',
        `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}`,
      );
      return res.end();
    }
    if (url.pathname === '/token') {
      let data = '';
      req.on('data', (d) => (data += d));
      req.on('end', () => {
        const p = new URLSearchParams(data);
        const rec = codes.get(p.get('code'));
        codes.delete(p.get('code'));
        const ok =
          rec &&
          createHash('sha256')
            .update(p.get('code_verifier') ?? '')
            .digest('base64url') === rec.challenge &&
          p.get('client_secret') === clientSecret &&
          p.get('client_id') === clientId;
        if (!ok) {
          res.statusCode = 400;
          return json({ error: 'invalid_grant' });
        }
        const now = Math.floor(Date.now() / 1000);
        const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
        const body = b64({
          iss: issuer,
          aud: clientId,
          sub: user.sub,
          email: user.email,
          name: user.name,
          email_verified: true,
          iat: now,
          exp: now + 600,
          nonce: rec.nonce,
        });
        const sig = createSign('RSA-SHA256')
          .update(`${head}.${body}`)
          .sign(privateKey)
          .toString('base64url');
        return json({ id_token: `${head}.${body}.${sig}`, token_type: 'Bearer' });
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${server.address().port}`;
  return { issuer, close: () => server.close() };
}
