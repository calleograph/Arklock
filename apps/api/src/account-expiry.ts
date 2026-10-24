import { and, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { audit } from './audit.js';
import type { Db } from './db/connect.js';
import { sessions, users } from './db/schema.js';

/**
 * Учётные записи, у которых истёк срок действия: отключаются (причина «срок истёк»), сеансы завершаются,
 * событие пишется в журнал. Вызывается при входе, при проверке сеанса и токена и в плановом обслуживании.
 */
export async function expireAccounts(db: Db, now = new Date()): Promise<string[]> {
  const gone = await db
    .update(users)
    .set({
      disabledAt: now,
      disabledReason: 'expired',
      disabledNote: null,
      disabledBy: null,
      updatedAt: now,
    })
    .where(and(isNotNull(users.accessUntil), lte(users.accessUntil, now), isNull(users.disabledAt)))
    .returning({ id: users.id });
  const ids = gone.map((g) => g.id);
  if (!ids.length) return ids;
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(inArray(sessions.userId, ids), isNull(sessions.revokedAt)));
  for (const id of ids) await audit(db, 'system', 'admin.user.expired', `user:${id}`);
  return ids;
}

/** Срок истёк к моменту `now` (мс)? Тогда учётная запись отключается сразу, не дожидаясь обслуживания. */
export async function expiredNow(
  db: Db,
  user: { accessUntil: Date | null },
  now: number,
): Promise<boolean> {
  if (!user.accessUntil || user.accessUntil.getTime() > now) return false;
  await expireAccounts(db, new Date(now));
  return true;
}
