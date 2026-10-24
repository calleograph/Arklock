import { eq, lt, or, and, inArray, isNotNull, sql } from 'drizzle-orm';
import type { BlobStore } from './blobs.js';
import type { Db } from './db/connect.js';
import { audit } from './audit.js';
import { expireAccounts } from './account-expiry.js';
import { loadAccess } from './access.js';
import {
  entries,
  handoffs,
  ledger,
  sessions,
  settings,
  signals,
  vaultMembers,
} from './db/schema.js';
import { notifyUsers } from './notifications.js';
import { sweepBlobs } from './routes/attachments.js';
import { purgeExpiredTrash } from './routes/content.js';

/** Плановое обслуживание. Возвращает число удалённых объектов по категориям (для журнала и тестов). */
export async function runMaintenance(db: Db, now = new Date(), blobs?: BlobStore) {
  const expired = (await expireAccounts(db, now)).length;
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
    digest: await signalsDigest(db, now),
    expired,
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

const DIGEST_EVERY_MS = 7 * 86_400_000;

/**
 * Еженедельный отчёт о здоровье паролей: администраторам сейфа — число открытых событий безопасности
 * и сколько из них высокого риска. Считаются только записи, которые получатель видит (как в списке событий);
 * паролей сервер не знает — отчёт строится из событий, о которых сообщили браузеры и увольнения.
 * Возвращает число отправленных уведомлений.
 */
async function signalsDigest(db: Db, now: Date): Promise<number> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'signals.digestAt'));
  const last = typeof row?.value === 'string' ? Date.parse(row.value) : 0;
  if (now.getTime() - last < DIGEST_EVERY_MS) return 0;
  await db
    .insert(settings)
    .values({ key: 'signals.digestAt', value: now.toISOString() })
    .onConflictDoUpdate({ target: settings.key, set: { value: now.toISOString() } });
  const open = await db
    .select({
      vaultId: signals.vaultId,
      entryId: signals.entryId,
      branchId: entries.branchId,
      type: signals.type,
    })
    .from(signals)
    .innerJoin(entries, eq(entries.id, signals.entryId))
    .where(inArray(signals.status, ['open', 'in_progress']));
  let sent = 0;
  for (const vaultId of new Set(open.map((r) => r.vaultId))) {
    const rows = open.filter((r) => r.vaultId === vaultId);
    const admins = await db
      .select({ userId: vaultMembers.userId })
      .from(vaultMembers)
      .where(
        and(
          eq(vaultMembers.vaultId, vaultId),
          or(eq(vaultMembers.role, 'owner'), eq(vaultMembers.role, 'admin')),
        ),
      );
    for (const { userId } of admins) {
      const acc = await loadAccess(db, vaultId, userId);
      const seen = rows.filter((r) => acc.entry(r.entryId, r.branchId));
      if (!acc.isAdmin || !seen.length) continue;
      const high = seen.filter((r) => r.type === 'compromised' || r.type === 'rotate').length;
      const ok = await notifyUsers(db, [userId], {
        category: 'security',
        event: 'signals.digest',
        vaultId,
        resourceType: 'signals',
        resourceId: null,
        detail: { open: String(seen.length), high: String(high) },
      });
      if (ok) sent++;
    }
  }
  return sent;
}
