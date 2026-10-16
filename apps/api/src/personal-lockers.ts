import { eq, inArray } from 'drizzle-orm';
import type { Db } from './db/connect.js';
import { circleMembers, settings } from './db/schema.js';
import { AppError } from './errors.js';

type PolicyDb = Pick<Db, 'select'>;

/** No stored policy means corporate-only; existing ciphertext and keys remain untouched. */
export async function personalLockersAllowed(db: PolicyDb, userId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(settings)
    .where(
      inArray(settings.key, [
        'vaults.personalLockers',
        'vaults.personalLockerUsers',
        'vaults.personalLockerCircles',
      ]),
    );
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  if (value('vaults.personalLockers') === true) return true;
  const userIds = value('vaults.personalLockerUsers');
  if (Array.isArray(userIds) && userIds.includes(userId)) return true;
  const circleIds = value('vaults.personalLockerCircles');
  if (!Array.isArray(circleIds) || !circleIds.length) return false;
  const memberships = await db
    .select({ id: circleMembers.circleId })
    .from(circleMembers)
    .where(eq(circleMembers.userId, userId));
  return memberships.some((m) => circleIds.includes(m.id));
}

export async function requirePersonalLockerAllowed(db: PolicyDb, userId: string): Promise<void> {
  if (!(await personalLockersAllowed(db, userId)))
    throw new AppError(
      403,
      'personal_lockers_disabled',
      'Personal vaults are disabled by organization policy',
    );
}
