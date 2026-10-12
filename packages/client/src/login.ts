import {
  MIN_KDF,
  deriveMasterKeys,
  fromBase64Url,
  toBase64Url,
  type KdfParams,
} from '@arklock/crypto';
import { ClientError } from './session.js';

export interface LoginOptions {
  fetchFn?: typeof fetch;
  kdfFloor?: KdfParams;
  /** Вызывается, если нужен код второго фактора; возвращает код. */
  askCode?: () => Promise<string | null | undefined>;
}

/**
 * Вход по почте и мастер-паролю (и коду второго фактора). Мастер-пароль превращается в проверочное значение здесь;
 * серверу уходит только оно. Возвращает токен сессии.
 */
export async function passwordLogin(
  server: string,
  email: string,
  password: string,
  opts: LoginOptions = {},
): Promise<string> {
  const f = opts.fetchFn ?? fetch;
  const base = `${server.replace(/\/$/, '')}/api/v1`;
  const params = (await (
    await f(`${base}/auth/params?email=${encodeURIComponent(email)}`)
  ).json()) as { salt: string; kdf: KdfParams; userId: string };
  const keys = await deriveMasterKeys(
    password,
    fromBase64Url(params.salt),
    params.userId,
    params.kdf,
    opts.kdfFloor ?? MIN_KDF,
  );
  const post = async (path: string, body: unknown) => {
    const r = await f(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: r.status,
      json: (await r.json().catch(() => null)) as Record<string, unknown> | null,
    };
  };
  try {
    let res = await post('/auth/login', { email, authKey: toBase64Url(keys.authKey) });
    if (
      res.status === 403 &&
      (res.json?.error as { code?: string } | undefined)?.code === 'external_login_required'
    )
      throw new ClientError(
        'This account signs in through your organization (directory or SSO): create an API token in the web app and use it instead',
      );
    if (res.status !== 200) throw new ClientError('Invalid email or password');
    if (res.json?.mfaRequired) {
      const code = await opts.askCode?.();
      if (!code) throw new ClientError('Two-factor code required');
      res = await post('/auth/mfa/verify', { challenge: res.json.challenge, code });
      if (res.status !== 200) throw new ClientError('The code is invalid or already used');
    }
    return String(res.json?.token);
  } finally {
    keys.authKey.fill(0);
    keys.wrapKey.fill(0);
  }
}
