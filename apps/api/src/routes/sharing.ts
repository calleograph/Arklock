import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { handoffCreate, signalPatch, signalsPost, uuid } from '@arklock/contracts';
import { requireVault } from '../access.js';
import { audit } from '../audit.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { entries, handoffs, ledger, settings, signals, users, vaults } from '../db/schema.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';
import { AttemptLimiter } from '../rateLimit.js';

/**
 * Передача секретов по ссылке (Handoff): сервер хранит только шифртекст. Ключ ссылки находится во фрагменте URL
 * и серверу неизвестен. Просмотр — отдельный POST (не GET), чтобы предпросмотр ссылок мессенджерами не расходовал просмотры.
 */
export const registerSharingRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db, config } = ctx;
  const openLimiter = new AttemptLimiter(60, 15 * 60_000);
  const auth = requireAuth(ctx);
  const idParam = z.object({ id: uuid });

  // ---- публичная часть (без входа)

  /** Окно после первого открытия закрылось: ссылка больше не действует, даже если просмотры остались. */
  const windowClosed = (h: typeof handoffs.$inferSelect, now = Date.now()) =>
    !!h.openWindowMinutes &&
    !!h.firstOpenedAt &&
    h.firstOpenedAt.getTime() + h.openWindowMinutes * 60_000 <= now;
  const setting = async <T>(key: string, fallback: T): Promise<T> =>
    ((await db.select().from(settings).where(eq(settings.key, key)))[0]?.value as T) ?? fallback;

  app.get('/handoffs/:id/meta', async (req) => {
    const { id } = parse(idParam, req.params);
    const [h] = await db.select().from(handoffs).where(eq(handoffs.id, id));
    // Одинаковый ответ для несуществующих, истёкших и отозванных ссылок: ничего лишнего не раскрываем.
    if (
      !h ||
      h.revokedAt ||
      h.expiresAt.getTime() <= Date.now() ||
      h.views >= h.maxViews ||
      windowClosed(h)
    ) {
      throw new AppError(404, 'handoff_unavailable', 'The link is not available');
    }
    return {
      hasPassphrase: h.hasPassphrase,
      label: '',
      remainingViews: h.maxViews - h.views,
      openWindowMinutes: h.openWindowMinutes,
      notice: await setting('links.notice', ''),
    };
  });

  app.post('/handoffs/:id/open', async (req) => {
    const { id } = parse(idParam, req.params);
    const ip = req.ip ?? 'unknown';
    if (openLimiter.retryAfter(ip) > 0) {
      throw new AppError(429, 'too_many_attempts', 'Too many attempts, try again later');
    }
    // Атомарный учёт просмотра: два одновременных запроса не превысят лимит.
    // окно после первого открытия проверяется в том же условном обновлении, что и число просмотров
    const rows = await db
      .update(handoffs)
      .set({
        views: sql`${handoffs.views} + 1`,
        firstOpenedAt: sql`coalesce(${handoffs.firstOpenedAt}, now())`,
      })
      .where(
        and(
          eq(handoffs.id, id),
          isNull(handoffs.revokedAt),
          gt(handoffs.expiresAt, new Date()),
          lt(handoffs.views, handoffs.maxViews),
          sql`(${handoffs.openWindowMinutes} is null or ${handoffs.firstOpenedAt} is null or ${handoffs.firstOpenedAt} + ${handoffs.openWindowMinutes} * interval '1 minute' > now())`,
        ),
      )
      .returning();
    const h = rows[0];
    if (!h) {
      openLimiter.fail(ip);
      throw new AppError(404, 'handoff_unavailable', 'The link is not available');
    }
    const remaining = h.maxViews - h.views;
    if (remaining <= 0) {
      // Последний просмотр: шифртекст стирается сразу после выдачи (запись остаётся для журнала владельца).
      await db.update(handoffs).set({ ciphertext: '' }).where(eq(handoffs.id, id));
    }
    await audit(db, 'anonymous', 'handoff.open', `handoff:${id}`, { remaining });
    return { ciphertext: h.ciphertext, hasPassphrase: h.hasPassphrase, remainingViews: remaining };
  });

  // ---- управление ссылками

  app.post('/handoffs', { preHandler: auth }, async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(handoffCreate, req.body);
    const [dupe] = await db
      .select({ id: handoffs.id })
      .from(handoffs)
      .where(eq(handoffs.id, body.id));
    if (dupe) throw new AppError(409, 'already_exists', 'Link already exists');
    // ограничения организации проверяет сервер: клиент мог бы прислать любой срок
    const maxMinutes = await setting('links.maxMinutes', 0);
    const maxViews = await setting('links.maxViews', 100);
    if ((maxMinutes > 0 && body.expiresInMinutes > maxMinutes) || body.maxViews > maxViews) {
      throw new AppError(400, 'link_limit', 'The link exceeds the organization limits', {
        maxMinutes,
        maxViews,
      });
    }
    await db.insert(handoffs).values({
      id: body.id,
      createdBy: user.id,
      label: body.label,
      ciphertext: body.ciphertext,
      hasPassphrase: body.hasPassphrase,
      expiresAt: new Date(Date.now() + body.expiresInMinutes * 60_000),
      maxViews: body.maxViews,
      openWindowMinutes: body.openWindowMinutes ?? null,
    });
    await audit(db, `user:${user.id}`, 'handoff.create', `handoff:${body.id}`, {
      maxViews: body.maxViews,
    });
    return reply.status(201).send({ id: body.id });
  });

  app.get('/handoffs', { preHandler: auth }, async (req) => {
    const { user } = authOf(req);
    const rows = await db
      .select()
      .from(handoffs)
      .where(eq(handoffs.createdBy, user.id))
      .orderBy(desc(handoffs.createdAt))
      .limit(200);
    const now = Date.now();
    return rows.map((h) => ({
      id: h.id,
      label: h.label,
      hasPassphrase: h.hasPassphrase,
      createdAt: h.createdAt.toISOString(),
      expiresAt: h.expiresAt.toISOString(),
      maxViews: h.maxViews,
      views: h.views,
      openWindowMinutes: h.openWindowMinutes,
      firstOpenedAt: h.firstOpenedAt?.toISOString() ?? null,
      status: h.revokedAt
        ? 'revoked'
        : h.views >= h.maxViews
          ? 'used'
          : h.expiresAt.getTime() <= now || windowClosed(h, now)
            ? 'expired'
            : 'active',
    }));
  });

  app.delete('/handoffs/:id', { preHandler: auth }, async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    const res = await db
      .update(handoffs)
      .set({ revokedAt: new Date(), ciphertext: '' })
      .where(and(eq(handoffs.id, id), eq(handoffs.createdBy, user.id)))
      .returning({ id: handoffs.id });
    if (!res.length) throw notFound();
    await audit(db, `user:${user.id}`, 'handoff.revoke', `handoff:${id}`);
    return reply.status(204).send();
  });

  // ---- события безопасности (сигналы)

  /** Клиент передаёт результат локального анализа паролей: на сервер попадают только идентификаторы записей и типы проблем. */
  app.post('/vaults/:vaultId/signals', { preHandler: auth }, async (req) => {
    const { user } = authOf(req);
    const { vaultId } = parse(z.object({ vaultId: uuid }), req.params);
    const body = parse(signalsPost, req.body);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.isMember || !access.allows('vault.signals')) throw forbidden();
    const mine = await db
      .select({ id: entries.id, branchId: entries.branchId })
      .from(entries)
      .where(and(eq(entries.vaultId, vaultId), isNull(entries.deletedAt)));
    const allowed = new Set(mine.filter((e) => access.entry(e.id, e.branchId)).map((e) => e.id));
    const items = body.items.filter((i) => allowed.has(i.entryId));
    const now = new Date();
    let created = 0;
    for (const i of items) {
      const res = await db
        .insert(signals)
        .values({
          id: crypto.randomUUID(),
          vaultId,
          entryId: i.entryId,
          type: i.type,
          reportedBy: user.id,
        })
        .onConflictDoNothing()
        .returning({ id: signals.id });
      created += res.length;
      if (res.length) {
        await audit(db, `user:${user.id}`, 'signal.create', `signal:${res[0]!.id}`, {
          vault: vaultId,
        });
        continue;
      }
      // проблема вернулась: решённое событие открывается снова, проигнорированное остаётся решением человека
      const reopened = await db
        .update(signals)
        .set({ status: 'open', assignedTo: null, updatedAt: now })
        .where(
          and(
            eq(signals.entryId, i.entryId),
            eq(signals.type, i.type),
            eq(signals.status, 'resolved'),
          ),
        )
        .returning({ id: signals.id });
      for (const r of reopened)
        await audit(db, `user:${user.id}`, 'signal.reopen', `signal:${r.id}`, { vault: vaultId });
    }
    // Проблемы, которых при полной проверке больше нет, закрываются как устранённые.
    const keep = new Set(items.map((i) => `${i.entryId}:${i.type}`));
    const open = await db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.vaultId, vaultId),
          inArray(signals.type, body.checkedTypes.length ? body.checkedTypes : ['weak']),
          or(eq(signals.status, 'open'), eq(signals.status, 'in_progress')),
        ),
      );
    const gone = open
      .filter((s) => allowed.has(s.entryId) && !keep.has(`${s.entryId}:${s.type}`))
      .map((s) => s.id);
    if (gone.length) {
      await db
        .update(signals)
        .set({ status: 'resolved', updatedAt: now })
        .where(inArray(signals.id, gone));
      for (const g of gone)
        await audit(db, `user:${user.id}`, 'signal.resolve', `signal:${g}`, {
          vault: vaultId,
          auto: true,
        });
    }
    await db.update(vaults).set({ signalsReportedAt: now }).where(eq(vaults.id, vaultId));
    return { created, resolved: gone.length };
  });

  app.get('/vaults/:vaultId/signals', { preHandler: auth }, async (req) => {
    const { user } = authOf(req);
    const { vaultId } = parse(z.object({ vaultId: uuid }), req.params);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.isAdmin) throw forbidden();
    const rows = await db
      .select()
      .from(signals)
      .where(eq(signals.vaultId, vaultId))
      .orderBy(asc(signals.status), desc(signals.createdAt))
      .limit(1000);
    const objects = await db
      .select({ id: entries.id, branchId: entries.branchId })
      .from(entries)
      .where(eq(entries.vaultId, vaultId));
    const allowed = new Set(
      objects.filter((entry) => access.entry(entry.id, entry.branchId)).map((entry) => entry.id),
    );
    const visible = rows.filter((row) => allowed.has(row.entryId));
    const assignees = visible.map((r) => r.assignedTo).filter((x): x is string => !!x);
    const us = assignees.length
      ? await db
          .select({ id: users.id, name: users.displayName })
          .from(users)
          .where(inArray(users.id, assignees))
      : [];
    const names = new Map(us.map((u) => [u.id, u.name]));
    return visible.map((s) => ({
      id: s.id,
      entryId: s.entryId,
      type: s.type,
      status: s.status,
      assignedTo: s.assignedTo,
      assignedName: s.assignedTo ? (names.get(s.assignedTo) ?? null) : null,
      createdAt: s.createdAt.toISOString(),
    }));
  });

  app.patch('/vaults/:vaultId/signals/:signalId', { preHandler: auth }, async (req) => {
    const { user } = authOf(req);
    const { vaultId, signalId } = parse(z.object({ vaultId: uuid, signalId: uuid }), req.params);
    const body = parse(signalPatch, req.body);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.isAdmin) throw forbidden();
    const [s] = await db
      .select()
      .from(signals)
      .where(and(eq(signals.id, signalId), eq(signals.vaultId, vaultId)));
    if (!s) throw notFound();
    const [entry] = await db
      .select({ branchId: entries.branchId })
      .from(entries)
      .where(and(eq(entries.id, s.entryId), eq(entries.vaultId, vaultId)));
    if (!entry || !access.entry(s.entryId, entry.branchId)) throw notFound();
    if (body.assignedTo) {
      const target = await requireVault(db, vaultId, body.assignedTo).catch(() => null);
      if (!target || !target.isAdmin || !target.entry(s.entryId, entry.branchId))
        throw new AppError(
          400,
          'bad_assignee',
          'The assignee must be an administrator of the vault',
        );
    }
    const [row] = await db
      .update(signals)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(signals.id, signalId))
      .returning();
    await audit(db, `user:${user.id}`, 'signal.update', `signal:${signalId}`, {
      vault: vaultId,
      status: body.status ?? null,
      ...(body.assignedTo !== undefined ? { assignedTo: body.assignedTo } : {}),
    });
    return { id: row!.id, status: row!.status, assignedTo: row!.assignedTo };
  });

  /** История события: создание, смены статуса и ответственного, закрытие — из журнала действий. */
  app.get('/vaults/:vaultId/signals/:signalId/history', { preHandler: auth }, async (req) => {
    const { user } = authOf(req);
    const { vaultId, signalId } = parse(z.object({ vaultId: uuid, signalId: uuid }), req.params);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.isAdmin) throw forbidden();
    const [s] = await db
      .select({ entryId: signals.entryId, branchId: entries.branchId })
      .from(signals)
      .innerJoin(entries, eq(entries.id, signals.entryId))
      .where(and(eq(signals.id, signalId), eq(signals.vaultId, vaultId)));
    if (!s || !access.entry(s.entryId, s.branchId)) throw notFound();
    const rows = await db
      .select()
      .from(ledger)
      .where(eq(ledger.target, `signal:${signalId}`))
      .orderBy(asc(ledger.id))
      .limit(200);
    const detailOf = (d: unknown) => (d ?? {}) as Record<string, unknown>;
    const ids = [
      ...new Set(
        rows.flatMap((r) => [
          r.actor.startsWith('user:') ? r.actor.slice(5) : '',
          String(detailOf(r.detail).assignedTo ?? ''),
        ]),
      ),
    ].filter((x) => /^[0-9a-f-]{36}$/.test(x));
    const people = ids.length
      ? await db
          .select({ id: users.id, name: users.displayName })
          .from(users)
          .where(inArray(users.id, ids))
      : [];
    const names = new Map(people.map((p) => [p.id, p.name]));
    return rows.map((r) => {
      const d = detailOf(r.detail);
      const assigned = typeof d.assignedTo === 'string' ? d.assignedTo : null;
      return {
        at: r.at.toISOString(),
        action: r.action,
        actorName: r.actor.startsWith('user:') ? (names.get(r.actor.slice(5)) ?? null) : null,
        status: typeof d.status === 'string' ? d.status : null,
        assigned: d.assignedTo === undefined ? undefined : assigned,
        assignedName: assigned ? (names.get(assigned) ?? null) : null,
        auto: d.auto === true,
        clientReported: d.clientReported === true,
        reason: typeof d.reason === 'string' ? d.reason : null,
      };
    });
  });

  void config;
};
