import { and, asc, count, eq, inArray, isNull, max, ne } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { uuid } from '@arklock/contracts';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import { requireReauth } from '../auth/reauth.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db/connect.js';
import {
  entries,
  sessions,
  settings,
  signals,
  spaces,
  users,
  vaultCircles,
  vaultMembers,
  vaults,
} from '../db/schema.js';
import { AppError, notFound, parse } from '../errors.js';
import { notifyUsers } from '../notifications.js';
import { verifyProof } from '../security.js';
import { recordFailure, throttle } from './auth.js';

export const CHIEF_OFFER_KEY = 'chief.transfer';
/** Предложения стать ещё одним главным администратором: у предлагающего роль остаётся, предложений может быть несколько. */
export const CHIEF_ADD_KEY = 'chief.add';
const OFFER_TTL_MS = 72 * 3_600_000;
interface Offer {
  from: string;
  to: string;
  expiresAt: string;
}

export const chiefRequired = () =>
  new AppError(403, 'chief_required', 'Only the chief administrator can do this');

async function addOffers(db: Db): Promise<Offer[]> {
  const [row] = await db.select().from(settings).where(eq(settings.key, CHIEF_ADD_KEY));
  const list = (row?.value as Offer[] | undefined) ?? [];
  return list.filter((o) => Date.parse(o.expiresAt) > Date.now());
}
async function saveAddOffers(
  db: Db | Parameters<Parameters<Db['transaction']>[0]>[0],
  list: Offer[],
  by: string,
) {
  await db
    .insert(settings)
    .values({ key: CHIEF_ADD_KEY, value: list, updatedBy: by })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: list, updatedBy: by, updatedAt: new Date() },
    });
}

/** Действующее предложение передать роль главного администратора (просроченное не действует). */
export async function chiefOffer(db: Db): Promise<Offer | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, CHIEF_OFFER_KEY));
  const offer = row?.value as Offer | undefined;
  return offer && Date.parse(offer.expiresAt) > Date.now() ? offer : null;
}

/**
 * Главный администратор. Роль не теряется: её можно только передать, и преемник подтверждает приём своим
 * мастер-паролем. Роль даёт обзор метаданных организации; содержимое сейфов она не открывает — серверного
 * мастер-ключа нет. С получателем корпоративного восстановления роль не связана.
 */
