import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { email, uuid } from '@arklock/contracts';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import { requireReauth } from '../auth/reauth.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { mailQueue, settings } from '../db/schema.js';
import { AppError, notFound, parse } from '../errors.js';
import { sealSetting } from '../secretbox.js';
import {
  activeSmtpId,
  authOf as authMethodOf,
  loadSmtpProfile,
  loadStoredSmtp,
  loadTrustedCas,
  loopbackAllowed,
  parseCaPem,
  publicSmtp,
  recordSmtpStatus,
  SMTP_ACTIVE_KEY,
  SMTP_CA_KEY,
  smtpPasswordPurpose,
  smtpProfileId,
  smtpProfileKey,
  smtpProfiles,
  smtpPut,
  toSmtpConfig,
  type StoredSmtp,
} from '../mail/profiles.js';
import { enqueueMail, mailFailure, sendQueuedMail } from '../mail/send.js';
import { serverText, smtpSession, type StageResult } from '../mail/smtp.js';
import { isForbiddenSmtpAddress } from '../mail/target.js';
import net from 'node:net';
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
import { chiefRequired } from './chief.js';

/** Скользящее окно по ключу: не больше `max` событий за `windowMs`. В памяти процесса. */
class Window {
  private readonly hits = new Map<string, number[]>();
  take(key: string, max: number, windowMs: number, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

export const registerAdminSmtpRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', (req) => adminGate(ctx, req));
  const params = z.object({ id: smtpProfileId });
  const profileWrite = smtpPut.extend({ name: z.string().trim().min(1).max(100) }).strict();

  // тестовые письма и проверки: не чаще лимита на администратора и на сервер, одна проверка профиля за раз
  const limits = new Window();
  const running = new Set<string>();
  const throttle = (userId: string, kind: 'check' | 'mail'): void => {
    const per =
      kind === 'mail' ? ctx.config.SMTP_TEST_MAILS_PER_10MIN : ctx.config.SMTP_CHECKS_PER_10MIN;
    const all = per * 4;
    if (
      !limits.take(`${kind}:${userId}`, per, 10 * 60_000) ||
      !limits.take(`${kind}:*`, all, 10 * 60_000)
    )
      throw new AppError(
        429,
        'smtp_rate_limited',
        'Too many test requests. Try again in a few minutes',
      );
  };
  const exclusive = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (running.has(key))
      throw new AppError(409, 'smtp_busy', 'A check of this profile is already running');
    running.add(key);
    try {
      return await fn();
    } finally {
      running.delete(key);
    }
  };

