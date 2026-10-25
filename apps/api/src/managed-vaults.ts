import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { audit } from './audit.js';
import type { Db } from './db/connect.js';
import { circles, grants, settings, vaultCircles, vaults } from './db/schema.js';
import { auditRotations, rotateLostAccess, subjectUsers } from './rotate-signals.js';

/**
 * Персональные корпоративные сейфы. В организации два вида персональных сейфов:
 *  - личный приватный (kind = locker): ключ только у владельца, никакого обхода нет;
 *  - персональный корпоративный (vaults.managed_for): обычный сейф сотрудника, к которому по открыто объявленной политике
 *    организации имеют доступ группы-хранители. Доступ даёт членство в группе и выданный клиентом ключ, а не серверная роль.
 */
export const MANAGED_ENABLED_KEY = 'vaults.managedPersonal';
export const MANAGED_GUARDIANS_KEY = 'vaults.managedGuardians';
export const MANAGED_ROLE_KEY = 'vaults.managedRole';

export interface ManagedPolicy {
  enabled: boolean;
  guardians: { id: string; name: string }[];
  role: 'reader' | 'editor';
}

export async function managedPolicy(db: Db): Promise<ManagedPolicy> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [MANAGED_ENABLED_KEY, MANAGED_GUARDIANS_KEY, MANAGED_ROLE_KEY]));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const ids = Array.isArray(get(MANAGED_GUARDIANS_KEY))
    ? (get(MANAGED_GUARDIANS_KEY) as string[])
    : [];
  const found = ids.length
    ? await db
        .select({ id: circles.id, name: circles.name })
        .from(circles)
        .where(inArray(circles.id, ids))
    : [];
  return {
    enabled: get(MANAGED_ENABLED_KEY) === true,
    // удалённая группа выпадает из списка сама
    guardians: found,
    role: get(MANAGED_ROLE_KEY) === 'editor' ? 'editor' : 'reader',
  };
}

/**
 * Приводит группы-хранители всех персональных корпоративных сейфов к политике: недостающие добавляются,
 * лишние снимаются (с событиями «смените пароль» по потерянному доступу), роль выравнивается.
 * Строки доступа, добавленные владельцем сейфа от себя, не затрагиваются. Возвращает число изменённых сейфов.
 */
export async function syncManagedGuardians(db: Db, actorId: string): Promise<number> {
  const actor = `user:${actorId}`;
  const policy = await managedPolicy(db);
  const want = new Set(policy.guardians.map((g) => g.id));
  const managed = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(isNotNull(vaults.managedFor));
  let changed = 0;
  for (const v of managed) {
    const rows = await db.select().from(vaultCircles).where(eq(vaultCircles.vaultId, v.id));
    const drop = rows.filter((r) => r.managed && !want.has(r.circleId));
    for (const r of drop) {
      const members = await subjectUsers(db, 'circle', r.circleId);
      const { opened } = await rotateLostAccess(
        db,
        members.map((userId) => ({ vaultId: v.id, userId })),
        async () => {
          await db
            .delete(vaultCircles)
            .where(and(eq(vaultCircles.vaultId, v.id), eq(vaultCircles.circleId, r.circleId)));
          await db
            .delete(grants)
            .where(
              and(
                eq(grants.vaultId, v.id),
                eq(grants.subjectType, 'circle'),
                eq(grants.subjectId, r.circleId),
              ),
            );
        },
        actorId,
      );
      await auditRotations(db, actor, opened);
    }
    let touched = drop.length > 0;
    for (const g of policy.guardians) {
      const have = rows.find((r) => r.circleId === g.id);
      if (have?.managed && have.role === policy.role) continue;
      await db
        .insert(vaultCircles)
        .values({ vaultId: v.id, circleId: g.id, role: policy.role, managed: true })
        .onConflictDoUpdate({
          target: [vaultCircles.vaultId, vaultCircles.circleId],
          set: { role: policy.role, customRoleId: null, expiresAt: null, managed: true },
        });
      touched = true;
    }
    if (touched) {
      changed++;
      await audit(db, actor, 'vault.managed.sync', `vault:${v.id}`, {
        guardians: policy.guardians.length,
        role: policy.role,
      });
    }
  }
  return changed;
}
