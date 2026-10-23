import type { UserBundle } from '@arklock/contracts';
import { reauth } from './account';

/**
 * Повышенное подтверждение (step-up) для разрушительных операций. Одно подтверждение мастер-паролем действует
 * на все такие операции сеанса, пока не истечёт (15 минут на сервере) или пока вкладку не заблокировали.
 * Хранится только в памяти вкладки.
 */
let cached: { token: string; until: number } | null = null;

/** Заголовок действующего подтверждения или null, если нужно спросить мастер-пароль. */
export function stepUpHeaders(): Record<string, string> | null {
  return cached && cached.until > Date.now() + 5_000 ? { 'X-Reauth-Token': cached.token } : null;
}

export async function confirmStepUp(
  user: UserBundle,
  password: string,
): Promise<Record<string, string>> {
  const r = await reauth(user, password);
  cached = { token: r.token, until: Date.parse(r.expiresAt) };
  return { 'X-Reauth-Token': r.token };
}

export function clearStepUp(): void {
  cached = null;
}
