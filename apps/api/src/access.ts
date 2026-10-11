import { and, eq, inArray } from 'drizzle-orm';
import type { VaultRole } from '@arklock/contracts';
import type { Db } from './db/connect.js';
import { branches, circleMembers, grants, vaultCircles, vaultMembers } from './db/schema.js';
import { notFound } from './errors.js';

/** Эффективное право на ветвь или запись. */
export type Access = 'reader' | 'editor' | 'manager';
const ACCESS_RANK: Record<Access, number> = { reader: 1, editor: 2, manager: 3 };
const ROLE_RANK: Record<VaultRole, number> = {
  owner: 4,
  admin: 3,
  editor: 2,
  reader: 1,
  limited: 0,
};

export const roleAtLeast = (role: VaultRole | null, min: VaultRole): boolean =>
  role !== null && ROLE_RANK[role] >= ROLE_RANK[min];

const maxAccess = (a: Access | null, b: Access | null): Access | null =>
  !a ? b : !b ? a : ACCESS_RANK[a] >= ACCESS_RANK[b] ? a : b;

const baseAccess = (role: VaultRole | null): Access | null =>
  role === 'owner' || role === 'admin'
    ? 'manager'
    : role === 'editor'
      ? 'editor'
      : role === 'reader'
        ? 'reader'
        : null;

/**
 * Контекст доступа пользователя к хранилищу: роль (прямая и через круги), гранты (на пользователя и его круги,
 * действующие на момент запроса) и дерево ветвей для наследования прав вниз по структуре.
 */
export class VaultAccess {
  constructor(
    readonly vaultId: string,
    readonly userId: string,
    readonly role: VaultRole | null,
    private readonly grantMap: Map<string, Access>,
    private readonly parents: Map<string, string | null>,
  ) {}

  get isMember(): boolean {
    return this.role !== null;
  }

  get isAdmin(): boolean {
    return roleAtLeast(this.role, 'admin');
  }

  /** Право на ветвь (null — нет доступа). Права наследуются от родительских ветвей. */
  branch(branchId: string | null): Access | null {
    let best = baseAccess(this.role);
    let cur: string | null = branchId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      best = maxAccess(best, this.grantMap.get(`branch:${cur}`) ?? null);
      cur = this.parents.get(cur) ?? null;
    }
    return best;
  }

  /** Право на запись: роль, грант на запись, гранты на ветви-предки. */
  entry(entryId: string, branchId: string | null): Access | null {
    return maxAccess(this.branch(branchId), this.grantMap.get(`entry:${entryId}`) ?? null);
  }

  /** Цепочка ветвей от указанной вверх (для проверки циклов при перемещении). */
  ancestors(branchId: string | null): string[] {
    const out: string[] = [];
    let cur = branchId;
    while (cur && !out.includes(cur)) {
      out.push(cur);
      cur = this.parents.get(cur) ?? null;
    }
    return out;
  }
}

export async function loadAccess(
  db: Db,
  vaultId: string,
  userId: string,
  now: Date = new Date(),
): Promise<VaultAccess> {
  const [direct] = await db
    .select({ role: vaultMembers.role })
    .from(vaultMembers)
    .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, userId)));
  const circleRows = await db
    .select({ circleId: circleMembers.circleId })
    .from(circleMembers)
    .where(eq(circleMembers.userId, userId));
  const circleIds = circleRows.map((c) => c.circleId);

  let role: VaultRole | null = direct?.role ?? null;
  if (circleIds.length) {
    const viaCircles = await db
      .select({ role: vaultCircles.role })
      .from(vaultCircles)
      .where(and(eq(vaultCircles.vaultId, vaultId), inArray(vaultCircles.circleId, circleIds)));
    for (const c of viaCircles) if (!role || ROLE_RANK[c.role] > ROLE_RANK[role]) role = c.role;
  }

  const grantRows = await db.select().from(grants).where(eq(grants.vaultId, vaultId));
  const grantMap = new Map<string, Access>();
  for (const g of grantRows) {
    if (g.expiresAt && g.expiresAt.getTime() <= now.getTime()) continue;
    const mine =
      (g.subjectType === 'user' && g.subjectId === userId) ||
      (g.subjectType === 'circle' && circleIds.includes(g.subjectId));
    if (!mine) continue;
    const key = `${g.targetType}:${g.targetId}`;
    grantMap.set(key, maxAccess(grantMap.get(key) ?? null, g.role) as Access);
  }
  // Член хранилища с ролью limited существует только пока есть гранты; без ролей и грантов доступа нет вообще.
  const hasGrants = grantMap.size > 0;
  if (!role && hasGrants) role = 'limited';

  const brRows = await db
    .select({ id: branches.id, parentId: branches.parentId })
    .from(branches)
    .where(eq(branches.vaultId, vaultId));
  const parents = new Map(brRows.map((b) => [b.id, b.parentId]));
  return new VaultAccess(vaultId, userId, role, grantMap, parents);
}

/** Доступ к хранилищу или 404: не участник не отличает хранилище от несуществующего. */
export async function requireVault(db: Db, vaultId: string, userId: string): Promise<VaultAccess> {
  const access = await loadAccess(db, vaultId, userId);
  if (!access.isMember) throw notFound();
  return access;
}
