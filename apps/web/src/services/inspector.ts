import { estimateStrength } from '@arklock/crypto';
import type { EntryItem } from './model';

export type IssueType = 'weak' | 'reused' | 'old' | 'expired' | 'compromised';

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
    if (d.password && estimateStrength(d.password).score < 2)
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
