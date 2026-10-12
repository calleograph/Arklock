import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { roles, users } from '../db/schema.js';
import { forbidden } from '../errors.js';
import { ADMIN_PERMS, adminPermFor, effective, expandRole } from '../perms.js';
import { loadRoleDefs } from '../access.js';
import { authOf } from './session.js';

/** Административные полномочия пользователя: полный администратор — все; иначе из назначенной административной роли. */
export async function adminPermsOf(
  ctx: AppContext,
  user: Pick<typeof users.$inferSelect, 'id' | 'role' | 'adminRoleId'>,
): Promise<Set<string>> {
  if (user.role === 'admin') return new Set(ADMIN_PERMS);
  if (!user.adminRoleId) return new Set();
  const defs = await loadRoleDefs(ctx.db);
  const d = defs.get(user.adminRoleId);
  if (!d || d.scope !== 'admin') return new Set();
  return new Set(
    [...effective([expandRole(defs, user.adminRoleId)])].filter((p) =>
      (ADMIN_PERMS as readonly string[]).includes(p),
    ),
  );
}

/**
 * Проверка доступа к административному маршруту: полному администратору можно всё, делегированному — только разделы,
 * полномочие на которые есть в его роли. Маршрут без сопоставленного полномочия закрыт для делегированных.
 */
export async function adminGate(ctx: AppContext, req: FastifyRequest): Promise<void> {
  const { user } = authOf(req);
  if (user.role === 'admin') return;
  if (!user.adminRoleId) throw forbidden();
  const perms = await adminPermsOf(ctx, user);
  const path = req.url.split('?')[0] ?? '';
  // повторное подтверждение пароля нужно любому делегированному администратору для опасных действий своего раздела
  if (path === '/api/v1/admin/reauth' && perms.size > 0) return;
  const need = adminPermFor(path);
  if (!need || !perms.has(need)) throw forbidden();
}

export async function roleInUse(ctx: AppContext, id: string): Promise<number> {
  const { vaultMembers, vaultCircles } = await import('../db/schema.js');
  const [a, b, c] = await Promise.all([
    ctx.db
      .select({ v: vaultMembers.userId })
      .from(vaultMembers)
      .where(eq(vaultMembers.customRoleId, id)),
    ctx.db
      .select({ v: vaultCircles.circleId })
      .from(vaultCircles)
      .where(eq(vaultCircles.customRoleId, id)),
    ctx.db.select({ v: users.id }).from(users).where(eq(users.adminRoleId, id)),
  ]);
  const children = (await ctx.db.select().from(roles)).filter((r) =>
    (r.parents as string[]).includes(id),
  );
  return a.length + b.length + c.length + children.length;
}
