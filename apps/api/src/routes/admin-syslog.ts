import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { settings } from '../db/schema.js';
import { forbidden, parse } from '../errors.js';
import { SYSLOG_KEY, type SyslogConfig } from '../syslog.js';

const putSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(['udp', 'tcp', 'tls']),
  insecureTls: z.boolean().default(false),
  prefixes: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[a-z][a-z0-9.-]{0,40}$/),
    )
    .max(20)
    .default([]),
});

/** Экспорт журнала событий во внешний сборщик (syslog, RFC 5424; UDP, TCP или TLS). */
export const registerAdminSyslogRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', async (req: FastifyRequest) => {
    if (authOf(req).user.role !== 'admin') throw forbidden();
  });

  const load = async () => {
    const [row] = await db.select().from(settings).where(eq(settings.key, SYSLOG_KEY));
    return (row?.value as SyslogConfig | undefined) ?? null;
  };
  const status = () => ({
    sent: ctx.syslog.sent,
    failed: ctx.syslog.failed,
    lastError: ctx.syslog.lastError,
    lastAt: ctx.syslog.lastAt,
  });

  app.get('/admin/syslog', async () => {
    const cfg = await load();
    return { configured: !!cfg, ...(cfg ?? {}), status: status() };
  });

  app.put('/admin/syslog', async (req) => {
    const { user } = authOf(req);
    const body = parse(putSchema, req.body);
    await db
      .insert(settings)
      .values({ key: SYSLOG_KEY, value: body as never, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: body as never, updatedAt: new Date(), updatedBy: user.id },
      });
    ctx.syslog.reset();
    await audit(db, `user:${user.id}`, 'admin.syslog.save', null, {
      host: body.host,
      protocol: body.protocol,
      enabled: body.enabled,
    });
    return { ok: true };
  });

  /** Тестовое сообщение по введённым (ещё не сохранённым) параметрам; ошибка доставки возвращается администратору. */
  app.post('/admin/syslog/test', async (req) => {
    const body = parse(putSchema, req.body);
    try {
      await ctx.syslog.test(body);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: (e as Error).message.slice(0, 200) };
    }
  });
};
