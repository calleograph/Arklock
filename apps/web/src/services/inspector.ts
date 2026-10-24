import { estimateStrength, findInRange, sha1Hex } from '@arklock/crypto';
import { api } from './api';
import type { EntryItem } from './model';
import { checkPolicy, NO_POLICY, type PasswordPolicy } from './policy';

export type IssueType = 'weak' | 'reused' | 'old' | 'expired' | 'compromised' | 'policy';

export interface Issue {
  entryId: string;
  type: IssueType;
  /** Дополнительные сведения без секретов (например, число записей с тем же паролем). */
  info?: number;
}

export interface InspectOptions {
  /** Максимальный возраст пароля, дней (0 — не проверять). */
  maxAgeDays: number;
  now?: Date;
  /** Политика паролей организации: записи, ей не соответствующие, помечаются. */
  policy?: PasswordPolicy;
}

/** Локальный анализ паролей. Пароли и их хэши никуда не отправляются. */
export function inspect(entries: EntryItem[], o: InspectOptions): Issue[] {
  const now = (o.now ?? new Date()).getTime();
  const issues: Issue[] = [];
  const byPassword = new Map<string, string[]>();
  for (const e of entries) {
    const pw = e.data.password;
    if (!pw || e.data.kind === 'note') continue;
    byPassword.set(pw, [...(byPassword.get(pw) ?? []), e.id]);
  }
  for (const e of entries) {
    const d = e.data;
    if (d.kind === 'note') continue;
    if (d.password && checkPolicy(d.password, o.policy ?? NO_POLICY).length)
      issues.push({ entryId: e.id, type: 'policy' });
    if (d.password && estimateStrength(d.password, d.username).score < 2)
      issues.push({ entryId: e.id, type: 'weak' });
    const same = d.password ? byPassword.get(d.password) : undefined;
    if (same && same.length > 1) issues.push({ entryId: e.id, type: 'reused', info: same.length });
    if (d.password && o.maxAgeDays > 0) {
      const changed = Date.parse(d.passwordChangedAt ?? e.updatedAt);
      if (Number.isFinite(changed) && now - changed > o.maxAgeDays * 86_400_000)
        issues.push({ entryId: e.id, type: 'old' });
    }
    if (d.expiresAt) {
      const exp = Date.parse(d.expiresAt);
      if (Number.isFinite(exp) && exp < now) issues.push({ entryId: e.id, type: 'expired' });
    }
  }
  return issues;
}

/** Отпечаток набора записей сейфа: результат проверки утечек годится, пока записи не менялись. */
export const entriesSnapshot = (vaultId: string | null, entries: EntryItem[]) =>
  `${vaultId}:${entries
    .map((e) => `${e.id}:${e.version}`)
    .sort()
    .join(',')}`;

/**
 * Проверка паролей по базам утечек: наружу уходит только префикс SHA-1 из 5 символов, пароли не передаются.
 * Возвращает запись → сколько раз пароль встречается в утечках (только найденные).
 */
export async function checkBreaches(
  entries: EntryItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, number>> {
  const withPw = entries.filter((e) => e.data.password && e.data.kind !== 'note');
  const found = new Map<string, number>();
  const cache = new Map<string, string>();
  let done = 0;
  onProgress?.(0, withPw.length);
  for (const e of withPw) {
    const hash = await sha1Hex(e.data.password);
    const prefix = hash.slice(0, 5);
    let body = cache.get(prefix);
    if (body === undefined) {
      body = await api<string>('GET', `/security/range/${prefix}`);
      cache.set(prefix, body);
    }
    const count = findInRange(body, hash.slice(5));
    if (count > 0) found.set(e.id, count);
    onProgress?.(++done, withPw.length);
  }
  return found;
}

/**
 * Здоровье паролей: сколько записей с паролем не имеют ни одной проблемы инспектора.
 * Заметки и записи без пароля не учитываются; без записей с паролем — 100 %.
 */
export function passwordHealth(
  entries: EntryItem[],
  issues: Issue[],
): { ok: number; total: number; percent: number } {
  const withPassword = entries.filter((e) => e.data.kind !== 'note' && e.data.password);
  const bad = new Set(issues.map((i) => i.entryId));
  const ok = withPassword.filter((e) => !bad.has(e.id)).length;
  const total = withPassword.length;
  return { ok, total, percent: total ? Math.floor((ok * 100) / total) : 100 };
}