export const registerChiefRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', async (req: FastifyRequest) => {
    if (req.url.startsWith('/api/v1/admin/')) await adminGate(ctx, req);
  });
  const person = async (id: string) => {
    const [u] = await db
      .select({ id: users.id, name: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, id));
    return u ?? null;
  };

  app.get('/admin/chief', async (req) => {
    const { user } = authOf(req);
    const chiefs = await db
      .select({
        id: users.id,
        name: users.displayName,
        email: users.email,
        authSource: users.authSource,
        since: users.chiefSince,
        disabled: users.disabledAt,
      })
      .from(users)
      .where(eq(users.chief, true))
      .orderBy(asc(users.chiefSince), asc(users.displayName));
    const offer = await chiefOffer(db);
    const adds = await addOffers(db);
    return {
      // первый по дате назначения: поле оставлено для прежних клиентов
      chief: chiefs[0] ? { id: chiefs[0].id, name: chiefs[0].name, email: chiefs[0].email } : null,
      chiefs: chiefs.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        authSource: c.authSource,
        since: c.since?.toISOString() ?? null,
        disabled: !!c.disabled,
      })),
      you: user.chief,
      offer: offer ? { to: await person(offer.to), expiresAt: offer.expiresAt } : null,
      offers: await Promise.all(
        adds.map(async (o) => ({ to: await person(o.to), expiresAt: o.expiresAt })),
      ),
    };
  });

  /** Предложить стать ещё одним главным администратором: роль появится только после подтверждения мастер-паролем. */
  app.post('/admin/chief/appoint', async (req) => {
    const { user } = authOf(req);
    if (!user.chief) throw chiefRequired();
    requireReauth(ctx, req);
    const { userId } = parse(z.object({ userId: uuid }).strict(), req.body);
    const [target] = await db.select().from(users).where(eq(users.id, userId));
    if (!target || target.disabledAt) throw notFound();
    if (target.chief)
      throw new AppError(409, 'conflict', 'The person is already a chief administrator');
    const list = (await addOffers(db)).filter((o) => o.to !== userId);
    const offer: Offer = {
      from: user.id,
      to: userId,
      expiresAt: new Date(Date.now() + OFFER_TTL_MS).toISOString(),
    };
    await saveAddOffers(db, [...list, offer], user.id);
    await audit(db, `user:${user.id}`, 'admin.chief.appoint', `user:${userId}`);
    await notifyUsers(db, [userId], {
      category: 'security',
      event: 'admin.chief.offer',
      resourceType: 'account',
    });
    return { expiresAt: offer.expiresAt };
  });

  app.delete('/admin/chief/appoint/:id', async (req, reply) => {
    const { user } = authOf(req);
    if (!user.chief) throw chiefRequired();
    const { id } = parse(z.object({ id: uuid }), req.params);
    const list = await addOffers(db);
    await saveAddOffers(
      db,
      list.filter((o) => o.to !== id),
      user.id,
    );
    await audit(db, `user:${user.id}`, 'admin.chief.cancel', `user:${id}`);
    return reply.status(204).send();
  });

  /**
   * Отозвать роль главного администратора (у себя или у другого). Последнего главного отозвать нельзя.
   * Человек остаётся полным администратором: снять и это можно обычным изменением роли.
   */
  app.delete('/admin/chief/:id', async (req, reply) => {
    const { user } = authOf(req);
    if (!user.chief) throw chiefRequired();
    requireReauth(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await db.transaction(async (tx) => {
      const active = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.chief, true), isNull(users.disabledAt)))
        .for('update');
      const [target] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (!target?.chief) throw notFound();
      // остаться должен хотя бы один действующий главный администратор
      if (!active.some((a) => a.id !== id))
        throw new AppError(409, 'last_chief', 'The last chief administrator cannot be removed');
      await tx
        .update(users)
        .set({ chief: false, chiefSince: null, updatedAt: new Date() })
        .where(eq(users.id, id));
      // права сменились: сеансы завершаются (свой текущий сохраняется)
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(sessions.userId, id),
            isNull(sessions.revokedAt),
            id === user.id ? ne(sessions.id, authOf(req).session.id) : undefined,
          ),
        );
      await audit(tx, `user:${user.id}`, 'admin.chief.remove', `user:${id}`);
    });
    await notifyUsers(db, [id], {
      category: 'security',
      event: 'admin.chief.removed',
      resourceType: 'account',
    });
    return reply.status(204).send();
  });

  app.post('/admin/chief/transfer', async (req) => {
    const { user } = authOf(req);
    if (!user.chief) throw chiefRequired();
    requireReauth(ctx, req);
    const { userId } = parse(z.object({ userId: uuid }).strict(), req.body);
    if (userId === user.id)
      throw new AppError(409, 'conflict', 'You already are the chief administrator');
    const [target] = await db.select().from(users).where(eq(users.id, userId));
    if (!target || target.disabledAt) throw notFound();
    const offer: Offer = {
      from: user.id,
      to: userId,
      expiresAt: new Date(Date.now() + OFFER_TTL_MS).toISOString(),
    };
    await db
      .insert(settings)
      .values({ key: CHIEF_OFFER_KEY, value: offer, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: offer, updatedBy: user.id, updatedAt: new Date() },
      });
    await audit(db, `user:${user.id}`, 'admin.chief.offer', `user:${userId}`);
    await notifyUsers(db, [userId], {
      category: 'security',
      event: 'admin.chief.offer',
      resourceType: 'account',
    });
    return { expiresAt: offer.expiresAt };
  });

  app.delete('/admin/chief/transfer', async (req, reply) => {
    const { user } = authOf(req);
    if (!user.chief) throw chiefRequired();
    const offer = await chiefOffer(db);
    await db.delete(settings).where(eq(settings.key, CHIEF_OFFER_KEY));
    if (offer) await audit(db, `user:${user.id}`, 'admin.chief.cancel', `user:${offer.to}`);
    return reply.status(204).send();
  });

  /** Предложение адресовано мне? (для карточки в «Безопасности»; доступно и не администратору). */
  app.get('/auth/chief-offer', async (req) => {
    const { user } = authOf(req);
    const offer = await chiefOffer(db);
    if (offer && offer.to === user.id)
      return {
        offer: { from: await person(offer.from), expiresAt: offer.expiresAt, mode: 'transfer' },
      };
    const add = (await addOffers(db)).find((o) => o.to === user.id);
    if (!add) return { offer: null };
    return { offer: { from: await person(add.from), expiresAt: add.expiresAt, mode: 'add' } };
  });

  app.post('/auth/chief-offer/accept', async (req) => {
    const { user, session, viaToken } = authOf(req);
    if (viaToken) throw new AppError(403, 'forbidden', 'Not available with an API token');
    const { authKey } = parse(z.object({ authKey: z.string().min(20).max(100) }), req.body);
    throttle(ctx, req, `chief:${user.email}`);
    if (!verifyProof(user.authSalt, authKey, user.authHash)) {
      recordFailure(ctx, req, `chief:${user.email}`);
      throw new AppError(401, 'invalid_credentials', 'Master password is incorrect');
    }
    const transfer = await chiefOffer(db);
    if (!transfer || transfer.to !== user.id) {
      // предложение «стать ещё одним главным»: у предложившего роль остаётся
      const add = (await addOffers(db)).find((o) => o.to === user.id);
      if (!add) throw notFound();
      await db.transaction(async (tx) => {
        const [prev] = await tx.select().from(users).where(eq(users.id, add.from));
        if (!prev?.chief) throw new AppError(409, 'conflict', 'The offer is no longer valid');
        await tx
          .update(users)
          .set({
            chief: true,
            chiefSince: new Date(),
            role: 'admin',
            adminRoleId: null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));
        await saveAddOffers(
          tx,
          (await addOffers(tx)).filter((o) => o.to !== user.id),
          user.id,
        );
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(sessions.userId, user.id),
              isNull(sessions.revokedAt),
              ne(sessions.id, session.id),
            ),
          );
        await audit(tx, `user:${user.id}`, 'admin.chief.accept', `user:${add.from}`);
      });
      await notifyUsers(db, [add.from], {
        category: 'security',
        event: 'admin.chief.accepted',
        resourceType: 'account',
      });
      return { chief: true };
    }
    const from = await db.transaction(async (tx) => {
      // одна передача за раз: повторный приём или встречная передача ждут завершения
      const [row] = await tx
        .select()
        .from(settings)
        .where(eq(settings.key, CHIEF_OFFER_KEY))
        .for('update');
      const offer = row?.value as Offer | undefined;
      if (!offer || offer.to !== user.id || Date.parse(offer.expiresAt) <= Date.now())
        throw notFound();
      const [prev] = await tx.select().from(users).where(eq(users.id, offer.from)).for('update');
      if (!prev?.chief) throw new AppError(409, 'conflict', 'The offer is no longer valid');
      await tx
        .update(users)
        .set({ chief: false, chiefSince: null, updatedAt: new Date() })
        .where(eq(users.id, prev.id));
      await tx
        .update(users)
        .set({
          chief: true,
          chiefSince: new Date(),
          role: 'admin',
          adminRoleId: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
      await tx.delete(settings).where(eq(settings.key, CHIEF_OFFER_KEY));
      // права сменились у обоих: прежние сеансы завершаются (текущий сеанс преемника — подтверждён сейчас)
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, prev.id), isNull(sessions.revokedAt)));
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(sessions.userId, user.id),
            isNull(sessions.revokedAt),
            ne(sessions.id, session.id),
          ),
        );
      await audit(tx, `user:${user.id}`, 'admin.chief.accept', `user:${prev.id}`);
      return prev.id;
    });
    await notifyUsers(db, [from], {
      category: 'security',
      event: 'admin.chief.accepted',
      resourceType: 'account',
    });
    return { chief: true };
  });

  app.post('/auth/chief-offer/decline', async (req, reply) => {
    const { user } = authOf(req);
    const offer = await chiefOffer(db);
    if (offer && offer.to === user.id) {
      await db.delete(settings).where(eq(settings.key, CHIEF_OFFER_KEY));
      await audit(db, `user:${user.id}`, 'admin.chief.decline', `user:${offer.from}`);
      return reply.status(204).send();
    }
    const list = await addOffers(db);
    const add = list.find((o) => o.to === user.id);
    if (!add) throw notFound();
    await saveAddOffers(
      db,
      list.filter((o) => o.to !== user.id),
      user.id,
    );
    await audit(db, `user:${user.id}`, 'admin.chief.decline', `user:${add.from}`);
    return reply.status(204).send();
  });

  /** Обзор организации для главного администратора: пространства и сейфы, только метаданные. */
  app.get('/admin/structure', async (req) => {
    const { user } = authOf(req);
    if (!user.chief) throw chiefRequired();
    const [spaceRows, vaultRows, owners, members, groups, stats, open] = await Promise.all([
      db.select().from(spaces).orderBy(asc(spaces.createdAt)),
      db
        .select({
          id: vaults.id,
          name: vaults.name,
          spaceId: vaults.spaceId,
          checkedAt: vaults.signalsReportedAt,
        })
        .from(vaults)
        .where(eq(vaults.kind, 'shared'))
        .orderBy(asc(vaults.name)),
      db
        .select({ vaultId: vaultMembers.vaultId, name: users.displayName })
        .from(vaultMembers)
        .innerJoin(users, eq(users.id, vaultMembers.userId))
        .where(eq(vaultMembers.role, 'owner')),
      db
        .select({ vaultId: vaultMembers.vaultId, n: count() })
        .from(vaultMembers)
        .groupBy(vaultMembers.vaultId),
      db
        .select({ vaultId: vaultCircles.vaultId, n: count() })
        .from(vaultCircles)
        .groupBy(vaultCircles.vaultId),
      db
        .select({ vaultId: entries.vaultId, n: count(), last: max(entries.updatedAt) })
        .from(entries)
        .where(isNull(entries.deletedAt))
        .groupBy(entries.vaultId),
      // открытые события безопасности: только метаданные, которые сообщили браузеры и сервер
      db
        .select({ vaultId: signals.vaultId, type: signals.type, n: count() })
        .from(signals)
        .innerJoin(entries, and(eq(entries.id, signals.entryId), isNull(entries.deletedAt)))
        .where(inArray(signals.status, ['open', 'in_progress']))
        .groupBy(signals.vaultId, signals.type),
    ]);
    const HIGH = new Set(['compromised', 'rotate']);
    const security = (vaultId: string) => {
      const rows = open.filter((o) => o.vaultId === vaultId);
      const sum = (high: boolean) =>
        rows.filter((r) => HIGH.has(r.type) === high).reduce((a, r) => a + r.n, 0);
      return {
        high: sum(true),
        medium: sum(false),
        byType: Object.fromEntries(rows.map((r) => [r.type, r.n])),
      };
    };
    const by = <T extends { vaultId: string }>(rows: T[]) =>
      new Map(rows.map((r) => [r.vaultId, r]));
    const [m, g, s] = [by(members), by(groups), by(stats)];
    return spaceRows.map((sp) => ({
      id: sp.id,
      name: sp.name,
      archived: sp.archived,
      publicToOrg: sp.publicToOrg,
      isDefault: sp.isDefault,
      vaults: vaultRows
        .filter((v) => v.spaceId === sp.id)
        .map((v) => ({
          id: v.id,
          name: v.name,
          owners: owners.filter((o) => o.vaultId === v.id).map((o) => o.name),
          members: m.get(v.id)?.n ?? 0,
          groups: g.get(v.id)?.n ?? 0,
          entries: s.get(v.id)?.n ?? 0,
          lastChange: s.get(v.id)?.last ? new Date(s.get(v.id)!.last!).toISOString() : null,
          security: { ...security(v.id), checkedAt: v.checkedAt?.toISOString() ?? null },
        })),
    }));
  });
};