  async function saveProfile(
    id: string,
    body: z.infer<typeof smtpPut> & { name?: string },
    req: FastifyRequest,
  ) {
    const { user } = authOf(req);
    const previous = await loadSmtpProfile(ctx, id);
    const auth = body.auth ?? authMethodOf({ auth: undefined, user: body.user });
    if (auth !== 'none' && !body.user)
      throw new AppError(
        400,
        'smtp_account_required',
        'Specify the account for this sign-in method',
      );
    if (auth === 'ntlm' && body.security === 'none')
      throw new AppError(400, 'smtp_ntlm_needs_tls', 'NTLM is only used over STARTTLS or SSL/TLS');
    if (net.isIP(body.host) && isForbiddenSmtpAddress(body.host, loopbackAllowed(ctx)))
      throw new AppError(
        400,
        'smtp_target_forbidden',
        'This server address is not allowed for outgoing mail',
      );
    if (body.caId && !(await loadTrustedCas(ctx)).some((c) => c.id === body.caId))
      throw new AppError(
        400,
        'smtp_ca_unknown',
        'The selected certificate authority does not exist',
      );
    // небезопасные режимы — только главный администратор, с подтверждением паролем и записью в журнале
    const plaintext = body.security === 'none';
    const unverified = body.verifyCert === false;
    if (plaintext || unverified) {
      if (!user.chief) throw chiefRequired();
      requireReauth(ctx, req);
    }
    const value: StoredSmtp = {
      host: body.host,
      port: body.port,
      security: body.security,
      auth,
      user: auth === 'none' ? '' : body.user,
      from: body.from,
      fromName: body.fromName,
      timeoutSec: body.timeoutSec,
      verifyCert: body.verifyCert,
      caId: body.caId,
      purposes: body.purposes,
      fallback: body.fallback,
      name: body.name ?? previous?.name ?? 'Default',
      passwordCipher:
        auth === 'none'
          ? ''
          : body.password === undefined
            ? (previous?.passwordCipher ?? '')
            : body.password
              ? sealSetting(ctx.config.APP_SECRET, smtpPasswordPurpose(id), body.password)
              : '',
    };
    await db
      .insert(settings)
      .values({ key: smtpProfileKey(id), value, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedBy: user.id, updatedAt: new Date() },
      });
    // без паролей и значений секретов: только что изменилось и какие небезопасные режимы включены
    const changed = previous
      ? (
          [
            'host',
            'port',
            'security',
            'auth',
            'user',
            'from',
            'fromName',
            'timeoutSec',
            'verifyCert',
            'caId',
            'fallback',
          ] as const
        ).filter(
          (k) =>
            JSON.stringify(k === 'auth' ? authMethodOf(previous) : previous[k]) !==
            JSON.stringify(value[k === 'auth' ? 'auth' : k]),
        )
      : ['created'];
    await audit(db, `user:${user.id}`, 'admin.smtp.save', `smtp:${id}`, {
      host: body.host,
      port: body.port,
      security: body.security,
      auth,
      changed: changed.join(','),
      passwordChanged: body.password !== undefined && auth !== 'none',
      plaintext,
      tlsVerificationOff: unverified,
    });
    if (plaintext || unverified)
      await audit(db, `user:${user.id}`, 'admin.smtp.insecure', `smtp:${id}`, {
        plaintext,
        tlsVerificationOff: unverified,
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
    await saveProfile(id, body, req);
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
    const id = crypto.randomUUID();
    await saveProfile(id, parse(profileWrite, req.body), req);
    return reply.status(201).send({ id });
  });
  app.put('/admin/smtp/profiles/:id', async (req) => {
    const { id } = parse(params, req.params);
    if (!(await loadSmtpProfile(ctx, id))) throw notFound();
    await saveProfile(id, parse(profileWrite, req.body), req);
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
      await tx.delete(settings).where(eq(settings.key, `smtp.status.${id}`));
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

  /** Подбор профиля из маршрута: с идентификатором — он, без — активный. */
  const profileOf = async (req: FastifyRequest): Promise<StoredSmtp> => {
    const id = (req.params as { id?: string }).id;
    const profile = id
      ? await loadSmtpProfile(ctx, parse(smtpProfileId, id))
      : await loadStoredSmtp(ctx);
    if (!profile) throw new AppError(409, 'smtp_not_configured', 'SMTP is not configured');
    return profile;
  };

  for (const base of ['/admin/smtp', '/admin/smtp/profiles/:id']) {
    // проверка соединения по этапам: DNS, TCP, приветствие, EHLO, TLS, сертификат, способы входа, вход
    for (const path of [`${base}/test`, `${base}/check`])
      app.post(path, async (req) => {
        const { user } = authOf(req);
        const profile = await profileOf(req);
        throttle(user.id, 'check');
        return exclusive(`check:${profile.profileId}`, async () => {
          const stages: StageResult[] = [];
          const config = await toSmtpConfig(ctx, profile);
          try {
            const response = await smtpSession(config, null, {
              probeCertificate: true,
              onStage: (s) => stages.push(s),
            });
            await recordSmtpStatus(ctx, profile.profileId!, { ok: true });
            await audit(db, `user:${user.id}`, 'admin.smtp.test', `smtp:${profile.profileId}`, {
              ok: true,
            });
            return {
              ok: true,
              banner: response.banner.slice(0, 200),
              stages,
              methods: response.methods,
            };
          } catch (error) {
            const failure = mailFailure(error);
            await recordSmtpStatus(ctx, profile.profileId!, {
              ok: false,
              stage: failure.stage,
              code: failure.code,
            });
            await audit(db, `user:${user.id}`, 'admin.smtp.test', `smtp:${profile.profileId}`, {
              ok: false,
              code: failure.code,
              stage: failure.stage,
              smtpStatus: failure.smtpStatus,
            });
            return {
              ok: false,
              ...failure,
              text: failure.text ? serverText(failure.text, config.password) : null,
              stages,
            };
          }
        });
      });
    // тестовое письмо: через очередь, как и все письма; «принято сервером» не равно «доставлено в ящик»
    app.post(`${base}/send-test`, async (req) => {
      const { user } = authOf(req);
      const profile = await profileOf(req);
      const address = email.safeParse((req.body as { to?: unknown } | undefined)?.to);
      if (!address.success)
        return { ok: false, code: 'invalid', message: 'Invalid recipient address' };
      throttle(user.id, 'mail');
      return exclusive(`mail:${profile.profileId}`, async () => {
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
          code: sent?.lastCode ?? null,
        });
        return {
          ok: sent?.status === 'sent',
          accepted: sent?.status === 'sent',
          // подтверждения доставки в ящик у SMTP нет: сервер принял письмо, дальше его путь неизвестен
          deliveryConfirmed: false,
          queued: sent?.status === 'queued',
          id: queuedId,
          messageId: sent?.messageId ?? undefined,
          smtpRef: sent?.smtpRef ?? undefined,
          code: sent?.lastCode ?? undefined,
          stage: sent?.stage ?? undefined,
          text: sent?.text ?? undefined,
          smtpStatus: sent?.smtpStatus ?? undefined,
          attempts: sent?.attempts,
        };
      });
    });
  }

