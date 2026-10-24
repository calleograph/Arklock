import { and, count, desc, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import {
  branches,
  entries,
  handoffs,
  notificationPreferences,
  userNotifications,
} from '../db/schema.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';
import { requireVault } from '../access.js';
import { observeUpdaterNotifications } from '../notifications.js';

const defaults = { access: true, security: true, sharing: true, system: true };
const idParam = z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export const registerNotificationRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', async (req) => {
    if (authOf(req).viaToken) throw forbidden();
  });
  app.get('/notifications', async (req) => {
    const { user } = authOf(req);
    if (user.role === 'admin') await observeUpdaterNotifications(ctx);
    const query = parse(
      z.object({
        view: z.enum(['inbox', 'unread', 'archived']).default('inbox'),
        before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    const mine = eq(userNotifications.userId, user.id);
    const [items, unread] = await Promise.all([
      db
        .select()
        .from(userNotifications)
        .where(
          and(
            mine,
            query.view === 'archived'
              ? isNotNull(userNotifications.archivedAt)
              : isNull(userNotifications.archivedAt),
            query.view === 'unread' ? isNull(userNotifications.readAt) : undefined,
            query.before ? lt(userNotifications.id, query.before) : undefined,
          ),
        )
        .orderBy(desc(userNotifications.id))
        .limit(query.limit),
      db
        .select({ count: count() })
        .from(userNotifications)
        .where(and(mine, isNull(userNotifications.readAt), isNull(userNotifications.archivedAt))),
    ]);
    return {
      items: items.map(({ userId: _user, ...row }) => {
        void _user;
        return row;
      }),
      unread: unread[0]?.count ?? 0,
      next: items.length === query.limit ? items.at(-1)!.id : null,
    };
  });
  app.get('/notifications/preferences', async (req) => {
    const [row] = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, authOf(req).user.id));
    return row
      ? { access: row.access, security: row.security, sharing: row.sharing, system: row.system }
      : defaults;
  });
  app.put('/notifications/preferences', async (req) => {
    const { user } = authOf(req);
    const body = parse(
      z
        .object({
          access: z.boolean(),
          security: z.boolean(),
          sharing: z.boolean(),
          system: z.boolean(),
        })
        .strict(),
      req.body,
    );
    await db
      .insert(notificationPreferences)
      .values({ userId: user.id, ...body })
      .onConflictDoUpdate({ target: notificationPreferences.userId, set: body });
    return body;
  });
  app.post('/notifications/read-all', async (req) => {
    await db
      .update(userNotifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(userNotifications.userId, authOf(req).user.id),
          isNull(userNotifications.readAt),
          isNull(userNotifications.archivedAt),
        ),
      );
    return { ok: true };
  });
  app.post('/notifications/archive-all', async (req) => {
    await db
      .update(userNotifications)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(userNotifications.userId, authOf(req).user.id),
          isNull(userNotifications.archivedAt),
        ),
      );
    return { ok: true };
  });
  app.patch('/notifications/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z
        .object({ read: z.boolean().optional(), archived: z.boolean().optional() })
        .strict()
        .refine((v) => v.read !== undefined || v.archived !== undefined),
      req.body,
    );
    const [row] = await db
      .update(userNotifications)
      .set({
        ...(body.read !== undefined ? { readAt: body.read ? new Date() : null } : {}),
        ...(body.archived !== undefined ? { archivedAt: body.archived ? new Date() : null } : {}),
      })
      .where(and(eq(userNotifications.id, id), eq(userNotifications.userId, authOf(req).user.id)))
      .returning({ id: userNotifications.id });
    if (!row) throw notFound();
    return row;
  });
  app.get('/notifications/:id/destination', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    const [row] = await db
      .select()
      .from(userNotifications)
      .where(and(eq(userNotifications.id, id), eq(userNotifications.userId, user.id)));
    if (!row) throw notFound();
    const unavailable = () =>
      new AppError(
        404,
        'notification_target_unavailable',
        'This notification no longer has an accessible target',
      );
    if (row.resourceType === 'account') return { path: '/security' };
    if (row.resourceType === 'system') {
      if (user.role !== 'admin') throw unavailable();
      return { path: '/admin/overview' };
    }
    if (row.resourceType === 'updates') {
      if (user.role !== 'admin') throw unavailable();
      return { path: '/admin/updates' };
    }
    if (row.resourceType === 'circle') return { path: '/' };
    if (row.resourceType === 'handoff' && row.resourceId) {
      const [link] = await db
        .select({ id: handoffs.id })
        .from(handoffs)
        .where(and(eq(handoffs.id, row.resourceId), eq(handoffs.createdBy, user.id)));
      if (!link) throw unavailable();
      return { path: '/notifications' };
    }
    if (!row.vaultId) throw unavailable();
    const access = await requireVault(db, row.vaultId, user.id).catch(() => null);
    if (!access) throw unavailable();
    // отчёт о событиях безопасности ведёт к их списку в настройках сейфа — он только для администратора сейфа
    if (row.resourceType === 'signals') {
      if (!access.isAdmin) throw unavailable();
      return { path: `/vault/${row.vaultId}/settings`, vaultId: row.vaultId };
    }
    if (row.resourceType === 'entry' && row.resourceId) {
      const [entry] = await db
        .select({ branchId: entries.branchId })
        .from(entries)
        .where(
          and(
            eq(entries.id, row.resourceId),
            eq(entries.vaultId, row.vaultId),
            isNull(entries.deletedAt),
          ),
        );
      if (!entry || !access.entry(row.resourceId, entry.branchId)) throw unavailable();
      return { path: `/?vault=${row.vaultId}&entry=${row.resourceId}`, vaultId: row.vaultId };
    }
    if (row.resourceType === 'branch' && row.resourceId) {
      const [branch] = await db
        .select({ id: branches.id })
        .from(branches)
        .where(
          and(
            eq(branches.id, row.resourceId),
            eq(branches.vaultId, row.vaultId),
            isNull(branches.deletedAt),
          ),
        );
      if (!branch || !access.branch(row.resourceId)) throw unavailable();
    }
    return { path: '/', vaultId: row.vaultId };
  });
};
