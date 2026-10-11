import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { reauthRequest, updateAction } from '@arklock/contracts';
import type { UpdatesOverview } from '@arklock/contracts';
import { audit } from '../audit.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { AppError, forbidden, parse } from '../errors.js';
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
    if (authOf(req).user.role !== 'admin') throw forbidden();
  });

  function requireReauth(req: FastifyRequest): void {
    const { session } = authOf(req);
    const token = req.headers['x-reauth-token'];
    if (!ctx.reauth.check(typeof token === 'string' ? token : undefined, session.id)) {
      throw new AppError(403, 'reauth_required', 'Confirm your master password to continue');
    }
  }

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

  app.get('/admin/updates', async () => overview());

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
    // Проверка наличия новой версии не меняет систему и повторного подтверждения не требует.
    if (body.action !== 'check') requireReauth(req);
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
