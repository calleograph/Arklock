import { and, eq, inArray } from 'drizzle-orm';
import type { VaultRole } from '@arklock/contracts';
import type { Db } from './db/connect.js';
import {
  branches,
  circleMembers,
  grants,
  roles,
  users,
  vaultCircles,
  vaultMembers,
  vaults,
} from './db/schema.js';
import { notFound } from './errors.js';
import { BUILTIN_VAULT_ROLES, effective, expandRole, type RoleDef } from './perms.js';
import { personalLockersAllowed } from './personal-lockers.js';
import { spaceAccess } from './spaces.js';

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

/** Уровень доступа по полномочиям: управление (изменение, удаление, ветви) > изменение > чтение. */
function levelOf(perms: Set<string>): Access | null {
  if (perms.has('entry.update') && perms.has('entry.delete') && perms.has('branch.manage'))
    return 'manager';
  if (perms.has('entry.update')) return 'editor';
  if (perms.has('entry.read')) return 'reader';
  return null;
}

/**
 * Контекст доступа пользователя к хранилищу: полномочия (встроенные и пользовательские роли прямо и через круги,
 * с учётом срока, запретов и наследования), гранты на ветви и записи и дерево ветвей для наследования вниз по структуре.
 * Явный запрет полномочия ограничивает и права, полученные через гранты.
 */
export class VaultAccess {
  constructor(
    readonly vaultId: string,
    readonly userId: string,
    readonly role: VaultRole | null,
    private readonly grantMap: Map<string, Access>,
    private readonly parents: Map<string, string | null>,
    /** Эффективные полномочия по ролям (без грантов). */
    readonly perms: Set<string> = new Set(role ? (BUILTIN_VAULT_ROLES[role] ?? []) : []),
    /** Запреты из всех назначенных ролей. */
    private readonly denied: Set<string> = new Set(),
    /** Названия пользовательских ролей (для отображения). */
    readonly customRoles: string[] = [],
    private readonly objectDenials: Set<string> = new Set(),
  ) {}

  get isMember(): boolean {
    return this.role !== null;
  }

  can(perm: string): boolean {
    return this.perms.has(perm);
  }

  /**
   * Разрешено ли действие: роль даёт полномочие, либо доступ у пользователя только по грантам (без ролевого доступа к записям),
   * и полномочие не запрещено явно.
   */
  allows(perm: string): boolean {
    if (this.denied.has(perm)) return false;
    return this.perms.has(perm) || !this.perms.has('entry.read');
  }

  /** Управление участниками и выдача ключей (администратор хранилища и роли с таким полномочием). */
  get isAdmin(): boolean {
    return this.can('members.manage');
  }

  /** Ограничение уровня доступа явными запретами. */
  private cap(a: Access | null): Access | null {
    if (!a) return null;
    if (this.denied.has('entry.read')) return null;
    if (this.denied.has('entry.update') && ACCESS_RANK[a] > ACCESS_RANK.reader) return 'reader';
    return a;
  }

  /** Право на ветвь (null — нет доступа). Права наследуются от родительских ветвей. */
  branch(branchId: string | null): Access | null {
    let best = levelOf(this.perms);
    let cur: string | null = branchId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (this.objectDenials.has(`branch:${cur}`)) return null;
      best = maxAccess(best, this.grantMap.get(`branch:${cur}`) ?? null);
      cur = this.parents.get(cur) ?? null;
    }
    return this.cap(best);
  }

  /** Право на запись: роль, грант на запись, гранты на ветви-предки. */
  entry(entryId: string, branchId: string | null): Access | null {
    if (
      this.objectDenials.has(`entry:${entryId}`) ||
      this.ancestors(branchId).some((id) => this.objectDenials.has(`branch:${id}`))
    )
      return null;
    return this.cap(
      maxAccess(this.branch(branchId), this.grantMap.get(`entry:${entryId}`) ?? null),
    );
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

/** Все пользовательские роли (для разворачивания наследования). */
export async function loadRoleDefs(db: Db): Promise<Map<string, RoleDef & { name: string }>> {
  const rows = await db.select().from(roles);
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        scope: r.scope,
        allow: r.allow as string[],
        deny: r.deny as string[],
        parents: r.parents as string[],
      },
    ]),
  );
}

