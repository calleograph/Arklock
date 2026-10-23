import { and, asc, count, eq, isNull, max, ne } from 'drizzle-orm';
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
const OFFER_TTL_MS = 72 * 3_600_000;
interface Offer {
  from: string;
  to: string;
  expiresAt: string;
}

export const chiefRequired = () =>
  new AppError(403, 'chief_required', 'Only the chief administrator can do this');

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
    const [chief] = await db
      .select({ id: users.id, name: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.chief, true));
    const offer = await chiefOffer(db);
    return {
      chief: chief ?? null,
      you: user.chief,
      offer: offer ? { to: await person(offer.to), expiresAt: offer.expiresAt } : null,
    };
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
    if (!offer || offer.to !== user.id) return { offer: null };
    return { offer: { from: await person(offer.from), expiresAt: offer.expiresAt } };
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
        .set({ chief: false, updatedAt: new Date() })
        .where(eq(users.id, prev.id));
      await tx
        .update(users)
        .set({ chief: true, role: 'admin', adminRoleId: null, updatedAt: new Date() })
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
    if (!offer || offer.to !== user.id) throw notFound();
    await db.delete(settings).where(eq(settings.key, CHIEF_OFFER_KEY));
    await audit(db, `user:${user.id}`, 'admin.chief.decline', `user:${offer.from}`);
    return reply.status(204).send();
  });

  /** Обзор организации для главного администратора: пространства и сейфы, только метаданные. */
  app.get('/admin/structure', async (req) => {
    const { user } = authOf(req);
    if (!user.chief) throw chiefRequired();
    const [spaceRows, vaultRows, owners, members, groups, stats] = await Promise.all([
      db.select().from(spaces).orderBy(asc(spaces.createdAt)),
      db
        .select({ id: vaults.id, name: vaults.name, spaceId: vaults.spaceId })
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
    ]);
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
        })),
    }));
  });
};
