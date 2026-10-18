import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { spaceWrite, uuid, type SpaceInfo } from '@arklock/contracts';
import { audit } from '../audit.js';
import { authOf, requireAuth } from '../auth/session.js';
import { spaces, spaceMembers, spaceCircles, circles, users, vaults } from '../db/schema.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db/connect.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';
import { spaceAccess } from '../spaces.js';

export const registerSpaceRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  const params = z.object({ id: uuid });
  async function manageable(connection: Db, id: string, user: typeof users.$inferSelect) {
    const [space] = await connection.select().from(spaces).where(eq(spaces.id, id));
    if (!space) throw notFound();
    if (user.role !== 'admin' && !(await spaceAccess(connection, id, user.id)).admin)
      throw forbidden();
    return space;
  }
  async function info(
    space: typeof spaces.$inferSelect,
    user: typeof users.$inferSelect,
  ): Promise<SpaceInfo> {
    const access = await spaceAccess(db, space.id, user.id);
    return { ...space, member: access.member, canManage: user.role === 'admin' || access.admin };
  }
  app.get('/spaces', async (req) => {
    const { user } = authOf(req);
    const { manage } = parse(z.object({ manage: z.enum(['0', '1']).default('0') }), req.query);
    const result: SpaceInfo[] = [];
    for (const space of await db.select().from(spaces).orderBy(asc(spaces.createdAt))) {
      const value = await info(space, user);
      if (value.member || (manage === '1' && value.canManage)) result.push(value);
    }
    return result;
  });
  app.post('/spaces', async (req, reply) => {
    const { user } = authOf(req);
    if (user.role !== 'admin') throw forbidden();
    const body = parse(spaceWrite, req.body);
    const id = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(spaces).values({ id, ...body, createdBy: user.id });
      await tx.insert(spaceMembers).values({ spaceId: id, userId: user.id, role: 'admin' });
      await audit(tx, `user:${user.id}`, 'space.create', `space:${id}`, {
        publicToOrg: body.publicToOrg,
      });
    });
    return reply.status(201).send({ id });
  });
  app.get('/spaces/:id', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(params, req.params);
    const [space] = await db.select().from(spaces).where(eq(spaces.id, id));
    if (!space) throw notFound();
    const value = await info(space, user);
    if (!value.member && !value.canManage) throw notFound();
    const [members, groups] = await Promise.all([
      db
        .select({
          userId: users.id,
          name: users.displayName,
          email: users.email,
          role: spaceMembers.role,
        })
        .from(spaceMembers)
        .innerJoin(users, eq(users.id, spaceMembers.userId))
        .where(eq(spaceMembers.spaceId, id)),
      db
        .select({ circleId: circles.id, name: circles.name, role: spaceCircles.role })
        .from(spaceCircles)
        .innerJoin(circles, eq(circles.id, spaceCircles.circleId))
        .where(eq(spaceCircles.spaceId, id)),
    ]);
    const containers = value.canManage
      ? await db
          .select({ id: vaults.id, name: vaults.name })
          .from(vaults)
          .where(eq(vaults.spaceId, id))
      : [];
    return { ...value, members, circles: groups, vaults: containers };
  });
  app.patch('/spaces/:id', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(params, req.params);
    const body = parse(
      spaceWrite.partial().extend({ archived: z.boolean().optional() }).strict(),
      req.body,
    );
    await db.transaction(async (tx) => {
      await tx.select().from(spaces).where(eq(spaces.id, id)).for('update');
      const space = await manageable(tx, id, user);
      if (space.isDefault && (body.archived === true || body.publicToOrg === false))
        throw new AppError(
          409,
          'default_space_required',
          'The default space must remain active and open to the organization',
        );
      await tx.update(spaces).set(body).where(eq(spaces.id, id));
      await audit(tx, `user:${user.id}`, 'space.update', `space:${id}`, {
        archived: body.archived ?? space.archived,
        publicToOrg: body.publicToOrg ?? space.publicToOrg,
      });
    });
    return { id };
  });
  app.delete('/spaces/:id', async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(params, req.params);
    await db.transaction(async (tx) => {
      await tx.select().from(spaces).where(eq(spaces.id, id)).for('update');
      const space = await manageable(tx, id, user);
      if (space.isDefault)
        throw new AppError(409, 'default_space_required', 'The default space cannot be deleted');
      const [container] = await tx
        .select({ id: vaults.id })
        .from(vaults)
        .where(eq(vaults.spaceId, id))
        .limit(1);
      if (container)
        throw new AppError(409, 'space_not_empty', 'Archive this space or move its vaults first');
      await tx.delete(spaces).where(eq(spaces.id, id));
      await audit(tx, `user:${user.id}`, 'space.delete', `space:${id}`);
    });
    return reply.status(204).send();
  });
  for (const subject of ['users', 'circles'] as const) {
    app.put(`/spaces/:id/${subject}/:subjectId`, async (req, reply) => {
      const { user } = authOf(req);
      const { id, subjectId } = parse(params.extend({ subjectId: uuid }), req.params);
      const { role } = parse(z.object({ role: z.enum(['member', 'admin']) }).strict(), req.body);
      await db.transaction(async (tx) => {
        await tx.select().from(spaces).where(eq(spaces.id, id)).for('update');
        await manageable(tx, id, user);
        if (subject === 'users') {
          const [target] = await tx.select().from(users).where(eq(users.id, subjectId));
          if (!target || target.disabledAt) throw notFound();
          await tx
            .insert(spaceMembers)
            .values({ spaceId: id, userId: subjectId, role })
            .onConflictDoUpdate({
              target: [spaceMembers.spaceId, spaceMembers.userId],
              set: { role },
            });
        } else {
          const [target] = await tx.select().from(circles).where(eq(circles.id, subjectId));
          if (!target) throw notFound();
          await tx
            .insert(spaceCircles)
            .values({ spaceId: id, circleId: subjectId, role })
            .onConflictDoUpdate({
              target: [spaceCircles.spaceId, spaceCircles.circleId],
              set: { role },
            });
        }
        await audit(tx, `user:${user.id}`, 'space.member.put', `space:${id}`, {
          subject,
          subjectId,
          role,
        });
      });
      return reply.status(204).send();
    });
    app.delete(`/spaces/:id/${subject}/:subjectId`, async (req, reply) => {
      const { user } = authOf(req);
      const { id, subjectId } = parse(params.extend({ subjectId: uuid }), req.params);
      await db.transaction(async (tx) => {
        await tx.select().from(spaces).where(eq(spaces.id, id)).for('update');
        await manageable(tx, id, user);
        if (subject === 'users')
          await tx
            .delete(spaceMembers)
            .where(and(eq(spaceMembers.spaceId, id), eq(spaceMembers.userId, subjectId)));
        else
          await tx
            .delete(spaceCircles)
            .where(and(eq(spaceCircles.spaceId, id), eq(spaceCircles.circleId, subjectId)));
        await audit(tx, `user:${user.id}`, 'space.member.remove', `space:${id}`, {
          subject,
          subjectId,
        });
      });
      return reply.status(204).send();
    });
  }
  app.put('/spaces/:id/vaults/:vaultId', async (req) => {
    const { user } = authOf(req);
    const { id, vaultId } = parse(params.extend({ vaultId: uuid }), req.params);
    const { targetSpaceId } = parse(z.object({ targetSpaceId: uuid }).strict(), req.body);
    await db.transaction(async (tx) => {
      await manageable(tx, id, user);
      const target = await manageable(tx, targetSpaceId, user);
      if (target.archived)
        throw new AppError(409, 'space_archived', 'Unarchive the target space first');
      const [vault] = await tx.select().from(vaults).where(eq(vaults.id, vaultId)).for('update');
      if (!vault || vault.kind !== 'shared' || vault.spaceId !== id) throw notFound();
      await tx.update(vaults).set({ spaceId: targetSpaceId }).where(eq(vaults.id, vaultId));
      await audit(tx, `user:${user.id}`, 'vault.space.move', `vault:${vaultId}`, {
        fromSpace: id,
        toSpace: targetSpaceId,
      });
    });
    return { id: vaultId, spaceId: targetSpaceId };
  });
};
