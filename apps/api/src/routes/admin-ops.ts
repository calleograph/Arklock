import { createReadStream } from 'node:fs';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';
import { BACKUP_NAME_RE, RequestPendingError, type UpdaterRequest } from '../updater/protocol.js';

const backupName = z
  .string()
  .max(160)
  .regex(BACKUP_NAME_RE)
  .refine((v) => !v.includes('..'));

const backupAction = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    label: z
      .string()
      .regex(/^[a-z0-9]{1,20}$/)
      .optional(),
  }),
  z.object({ action: z.literal('verify'), file: backupName }),
  z.object({ action: z.literal('delete'), file: backupName }),
  z.object({ action: z.literal('export'), file: backupName }),
  z.object({ action: z.literal('restore'), file: backupName, confirm: z.string() }),
  z.object({
    action: z.literal('schedule'),
    enabled: z.boolean(),
    hour: z.number().int().min(0).max(23),
    keep: z.number().int().min(1).max(90),
  }),
]);

/**
 * Контейнеры, резервные копии, системные журналы. Веб-приложение сам ничего не выполняет: операции ставит в очередь
 * помощник на хосте (набор действий фиксирован и проверяется), а состояние читается из публикуемых им снимков.
 * Разрушающие и выдающие данные действия (удаление, скачивание, восстановление, расписание) требуют повторного ввода пароля.
 */
export const registerAdminOpsRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
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

  async function helperAlive(): Promise<boolean> {
    if (!ctx.updater.configured) return false;
    const o = await ctx.updater.overview({ version: '', commit: '', builtAt: '', channel: '' });
    return o.helper.alive;
  }

  async function submit(req: FastifyRequest, body: Omit<UpdaterRequest, 'by'>): Promise<string> {
    if (!(await helperAlive()))
      throw new AppError(503, 'updater_unavailable', 'The host helper is not running');
    if ((await ctx.updater.status()).state === 'running' || (await ctx.updater.pending()))
      throw new AppError(409, 'update_in_progress', 'Another operation is in progress');
    try {
      return await ctx.updater.submit({ ...body, by: authOf(req).user.id });
    } catch (e) {
      if (e instanceof RequestPendingError)
        throw new AppError(409, 'update_in_progress', 'Another operation is in progress');
      throw e;
    }
  }

  app.get('/admin/containers', async () => {
    const [snap, alive] = await Promise.all([ctx.updater.containers(), helperAlive()]);
    return { ...snap, helperAlive: alive };
  });

  app.get('/admin/backups', async () => {
    const [snap, schedule, alive] = await Promise.all([
      ctx.updater.backups(),
      ctx.updater.schedule(),
      helperAlive(),
    ]);
    return { helperAlive: alive, backups: snap, schedule };
  });

  app.post('/admin/backups', async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(backupAction, req.body);
    if (body.action === 'delete' || body.action === 'export' || body.action === 'schedule')
      requireReauth(req);
    if (body.action === 'restore') {
      requireReauth(req);
      if (body.confirm !== body.file)
        throw new AppError(400, 'confirmation_mismatch', 'Type the backup name to confirm');
    }
    const map: Record<typeof body.action, UpdaterRequest['action']> = {
      create: 'backup',
      verify: 'backup_verify',
      delete: 'backup_delete',
      export: 'backup_export',
      restore: 'restore',
      schedule: 'schedule',
    };
    const requestId = await submit(req, {
      action: map[body.action],
      file: 'file' in body ? body.file : undefined,
      label: body.action === 'create' ? body.label : undefined,
      schedule:
        body.action === 'schedule'
          ? { enabled: body.enabled, hour: body.hour, keep: body.keep }
          : undefined,
    });
    await audit(db, `user:${user.id}`, `admin.backup.${body.action}`, `request:${requestId}`, {
      file: 'file' in body ? body.file : null,
    });
    return reply.status(202).send({ requestId });
  });

  /** Скачивание зашифрованной копии, подготовленной помощником (после `export`, действует 10 минут). */
  app.get('/admin/backups/:name/download', async (req, reply) => {
    const { user } = authOf(req);
    requireReauth(req);
    const { name } = parse(z.object({ name: backupName }), req.params);
    const f = await ctx.updater.exportedBackup(name);
    if (!f) throw notFound();
    await audit(db, `user:${user.id}`, 'admin.backup.download', null, { file: name });
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', f.size)
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store')
      .send(createReadStream(f.path));
  });

  app.get('/admin/logs/system', async () => ({
    log: await ctx.updater.logs(),
    helperAlive: await helperAlive(),
  }));

  app.post('/admin/logs/system', async (req, reply) => {
    const body = parse(
      z.object({ service: z.enum(['app', 'db']), lines: z.number().int().min(10).max(2000) }),
      req.body,
    );
    const requestId = await submit(req, {
      action: 'logs',
      service: body.service,
      lines: body.lines,
    });
    return reply.status(202).send({ requestId });
  });
};
