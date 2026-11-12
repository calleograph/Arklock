import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { uuid } from '@arklock/contracts';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import { readLdapProfiles } from '../auth/ldap-profiles.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db/connect.js';
import {
  circleMembers,
  circles,
  grants,
  spaceCircles,
  spaceMembers,
  spaces,
  users,
  vaultCircles,
  vaults,
} from '../db/schema.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';
import { spaceAccess } from '../spaces.js';

/** Разделитель в названии сейфа руководства: «Отдел · Руководство». */
const SEP = ' · ';

/**
 * Подразделение — закрытое пространство и группа с тем же названием (так их создаёт мастер). Здесь карточка, изменение
 * названия и описания (пространство, группа и сейфы отдела меняются вместе) и удаление пустого подразделения.
 * Состав и руководителей меняют существующие разделы: участников группы — `/admin/circles/:id/members`, роль в пространстве —
 * `/spaces/:id/users/:userId`.
 */
export const registerDepartmentRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', (req) => adminGate(ctx, req));
  const params = z.object({ id: uuid });

  /** Подразделение по пространству; право — полный администратор или администратор этого пространства. */
  async function load(conn: Db, id: string, user: typeof users.$inferSelect) {
    const [row] = await conn
      .select({ space: spaces, circle: circles })
      .from(spaces)
      .innerJoin(spaceCircles, eq(spaceCircles.spaceId, spaces.id))
      .innerJoin(circles, and(eq(circles.id, spaceCircles.circleId), eq(circles.name, spaces.name)))
      .where(and(eq(spaces.id, id), eq(spaces.isDefault, false), eq(spaces.publicToOrg, false)));
    if (!row) throw notFound();
    if (user.role !== 'admin' && !(await spaceAccess(conn, id, user.id)).admin) throw forbidden();
    return row;
  }

  app.get('/admin/departments/:id', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(params, req.params);
    const { space, circle } = await load(db, id, user);
    const [heads, vs, [members], profiles, guests] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.displayName,
          email: users.email,
          pending: users.pendingActivation,
        })
        .from(spaceMembers)
        .innerJoin(users, eq(users.id, spaceMembers.userId))
        .where(and(eq(spaceMembers.spaceId, id), eq(spaceMembers.role, 'admin')))
        .orderBy(asc(users.displayName)),
      db
        .select({ id: vaults.id, name: vaults.name, role: vaultCircles.role })
        .from(vaults)
        .leftJoin(
          vaultCircles,
          and(eq(vaultCircles.vaultId, vaults.id), eq(vaultCircles.circleId, circle.id)),
        )
        .where(and(eq(vaults.spaceId, id), eq(vaults.kind, 'shared')))
        .orderBy(asc(vaults.name)),
      db
        .select({
          n: sql<number>`count(*)::int`,
          waiting: sql<number>`count(*) filter (where ${users.pendingActivation})::int`,
        })
        .from(circleMembers)
        .innerJoin(users, eq(users.id, circleMembers.userId))
        .where(eq(circleMembers.circleId, circle.id)),
      readLdapProfiles(db),
      db
        .select({
          id: users.id,
          name: users.displayName,
          email: users.email,
          pending: users.pendingActivation,
        })
        .from(spaceMembers)
        .innerJoin(users, eq(users.id, spaceMembers.userId))
        .where(and(eq(spaceMembers.spaceId, id), eq(spaceMembers.guest, true)))
        .orderBy(asc(users.displayName))
        .limit(100),
    ]);
    return {
      id: space.id,
      circleId: circle.id,
      name: space.name,
      description: space.description,
      archived: space.archived,
      heads,
      guests,
      vaults: vs,
      members: members?.n ?? 0,
      waiting: members?.waiting ?? 0,
      directoryLinks: profiles.reduce(
        (n, p) => n + p.groups.filter((g) => g.circleId === circle.id).length,
        0,
      ),
    };
  });

  /** Название и описание: пространство, группа и сейфы отдела меняются вместе, чтобы подразделение осталось целым. */
  app.patch('/admin/departments/:id', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(params, req.params);
    const body = parse(
      z
        .object({
          name: z.string().trim().min(1).max(100).optional(),
          description: z.string().trim().max(2000).optional(),
        })
        .strict(),
      req.body,
    );
    await db.transaction(async (tx) => {
      await tx.select().from(spaces).where(eq(spaces.id, id)).for('update');
      const { space, circle } = await load(tx as unknown as Db, id, user);
      const next = body.name ?? space.name;
      if (next !== space.name) {
        const [taken] = await tx
          .select({ id: circles.id })
          .from(circles)
          .where(and(eq(circles.name, next), ne(circles.id, circle.id)));
        if (taken) throw new AppError(409, 'name_taken', 'A group with this name already exists');
        await tx.update(circles).set({ name: next }).where(eq(circles.id, circle.id));
        // «Отдел» и «Отдел · Руководство» переименовываются вместе; чужие сейфы пространства не затрагиваются
        for (const v of await tx
          .select({ id: vaults.id, name: vaults.name })
          .from(vaults)
          .where(eq(vaults.spaceId, id)))
          if (v.name && (v.name === space.name || v.name.startsWith(space.name + SEP)))
            await tx
              .update(vaults)
              .set({ name: next + v.name!.slice(space.name.length) })
              .where(eq(vaults.id, v.id));
      }
      await tx
        .update(spaces)
        .set({
          name: next,
          ...(body.description !== undefined ? { description: body.description } : {}),
        })
        .where(eq(spaces.id, id));
      await tx
        .update(circles)
        .set({ ...(body.description !== undefined ? { description: body.description } : {}) })
        .where(eq(circles.id, circle.id));
      await audit(tx, `user:${user.id}`, 'admin.department.update', `space:${id}`, {
        renamed: next !== space.name,
      });
    });
    return { id };
  });

  /**
   * Убрать гостя: он выходит из подразделения вместе со всеми выданными ему доступами к папкам и записям этих сейфов.
   * Ключ сейфа у него остаётся, поэтому после этого стоит обновить ключ сейфа (в настройках сейфа).
   */
  app.delete('/admin/departments/:id/guests/:userId', async (req, reply) => {
    const { user } = authOf(req);
    const { id, userId } = parse(z.object({ id: uuid, userId: uuid }), req.params);
    await db.transaction(async (tx) => {
      await load(tx as unknown as Db, id, user);
      const gone = await tx
        .delete(spaceMembers)
        .where(
          and(
            eq(spaceMembers.spaceId, id),
            eq(spaceMembers.userId, userId),
            eq(spaceMembers.guest, true),
          ),
        )
        .returning({ u: spaceMembers.userId });
      if (!gone.length) throw notFound();
      await tx
        .delete(grants)
        .where(
          and(
            eq(grants.subjectType, 'user'),
            eq(grants.subjectId, userId),
            sql`${grants.vaultId} in (select id from ${vaults} where space_id = ${id})`,
          ),
        );
      await audit(tx, `user:${user.id}`, 'admin.department.guest.remove', `space:${id}`, {
        guest: userId,
      });
    });
    return reply.status(204).send();
  });

  /** Удаление пустого подразделения. Группа удаляется, если она больше нигде не используется. */
  app.delete('/admin/departments/:id', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(params, req.params);
    let circleDeleted = false;
    await db.transaction(async (tx) => {
      await tx.select().from(spaces).where(eq(spaces.id, id)).for('update');
      const { circle } = await load(tx as unknown as Db, id, user);
      const [vault] = await tx
        .select({ id: vaults.id })
        .from(vaults)
        .where(eq(vaults.spaceId, id))
        .limit(1);
      if (vault)
        throw new AppError(
          409,
          'space_not_empty',
          'Archive this department or move its vaults first',
        );
      await tx.delete(spaces).where(eq(spaces.id, id));
      const [elsewhere] = await tx
        .select({ c: vaultCircles.circleId })
        .from(vaultCircles)
        .where(eq(vaultCircles.circleId, circle.id))
        .limit(1);
      const [otherSpace] = await tx
        .select({ c: spaceCircles.circleId })
        .from(spaceCircles)
        .where(eq(spaceCircles.circleId, circle.id))
        .limit(1);
      const linked = (await readLdapProfiles(tx as unknown as Db)).some((p) =>
        p.groups.some((g) => g.circleId === circle.id),
      );
      if (!elsewhere && !otherSpace && !linked) {
        await tx.delete(circles).where(eq(circles.id, circle.id));
        circleDeleted = true;
      }
      await audit(tx, `user:${user.id}`, 'admin.department.delete', `space:${id}`, {
        circleDeleted,
      });
    });
    return { circleDeleted };
  });
};
