import { eq, lt, or, and, isNotNull } from 'drizzle-orm';
import type { Db } from './db/connect.js';
import { handoffs, sessions, settings } from './db/schema.js';
import { purgeExpiredTrash } from './routes/content.js';

/** Плановое обслуживание. Возвращает число удалённых объектов по категориям (для журнала и тестов). */
export async function runMaintenance(db: Db, now = new Date()) {
  const [ret] = await db.select().from(settings).where(eq(settings.key, 'trash.retentionDays'));
  const days = typeof ret?.value === 'number' ? ret.value : 30;
  const trash = await purgeExpiredTrash(db, days, now);
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
  return { trash, sessions: sess.length, handoffs: hand.length };
}
