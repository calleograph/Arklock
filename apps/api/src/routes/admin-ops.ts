import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import { requireReauth } from '../auth/reauth.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { AppError, notFound, parse } from '../errors.js';
import {
  BACKUP_NAME_RE,
  BackupUploadError,
  RequestPendingError,
  type UpdaterRequest,
} from '../updater/protocol.js';

/** Предел размера загружаемой копии (8 ГиБ); больше — отказ до записи на диск. */
const MAX_BACKUP_UPLOAD_BYTES = 8 * 1024 ** 3;

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

const prefixRe = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const noDots = (v: string) => !v.includes('..');
const common = {
  prefix: z
    .string()
    .trim()
    .max(200)
    .refine(noDots)
    .refine((v) => v === '' || prefixRe.test(v))
    .default(''),
  auto: z.boolean().default(true),
  keep: z.number().int().min(1).max(365).default(14),
};
/** Секреты необязательны: пустое значение означает «оставить прежний». */
const offsiteConfig = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('s3'),
    endpoint: z.string().trim().url().max(500),
    region: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]{2,40}$/),
    bucket: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    accessKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9/+=._-]{3,128}$/),
    secretKey: z.string().max(300).default(''),
    pathStyle: z.boolean().default(true),
    caPem: z.string().max(16_000).default(''),
    insecureTls: z.boolean().default(false),
    allowHttp: z.boolean().default(false),
    ...common,
  }),
  z.object({
    type: z.literal('smb'),
    host: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,253}$/),
    port: z.number().int().min(1).max(65535).default(445),
    share: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._$-]{1,80}$/),
    user: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._@\\-]{1,128}$/),
    password: z.string().max(300).default(''),
    domain: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{0,128}$/)
      .default(''),
    encrypt: z.boolean().default(true),
    ...common,
  }),
]);

const offsiteAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('test') }),
  z.object({ action: z.literal('refresh') }),
  z.object({ action: z.literal('clear') }),
  z.object({ action: z.literal('push'), file: backupName }),
  z.object({ action: z.literal('pull'), file: backupName }),
  z.object({ action: z.literal('verify'), file: backupName }),
  z.object({ action: z.literal('delete'), file: backupName }),
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
    await adminGate(ctx, req);
  });

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
    // расписание копий ничего не удаляет и не выдаёт наружу — подтверждения не требует
    if (body.action === 'delete' || body.action === 'export') requireReauth(ctx, req);
    if (body.action === 'restore') {
      requireReauth(ctx, req);
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

  // ------------------------------------------------------------------ удалённое хранилище копий (S3 / SMB)

  app.get('/admin/backups/offsite', async () => {
    const [snap, alive] = await Promise.all([ctx.updater.offsite(), helperAlive()]);
    return { helperAlive: alive, offsite: snap };
  });

  /** Настройка: секреты уходят помощнику в файле с правами 600 и в базе не хранятся; нужен повторный ввод пароля. */
  app.put('/admin/backups/offsite', async (req, reply) => {
    const { user } = authOf(req);
    requireReauth(ctx, req);
    const b = parse(offsiteConfig, req.body);
    const v: Record<string, string> =
      b.type === 's3'
        ? {
            type: 's3',
            endpoint: b.endpoint,
            region: b.region,
            bucket: b.bucket,
            prefix: b.prefix,
            access_key: b.accessKey,
            secret_key: b.secretKey,
            path_style: b.pathStyle ? '1' : '0',
            ca_pem: b.caPem,
            insecure_tls: b.insecureTls ? '1' : '0',
            allow_http: b.allowHttp ? '1' : '0',
            auto: b.auto ? '1' : '0',
            keep: String(b.keep),
          }
        : {
            type: 'smb',
            host: b.host,
            port: String(b.port),
            share: b.share,
            prefix: b.prefix,
            user: b.user,
            password: b.password,
            domain: b.domain,
            encrypt: b.encrypt ? '1' : '0',
            auto: b.auto ? '1' : '0',
            keep: String(b.keep),
          };
    if (!(await helperAlive()))
      throw new AppError(503, 'updater_unavailable', 'The host helper is not running');
    await ctx.updater.writeOffsiteConfig(v);
    let requestId: string;
    try {
      requestId = await submit(req, { action: 'offsite_import' });
    } catch (e) {
      await ctx.updater.removeOffsiteConfig();
      throw e;
    }
    await audit(db, `user:${user.id}`, 'admin.backup.offsite.config', `request:${requestId}`, {
      type: b.type,
      auto: b.auto,
      keep: b.keep,
    });
    return reply.status(202).send({ requestId });
  });

  app.post('/admin/backups/offsite', async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(offsiteAction, req.body);
    if (body.action === 'clear' || body.action === 'delete' || body.action === 'pull')
      requireReauth(ctx, req);
    const requestId = await submit(req, {
      action: `offsite_${body.action}`,
      file: 'file' in body ? body.file : undefined,
    });
    await audit(
      db,
      `user:${user.id}`,
      `admin.backup.offsite.${body.action}`,
      `request:${requestId}`,
      { file: 'file' in body ? body.file : null },
    );
    return reply.status(202).send({ requestId });
  });

  /** Скачивание зашифрованной копии, подготовленной помощником (после `export`, действует 10 минут). */
  app.get('/admin/backups/:name/download', async (req, reply) => {
    const { user } = authOf(req);
    requireReauth(ctx, req);
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

  /**
   * Загрузка резервной копии (например, с другого сервера). Тело — сам файл; принимается потоком с ограничением размера.
   * Помощник переносит файл в каталог копий и проверяет его ключом этого сервера. Восстановление — отдельная операция.
   */
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
  );
  app.post('/admin/backups/upload', async (req, reply) => {
    const { user } = authOf(req);
    let name: string;
    try {
      name = await ctx.updater.acceptBackupUpload(req.body as Readable, MAX_BACKUP_UPLOAD_BYTES);
    } catch (e) {
      if (e instanceof BackupUploadError && e.code === 'too_large')
        throw new AppError(413, 'backup_too_large', 'The backup is larger than the upload limit');
      if (e instanceof BackupUploadError && e.code === 'empty')
        throw new AppError(400, 'backup_empty', 'The file is empty');
      throw e;
    }
    let requestId: string;
    try {
      requestId = await submit(req, { action: 'backup_import', file: name });
    } catch (e) {
      await ctx.updater.discardBackupUpload(name);
      throw e;
    }
    await audit(db, `user:${user.id}`, 'admin.backup.upload', `request:${requestId}`, {
      file: name,
    });
    return reply.status(202).send({ requestId });
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
