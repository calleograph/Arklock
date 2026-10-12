import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { uuid } from '@arklock/contracts';
import { loadRoleDefs } from '../access.js';
import { audit } from '../audit.js';
import { adminGate, adminPermsOf, roleInUse } from '../auth/adminperm.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { roles } from '../db/schema.js';
import { AppError, notFound, parse } from '../errors.js';
import { ADMIN_PERMS, BUILTIN_VAULT_ROLES, VAULT_PERMS, effective, expandRole } from '../perms.js';

const body = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).default(''),
  scope: z.enum(['vault', 'admin']),
  allow: z.array(z.string()).max(40).default([]),
  deny: z.array(z.string()).max(40).default([]),
  parents: z.array(uuid).max(10).default([]),
});

/** Пользовательские роли: набор разрешений, явные запреты, наследование. Управление — полномочие admin.roles. */
export const registerRoleRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', async (req: FastifyRequest) => adminGate(ctx, req));

  const known = (scope: 'vault' | 'admin') =>
    new Set<string>(scope === 'vault' ? VAULT_PERMS : ADMIN_PERMS);

  async function validate(b: z.infer<typeof body>, selfId?: string): Promise<void> {
    const ok = known(b.scope);
    for (const p of [...b.allow, ...b.deny])
      if (!ok.has(p)) throw new AppError(400, 'validation_error', `Unknown permission: ${p}`);
    const defs = await loadRoleDefs(db);
    for (const pid of b.parents) {
      const d = defs.get(pid);
      if (!d || d.scope !== b.scope)
        throw new AppError(400, 'validation_error', 'Parent role must exist in the same scope');
      if (pid === selfId)
        throw new AppError(400, 'validation_error', 'A role cannot inherit itself');
    }
    // цикл: путь от родителя обратно к редактируемой роли
    if (selfId) {
      const seen = new Set<string>();
      const walk = (id: string): boolean => {
        if (id === selfId) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return (defs.get(id)?.parents ?? []).some(walk);
      };
      if (b.parents.some(walk)) throw new AppError(400, 'validation_error', 'Inheritance cycle');
    }
  }

  /** Делегированный администратор не может создать роль с полномочиями, которых нет у него самого. */
  async function assertNotEscalating(req: FastifyRequest, b: z.infer<typeof body>): Promise<void> {
    const { user } = authOf(req);
    if (user.role === 'admin') return;
    const mine = await adminPermsOf(ctx, user);
    if (b.scope !== 'admin' || b.allow.some((p) => !mine.has(p)))
      throw new AppError(403, 'forbidden', 'You cannot grant permissions you do not have');
  }

  app.get('/admin/roles', async () => {
    const rows = await db.select().from(roles).orderBy(desc(roles.createdAt));
    return {
      roles: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        scope: r.scope,
        allow: r.allow,
        deny: r.deny,
        parents: r.parents,
      })),
      vaultPermissions: VAULT_PERMS,
      adminPermissions: ADMIN_PERMS,
      builtin: Object.fromEntries(Object.entries(BUILTIN_VAULT_ROLES).map(([k, v]) => [k, v])),
    };
  });

  /** Что получит назначенный: эффективные полномочия с учётом наследования и запретов. */
  app.get('/admin/roles/:id/effective', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const defs = await loadRoleDefs(db);
    if (!defs.has(id)) throw notFound();
    return { permissions: [...effective([expandRole(defs, id)])].sort() };
  });

  app.post('/admin/roles', async (req, reply) => {
    const { user } = authOf(req);
    const b = parse(body, req.body);
    await assertNotEscalating(req, b);
    await validate(b);
    const id = crypto.randomUUID();
    try {
      await db.insert(roles).values({ id, ...b } as never);
    } catch {
      throw new AppError(409, 'already_exists', 'A role with this name already exists');
    }
    await audit(db, `user:${user.id}`, 'admin.role.create', `role:${id}`, {
      name: b.name,
      scope: b.scope,
    });
    return reply.status(201).send({ id });
  });

  app.put('/admin/roles/:id', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(body, req.body);
    const [cur] = await db.select().from(roles).where(eq(roles.id, id));
    if (!cur) throw notFound();
    if (cur.scope !== b.scope)
      throw new AppError(400, 'validation_error', 'The scope of a role cannot change');
    await assertNotEscalating(req, b);
    await validate(b, id);
    await db
      .update(roles)
      .set({
        name: b.name,
        description: b.description,
        allow: b.allow,
        deny: b.deny,
        parents: b.parents,
        updatedAt: new Date(),
      } as never)
      .where(eq(roles.id, id));
    await audit(db, `user:${user.id}`, 'admin.role.update', `role:${id}`, { name: b.name });
    return { ok: true };
  });

  app.delete('/admin/roles/:id', async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [cur] = await db.select().from(roles).where(eq(roles.id, id));
    if (!cur) throw notFound();
    const used = await roleInUse(ctx, id);
    if (used > 0)
      throw new AppError(
        409,
        'role_in_use',
        'The role is assigned or inherited and cannot be deleted',
        {
          references: used,
        },
      );
    await db.delete(roles).where(eq(roles.id, id));
    await audit(db, `user:${user.id}`, 'admin.role.delete', `role:${id}`);
    return reply.status(204).send();
  });
};
