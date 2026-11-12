import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './db/connect.js';
import { grants, settings, spaceCircles, spaceMembers, vaults } from './db/schema.js';
import { spaceAccess } from './spaces.js';
import { AppError } from './errors.js';

/**
 * Кто может выдать доступ к папке или записи человеку вне подразделения:
 * owners — тот, кто управляет этой папкой или записью (по умолчанию); admins — только администратор сейфа
 * и подразделения; off — никто, кроме администратора подразделения.
 */
export type OutsideSharing = 'owners' | 'admins' | 'off';
export const OUTSIDE_SHARING_KEY = 'sharing.outside';

export async function outsideSharing(db: Db): Promise<OutsideSharing> {
  const [row] = await db.select().from(settings).where(eq(settings.key, OUTSIDE_SHARING_KEY));
  return row?.value === 'admins' || row?.value === 'off' ? row.value : 'owners';
}

/**
 * Получатель доступа к объекту сейфа подразделения не состоит в этом подразделении: он принимается гостем (видит только
 * выданное; членство в пространстве не даёт ни ключей, ни прав на сейф). Условия задаёт политика; группа вне
 * подразделения принимается только администратором подразделения. Возвращает true, если гость добавлен.
 */
export async function admitOutside(
  db: Db,
  opts: {
    vaultId: string;
    subjectType: 'user' | 'circle';
    subjectId: string;
    caller: { id: string; role: string };
    /** Вызывающий — администратор сейфа. */
    vaultAdmin: boolean;
  },
): Promise<boolean> {
  const [vault] = await db
    .select({ kind: vaults.kind, spaceId: vaults.spaceId })
    .from(vaults)
    .where(eq(vaults.id, opts.vaultId));
  if (!vault || vault.kind !== 'shared' || !vault.spaceId) return false;
  const spaceId = vault.spaceId;
  let inSpace: boolean;
  if (opts.subjectType === 'user')
    inSpace = (await spaceAccess(db, spaceId, opts.subjectId)).member;
  else {
    const [row] = await db
      .select({ c: spaceCircles.circleId })
      .from(spaceCircles)
      .where(and(eq(spaceCircles.spaceId, spaceId), eq(spaceCircles.circleId, opts.subjectId)));
    inSpace = !!row;
  }
  if (inSpace) return false;
  const spaceAdmin =
    opts.caller.role === 'admin' || (await spaceAccess(db, spaceId, opts.caller.id)).admin;
  const policy = await outsideSharing(db);
  if (!spaceAdmin) {
    if (policy === 'off')
      throw new AppError(
        403,
        'outside_sharing_off',
        'Sharing with people outside the department is turned off',
      );
    if (opts.subjectType === 'circle')
      throw new AppError(
        403,
        'outside_group_admin_only',
        'Only a department administrator can share with a group outside the department',
      );
    if (policy === 'admins' && !opts.vaultAdmin)
      throw new AppError(
        403,
        'outside_sharing_admins',
        'Only a vault administrator can share with people outside the department',
      );
  }
  if (opts.subjectType === 'circle') {
    await db
      .insert(spaceCircles)
      .values({ spaceId, circleId: opts.subjectId, role: 'member' })
      .onConflictDoNothing();
    return true;
  }
  await db
    .insert(spaceMembers)
    .values({ spaceId, userId: opts.subjectId, role: 'member', guest: true })
    .onConflictDoNothing();
  return true;
}

/**
 * Гости, у которых не осталось ни одного доступа к объектам сейфов подразделения, выходят из подразделения:
 * гость существует, пока ему что-то выдано. Без аргумента проверяются все подразделения.
 */
export async function pruneGuests(db: Db, spaceId?: string): Promise<number> {
  const rows = await db
    .delete(spaceMembers)
    .where(
      and(
        eq(spaceMembers.guest, true),
        spaceId ? eq(spaceMembers.spaceId, spaceId) : undefined,
        sql`not exists (
          select 1 from ${grants} g join ${vaults} v on v.id = g.vault_id
          where v.space_id = ${spaceMembers.spaceId} and g.subject_type = 'user'
            and g.subject_id = ${spaceMembers.userId} and g.role <> 'none'
            and (g.expires_at is null or g.expires_at > now()))`,
        sql`not exists (
          select 1 from vault_members m join ${vaults} v on v.id = m.vault_id
          where v.space_id = ${spaceMembers.spaceId} and m.user_id = ${spaceMembers.userId})`,
      ),
    )
    .returning({ u: spaceMembers.userId });
  return rows.length;
}

export const guestsOf = (db: Db, ids: string[]) =>
  ids.length
    ? db
        .select()
        .from(spaceMembers)
        .where(and(eq(spaceMembers.guest, true), inArray(spaceMembers.spaceId, ids)))
    : Promise.resolve([]);

export const OUTSIDE_MAX_DAYS_KEY = 'sharing.outsideMaxDays';
/** Срок гостевого доступа по умолчанию, дней. */
const GUEST_DEFAULT_DAYS = 30;

/**
 * Срок доступа гостя. Гость — человек вне подразделения, ему доступ всегда временный: без срока ставится срок по умолчанию
 * (30 дней), а слишком далёкий срок отклоняется (предел задаёт администратор, по умолчанию 90 дней, 0 — без предела).
 * Для члена подразделения срок остаётся таким, как указан.
 */
export async function guestTerm(
  db: Db,
  vaultId: string,
  subjectId: string,
  requested: Date | null,
): Promise<Date | null> {
  const [vault] = await db
    .select({ spaceId: vaults.spaceId })
    .from(vaults)
    .where(eq(vaults.id, vaultId));
  if (!vault?.spaceId || !(await spaceAccess(db, vault.spaceId, subjectId)).guest) return requested;
  const [row] = await db.select().from(settings).where(eq(settings.key, OUTSIDE_MAX_DAYS_KEY));
  const max = typeof row?.value === 'number' ? row.value : 90;
  const day = 86_400_000;
  if (!requested)
    return new Date(
      Date.now() + (max > 0 ? Math.min(GUEST_DEFAULT_DAYS, max) : GUEST_DEFAULT_DAYS) * day,
    );
  if (max > 0 && requested.getTime() > Date.now() + max * day)
    throw new AppError(
      400,
      'outside_expiry_too_long',
      'Access for a person outside the department is limited in time',
      { maxDays: max },
    );
  return requested;
}
