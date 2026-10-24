import { and, eq, isNull } from 'drizzle-orm';
import { loadAccess } from './access.js';
import type { Db } from './db/connect.js';
import { entries, signals } from './db/schema.js';

// shortcut: не больше ROTATE_MAX событий на сейф; для сейфов крупнее остаётся ротация ключа сейфа
export const ROTATE_MAX = 2000;

/** Живые записи сейфа, которые сотрудник видит сейчас (с учётом групп, правил и запретов). */
export async function visibleEntries(
  db: Db,
  vaultId: string,
  userId: string,
): Promise<Set<string>> {
  const acc = await loadAccess(db, vaultId, userId);
  const rows = await db
    .select({ id: entries.id, branchId: entries.branchId })
    .from(entries)
    .where(and(eq(entries.vaultId, vaultId), isNull(entries.deletedAt)));
  return new Set(rows.filter((r) => acc.entry(r.id, r.branchId)).map((r) => r.id));
}

/**
 * «Требуется смена пароля» по записям, которые сотрудник мог видеть и больше не видит:
 * при увольнении или отзыве доступа. Повторное событие открывает прежнее снова с новой причиной.
 */
export async function openRotateSignals(
  db: Db,
  o: {
    vaultId: string;
    entryIds: Iterable<string>;
    cause: string;
    reason: 'offboarding' | 'revoked';
    reportedBy: string;
  },
): Promise<string[]> {
  const out: string[] = [];
  for (const entryId of [...o.entryIds].slice(0, ROTATE_MAX)) {
    const [sig] = await db
      .insert(signals)
      .values({
        id: crypto.randomUUID(),
        vaultId: o.vaultId,
        entryId,
        type: 'rotate',
        reportedBy: o.reportedBy,
        causeUserId: o.cause,
        causeReason: o.reason,
      })
      .onConflictDoUpdate({
        target: [signals.entryId, signals.type],
        set: {
          status: 'open',
          assignedTo: null,
          causeUserId: o.cause,
          causeReason: o.reason,
          updatedAt: new Date(),
        },
      })
      .returning({ id: signals.id });
    out.push(sig!.id);
  }
  return out;
}
