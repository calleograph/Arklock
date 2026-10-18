import { and, count, desc, eq, gt, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { email, uuid } from '@arklock/contracts';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { mailQueue, settings } from '../db/schema.js';
import { AppError, notFound, parse } from '../errors.js';
import { sealSetting } from '../secretbox.js';
import {
  activeSmtpId,
  loadSmtpProfile,
  loadStoredSmtp,
  publicSmtp,
  SMTP_ACTIVE_KEY,
  smtpPasswordPurpose,
  smtpProfileId,
  smtpProfileKey,
  smtpProfiles,
  smtpPut,
  toSmtpConfig,
  type StoredSmtp,
} from '../mail/profiles.js';
import { enqueueMail, mailFailure, sendQueuedMail } from '../mail/send.js';
import { smtpSession } from '../mail/smtp.js';
import {
  loadMailTemplates,
  MAIL_NOTIFICATIONS_KEY,
  MAIL_TEMPLATES_KEY,
  mailNotificationPreferences,
  mailType,
  notificationWrite,
  previewTemplate,
  renderMail,
  templateVariables,
  templateWrite,
  validTemplate,
} from '../mail/templates.js';

export const registerAdminSmtpRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', (req) => adminGate(ctx, req));
  const params = z.object({ id: smtpProfileId });
  const profileWrite = smtpPut.extend({ name: z.string().trim().min(1).max(100) }).strict();

  async function saveProfile(
    id: string,
    body: z.infer<typeof smtpPut> & { name?: string },
    userId: string,
  ) {
    const previous = await loadSmtpProfile(ctx, id);
    const value: StoredSmtp = {
      host: body.host,
      port: body.port,
      security: body.security,
      user: body.user,
      from: body.from,
      name: body.name ?? previous?.name ?? 'Default',
      passwordCipher:
        body.password === undefined
          ? (previous?.passwordCipher ?? '')
          : body.password
            ? sealSetting(ctx.config.APP_SECRET, smtpPasswordPurpose(id), body.password)
            : '',
    };
    await db
      .insert(settings)
      .values({ key: smtpProfileKey(id), value, updatedBy: userId })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedBy: userId, updatedAt: new Date() },
      });
    await audit(db, `user:${userId}`, 'admin.smtp.save', `smtp:${id}`, {
      host: body.host,
      port: body.port,
    });
  }
  app.get('/admin/smtp', async () => {
    const stored = await loadStoredSmtp(ctx);
    if (!stored) return { configured: false };
    const config: Partial<ReturnType<typeof publicSmtp>> = { ...publicSmtp(stored) };
    delete config.id;
    delete config.name;
    return { configured: true, ...config };
  });
  app.put('/admin/smtp', async (req) => {
    const { user } = authOf(req);
    const body = parse(smtpPut, req.body);
    const id = (await activeSmtpId(ctx)) ?? 'default';
    await saveProfile(id, body, user.id);
    await db
      .insert(settings)
      .values({ key: SMTP_ACTIVE_KEY, value: id, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: id, updatedBy: user.id, updatedAt: new Date() },
      });
    return { ok: true };
  });
  app.get('/admin/smtp/profiles', () => smtpProfiles(ctx));
  app.post('/admin/smtp/profiles', async (req, reply) => {
    const { user } = authOf(req);
    const id = crypto.randomUUID();
    await saveProfile(id, parse(profileWrite, req.body), user.id);
    return reply.status(201).send({ id });
  });
  app.put('/admin/smtp/profiles/:id', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(params, req.params);
    if (!(await loadSmtpProfile(ctx, id))) throw notFound();
    await saveProfile(id, parse(profileWrite, req.body), user.id);
    return { ok: true };
  });
  app.put('/admin/smtp/active', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: smtpProfileId.nullable() }).strict(), req.body);
    if (id && !(await loadSmtpProfile(ctx, id))) throw notFound();
    await db
      .insert(settings)
      .values({ key: SMTP_ACTIVE_KEY, value: id, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: id, updatedBy: user.id, updatedAt: new Date() },
      });
    await audit(db, `user:${user.id}`, 'admin.smtp.activate', id ? `smtp:${id}` : null);
    return { ok: true };
  });
  app.delete('/admin/smtp/profiles/:id', async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(params, req.params);
    const activeId = await activeSmtpId(ctx);
    await db.transaction(async (tx) => {
      const [sending] = await tx
        .select({ id: mailQueue.id })
        .from(mailQueue)
        .where(and(eq(mailQueue.profileId, id), eq(mailQueue.status, 'sending')))
        .limit(1);
      if (sending)
        throw new AppError(
          409,
          'smtp_profile_busy',
          'Wait until the in-flight delivery finishes before deleting this profile',
        );
      const removed = await tx
        .delete(settings)
        .where(eq(settings.key, smtpProfileKey(id)))
        .returning({ key: settings.key });
      if (!removed.length) throw notFound();
      if (activeId === id)
        await tx
          .insert(settings)
          .values({ key: SMTP_ACTIVE_KEY, value: null, updatedBy: user.id })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: null, updatedBy: user.id, updatedAt: new Date() },
          });
      await tx
        .update(mailQueue)
        .set({
          status: 'failed',
          payloadCipher: '',
          lastCode: 'profile_removed',
          updatedAt: new Date(),
        })
        .where(and(eq(mailQueue.profileId, id), inArray(mailQueue.status, ['queued', 'failed'])));
    });
    await audit(db, `user:${user.id}`, 'admin.smtp.remove', `smtp:${id}`);
    return reply.status(204).send();
  });

  for (const base of ['/admin/smtp', '/admin/smtp/profiles/:id']) {
    app.post(`${base}/test`, async (req) => {
      const { user } = authOf(req);
      const id = (req.params as { id?: string }).id;
      const profile = id
        ? await loadSmtpProfile(ctx, parse(smtpProfileId, id))
        : await loadStoredSmtp(ctx);
      if (!profile) throw new AppError(409, 'smtp_not_configured', 'SMTP is not configured');
      try {
        const response = await smtpSession(toSmtpConfig(ctx, profile), null);
        await audit(db, `user:${user.id}`, 'admin.smtp.test', `smtp:${profile.profileId}`, {
          ok: true,
        });
        return { ok: true, banner: response.banner.slice(0, 200) };
      } catch (error) {
        const failure = mailFailure(error);
        await audit(db, `user:${user.id}`, 'admin.smtp.test', `smtp:${profile.profileId}`, {
          ok: false,
          code: failure.code,
          smtpStatus: failure.smtpStatus,
        });
        return { ok: false, ...failure };
      }
    });
    app.post(`${base}/send-test`, async (req) => {
      const { user } = authOf(req);
      const id = (req.params as { id?: string }).id;
      const profile = id
        ? await loadSmtpProfile(ctx, parse(smtpProfileId, id))
        : await loadStoredSmtp(ctx);
      if (!profile) throw new AppError(409, 'smtp_not_configured', 'SMTP is not configured');
      const address = email.safeParse((req.body as { to?: unknown } | undefined)?.to);
      if (!address.success)
        return { ok: false, code: 'invalid', message: 'Invalid recipient address' };
      const rendered = await renderMail(ctx, 'test');
      const queuedId = await enqueueMail(
        ctx,
        address.data,
        rendered.subject,
        rendered.text,
        'test',
        profile.profileId,
      );
      if (!queuedId) throw new AppError(409, 'mail_queue_full', 'Mail queue is full');
      const sent = await sendQueuedMail(ctx, queuedId);
      await audit(db, `user:${user.id}`, 'admin.smtp.send-test', `mail:${queuedId}`, {
        ok: sent?.status === 'sent',
      });
      return {
        ok: sent?.status === 'sent',
        queued: sent?.status === 'queued',
        id: queuedId,
        code: sent?.lastCode ?? undefined,
        smtpStatus: sent?.smtpStatus ?? undefined,
      };
    });
  }

  app.get('/admin/smtp/queue', async (req) => {
    const q = parse(
      z.object({
        status: z.enum(['queued', 'sending', 'sent', 'failed']).optional(),
        offset: z.coerce.number().int().min(0).max(1000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    const where = q.status ? eq(mailQueue.status, q.status) : undefined;
    const [items, totals] = await Promise.all([
      db
        .select({
          id: mailQueue.id,
          profileId: mailQueue.profileId,
          to: mailQueue.to,
          type: mailQueue.type,
          status: mailQueue.status,
          attempts: mailQueue.attempts,
          nextAttemptAt: mailQueue.nextAttemptAt,
          lastCode: mailQueue.lastCode,
          smtpStatus: mailQueue.lastSmtpStatus,
          createdAt: mailQueue.createdAt,
          deliveredAt: mailQueue.deliveredAt,
        })
        .from(mailQueue)
        .where(where)
        .orderBy(desc(mailQueue.createdAt))
        .limit(q.limit)
        .offset(q.offset),
      db
        .select({ status: mailQueue.status, count: count() })
        .from(mailQueue)
        .groupBy(mailQueue.status),
    ]);
    return {
      items,
      totals,
      total: totals
        .filter((row) => !q.status || row.status === q.status)
        .reduce((sum, row) => sum + row.count, 0),
    };
  });
  app.post('/admin/smtp/queue/:id/retry', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [row] = await db.select().from(mailQueue).where(eq(mailQueue.id, id));
    if (!row || row.status !== 'failed' || !row.payloadCipher || row.expiresAt <= new Date())
      throw new AppError(
        409,
        'mail_not_retryable',
        'This message has expired or cannot be retried',
      );
    if (!(await loadSmtpProfile(ctx, row.profileId)))
      throw new AppError(409, 'smtp_not_configured', 'The message SMTP profile is unavailable');
    await db
      .update(mailQueue)
      .set({
        status: 'queued',
        attempts: 0,
        lastCode: null,
        lastSmtpStatus: null,
        nextAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mailQueue.id, id),
          eq(mailQueue.status, 'failed'),
          gt(mailQueue.expiresAt, new Date()),
        ),
      );
    await audit(db, `user:${user.id}`, 'admin.smtp.mail.retry', `mail:${id}`, {
      previousAttempts: row.attempts,
    });
    return { ok: true };
  });
  app.get('/admin/smtp/templates', async () => {
    const templates = await loadMailTemplates(ctx);
    return mailType.options.map((id) => ({
      id,
      ...templates[id],
      variables: templateVariables[id],
      preview: previewTemplate(id, templates[id]),
    }));
  });
  app.put('/admin/smtp/templates/:id', async (req) => {
    const { user } = authOf(req);
    const id = parse(mailType, (req.params as { id: string }).id);
    const body = parse(templateWrite, req.body);
    if (!validTemplate(id, body))
      throw new AppError(400, 'template_invalid', 'Use only the listed template placeholders');
    const templates = { ...(await loadMailTemplates(ctx)), [id]: body };
    await db
      .insert(settings)
      .values({ key: MAIL_TEMPLATES_KEY, value: templates, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: templates, updatedBy: user.id, updatedAt: new Date() },
      });
    await audit(db, `user:${user.id}`, 'admin.smtp.template.save', `mail-template:${id}`);
    return { ok: true };
  });
  app.post('/admin/smtp/templates/:id/preview', async (req) => {
    const id = parse(mailType, (req.params as { id: string }).id);
    const body = parse(templateWrite, req.body);
    if (!validTemplate(id, body))
      throw new AppError(400, 'template_invalid', 'Use only the listed template placeholders');
    return previewTemplate(id, body);
  });
  app.get('/admin/smtp/notifications', () => mailNotificationPreferences(ctx));
  app.put('/admin/smtp/notifications', async (req) => {
    const { user } = authOf(req);
    const body = parse(notificationWrite, req.body);
    await db.transaction(async (tx) => {
      for (const [key, value] of [
        [MAIL_NOTIFICATIONS_KEY, body],
        ['notifications.security', body.security],
      ] as const)
        await tx
          .insert(settings)
          .values({ key, value, updatedBy: user.id })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedBy: user.id, updatedAt: new Date() },
          });
    });
    await audit(db, `user:${user.id}`, 'admin.smtp.notifications.save');
    return { ok: true };
  });
};
