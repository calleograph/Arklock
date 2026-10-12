/** Сопоставление адреса записи с адресом вкладки. Заполнение разрешено только при совпадении узла. */

const hostOf = (url: string): string | null => {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

export type Match = 'exact' | 'subdomain' | 'none';

/**
 * exact — тот же узел (без www); subdomain — вкладка является поддоменом узла записи (запись для example.com
 * подходит для login.example.com, но не наоборот и не для evil-example.test).
 */
export function matchUrl(entryUrl: string, tabUrl: string): Match {
  const e = hostOf(entryUrl);
  const t = hostOf(tabUrl);
  if (!e || !t) return 'none';
  if (e === t) return 'exact';
  if (t.endsWith(`.${e}`) && e.includes('.')) return 'subdomain';
  return 'none';
}

/** Передача пароля по открытому http-каналу при записи для https — понижение защиты. */
export function isDowngrade(entryUrl: string, tabUrl: string): boolean {
  try {
    const e = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(entryUrl) ? entryUrl : `https://${entryUrl}`);
    const t = new URL(tabUrl);
    return e.protocol === 'https:' && t.protocol === 'http:';
  } catch {
    return false;
  }
}

export { hostOf };