  // доверенные центры сертификации для проверки внутренних почтовых серверов
  app.get('/admin/smtp/cas', async () => {
    const [cas, profiles] = await Promise.all([loadTrustedCas(ctx), smtpProfiles(ctx)]);
    return cas.map(({ pem: _pem, ...c }) => ({
      ...c,
      usedBy: profiles.profiles.filter((p) => p.caId === c.id).map((p) => p.name),
    }));
  });
  app.post('/admin/smtp/cas', async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(100), pem: z.string().max(200_000) }).strict(),
      req.body,
    );
    const found = parseCaPem(body.pem);
    if (!found.length)
      throw new AppError(
        400,
        'ca_invalid',
        'No certificate authority certificate was found in the text',
      );
    const existing = await loadTrustedCas(ctx);
    if (existing.length + found.length > 30)
      throw new AppError(409, 'ca_limit', 'Too many trusted certificate authorities');
    const added = found.map((c, i) => ({
      id: crypto.randomUUID(),
      name: found.length > 1 ? `${body.name} (${i + 1})`.slice(0, 100) : body.name,
      ...c,
      addedAt: new Date().toISOString(),
    }));
    const next = [
      ...existing,
      ...added.filter((c) => !existing.some((e) => e.fingerprint256 === c.fingerprint256)),
    ];
    await db
      .insert(settings)
      .values({ key: SMTP_CA_KEY, value: next, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: next, updatedBy: user.id, updatedAt: new Date() },
      });
    await audit(db, `user:${user.id}`, 'admin.smtp.ca.add', null, {
      count: added.length,
      fingerprints: added.map((c) => c.fingerprint256).join(','),
    });
    return reply.status(201).send({ ids: added.map((c) => c.id) });
  });
  app.delete('/admin/smtp/cas/:id', async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [cas, profiles] = await Promise.all([loadTrustedCas(ctx), smtpProfiles(ctx)]);
    if (!cas.some((c) => c.id === id)) throw notFound();
    if (profiles.profiles.some((p) => p.caId === id))
      throw new AppError(409, 'ca_in_use', 'This certificate authority is used by an SMTP profile');
    const next = cas.filter((c) => c.id !== id);
    await db
      .insert(settings)
      .values({ key: SMTP_CA_KEY, value: next, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: next, updatedBy: user.id, updatedAt: new Date() },
      });
    await audit(db, `user:${user.id}`, 'admin.smtp.ca.remove', `ca:${id}`);
    return reply.status(204).send();
  });

  // журнал отправки: фильтры, поиск, страницы
  const PUBLIC_STATUS = ['queued', 'retry', 'sending', 'accepted', 'failed', 'cancelled'] as const;
  const statusExpr = sql<string>`case
    when ${mailQueue.status} = 'sent' then 'accepted'
    when ${mailQueue.status} = 'queued' and ${mailQueue.attempts} > 0 then 'retry'
    else ${mailQueue.status} end`;
  app.get('/admin/smtp/queue', async (req) => {
    const q = parse(
      z.object({
        status: z.enum([...PUBLIC_STATUS, 'sent']).optional(),
        type: mailType.optional(),
        category: z.string().max(40).optional(),
        profile: z.string().max(80).optional(),
        recipient: z.string().max(200).optional(),
        q: z.string().max(200).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        errors: z.enum(['0', '1']).optional(),
        offset: z.coerce.number().int().min(0).max(100_000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    const status = q.status === 'sent' ? 'accepted' : q.status;
    const like = (v: string) => `%${escapeLike(v.trim())}%`;
    const where = and(
      status ? sql`${statusExpr} = ${status}` : undefined,
      q.type ? eq(mailQueue.type, q.type) : undefined,
      q.category ? eq(mailQueue.category, q.category) : undefined,
      q.profile ? eq(mailQueue.profileId, q.profile) : undefined,
      q.recipient ? ilike(mailQueue.to, like(q.recipient)) : undefined,
      q.from ? gte(mailQueue.createdAt, q.from) : undefined,
      q.to ? lte(mailQueue.createdAt, q.to) : undefined,
      q.errors === '1'
        ? or(inArray(mailQueue.status, ['failed']), isNotNull(mailQueue.lastCode))
        : undefined,
      q.q
        ? or(
            ilike(mailQueue.to, like(q.q)),
            ilike(mailQueue.messageId, like(q.q)),
            ilike(mailQueue.smtpRef, like(q.q)),
            ilike(mailQueue.lastText, like(q.q)),
            ilike(mailQueue.profileName, like(q.q)),
            sql`${mailQueue.id}::text = ${q.q.trim().toLowerCase()}`,
          )
        : undefined,
    );
    const [items, [filtered], totals] = await Promise.all([
      db
        .select({
          id: mailQueue.id,
          profileId: mailQueue.profileId,
          profileName: mailQueue.profileName,
          to: mailQueue.to,
          type: mailQueue.type,
          category: mailQueue.category,
          status: statusExpr,
          attempts: mailQueue.attempts,
          nextAttemptAt: mailQueue.nextAttemptAt,
          lastCode: mailQueue.lastCode,
          stage: mailQueue.lastStage,
          text: mailQueue.lastText,
          smtpStatus: mailQueue.lastSmtpStatus,
          messageId: mailQueue.messageId,
          smtpRef: mailQueue.smtpRef,
          createdAt: mailQueue.createdAt,
          deliveredAt: mailQueue.deliveredAt,
          expiresAt: mailQueue.expiresAt,
        })
        .from(mailQueue)
        .where(where)
        .orderBy(desc(mailQueue.createdAt))
        .limit(q.limit)
        .offset(q.offset),
      db.select({ n: count() }).from(mailQueue).where(where),
      db.select({ status: statusExpr, count: count() }).from(mailQueue).groupBy(statusExpr),
    ]);
    return { items, total: filtered?.n ?? 0, totals };
  });
  app.post('/admin/smtp/queue/:id/retry', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [row] = await db.select().from(mailQueue).where(eq(mailQueue.id, id));
    // просроченное письмо не отправляется: ссылка или приглашение уже недействительны
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
        lastStage: null,
        lastText: null,
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
  app.post('/admin/smtp/queue/:id/cancel', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const cancelled = await db
      .update(mailQueue)
      .set({
        status: 'cancelled',
        payloadCipher: '',
        lockToken: null,
        lockedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(mailQueue.id, id), eq(mailQueue.status, 'queued')))
      .returning({ id: mailQueue.id });
    if (!cancelled.length)
      throw new AppError(
        409,
        'mail_not_cancellable',
        'Only a message waiting in the queue can be cancelled',
      );
    await audit(db, `user:${user.id}`, 'admin.smtp.mail.cancel', `mail:${id}`);
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
