import { and, count, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { uuid } from '@arklock/contracts';
import { loadAccess } from '../access.js';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db/connect.js';
import { corporateAccessRisks } from '../corporate-continuity.js';
import {
  apiTokens,
  circleMembers,
  circles,
  entries,
  grants,
  handoffs,
  pinDevices,
  sessions,
  signals,
  spaceMembers,
  spaces,
  users,
  vaultKeys,
  vaultMembers,
  vaults,
} from '../db/schema.js';
import { chiefRequired } from './chief.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';
import { notifyUsers } from '../notifications.js';
import { hasPasskey, hasTotp } from '../auth/mfa.js';
import { spaceAccess } from '../spaces.js';

const ROTATE_MAX = 2000;

/**
 * «Смените пароль» после увольнения сотрудника — одно общее событие по всем его записям: всего, открыто
 * и сколько из них может разобрать просматривающий (как в списке событий сейфа: администратор сейфа и доступ к записи).
 */
async function rotationOf(db: Db, causeId: string, viewerId: string) {
  const rows = await db
    .select({
      vaultId: signals.vaultId,
      entryId: signals.entryId,
      branchId: entries.branchId,
      status: signals.status,
      name: vaults.name,
      kind: vaults.kind,
    })
    .from(signals)
    .innerJoin(entries, eq(entries.id, signals.entryId))
    .innerJoin(vaults, eq(vaults.id, signals.vaultId))
    .where(and(eq(signals.type, 'rotate'), eq(signals.causeUserId, causeId)));
  if (!rows.length) return null;
  const isOpen = (s: string) => s === 'open' || s === 'in_progress';
  const out: { id: string; name: string | null; total: number; open: number; available: number }[] =
    [];
  for (const vaultId of new Set(rows.map((r) => r.vaultId))) {
    const list = rows.filter((r) => r.vaultId === vaultId);
    const acc = await loadAccess(db, vaultId, viewerId);
    out.push({
      id: vaultId,
      name: list[0]!.kind === 'shared' ? list[0]!.name : null,
      total: list.length,
      open: list.filter((r) => isOpen(r.status)).length,
      available: acc.isAdmin ? list.filter((r) => acc.entry(r.entryId, r.branchId)).length : 0,
    });
  }
  const sum = (k: 'total' | 'open' | 'available') => out.reduce((n, v) => n + v[k], 0);
  return { total: sum('total'), open: sum('open'), available: sum('available'), vaults: out };
}

/** Корпоративные сейфы сотрудника: роль, число живых записей и другие действующие владельцы. */
async function heldVaults(db: Db, userId: string) {
  const mine = await db
    .select({
      id: vaults.id,
      name: vaults.name,
      role: vaultMembers.role,
      keyVersion: vaults.keyVersion,
    })
    .from(vaultMembers)
    .innerJoin(vaults, eq(vaults.id, vaultMembers.vaultId))
    .where(and(eq(vaultMembers.userId, userId), eq(vaults.kind, 'shared')));
  const out = [];
  for (const v of mine) {
    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(entries)
      .where(and(eq(entries.vaultId, v.id), isNull(entries.deletedAt)));
    const owners = await db
      .select({ id: vaultMembers.userId })
      .from(vaultMembers)
      .innerJoin(users, eq(users.id, vaultMembers.userId))
      .where(
        and(
          eq(vaultMembers.vaultId, v.id),
          eq(vaultMembers.role, 'owner'),
          ne(vaultMembers.userId, userId),
          isNull(users.disabledAt),
        ),
      );
    out.push({
      id: v.id,
      name: v.name ?? '',
      role: v.role,
      entries: n,
      otherOwners: owners.length,
      lastOwner: v.role === 'owner' && owners.length === 0,
    });
  }
  return out;
}

export const registerOffboardingRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', (req) => adminGate(ctx, req));
  const idParam = z.object({ id: uuid });

  /**
   * Что связано с сотрудником: группы, сеансы, сейфы, токены и ссылки — без содержимого и ключей.
   * Один ответ для карточки пользователя и для предпросмотра увольнения.
   */
  const profile = async (req: FastifyRequest) => {
    const { id } = parse(idParam, req.params);
    const [target] = await db.select().from(users).where(eq(users.id, id));
    if (!target) throw notFound();
    const [[tokens], [links], [sess]] = await Promise.all([
      db
        .select({ n: count() })
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, id), isNull(apiTokens.revokedAt))),
      db
        .select({ n: count() })
        .from(handoffs)
        .where(and(eq(handoffs.createdBy, id), isNull(handoffs.revokedAt))),
      db
        .select({ n: count() })
        .from(sessions)
        .where(and(eq(sessions.userId, id), isNull(sessions.revokedAt))),
    ]);
    const [groups, sessionList] = await Promise.all([
      db
        .select({ id: circles.id, name: circles.name, adminRoleId: circles.adminRoleId })
        .from(circleMembers)
        .innerJoin(circles, eq(circles.id, circleMembers.circleId))
        .where(eq(circleMembers.userId, id)),
      db
        .select({
          id: sessions.id,
          createdAt: sessions.createdAt,
          lastSeenAt: sessions.lastSeenAt,
          ip: sessions.ip,
          userAgent: sessions.userAgent,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, id),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, new Date()),
          ),
        ),
    ]);
    const memberOf: { id: string; name: string; isDefault: boolean }[] = [];
    for (const s of await db.select().from(spaces))
      if ((await spaceAccess(db, s.id, id)).member)
        memberOf.push({ id: s.id, name: s.name, isDefault: s.isDefault });
    return {
      user: {
        id,
        name: target.displayName,
        email: target.email,
        title: target.title,
        department: target.department,
        phone: target.phone,
        profileSource: target.profileSource,
        disabled: !!target.disabledAt,
        disabledReason: target.disabledAt ? target.disabledReason : null,
        accessUntil: target.accessUntil?.toISOString() ?? null,
        disabledNote: target.disabledAt ? target.disabledNote : null,
        disabledAt: target.disabledAt?.toISOString() ?? null,
        role: target.role,
        chief: target.chief,
        adminRoleId: target.adminRoleId,
        authSource: target.authSource,
        createdAt: target.createdAt.toISOString(),
      },
      mfa: { totp: await hasTotp(ctx, id), passkey: await hasPasskey(ctx, id) },
      spaces: memberOf,
      groups,
      sessionList: sessionList.map((x) => ({
        ...x,
        createdAt: x.createdAt.toISOString(),
        lastSeenAt: x.lastSeenAt.toISOString(),
      })),
      vaults: await heldVaults(db, id),
      accessRisks: await corporateAccessRisks(db, id),
      rotation: await rotationOf(db, id, authOf(req).user.id),
      apiTokens: tokens?.n ?? 0,
      externalLinks: links?.n ?? 0,
      sessions: sess?.n ?? 0,
    };
  };
  app.get('/admin/users/:id/offboarding', profile);
  app.get('/admin/users/:id/profile', profile);

  /** Справочные поля карточки. Поля, пришедшие из каталога, меняются только в каталоге. */
  app.patch('/admin/users/:id/profile', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    const text = z.string().trim().max(200);
    const body = parse(
      z
        .object({
          displayName: text.min(1).optional(),
          title: text.nullable().optional(),
          department: text.nullable().optional(),
          phone: text.max(50).nullable().optional(),
        })
        .strict(),
      req.body,
    );
    const [target] = await db.select().from(users).where(eq(users.id, id));
    if (!target) throw notFound();
    if (user.role !== 'admin' && target.role === 'admin') throw forbidden();
    const synced = Object.keys(body).filter((k) => target.profileSource[k] === 'ldap');
    if (synced.length)
      throw new AppError(409, 'synced_field', 'These fields come from the directory', {
        fields: synced,
      });
    const blank = (v: string | null | undefined) => (v === undefined ? undefined : v || null);
    await db
      .update(users)
      .set({
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.title !== undefined ? { title: blank(body.title) } : {}),
        ...(body.department !== undefined ? { department: blank(body.department) } : {}),
        ...(body.phone !== undefined ? { phone: blank(body.phone) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));
    await audit(db, `user:${user.id}`, 'admin.user.profile', `user:${id}`, {
      fields: Object.keys(body).join(','),
    });
    return { id };
  });

  app.post('/admin/users/:id/offboard', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        /** Передача владения: сейф → новый владелец, уже имеющий текущий ключ сейфа. */
        transfers: z
          .array(z.object({ vaultId: uuid, toUserId: uuid }))
          .max(200)
          .default([]),
        acknowledgeAccessRisk: z.boolean().optional(),
      }),
      req.body,
    );
    if (id === user.id) throw new AppError(409, 'self_disable', 'You cannot offboard yourself');
    const [target] = await db.select().from(users).where(eq(users.id, id));
    if (!target) throw notFound();
    if (target.disabledAt) throw new AppError(409, 'conflict', 'The account is already disabled');
    // выдача владения — решение полного администратора: делегат не должен получать им доступ к сейфам
    if (user.role !== 'admin' && (target.role === 'admin' || body.transfers.length))
      throw forbidden();
    if (target.chief)
      throw new AppError(409, 'chief_admin', 'Transfer the chief administrator role first');
    if (target.role === 'admin' && !user.chief) throw chiefRequired();
    if (target.role === 'admin') {
      const [{ n } = { n: 0 }] = await db
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, id)));
      if (n === 0)
        throw new AppError(409, 'last_admin', 'The last active administrator cannot be offboarded');
    }

    const result = await db.transaction(async (tx) => {
      // увольнения выполняются по одному: иначе двое совладельцев могли бы оставить сейф без владельца
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('arklock.offboard'))`);
      const txDb = tx as unknown as Db;
      const held = await heldVaults(txDb, id);
      const newOwners = new Set<string>();
      for (const t of body.transfers) {
        const v = held.find((h) => h.id === t.vaultId);
        if (!v || t.toUserId === id) throw new AppError(400, 'validation_error', 'Bad transfer');
        const [vault] = await tx.select().from(vaults).where(eq(vaults.id, t.vaultId));
        const [heir] = await tx
          .select({ id: users.id })
          .from(users)
          .innerJoin(
            vaultMembers,
            and(eq(vaultMembers.userId, users.id), eq(vaultMembers.vaultId, t.vaultId)),
          )
          .innerJoin(
            vaultKeys,
            and(
              eq(vaultKeys.userId, users.id),
              eq(vaultKeys.vaultId, t.vaultId),
              eq(vaultKeys.keyVersion, vault!.keyVersion),
            ),
          )
          .where(and(eq(users.id, t.toUserId), isNull(users.disabledAt)));
        if (!heir)
          throw new AppError(
            409,
            'key_missing',
            'The new owner must be an active vault member with the current key',
          );
        await tx
          .update(vaultMembers)
          .set({ role: 'owner', customRoleId: null, expiresAt: null })
          .where(and(eq(vaultMembers.vaultId, t.vaultId), eq(vaultMembers.userId, t.toUserId)));
        newOwners.add(t.toUserId);
      }
      const after = await heldVaults(txDb, id);
      const orphaned = after.filter((v) => v.lastOwner);
      if (orphaned.length)
        throw new AppError(409, 'last_owner', 'Transfer ownership of these vaults first', {
          vaults: orphaned.map((v) => ({ id: v.id, name: v.name })),
        });
      const risks = await corporateAccessRisks(txDb, id);
      if (risks.length && !body.acknowledgeAccessRisk)
        throw new AppError(
          409,
          'corporate_access_at_risk',
          'Transfer corporate vault access before offboarding, or acknowledge the risk',
          { vaults: risks },
        );

      // пароли записей, которые сотрудник мог видеть, стоит сменить: событие «требуется смена пароля»
      // по каждой (доступ считается до удаления членства; повторное увольнение открывает событие снова)
      const rotate: { id: string; vault: string }[] = [];
      for (const v of after) {
        const acc = await loadAccess(txDb, v.id, id);
        const rows = await tx
          .select({ id: entries.id, branchId: entries.branchId })
          .from(entries)
          .where(and(eq(entries.vaultId, v.id), isNull(entries.deletedAt)));
        // shortcut: не больше ROTATE_MAX событий на сейф; для сейфов крупнее остаётся ротация ключа из ответа
        for (const e of rows.filter((r) => acc.entry(r.id, r.branchId)).slice(0, ROTATE_MAX)) {
          const [sig] = await tx
            .insert(signals)
            .values({
              id: crypto.randomUUID(),
              vaultId: v.id,
              entryId: e.id,
              type: 'rotate',
              reportedBy: user.id,
              causeUserId: id,
            })
            .onConflictDoUpdate({
              target: [signals.entryId, signals.type],
              set: { status: 'open', assignedTo: null, causeUserId: id, updatedAt: new Date() },
            })
            .returning({ id: signals.id });
          rotate.push({ id: sig!.id, vault: v.id });
        }
      }

      const vaultIds = after.map((v) => v.id);
      if (vaultIds.length) {
        await tx
          .delete(vaultMembers)
          .where(and(eq(vaultMembers.userId, id), inArray(vaultMembers.vaultId, vaultIds)));
        await tx
          .delete(vaultKeys)
          .where(and(eq(vaultKeys.userId, id), inArray(vaultKeys.vaultId, vaultIds)));
      }
      await tx.delete(pinDevices).where(eq(pinDevices.userId, id));
      await tx.delete(circleMembers).where(eq(circleMembers.userId, id));
      await tx.delete(spaceMembers).where(eq(spaceMembers.userId, id));
      await tx.delete(grants).where(and(eq(grants.subjectType, 'user'), eq(grants.subjectId, id)));
      const now = new Date();
      const tokens = await tx
        .update(apiTokens)
        .set({ revokedAt: now })
        .where(and(eq(apiTokens.userId, id), isNull(apiTokens.revokedAt)))
        .returning({ id: apiTokens.id });
      const links = await tx
        .update(handoffs)
        .set({ revokedAt: now })
        .where(and(eq(handoffs.createdBy, id), isNull(handoffs.revokedAt)))
        .returning({ id: handoffs.id });
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)));
      await tx
        .update(users)
        .set({
          disabledAt: now,
          disabledReason: 'offboarding',
          disabledNote: null,
          disabledBy: user.id,
          adminRoleId: null,
          updatedAt: now,
        })
        .where(eq(users.id, id));
      return {
        after,
        tokens: tokens.length,
        links: links.length,
        newOwners: [...newOwners],
        rotate,
      };
    });

    // участники затронутых сейфов узнают, что ключ сейфа стоит заменить
    const managers = result.after.length
      ? await db
          .select({ id: vaultMembers.userId })
          .from(vaultMembers)
          .where(
            and(
              inArray(
                vaultMembers.vaultId,
                result.after.map((v) => v.id),
              ),
              or(eq(vaultMembers.role, 'owner'), eq(vaultMembers.role, 'admin')),
            ),
          )
      : [];
    await notifyUsers(db, [...new Set([...managers.map((m) => m.id), ...result.newOwners])], {
      category: 'access',
      event: 'admin.user.offboarded',
      resourceType: 'user',
      resourceId: id,
    });
    for (const r of result.rotate)
      await audit(db, `user:${user.id}`, 'signal.create', `signal:${r.id}`, {
        vault: r.vault,
        reason: 'offboarding',
        user: id,
      });
    await audit(db, `user:${user.id}`, 'admin.user.offboard', `user:${id}`, {
      vaults: result.after.length,
      transfers: body.transfers.length,
      tokensRevoked: result.tokens,
      linksRevoked: result.links,
      accessRiskAcknowledged: body.acknowledgeAccessRisk === true,
    });
    return {
      id,
      /** Сейфы, ключ которых сотрудник мог сохранить: стоит выполнить ротацию ключа и сменить хранившиеся там пароли. */
      rotateVaults: result.after.map((v) => ({ id: v.id, name: v.name, entries: v.entries })),
      tokensRevoked: result.tokens,
      linksRevoked: result.links,
      /** Записи, по которым открыто событие «требуется смена пароля». */
      rotateEntries: result.rotate.length,
    };
  });
};
