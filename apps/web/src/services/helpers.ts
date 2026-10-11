import { ApiError } from './api';

type T = (key: string) => string;

/** Понятное пользователю сообщение. Технические детали и тексты сервера не показываются. */
export function errorMessage(e: unknown, t: T): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'invalid_credentials':
        return t('auth.invalid');
      case 'too_many_attempts':
        return t('auth.locked');
      case 'registration_closed':
        return t('auth.closed');
      case 'invalid_setup_token':
        return t('auth.badSetupCode');
      case 'setup_disabled':
        return t('auth.setupDisabled');
      case 'already_exists':
        return t('auth.exists');
      case 'version_conflict':
        return t('vault.conflict');
      case 'network_error':
        return t('error.network');
    }
  }
  return t('error.generic');
}

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+?';

function randomInt(max: number): number {
  // Отбрасывание значений «хвоста» — без смещения распределения.
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0]! >= limit);
  return buf[0]! % max;
}

/** Генератор паролей на CSPRNG; гарантирует хотя бы по одному символу каждого класса. */
export function generatePassword(length = 20): string {
  const classes = [LOWER, UPPER, DIGITS, SYMBOLS];
  const all = classes.join('');
  const chars = classes.map((c) => c[randomInt(c.length)]!);
  while (chars.length < length) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
