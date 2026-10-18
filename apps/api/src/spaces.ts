import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './db/connect.js';
import { circleMembers, spaceCircles, spaceMembers, spaces, users } from './db/schema.js';
import { notFound } from './errors.js';

export const DEFAULT_SPACE_ID = '00000000-0000-4000-8000-000000000001';

export async function spaceAccess(db: Db, spaceId: string | null, userId: string) {
  if (!spaceId) return { member: false, admin: false };
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId));
  const [user] = await db
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!space || !user || user.disabledAt) return { member: false, admin: false };
  const [direct] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)));
  const memberships = await db
    .select({ id: circleMembers.circleId })
    .from(circleMembers)
    .where(eq(circleMembers.userId, userId));
  const groups = memberships.length
    ? await db
        .select()
        .from(spaceCircles)
        .where(
          and(
            eq(spaceCircles.spaceId, spaceId),
            inArray(
              spaceCircles.circleId,
              memberships.map((m) => m.id),
            ),
          ),
        )
    : [];
  return {
    member: !space.archived && (space.publicToOrg || !!direct || groups.length > 0),
    admin: direct?.role === 'admin' || groups.some((g) => g.role === 'admin'),
  };
}

export async function requireSpace(db: Db, spaceId: string, userId: string): Promise<void> {
  if (!(await spaceAccess(db, spaceId, userId)).member) throw notFound();
}

/** A recovery claim grants explicit space membership; a system role alone grants no vault access. */
export async function ensureRecoveredSpaceMember(
  db: Db,
  spaceId: string | null,
  userId: string,
): Promise<boolean> {
  if (!spaceId) throw notFound();
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId));
  if (!space || space.archived) throw notFound();
  if ((await spaceAccess(db, spaceId, userId)).member) return false;
  await db.insert(spaceMembers).values({ spaceId, userId, role: 'member' }).onConflictDoNothing();
  return true;
}