export async function loadAccess(
  db: Db,
  vaultId: string,
  userId: string,
  now: Date = new Date(),
): Promise<VaultAccess> {
  const [vault] = await db
    .select({ kind: vaults.kind, spaceId: vaults.spaceId })
    .from(vaults)
    .where(eq(vaults.id, vaultId));
  const [user] = await db
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!user || user.disabledAt) return new VaultAccess(vaultId, userId, null, new Map(), new Map());
  if (vault?.kind === 'locker' && !(await personalLockersAllowed(db, userId))) {
    return new VaultAccess(vaultId, userId, null, new Map(), new Map());
  }
  if (!vault) return new VaultAccess(vaultId, userId, null, new Map(), new Map());
  if (vault.kind === 'shared' && !(await spaceAccess(db, vault.spaceId, userId)).member)
    return new VaultAccess(vaultId, userId, null, new Map(), new Map());
  const nowMs = now.getTime();
  const [direct] = await db
    .select({
      role: vaultMembers.role,
      customRoleId: vaultMembers.customRoleId,
      expiresAt: vaultMembers.expiresAt,
    })
    .from(vaultMembers)
    .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, userId)));
  const circleRows = await db
    .select({ circleId: circleMembers.circleId })
    .from(circleMembers)
    .where(eq(circleMembers.userId, userId));
  const circleIds = circleRows.map((c) => c.circleId);

  type Assign = { role: VaultRole; customRoleId: string | null };
  const assigns: Assign[] = [];
  if (direct && !(direct.expiresAt && direct.expiresAt.getTime() <= nowMs))
    assigns.push({ role: direct.role, customRoleId: direct.customRoleId });
  if (circleIds.length) {
    const viaCircles = await db
      .select({
        role: vaultCircles.role,
        customRoleId: vaultCircles.customRoleId,
        expiresAt: vaultCircles.expiresAt,
      })
      .from(vaultCircles)
      .where(and(eq(vaultCircles.vaultId, vaultId), inArray(vaultCircles.circleId, circleIds)));
    for (const c of viaCircles)
      if (!(c.expiresAt && c.expiresAt.getTime() <= nowMs))
        assigns.push({ role: c.role, customRoleId: c.customRoleId });
  }

  const defs = assigns.some((a) => a.customRoleId) ? await loadRoleDefs(db) : new Map();
  const parts: { allow: Iterable<string>; deny: Iterable<string> }[] = [];
  const denied = new Set<string>();
  const customNames: string[] = [];
  let role: VaultRole | null = null;
  for (const a of assigns) {
    if (a.customRoleId) {
      const def = defs.get(a.customRoleId);
      if (!def || def.scope !== 'vault') continue; // удалённая роль не даёт ничего
      const e = expandRole(defs, a.customRoleId);
      parts.push(e);
      e.deny.forEach((d) => denied.add(d));
      customNames.push(def.name);
      role ??= 'limited';
    } else {
      parts.push({ allow: BUILTIN_VAULT_ROLES[a.role] ?? [], deny: [] });
      if (!role || ROLE_RANK[a.role] > ROLE_RANK[role]) role = a.role;
    }
  }
  const perms = effective(parts);

  const grantRows = await db.select().from(grants).where(eq(grants.vaultId, vaultId));
  const grantMap = new Map<string, Access>();
  const objectDenials = new Set<string>();
  for (const g of grantRows) {
    if (g.expiresAt && g.expiresAt.getTime() <= nowMs) continue;
    const mine =
      (g.subjectType === 'user' && g.subjectId === userId) ||
      (g.subjectType === 'circle' && circleIds.includes(g.subjectId));
    if (!mine) continue;
    const key = `${g.targetType}:${g.targetId}`;
    if (g.role === 'none') {
      objectDenials.add(key);
      continue;
    }
    grantMap.set(key, maxAccess(grantMap.get(key) ?? null, g.role) as Access);
  }
  // Член хранилища с ролью limited существует только пока есть гранты; без ролей и грантов доступа нет вообще.
  if (!role && grantMap.size > 0) role = 'limited';

  const brRows = await db
    .select({ id: branches.id, parentId: branches.parentId })
    .from(branches)
    .where(eq(branches.vaultId, vaultId));
  const parents = new Map(brRows.map((b) => [b.id, b.parentId]));
  return new VaultAccess(
    vaultId,
    userId,
    role,
    grantMap,
    parents,
    perms,
    denied,
    customNames,
    objectDenials,
  );
}

/** Доступ к хранилищу или 404: не участник не отличает хранилище от несуществующего. */
export async function requireVault(db: Db, vaultId: string, userId: string): Promise<VaultAccess> {
  const access = await loadAccess(db, vaultId, userId);
  if (!access.isMember) throw notFound();
  return access;
}
