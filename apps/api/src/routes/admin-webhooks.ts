import { randomBytes } from 'node:crypto';
import { desc, eq, inArray, not } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { uuid } from '@arklock/contracts';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { settings, webhookDeliveries } from '../db/schema.js';
import { AppError, notFound, parse } from '../errors.js';
import { assertSafeUrl, UnsafeUrlError } from '../net/safeFetch.js';
import { sealSetting } from '../secretbox.js';
import { WEBHOOKS_KEY, webhookSecretPurpose, type WebhookConfig } from '../webhooks.js';

const hookSchema = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().max(500),
  prefixes: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[a-z][a-z0-9.-]{0,40}$/),
    )
    .max(20)
    .default([]),
  enabled: z.boolean().default(true),
  /** Выпустить новый секрет подписи (для новой записи выпускается всегда). */
  newSecret: z.boolean().optional(),
});

/** Вебхуки: подписанные уведомления о событиях журнала во внешнюю систему. Секреты читать нельзя, только выпустить новый. */
export const registerAdminWebhookRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  const insecure = ctx.config.NODE_ENV === 'test';
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', (req) => adminGate(ctx, req));

  const load = async (): Promise<WebhookConfig[]> => {
    const [row] = await db.select().from(settings).where(eq(settings.key, WEBHOOKS_KEY));
    return (row?.value as { hooks?: WebhookConfig[] } | undefined)?.hooks ?? [];
  };

  app.get('/admin/webhooks', async () => ({
    hooks: (await load()).map(({ secretSealed: _s, ...h }) => ({
      ...h,
      status: ctx.webhooks.statusOf(h.id),
    })),
  }));

  app.put('/admin/webhooks', async (req) => {
    const { user } = authOf(req);
    const body = parse(z.object({ hooks: z.array(hookSchema).max(10) }), req.body);
    const old = new Map((await load()).map((h) => [h.id, h]));
    const issued: Record<string, string> = {};
    const hooks: WebhookConfig[] = [];
    for (const h of body.hooks) {
      let url: string;
      try {
        url = assertSafeUrl(h.url, insecure).toString();
      } catch (e) {
        throw new AppError(
          400,
          'invalid_url',
          e instanceof UnsafeUrlError ? e.message : 'invalid URL',
        );
      }
      const prev = h.id ? old.get(h.id) : undefined;
      if (h.id && !prev) throw notFound();
      const id = prev?.id ?? crypto.randomUUID();
      let secretSealed = prev?.secretSealed;
      if (!secretSealed || h.newSecret) {
        const secret = randomBytes(32).toString('base64url');
        issued[id] = secret;
        secretSealed = sealSetting(ctx.config.APP_SECRET, webhookSecretPurpose(id), secret);
      }
      hooks.push({
        id,
        name: h.name,
        url,
        secretSealed,
        prefixes: [...new Set(h.prefixes)],
        enabled: h.enabled,
      });
    }
    await db
      .insert(settings)
      .values({ key: WEBHOOKS_KEY, value: { hooks } as never, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: { hooks } as never, updatedAt: new Date(), updatedBy: user.id },
      });
    ctx.webhooks.reset();
    // журнал удалённых вебхуков не хранится
    await db.delete(webhookDeliveries).where(
      hooks.length
        ? not(
            inArray(
              webhookDeliveries.hookId,
              hooks.map((h) => h.id),
            ),
          )
        : undefined,
    );
    await audit(db, `user:${user.id}`, 'admin.webhooks.save', null, {
      hooks: hooks.length,
      secretsIssued: Object.keys(issued).length,
    });
    // секрет показывается один раз: в базе остаётся только запечатанное значение
    return { issuedSecrets: issued };
  });

  /** Пробная доставка: показывает код ответа получателя, события журнала не создаёт. */
  app.post('/admin/webhooks/:id/test', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const hook = (await load()).find((h) => h.id === id);
    if (!hook) throw notFound();
    try {
      const status = await ctx.webhooks.deliver(hook, 'webhook.test', {
        actor: 'system',
        target: null,
        detail: null,
      });
      const ok = status >= 200 && status < 300;
      await ctx.webhooks.record(hook.id, 'webhook.test', {
        ok,
        code: status,
        attempts: 1,
        error: `HTTP ${status}`,
      });
      return { ok, status };
    } catch (e) {
      const reason = e instanceof Error ? e.message.slice(0, 200) : 'failed';
      await ctx.webhooks.record(hook.id, 'webhook.test', {
        ok: false,
        code: null,
        attempts: 1,
        error: reason,
      });
      return { ok: false, reason };
    }
  });

  /** Последние доставки вебхука: время, событие, итог, код ответа, число попыток. Тел сообщений нет. */
  app.get('/admin/webhooks/:id/deliveries', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    if (!(await load()).some((h) => h.id === id)) throw notFound();
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.hookId, id))
      .orderBy(desc(webhookDeliveries.id))
      .limit(50);
    return {
      deliveries: rows.map((r) => ({
        at: r.at.toISOString(),
        event: r.event,
        ok: r.ok,
        code: r.code,
        attempts: r.attempts,
        error: r.error,
      })),
    };
  });
};
