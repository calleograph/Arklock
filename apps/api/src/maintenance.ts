import { eq, lt, or, and, isNotNull, sql } from 'drizzle-orm';
import type { BlobStore } from './blobs.js';
import type { Db } from './db/connect.js';
import { audit } from './audit.js';
import { handoffs, ledger, sessions, settings } from './db/schema.js';
import { sweepBlobs } from './routes/attachments.js';
import { purgeExpiredTrash } from './routes/content.js';

/** Плановое обслуживание. Возвращает число удалённых объектов по категориям (для журнала и тестов). */
export async function runMaintenance(db: Db, now = new Date(), blobs?: BlobStore) {
  const [ret] = await db.select().from(settings).where(eq(settings.key, 'trash.retentionDays'));
  const days = typeof ret?.value === 'number' ? ret.value : 30;
  const trash = await purgeExpiredTrash(db, days, now, blobs);
  const old = new Date(now.getTime() - 30 * 86_400_000);
  const sess = await db
    .delete(sessions)
    .where(
      or(
        lt(sessions.expiresAt, old),
        and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, old)),
      ),
    )
    .returning({ id: sessions.id });
  const hand = await db
    .delete(handoffs)
    .where(lt(handoffs.expiresAt, old))
    .returning({ id: handoffs.id });
  // окно после первого открытия закрылось — шифртекст больше не нужен (как после последнего просмотра)
  await db
    .update(handoffs)
    .set({ ciphertext: '' })
    .where(
      sql`${handoffs.openWindowMinutes} is not null and ${handoffs.firstOpenedAt} + ${handoffs.openWindowMinutes} * interval '1 minute' <= ${now} and ${handoffs.ciphertext} <> ''`,
    );
  const files = blobs ? await sweepBlobs({ db, blobs }, now) : { orphans: 0, pending: 0 };
  return {
    trash,
    sessions: sess.length,
    handoffs: hand.length,
    files,
    journal: await pruneLedger(db, now),
  };
}

const PRUNE_BATCH = 10_000;

/**
 * Срок хранения журнала действий (`ledger.retentionDays`, 0 — бессрочно, иначе не меньше 30 дней).
 * Старые события удаляются пачками (без долгой блокировки таблицы), удаление само записывается в журнал —
 * и уходит в syslog и вебхуки, как любое событие: пробел в журнале объясним.
 */
async function pruneLedger(db: Db, now: Date): Promise<number> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'ledger.retentionDays'));
  const days = typeof row?.value === 'number' && row.value >= 30 ? row.value : 0;
  if (!days) return 0;
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  let count = 0;
  for (;;) {
    const gone = await db
      .delete(ledger)
      .where(
        sql`${ledger.id} in (select ${ledger.id} from ${ledger} where ${ledger.at} < ${cutoff} limit ${PRUNE_BATCH})`,
      )
      .returning({ id: ledger.id });
    count += gone.length;
    if (gone.length < PRUNE_BATCH) break;
  }
  if (count)
    await audit(db, 'system:maintenance', 'ledger.pruned', null, {
      before: cutoff.toISOString(),
      count,
      days,
    });
  return count;
}
