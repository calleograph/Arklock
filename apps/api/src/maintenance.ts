import { eq, lt, or, and, isNotNull, sql } from 'drizzle-orm';
import type { BlobStore } from './blobs.js';
import type { Db } from './db/connect.js';
import { handoffs, sessions, settings } from './db/schema.js';
import { sweepBlobs } from './routes/attachments.js';
import { purgeExpiredTrash } from './routes/content.js';
import { syncScheduledLdap } from './auth/ldap-sync.js';

/** Плановое обслуживание. Возвращает число удалённых объектов по категориям (для журнала и тестов). */
export async function runMaintenance(
  db: Db,
  now = new Date(),
  blobs?: BlobStore,
  appSecret?: string,
) {
  if (appSecret) await syncScheduledLdap(db, appSecret);
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
  return { trash, sessions: sess.length, handoffs: hand.length, files };
}
