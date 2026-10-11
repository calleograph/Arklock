import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { circleWrite, uuid } from '@arklock/contracts';
import { audit } from '../audit.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { circleMembers, circles, ledger, sessions, settings, users } from '../db/schema.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';

/** Настройки, которые администратор может менять через API, и их допустимые значения. */
const SETTINGS: Record<string, z.ZodType> = {
  'registration.mode': z.enum(['closed', 'open']),
  'vaults.creators': z.enum(['admins', 'members']),
  'trash.retentionDays': z.number().int().min(1).max(3650),
  'session.idleHours': z.number().min(0.25).max(720),
  'security.passwordMaxAgeDays': z.number().int().min(0).max(3650),
};
export const SETTING_DEFAULTS: Record<string, unknown> = {
  'registration.mode': 'closed',
  'vaults.creators': 'admins',
  'trash.retentionDays': 30,
  'session.idleHours': 12,
  'security.passwordMaxAgeDays': 365,
};

/** Пользователи, круги, настройки и журнал — только для администратора. */
export const registerAdminDirectoryRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', async (req: FastifyRequest) => {
    if (authOf(req).user.role !== 'admin') throw forbidden();
  });
  const idParam = z.object({ id: uuid });

  // ------------------------------------------------------------------ пользователи

  app.get('/admin/users', async () => {
    const rows = await db.select().from(users).orderBy(asc(users.displayName));
    const lastSeen = await db
      .select({ userId: sessions.userId, at: sql<Date>`max(${sessions.lastSeenAt})` })
      .from(sessions)
      .groupBy(sessions.userId);
    const seen = new Map(lastSeen.map((s) => [s.userId, s.at]));
    return rows.map((u) => ({
      id: u.id,
      name: u.displayName,
      email: u.email,
      role: u.role,
      disabled: !!u.disabledAt,
      createdAt: u.createdAt.toISOString(),
      lastSeenAt: seen.get(u.id) ? new Date(seen.get(u.id)!).toISOString() : null,
    }));
  });

  app.patch('/admin/users/:id', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({ role: z.enum(['admin', 'member']).optional(), disabled: z.boolean().optional() }),
      req.body,
    );
    const [target] = await db.select().from(users).where(eq(users.id, id));
    if (!target) throw notFound();
    const demoting = body.role === 'member' && target.role === 'admin';
    const disabling = body.disabled === true && !target.disabledAt;
    if ((demoting || disabling) && target.role === 'admin') {
      const [{ n } = { n: 0 }] = await db
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, id)));
      if (n === 0)
        throw new AppError(
          409,
          'last_admin',
          'The last active administrator cannot be demoted or disabled',
        );
    }
    if (id === user.id && disabling)
      throw new AppError(409, 'self_disable', 'You cannot disable your own account');
    await db
      .update(users)
      .set({
        ...(body.role ? { role: body.role } : {}),
        ...(body.disabled !== undefined ? { disabledAt: body.disabled ? new Date() : null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));
    // Отключение и смена роли немедленно завершают все сеансы пользователя.
    if (disabling || body.role) {
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)));
    }
    await audit(db, `user:${user.id}`, 'admin.user.update', `user:${id}`, {
      role: body.role ?? null,
      disabled: body.disabled ?? null,
    });
    return { id };
  });

  app.post('/admin/users/:id/revoke-sessions', async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)));
    await audit(db, `user:${user.id}`, 'admin.user.revoke-sessions', `user:${id}`);
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ круги

  app.get('/admin/circles', async () => {
    const rows = await db.select().from(circles).orderBy(asc(circles.name));
    const counts = await db
      .select({ id: circleMembers.circleId, n: count() })
      .from(circleMembers)
      .groupBy(circleMembers.circleId);
    const m = new Map(counts.map((c) => [c.id, c.n]));
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      members: m.get(c.id) ?? 0,
    }));
  });

  app.post('/admin/circles', async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(circleWrite, req.body);
    const id = crypto.randomUUID();
    try {
      await db.insert(circles).values({ id, ...body });
    } catch {
      throw new AppError(409, 'already_exists', 'A circle with this name already exists');
    }
    await audit(db, `user:${user.id}`, 'admin.circle.create', `circle:${id}`);
    return reply.status(201).send({ id });
  });

  app.patch('/admin/circles/:id', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(circleWrite.partial(), req.body);
    const res = await db
      .update(circles)
      .set(body)
      .where(eq(circles.id, id))
      .returning({ id: circles.id });
    if (!res.length) throw notFound();
    await audit(db, `user:${user.id}`, 'admin.circle.update', `circle:${id}`);
    return { id };
  });

  app.delete('/admin/circles/:id', async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    const res = await db.delete(circles).where(eq(circles.id, id)).returning({ id: circles.id });
    if (!res.length) throw notFound();
    await audit(db, `user:${user.id}`, 'admin.circle.delete', `circle:${id}`);
    return reply.status(204).send();
  });

  app.get('/admin/circles/:id/members', async (req) => {
    const { id } = parse(idParam, req.params);
    const rows = await db
      .select({ id: users.id, name: users.displayName, email: users.email })
      .from(circleMembers)
      .innerJoin(users, eq(users.id, circleMembers.userId))
      .where(eq(circleMembers.circleId, id))
      .orderBy(asc(users.displayName));
    return rows;
  });

  app.put('/admin/circles/:id/members/:userId', async (req, reply) => {
    const { user } = authOf(req);
    const { id, userId } = parse(z.object({ id: uuid, userId: uuid }), req.params);
    const [c] = await db.select({ id: circles.id }).from(circles).where(eq(circles.id, id));
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!c || !u) throw notFound();
    await db.insert(circleMembers).values({ circleId: id, userId }).onConflictDoNothing();
    await audit(db, `user:${user.id}`, 'admin.circle.member.add', `circle:${id}`, {
      member: userId,
    });
    return reply.status(204).send();
  });

  app.delete('/admin/circles/:id/members/:userId', async (req, reply) => {
    const { user } = authOf(req);
    const { id, userId } = parse(z.object({ id: uuid, userId: uuid }), req.params);
    const res = await db
      .delete(circleMembers)
      .where(and(eq(circleMembers.circleId, id), eq(circleMembers.userId, userId)))
      .returning();
    if (!res.length) throw notFound();
    await audit(db, `user:${user.id}`, 'admin.circle.member.remove', `circle:${id}`, {
      member: userId,
    });
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ настройки

  app.get('/admin/settings', async () => {
    const rows = await db.select().from(settings);
    const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
    for (const r of rows) if (r.key in SETTINGS) out[r.key] = r.value;
    return out;
  });

  app.put('/admin/settings', async (req) => {
    const { user } = authOf(req);
    const body = parse(z.record(z.string(), z.unknown()), req.body);
    for (const [key, value] of Object.entries(body)) {
      const schema = SETTINGS[key];
      if (!schema)
        throw new AppError(400, 'validation_error', 'Unknown setting', [
          { path: key, code: 'unknown' },
        ]);
      parse(schema, value);
    }
    for (const [key, value] of Object.entries(body)) {
      await db
        .insert(settings)
        .values({ key, value: value as never, updatedBy: user.id })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: value as never, updatedAt: new Date(), updatedBy: user.id },
        });
      await audit(db, `user:${user.id}`, 'admin.setting.change', key, {
        value: typeof value === 'object' ? 'object' : (value as string | number | boolean),
      });
    }
    return { updated: Object.keys(body) };
  });

  // ------------------------------------------------------------------ журнал действий

  app.get('/admin/ledger', async (req) => {
    const q = parse(
      z.object({
        action: z.string().max(100).optional(),
        actor: z.string().max(100).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        q: z.string().max(100).optional(),
        before: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        format: z.enum(['json', 'csv']).default('json'),
      }),
      req.query,
    );
    const conds = [
      q.action
        ? sql`${ledger.action} like ${q.action.replace(/[%_\\]/g, '\\$&') + '%'}`
        : undefined,
      q.actor ? eq(ledger.actor, q.actor) : undefined,
      q.from ? sql`${ledger.at} >= ${q.from}` : undefined,
      q.to ? sql`${ledger.at} <= ${q.to}` : undefined,
      q.before ? sql`${ledger.id} < ${q.before}` : undefined,
      q.q
        ? sql`(${ledger.action} ilike ${'%' + q.q.replace(/[%_\\]/g, '\\$&') + '%'} or ${ledger.target} ilike ${'%' + q.q.replace(/[%_\\]/g, '\\$&') + '%'})`
        : undefined,
    ].filter((c) => c !== undefined);
    const rows = await db
      .select()
      .from(ledger)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(sql`${ledger.id} desc`)
      .limit(q.limit);
    const items = rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actor: r.actor,
      action: r.action,
      target: r.target,
      detail: r.detail,
    }));
    if (q.format === 'csv') {
      const esc = (v: unknown) =>
        `"${String(v ?? '')
          .replace(/"/g, '""')
          .replace(/^([=+\-@])/, "'$1")}"`;
      const csv = [
        'id,at,actor,action,target,detail',
        ...items.map((i) =>
          [i.id, i.at, i.actor, i.action, i.target, JSON.stringify(i.detail ?? '')]
            .map(esc)
            .join(','),
        ),
      ].join('\n');
      return { csv };
    }
    return { items, next: items.length === q.limit ? items[items.length - 1]!.id : null };
  });
};
