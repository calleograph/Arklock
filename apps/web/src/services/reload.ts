import {
  concat,
  decrypt,
  encrypt,
  fromBase64Url,
  generateSalt,
  hkdf,
  toBase64Url,
} from '@arklock/crypto';
import { api, ApiError, loadToken, setToken } from './api';

/**
 * Разблокировка после обновления страницы. Закрытые ключи шифруются случайным ключом, полученным из доли сервера
 * (хранится в строке сеанса); шифртекст лежит только в sessionStorage этой вкладки. После F5 вкладка берёт долю
 * по действующему токену и открывает ключи без мастер-пароля. Ни сервер, ни вкладка по отдельности ключи не открывают.
 * Ручная блокировка и выход стирают долю на сервере; истёкший или отозванный сеанс её не выдаёт.
 */
const STORE = 'arklock.reload';
const aad = (userId: string) => `reload:${userId}`;

interface Blob {
  v: 1;
  userId: string;
  salt: string;
  sealed: string;
}
export interface PrivateKeys {
  privateKey: Uint8Array;
  signPrivateKey: Uint8Array;
}

function read(): Blob | null {
  try {
    const raw = sessionStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Blob) : null;
  } catch {
    return null;
  }
}
function write(blob: Blob | null): void {
  try {
    if (blob) sessionStorage.setItem(STORE, JSON.stringify(blob));
    else sessionStorage.removeItem(STORE);
  } catch {
    /* хранилище вкладки недоступно — после F5 понадобится мастер-пароль */
  }
}

/** Сохраняет ключи для этой вкладки. Ошибка (политика выключена, сеть) не мешает работе: просто F5 спросит пароль. */
export async function remember(userId: string, keys: PrivateKeys): Promise<void> {
  try {
    const { share } = await api<{ share: string }>('PUT', '/auth/session/reload-key');
    const salt = generateSalt();
    const key = await hkdf(fromBase64Url(share), salt, 'arklock/v1/reload');
    const len = new Uint8Array([keys.privateKey.length >> 8, keys.privateKey.length & 255]);
    const plain = concat(len, keys.privateKey, keys.signPrivateKey);
    const sealed = await encrypt(key, plain, aad(userId));
    key.fill(0);
    plain.fill(0);
    write({ v: 1, userId, salt: toBase64Url(salt), sealed });
  } catch {
    write(null);
  }
}

/** Ключи после перезагрузки страницы или null, если безопасное восстановление невозможно. */
export async function recall(userId: string): Promise<PrivateKeys | null> {
  const blob = read();
  if (!blob || blob.userId !== userId) return null;
  let share: string;
  try {
    share = (await api<{ share: string }>('GET', '/auth/session/reload-key')).share;
  } catch (e) {
    // сеть или перезапуск сервера: шифртекст сохраняем, следующий F5 попробует снова
    if (!(e instanceof ApiError && e.status !== 0 && e.status < 500)) return null;
    write(null);
    return null;
  }
  try {
    const key = await hkdf(fromBase64Url(share), fromBase64Url(blob.salt), 'arklock/v1/reload');
    const plain = await decrypt(key, blob.sealed, aad(userId));
    key.fill(0);
    const n = (plain[0]! << 8) | plain[1]!;
    const keys = { privateKey: plain.slice(2, 2 + n), signPrivateKey: plain.slice(2 + n) };
    plain.fill(0);
    return keys;
  } catch {
    write(null);
    return null;
  }
}

/** Стирает шифртекст вкладки; при ручной блокировке — и долю на сервере (тогда он бесполезен во всех вкладках). */
export async function forget(server: boolean): Promise<void> {
  write(null);
  if (server && loadToken()) await api('DELETE', '/auth/session/reload-key').catch(() => undefined);
}

// ---- несколько вкладок одного сеанса

type Message =
  | { type: 'need' }
  | { type: 'session'; token: string; blob: Blob }
  | { type: 'lock' }
  | { type: 'logout' };
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('arklock');

/** Новая вкладка без сеанса спрашивает открытые вкладки; ответ — токен и шифртекст, без самих ключей. */
export async function adoptFromOtherTab(timeoutMs = 150): Promise<boolean> {
  if (!channel || loadToken()) return false;
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      channel.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(ok);
    };
    const onMessage = (e: MessageEvent<Message>) => {
      if (e.data?.type !== 'session') return;
      setToken(e.data.token);
      write(e.data.blob);
      done(true);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    channel.addEventListener('message', onMessage);
    channel.postMessage({ type: 'need' } satisfies Message);
  });
}

/** Подписка вкладки: делиться сеансом с новыми вкладками и выполнять блокировку и выход, сделанные в другой вкладке. */
export function listen(handlers: {
  unlocked: () => boolean;
  lock: () => void;
  logout: () => void;
}) {
  channel?.addEventListener('message', (e: MessageEvent<Message>) => {
    const m = e.data;
    if (m?.type === 'need') {
      const token = loadToken();
      const blob = read();
      if (token && blob && handlers.unlocked())
        channel.postMessage({ type: 'session', token, blob } satisfies Message);
    } else if (m?.type === 'lock') handlers.lock();
    else if (m?.type === 'logout') handlers.logout();
  });
}
export const broadcast = (type: 'lock' | 'logout') =>
  channel?.postMessage({ type } satisfies Message);
