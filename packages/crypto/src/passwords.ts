import { WORDLIST } from './wordlist.js';

/** Генераторы и оценка паролей. Весь случайный выбор — через CSPRNG с отбрасыванием «хвоста» (без смещения). */

function randomInt(max: number): number {
  if (max <= 0 || max > 0x1_0000_0000) throw new RangeError('max out of range');
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  do globalThis.crypto.getRandomValues(buf);
  while (buf[0]! >= limit);
  return buf[0]! % max;
}

export interface PasswordOptions {
  length?: number;
  lower?: boolean;
  upper?: boolean;
  digits?: boolean;
  symbols?: boolean;
  /** Исключить похожие символы (0/O, 1/l/I). */
  avoidAmbiguous?: boolean;
}

const SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*-_=+?.,:;~',
};
const AMBIGUOUS = /[0O1lI|]/g;

export function generatePassword(o: PasswordOptions = {}): string {
  const length = Math.min(128, Math.max(4, o.length ?? 20));
  const classes = (['lower', 'upper', 'digits', 'symbols'] as const)
    .filter((k) => o[k] ?? true)
    .map((k) => (o.avoidAmbiguous ? SETS[k].replace(AMBIGUOUS, '') : SETS[k]));
  if (!classes.length) throw new RangeError('at least one character class is required');
  const all = classes.join('');
  const chars = classes.map((c) => c[randomInt(c.length)]!);
  while (chars.length < length) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

export interface PassphraseOptions {
  words?: number;
  separator?: string;
  capitalize?: boolean;
  appendNumber?: boolean;
}

export function generatePassphrase(o: PassphraseOptions = {}): string {
  const n = Math.min(12, Math.max(3, o.words ?? 5));
  const words = Array.from({ length: n }, () => {
    const w = WORDLIST[randomInt(WORDLIST.length)]!;
    return o.capitalize ? w[0]!.toUpperCase() + w.slice(1) : w;
  });
  const phrase = words.join(o.separator ?? '-');
  return o.appendNumber ? `${phrase}${o.separator ?? '-'}${randomInt(100)}` : phrase;
}

/** Энтропия случайной парольной фразы из списка (бит). */
export const passphraseEntropyBits = (words: number): number => words * Math.log2(WORDLIST.length);

export interface Strength {
  /** Оценка энтропии, бит. */
  bits: number;
  /** 0 — очень слабый … 4 — сильный. */
  score: 0 | 1 | 2 | 3 | 4;
  issues: ('short' | 'single-class' | 'common' | 'sequence' | 'repeat' | 'personal')[];
}

const COMMON = new Set(
  [
    'password',
    'passw0rd',
    'qwerty',
    'qwertyuiop',
    '123456',
    '12345678',
    '123456789',
    '1234567890',
    'letmein',
    'welcome',
    'admin',
    'administrator',
    'iloveyou',
    'monkey',
    'dragon',
    'football',
    'abc123',
    'login',
    'princess',
    'sunshine',
    'master',
    'hello',
    'freedom',
    'whatever',
    'trustno1',
    '111111',
    '000000',
    'qazwsx',
    'zaq1zaq1',
    'йцукен',
  ].map((s) => s.toLowerCase()),
);

/**
 * Эвристическая оценка стойкости (без внешних словарей). Не заменяет проверку по базам утечек.
 * `login` — логин записи: его вхождение в пароль (или части почты до «@», от 3 символов) почти не добавляет стойкости.
 */
export function estimateStrength(pw: string, login = ''): Strength {
  const issues: Strength['issues'] = [];
  if (!pw) return { bits: 0, score: 0, issues: ['short'] };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  if (/[Ѐ-ӿ]/.test(pw)) pool += 33;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  let bits = pw.length * Math.log2(Math.max(pool, 2));
  const lower = pw.toLowerCase();
  const personal = [login, login.split('@')[0] ?? '']
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3 && lower.includes(s))
    .sort((a, b) => b.length - a.length)[0];
  if (personal) {
    issues.push('personal');
    // логин подбирают первым: его символы считаются за одно слово (~4 бита), а не за случайные
    bits = (pw.length - personal.length) * Math.log2(Math.max(pool, 2)) + 4;
  }
  if (COMMON.has(lower)) {
    issues.push('common');
    bits = Math.min(bits, 10);
  }
  if (/(.)\1{2,}/.test(pw)) {
    issues.push('repeat');
    bits *= 0.8;
  }
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|asdf|zxcv)/i.test(pw)) {
    issues.push('sequence');
    bits *= 0.75;
  }
  if (pw.length < 10) issues.push('short');
  if (classes < 2) issues.push('single-class');
  const score = bits < 28 ? 0 : bits < 40 ? 1 : bits < 56 ? 2 : bits < 72 ? 3 : 4;
  return { bits: Math.round(bits), score, issues };
}

export async function sha1Hex(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** Разбор ответа range API (СУФФИКС:ЧИСЛО) и поиск суффикса; возвращает число появлений в утечках. */
export function findInRange(responseText: string, suffix: string): number {
  for (const line of responseText.split('\n')) {
    const [s, c] = line.trim().split(':');
    if (s?.toUpperCase() === suffix.toUpperCase()) return Number(c) || 0;
  }
  return 0;
}
