import { and, eq, isNotNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { circleMembers, circles, roles, users } from '../db/schema.js';
import { forbidden } from '../errors.js';
import { ADMIN_PERMS, adminPermFor, effective, expandRole } from '../perms.js';
import { loadRoleDefs } from '../access.js';
import { authOf } from './session.js';

/**
 * Административные полномочия пользователя: полный администратор — все; иначе объединение административных ролей,
 * назначенных ему напрямую и через группы (в том числе сопоставленные с группами каталога).
 */
export async function adminPermsOf(
  ctx: AppContext,
  user: Pick<typeof users.$inferSelect, 'id' | 'role' | 'adminRoleId'>,
): Promise<Set<string>> {
  if (user.role === 'admin') return new Set(ADMIN_PERMS);
  const viaGroups = await ctx.db
    .select({ roleId: circles.adminRoleId })
    .from(circleMembers)
    .innerJoin(circles, eq(circles.id, circleMembers.circleId))
    .where(and(eq(circleMembers.userId, user.id), isNotNull(circles.adminRoleId)));
  const ids = new Set<string>(viaGroups.map((r) => r.roleId!));
  if (user.adminRoleId) ids.add(user.adminRoleId);
  if (!ids.size) return new Set();
  const defs = await loadRoleDefs(ctx.db);
  const out = new Set<string>();
  for (const id of ids) {
    if (defs.get(id)?.scope !== 'admin') continue;
    for (const p of effective([expandRole(defs, id)]))
      if ((ADMIN_PERMS as readonly string[]).includes(p)) out.add(p);
  }
  return out;
}

/**
 * Проверка доступа к административному маршруту: полному администратору можно всё, делегированному — только разделы,
 * полномочие на которые есть в его роли. Маршрут без сопоставленного полномочия закрыт для делегированных.
 */
export async function adminGate(ctx: AppContext, req: FastifyRequest): Promise<void> {
  const { user } = authOf(req);
  if (user.role === 'admin') return;
  const perms = await adminPermsOf(ctx, user);
  const path = req.url.split('?')[0] ?? '';
  // повторное подтверждение пароля нужно любому делегированному администратору для опасных действий своего раздела
  if (path === '/api/v1/admin/reauth' && perms.size > 0) return;
  if (path === '/api/v1/admin/people' && (perms.has('admin.users') || perms.has('admin.circles')))
    return;
  const need = adminPermFor(path);
  if (!need || !perms.has(need)) throw forbidden();
}

export async function roleInUse(ctx: AppContext, id: string): Promise<number> {
  const { vaultMembers, vaultCircles } = await import('../db/schema.js');
  const [a, b, c, d] = await Promise.all([
    ctx.db
      .select({ v: vaultMembers.userId })
      .from(vaultMembers)
      .where(eq(vaultMembers.customRoleId, id)),
    ctx.db
      .select({ v: vaultCircles.circleId })
      .from(vaultCircles)
      .where(eq(vaultCircles.customRoleId, id)),
    ctx.db.select({ v: users.id }).from(users).where(eq(users.adminRoleId, id)),
    ctx.db.select({ v: circles.id }).from(circles).where(eq(circles.adminRoleId, id)),
  ]);
  const children = (await ctx.db.select().from(roles)).filter((r) =>
    (r.parents as string[]).includes(id),
  );
  return a.length + b.length + c.length + d.length + children.length;
}
