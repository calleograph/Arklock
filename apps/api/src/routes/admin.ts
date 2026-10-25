import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { reauthRequest, updateAction } from '@arklock/contracts';
import type { UpdatesOverview } from '@arklock/contracts';
import { audit } from '../audit.js';
import { AUTO_AT_KEY, AUTO_CHECK_KEY, AUTO_INSTALL_KEY, autoPolicy } from '../auto-update.js';
import { settings } from '../db/schema.js';
import { adminGate } from '../auth/adminperm.js';
import { requireReauth } from '../auth/reauth.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { AppError, parse } from '../errors.js';
import { inventory } from '../inventory.js';
import { verifyProof } from '../security.js';
import { RequestPendingError } from '../updater/protocol.js';

/** Все маршруты /admin/* доступны только администратору; опасные операции требуют повторного подтверждения пароля. */
export const registerAdminRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db, config } = ctx;

  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', async (req: FastifyRequest) => {
    await adminGate(ctx, req);
  });

  /** Получение короткоживущего токена повторного подтверждения. */
  app.post('/admin/reauth', async (req) => {
    const { user, session } = authOf(req);
    const body = parse(reauthRequest, req.body);
    const key = `reauth:${user.id}`;
    const wait = ctx.attempts.byEmail.retryAfter(key);
    if (wait > 0) {
      throw new AppError(429, 'too_many_attempts', 'Too many attempts, try again later', {
        retryAfterSeconds: wait,
      });
    }
    if (!verifyProof(user.authSalt, body.authKey, user.authHash)) {
      ctx.attempts.byEmail.fail(key);
      await audit(db, `user:${user.id}`, 'admin.reauth.failed');
      throw new AppError(401, 'invalid_credentials', 'Invalid password');
    }
    ctx.attempts.byEmail.reset(key);
    const { token, expiresAt } = ctx.reauth.issue(session.id);
    return { token, expiresAt: expiresAt.toISOString() };
  });

  async function overview(): Promise<UpdatesOverview> {
    return ctx.updater.overview({
      version: config.APP_VERSION,
      commit: config.APP_GIT_COMMIT,
      builtAt: config.APP_BUILT_AT,
      channel: config.UPDATE_CHANNEL,
    });
  }

  app.get('/admin/updates', async () => ({ ...(await overview()), auto: await autoPolicy(db) }));

  /**
   * Автоматические проверки и установка. Проверка по умолчанию включена; установка включается только явно и с повторным
   * подтверждением пароля: она запускается без человека, поэтому согласие должно быть осознанным.
   */
  app.put('/admin/updates/auto', async (req) => {
    const { user } = authOf(req);
    const body = parse(
      z.object({
        check: z.boolean(),
        install: z.boolean(),
        at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      }),
      req.body,
    );
    const before = await autoPolicy(db);
    if (body.install && (!before.install || before.at !== body.at)) requireReauth(ctx, req);
    for (const [key, value] of [
      [AUTO_CHECK_KEY, body.check],
      [AUTO_INSTALL_KEY, body.install],
      [AUTO_AT_KEY, body.at],
    ] as const)
      await db
        .insert(settings)
        .values({ key, value, updatedBy: user.id })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: new Date(), updatedBy: user.id },
        });
    await audit(db, `user:${user.id}`, 'admin.updates.auto.config', null, {
      check: body.check,
      install: body.install,
      at: body.at,
    });
    return autoPolicy(db);
  });
  app.get('/admin/updates/inventory', async () => inventory(ctx));

  app.post('/admin/updates', async (req: FastifyRequest, reply: FastifyReply) => {
    const { user } = authOf(req);
    const body = parse(updateAction, req.body);
    if (!ctx.updater.configured) {
      throw new AppError(503, 'updater_unavailable', 'Update helper is not configured');
    }
    const current = await overview();
    if (!current.helper.alive) {
      throw new AppError(503, 'updater_unavailable', 'Update helper is not running');
    }
    if (current.status.state === 'running' || current.pending) {
      throw new AppError(409, 'update_in_progress', 'Another operation is in progress');
    }
    // Проверка и штатное обновление до опубликованной версии (сверка по release.json, копия и автоматический откат
    // при сбое) выполняются по административному сеансу. Откат может вернуть уязвимую версию и восстановить старые
    // данные — для него нужно повышенное подтверждение.
    if (body.action === 'rollback') requireReauth(ctx, req);
    try {
      const requestId = await ctx.updater.submit({
        action: body.action,
        version: body.action === 'update' ? body.version : undefined,
        withRestore: body.action === 'rollback' ? body.withRestore : undefined,
        by: user.id,
      });
      await audit(db, `user:${user.id}`, `admin.updates.${body.action}`, `request:${requestId}`, {
        version: body.action === 'update' ? body.version : null,
      });
      return reply.status(202).send({ requestId });
    } catch (err) {
      if (err instanceof RequestPendingError) {
        throw new AppError(409, 'update_in_progress', 'Another operation is in progress');
      }
      throw err;
    }
  });
};
