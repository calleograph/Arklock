/** Политика паролей организации. Проверяется в браузере (серверу пароли неизвестны) и в инспекторе безопасности. */
export interface PasswordPolicy {
  /** Минимальная длина (0 — без требования). */
  minLength: number;
  /** Сколько классов символов обязательно: строчные, прописные, цифры, прочие (0–4). */
  classes: number;
}

export const NO_POLICY: PasswordPolicy = { minLength: 0, classes: 0 };

export type Violation = 'length' | 'classes';

const classOf = (pw: string): number =>
  [/[a-zа-яё]/, /[A-ZА-ЯЁ]/, /[0-9]/, /[^A-Za-zА-Яа-яЁё0-9]/].filter((re) => re.test(pw)).length;

export function checkPolicy(password: string, policy: PasswordPolicy): Violation[] {
  const out: Violation[] = [];
  if (policy.minLength > 0 && [...password].length < policy.minLength) out.push('length');
  if (policy.classes > 0 && classOf(password) < policy.classes) out.push('classes');
  return out;
}

/** Политика из ответа /auth/policy; некорректные значения игнорируются. */
export function policyFrom(raw: Record<string, unknown>): PasswordPolicy {
  const n = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  return {
    minLength: Math.min(n(raw['policy.password.minLength']), 128),
    classes: Math.min(n(raw['policy.password.classes']), 4),
  };
}
