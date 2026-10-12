import { fromBase64Url, toBase64Url } from '@arklock/crypto';
import type { Opened } from '@arklock/client';
import { Api } from '@arklock/client';
import type { UserBundle, VaultInfo } from '@arklock/contracts';

/**
 * Состояние расширения. Сессия и ключи хранилищ лежат в chrome.storage.session: это память браузера, она не пишется
 * на диск и очищается при закрытии браузера; дополнительно сеанс сбрасывается по таймеру (alarms) и кнопкой «Заблокировать».
 * Мастер-пароль и закрытый ключ аккаунта не сохраняются нигде.
 */
interface Unlocked {
  server: string;
  token: string;
  user: UserBundle;
  vaults: { info: VaultInfo; keyB64: string | null; problem?: string }[];
}

const SESSION_KEY = 'unlocked';
export const LOCK_ALARM = 'arklock-autolock';

export const saveUnlocked = async (o: Opened, server: string, token: string): Promise<void> => {
  const data: Unlocked = {
    server,
    token,
    user: o.user,
    vaults: o.vaults.map((v) => ({
      info: v.info,
      keyB64: v.key ? toBase64Url(v.key) : null,
      problem: v.problem,
    })),
  };
  await chrome.storage.session.set({ [SESSION_KEY]: data });
};

export async function loadUnlocked(): Promise<Opened | null> {
  const got = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] as Unlocked | undefined;
  if (!got) return null;
  return {
    api: new Api({ server: got.server, token: got.token }),
    user: got.user,
    keyLogTip: null,
    vaults: got.vaults.map((v) => ({
      info: v.info,
      key: v.keyB64 ? fromBase64Url(v.keyB64) : null,
      problem: v.problem,
    })),
  };
}

export async function lock(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
  await chrome.alarms.clear(LOCK_ALARM);
}

export interface Prefs {
  server: string;
  email: string;
  lockMinutes: number;
}
export async function loadPrefs(): Promise<Prefs> {
  const p = (await chrome.storage.local.get('prefs')).prefs as Partial<Prefs> | undefined;
  return { server: p?.server ?? '', email: p?.email ?? '', lockMinutes: p?.lockMinutes ?? 5 };
}
export const savePrefs = (p: Prefs) => chrome.storage.local.set({ prefs: p });

/** Продлевает таймер автоблокировки при активности. */
export async function touch(minutes: number): Promise<void> {
  await chrome.alarms.create(LOCK_ALARM, { delayInMinutes: Math.max(1, minutes) });
}
