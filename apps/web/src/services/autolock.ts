/**
 * Блокировка после бездействия: через сколько минут без активности ключи стираются и нужен мастер-пароль.
 * Значение — предпочтение браузера (не секрет и не пароль), поэтому хранится в localStorage этой вкладки-профиля.
 */
export const AUTO_LOCK_OPTIONS = [30, 60, 240, 480, 1440] as const;
export type AutoLockMinutes = (typeof AUTO_LOCK_OPTIONS)[number];
/** По умолчанию — 8 часов: рабочий день без повторного ввода мастер-пароля. */
export const DEFAULT_AUTO_LOCK_MINUTES: AutoLockMinutes = 480;

const KEY = 'arklock.autoLock';

export function isAutoLockMinutes(value: unknown): value is AutoLockMinutes {
  return (AUTO_LOCK_OPTIONS as readonly unknown[]).includes(value);
}

/**
 * Истёк ли срок бездействия. Пока идёт длительная операция с ключами (busy), срок не истекает:
 * прерывать передачу файла или ротацию ключей посреди работы нельзя.
 */
export function idleExpired(
  lastActivity: number,
  now: number,
  minutes: AutoLockMinutes,
  busy: boolean,
): boolean {
  if (busy) return false;
  return now - lastActivity >= minutes * 60_000;
}

export function autoLockMinutes(): AutoLockMinutes {
  try {
    const stored = Number(localStorage.getItem(KEY));
    if (isAutoLockMinutes(stored)) return stored;
  } catch {
    /* хранилище недоступно — действует значение по умолчанию */
  }
  return DEFAULT_AUTO_LOCK_MINUTES;
}

export function setAutoLockMinutes(value: AutoLockMinutes): void {
  try {
    localStorage.setItem(KEY, String(value));
  } catch {
    /* не критично: выбор действует до перезагрузки */
  }
}
