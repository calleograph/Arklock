/** Политика паролей организации. Проверяется в браузере (серверу пароли неизвестны) и в инспекторе безопасности. */
export interface PasswordPolicy {
  /** Минимальная длина (0 — без требования). */
  minLength: number;
  /** Сколько классов символов обязательно: строчные, прописные, цифры, прочие (0–4). */
  classes: number;
  /** Не больше стольких одинаковых символов подряд (0 — без требования). */
  maxRepeat?: number;
}

export const NO_POLICY: PasswordPolicy = { minLength: 0, classes: 0, maxRepeat: 0 };

export type Violation = 'length' | 'classes' | 'repeat';

/** Самая длинная серия одинаковых символов (по символам Unicode, а не по кодовым единицам). */
function longestRun(pw: string): number {
  let best = 0;
  let run = 0;
  let prev = '';
  for (const ch of pw) {
    run = ch === prev ? run + 1 : 1;
    prev = ch;
    best = Math.max(best, run);
  }
  return best;
}

const classOf = (pw: string): number =>
  [/[a-zа-яё]/, /[A-ZА-ЯЁ]/, /[0-9]/, /[^A-Za-zА-Яа-яЁё0-9]/].filter((re) => re.test(pw)).length;

export function checkPolicy(password: string, policy: PasswordPolicy): Violation[] {
  const out: Violation[] = [];
  if (policy.minLength > 0 && [...password].length < policy.minLength) out.push('length');
  if (policy.classes > 0 && classOf(password) < policy.classes) out.push('classes');
  if (policy.maxRepeat && longestRun(password) > policy.maxRepeat) out.push('repeat');
  return out;
}

/** Текст нарушения: число в сообщении — из той же политики, по которой проверяли. */
export const policyMessage = (
  v: Violation,
  p: Partial<PasswordPolicy>,
  t: (key: string, args: Record<string, unknown>) => string,
): string =>
  t(`policy.${v}`, {
    n: v === 'length' ? p.minLength : v === 'classes' ? p.classes : (p.maxRepeat ?? 0),
  });

/** Политика из ответа /auth/policy; некорректные значения игнорируются. */
export function policyFrom(raw: Record<string, unknown>): PasswordPolicy {
  const n = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  return {
    minLength: Math.min(n(raw['policy.password.minLength']), 128),
    classes: Math.min(n(raw['policy.password.classes']), 4),
    maxRepeat: Math.min(n(raw['policy.password.maxRepeat']), 20),
  };
}

/** Генератор паролей организации: значения по умолчанию и символы, которые он не использует никогда. */
export interface GeneratorDefaults {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  exclude: string;
}

export function generatorFrom(raw: Record<string, unknown>): GeneratorDefaults {
  const len = raw['generator.length'];
  const on = (k: string) => raw[`generator.${k}`] !== false;
  const out = {
    length: typeof len === 'number' && len >= 8 && len <= 128 ? Math.floor(len) : 20,
    lower: on('lower'),
    upper: on('upper'),
    digits: on('digits'),
    symbols: on('symbols'),
    exclude:
      typeof raw['generator.exclude'] === 'string'
        ? raw['generator.exclude'].replace(/[^\x21-\x7e]/g, '').slice(0, 64)
        : '',
  };
  // без единого класса генератору не из чего строить пароль — тогда все классы
  if (!out.lower && !out.upper && !out.digits && !out.symbols)
    Object.assign(out, { lower: true, upper: true, digits: true, symbols: true });
  return out;
}
