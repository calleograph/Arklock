import { and, count, eq, lt, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { uuid } from '@arklock/contracts';
import { audit } from '../audit.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { pinDevices, settings } from '../db/schema.js';
import { AppError, notFound, parse } from '../errors.js';
import { hashProof, randomB64url, verifyProof } from '../security.js';
import { openSetting, sealSetting } from '../secretbox.js';

export const PIN_MAX_FAILURES = 5;
const MAX_DEVICES = 5;
const purpose = (id: string) => `pin-share:${id}`;
const proof = z.string().min(20).max(100);

/**
 * Быстрая разблокировка PIN-кодом на доверенном устройстве. PIN заменяет только повторный ввод мастер-пароля при активном
 * сеансе, но не вход. Мастер-пароль и ключи сервер не получает; на устройстве хранится только шифртекст ключа, который
 * открывается PIN-кодом вместе с долей, выдаваемой сервером после верного PIN. Пять неверных попыток подряд удаляют устройство.
 */
export const registerPinRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));

  const policyOn = async (): Promise<boolean> => {
    const [row] = await db.select().from(settings).where(eq(settings.key, 'security.pinUnlock'));
    return row?.value === true;
  };
  const requirePolicy = async () => {
    if (!(await policyOn()))
      throw new AppError(403, 'pin_disabled', 'PIN unlock is disabled by the administrator');
  };

  app.get('/auth/pin', async (req) => {
    const { user } = authOf(req);
    const rows = await db.select().from(pinDevices).where(eq(pinDevices.userId, user.id));
    return {
      enabled: await policyOn(),
      devices: rows.map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.createdAt.toISOString(),
        lastUsedAt: d.lastUsedAt?.toISOString() ?? null,
      })),
    };
  });

  app.post('/auth/pin', async (req, reply) => {
    const { user } = authOf(req);
    await requirePolicy();
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(60), currentAuthKey: proof, authKey: proof }),
      req.body,
    );
    // мастер-пароль подтверждается заново: украденный сеанс не позволяет завести PIN
    if (!verifyProof(user.authSalt, body.currentAuthKey, user.authHash))
      throw new AppError(401, 'invalid_credentials', 'Current password is incorrect');
    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(pinDevices)
      .where(eq(pinDevices.userId, user.id));
    if (n >= MAX_DEVICES)
      throw new AppError(409, 'conflict', 'Too many PIN devices: remove an unused one first');
    const id = crypto.randomUUID();
    const verifierSalt = randomB64url(16);
    const share = randomB64url(32);
    await db.insert(pinDevices).values({
      id,
      userId: user.id,
      name: body.name,
      verifierSalt,
      verifierHash: hashProof(verifierSalt, body.authKey),
      shareSealed: sealSetting(ctx.config.APP_SECRET, purpose(id), share),
    });
    await audit(db, `user:${user.id}`, 'auth.pin.enable', `pin:${id}`);
    return reply.status(201).send({ deviceId: id, share });
  });

  app.post('/auth/pin/:id/unlock', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { authKey } = parse(z.object({ authKey: proof }), req.body);
    await requirePolicy();
    // Попытка резервируется атомарно до проверки: параллельные запросы не могут проверить больше пяти PIN
    const [d] = await db
      .update(pinDevices)
      .set({ failures: sql`${pinDevices.failures} + 1` })
      .where(
        and(
          eq(pinDevices.id, id),
          eq(pinDevices.userId, user.id),
          lt(pinDevices.failures, PIN_MAX_FAILURES),
        ),
      )
      .returning();
    const lock = async () => {
      await db.delete(pinDevices).where(eq(pinDevices.id, id));
      await audit(db, `user:${user.id}`, 'auth.pin.locked', `pin:${id}`);
      return new AppError(
        423,
        'pin_locked',
        'Too many wrong PIN attempts: use the master password',
      );
    };
    if (!d) {
      const [exists] = await db
        .select({ id: pinDevices.id })
        .from(pinDevices)
        .where(and(eq(pinDevices.id, id), eq(pinDevices.userId, user.id)));
      if (exists) throw await lock();
      throw new AppError(404, 'pin_gone', 'PIN unlock is no longer set up on this device');
    }
    if (!verifyProof(d.verifierSalt, authKey, d.verifierHash)) {
      if (d.failures >= PIN_MAX_FAILURES) throw await lock();
      throw new AppError(401, 'invalid_pin', 'Wrong PIN', {
        remaining: PIN_MAX_FAILURES - d.failures,
      });
    }
    await db
      .update(pinDevices)
      .set({ failures: 0, lastUsedAt: new Date() })
      .where(eq(pinDevices.id, id));
    return { share: openSetting(ctx.config.APP_SECRET, purpose(id), d.shareSealed) };
  });

  app.delete('/auth/pin/:id', async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const res = await db
      .delete(pinDevices)
      .where(and(eq(pinDevices.id, id), eq(pinDevices.userId, user.id)))
      .returning({ id: pinDevices.id });
    if (!res.length) throw notFound();
    await audit(db, `user:${user.id}`, 'auth.pin.remove', `pin:${id}`);
    return reply.status(204).send();
  });
};
