/**
 * Привязка внешнего входа (OIDC, SAML) к браузеру. Перед уходом к провайдеру создаётся случайное проверочное значение;
 * серверу передаётся только его хэш, само значение остаётся в sessionStorage этой вкладки и предъявляется при обмене билета.
 * Так чужой браузер не может навязать жертве уже подтверждённый вход.
 */
const KEY = 'arklock.sso.verifier';

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

/** Адрес начала входа с хэшем проверочного значения; значение запоминается во вкладке. */
export async function externalStartUrl(path: string): Promise<string> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  try {
    sessionStorage.setItem(KEY, verifier);
  } catch {
    /* без хранилища вкладки вход всё равно возможен, но обмен билета не пройдёт */
  }
  return `${path}?c=${b64url(hash)}`;
}

/** Проверочное значение читается один раз и стирается. */
export function takeVerifier(): string | undefined {
  try {
    const v = sessionStorage.getItem(KEY) ?? undefined;
    sessionStorage.removeItem(KEY);
    return v;
  } catch {
    return undefined;
  }
}
