import {
  concat,
  decrypt,
  DEFAULT_KDF,
  encrypt,
  fromBase64Url,
  generateSalt,
  hkdf,
  toBase64Url,
  type KdfParams,
} from '@arklock/crypto';
import type { UserBundle } from '@arklock/contracts';
import { api, ApiError } from './api';
import { masterKeysFor, unlockWithWrapKey, type UnlockedAccount } from './account';
import { deriveKeys } from './kdf';

/**
 * Быстрая разблокировка PIN-кодом (только для активного сеанса, вход по-прежнему требует мастер-пароль).
 * На устройстве лежит шифртекст ключа обёртки, который открывается ключом из PIN и доли, выдаваемой сервером после верного PIN.
 * Мастер-пароль и PIN нигде не сохраняются; без ответа сервера (пять попыток) шифртекст бесполезен.
 */
interface Blob {
  v: 1;
  deviceId: string;
  salt: string;
  kdf: KdfParams;
  sealed: string;
}

const storeKey = (userId: string) => `arklock.pin.${userId}`;
const aad = (userId: string, deviceId: string) => `pin:${userId}:${deviceId}`;

function read(userId: string): Blob | null {
  try {
    const raw = localStorage.getItem(storeKey(userId));
    return raw ? (JSON.parse(raw) as Blob) : null;
  } catch {
    return null;
  }
}
export const hasPin = (userId: string): boolean => read(userId) !== null;
export function forgetPin(userId: string): void {
  try {
    localStorage.removeItem(storeKey(userId));
  } catch {
    /* хранилище недоступно */
  }
}
export const pinDeviceId = (userId: string): string | null => read(userId)?.deviceId ?? null;

const combine = (pinKey: Uint8Array, share: Uint8Array, salt: Uint8Array) =>
  hkdf(concat(pinKey, share), salt, 'arklock/v1/pin');

/** PIN из 6–12 цифр: короткий PIN держится только на счётчике попыток на сервере. */
export const PIN_PATTERN = /^\d{6,12}$/;

export async function enablePin(
  user: UserBundle,
  password: string,
  pin: string,
  deviceName: string,
): Promise<void> {
  if (!PIN_PATTERN.test(pin)) throw new Error('pin_format');
  const master = await masterKeysFor(user, password);
  const salt = generateSalt();
  let pinKeys: Awaited<ReturnType<typeof deriveKeys>> | null = null;
  try {
    pinKeys = await deriveKeys(pin, salt, `${user.id}:pin`, DEFAULT_KDF);
    const made = await api<{ deviceId: string; share: string }>('POST', '/auth/pin', {
      name: deviceName,
      currentAuthKey: toBase64Url(master.authKey),
      authKey: toBase64Url(pinKeys.authKey),
    });
    const key = await combine(pinKeys.wrapKey, fromBase64Url(made.share), salt);
    const sealed = await encrypt(key, master.wrapKey, aad(user.id, made.deviceId));
    key.fill(0);
    const blob: Blob = {
      v: 1,
      deviceId: made.deviceId,
      salt: toBase64Url(salt),
      kdf: DEFAULT_KDF,
      sealed,
    };
    localStorage.setItem(storeKey(user.id), JSON.stringify(blob));
  } finally {
    master.wrapKey.fill(0);
    master.authKey.fill(0);
    pinKeys?.wrapKey.fill(0);
    pinKeys?.authKey.fill(0);
  }
}

export async function unlockWithPin(user: UserBundle, pin: string): Promise<UnlockedAccount> {
  const blob = read(user.id);
  if (!blob) throw new ApiError(404, 'pin_gone', 'PIN is not set up');
  const salt = fromBase64Url(blob.salt);
  const pinKeys = await deriveKeys(pin, salt, `${user.id}:pin`, blob.kdf);
  try {
    let share: string;
    try {
      share = (
        await api<{ share: string }>('POST', `/auth/pin/${blob.deviceId}/unlock`, {
          authKey: toBase64Url(pinKeys.authKey),
        })
      ).share;
    } catch (e) {
      // сервер удалил устройство или запретил PIN: шифртекст на устройстве больше не нужен
      if (e instanceof ApiError && ['pin_locked', 'pin_gone', 'pin_disabled'].includes(e.code))
        forgetPin(user.id);
      throw e;
    }
    const key = await combine(pinKeys.wrapKey, fromBase64Url(share), salt);
    const wrapKey = await decrypt(key, blob.sealed, aad(user.id, blob.deviceId));
    key.fill(0);
    try {
      return await unlockWithWrapKey(user, wrapKey);
    } finally {
      wrapKey.fill(0);
    }
  } finally {
    pinKeys.wrapKey.fill(0);
    pinKeys.authKey.fill(0);
  }
}

export async function disablePin(userId: string): Promise<void> {
  const id = pinDeviceId(userId);
  forgetPin(userId);
  if (id) await api('DELETE', `/auth/pin/${id}`).catch(() => undefined);
}
