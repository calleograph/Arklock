import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { uuid } from '@arklock/contracts';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { circles, invitations, users } from '../db/schema.js';
import { AppError, notFound, parse } from '../errors.js';
import { sendMail } from '../mail/send.js';
import { invitationTokenHash, newActivationCode } from '../activation.js';

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  /** Имя учётной записи; пользователь подтверждает его при активации. */
  displayName: z.string().trim().min(1).max(100).optional(),
  role: z.enum(['admin', 'member']).default('member'),
  circleIds: z.array(uuid).max(50).default([]),
  expiresInDays: z.number().int().min(1).max(60).default(7),
  /** Отправить ссылку письмом (если настроена почта). */
  sendEmail: z.boolean().default(false),
});

/** Приглашения: ссылка на регистрацию при закрытой регистрации. Токен показывается один раз, в базе хранится его SHA-256. */
export const registerInvitationRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db, config } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', async (req: FastifyRequest) => {
    await adminGate(ctx, req);
  });

  app.get('/admin/invitations', async () => {
    const rows = await db
      .select()
      .from(invitations)
      .orderBy(desc(invitations.createdAt))
      .limit(200);
    const now = Date.now();
    return rows.map((i) => ({
      id: i.id,
      email: i.email,
      displayName: i.displayName,
      role: i.role,
      circleIds: i.circleIds as string[],
      createdAt: i.createdAt.toISOString(),
      expiresAt: i.expiresAt.toISOString(),
      status: i.usedAt
        ? 'used'
        : i.revokedAt
          ? 'revoked'
          : i.expiresAt.getTime() <= now
            ? 'expired'
            : 'pending',
    }));
  });

  app.post('/admin/invitations', async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(createSchema, req.body);
    const [exists] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, body.email));
    if (exists)
      throw new AppError(409, 'already_exists', 'A user with this address already exists');
    if (body.circleIds.length) {
      const known = await db
        .select({ id: circles.id })
        .from(circles)
        .where(inArray(circles.id, body.circleIds));
      if (known.length !== new Set(body.circleIds).size)
        throw new AppError(400, 'validation_error', 'Unknown circle');
    }
    // повторное приглашение отзывает предыдущие неиспользованные для этого адреса
    await db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitations.email, body.email),
          isNull(invitations.revokedAt),
          isNull(invitations.usedAt),
        ),
      );
    // код активации показывается один раз; в базе хранится только его хэш
    const token = newActivationCode();
    const id = crypto.randomUUID();
    await db.insert(invitations).values({
      id,
      email: body.email,
      displayName: body.displayName ?? null,
      role: body.role,
      tokenHash: invitationTokenHash(token),
      circleIds: body.circleIds as never,
      createdBy: user.id,
      expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000),
    });
    const base = config.APP_PUBLIC_URL?.replace(/\/$/, '') ?? '';
    const link = `${base}/login?invite=${encodeURIComponent(token)}`;
    let emailed = false;
    if (body.sendEmail)
      emailed = await sendMail(
        ctx,
        body.email,
        'Arklock: приглашение / invitation',
        `Вас пригласили в Arklock. Создайте учётную запись по ссылке (действует ${body.expiresInDays} дн.):\n${link}\n\nYou have been invited to Arklock. Create your account here (valid for ${body.expiresInDays} days):\n${link}\n`,
      );
    await audit(db, `user:${user.id}`, 'admin.invitation.create', `invitation:${id}`, { emailed });
    return reply.status(201).send({ id, code: token, link, emailed });
  });

  app.delete('/admin/invitations/:id', async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const res = await db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(eq(invitations.id, id))
      .returning({ id: invitations.id });
    if (!res.length) throw notFound();
    await audit(db, `user:${user.id}`, 'admin.invitation.revoke', `invitation:${id}`);
    return reply.status(204).send();
  });
};
