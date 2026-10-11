import type { Readable } from 'node:stream';
import { and, eq, inArray, lt, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { attachmentCreate, uuid } from '@arklock/contracts';
import type { AttachmentRecord } from '@arklock/contracts';
import { requireVault, type VaultAccess } from '../access.js';
import { audit } from '../audit.js';
import { authOf, requireAuth } from '../auth/session.js';
import { BlobSizeError } from '../blobs.js';
import type { AppContext } from '../context.js';
import { attachments, entries, settings, vaults } from '../db/schema.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';

export const DEFAULT_MAX_MIB = 25;
const MIB = 1024 * 1024;
export const blobSuffix = (keyVersion: number) => `.k${keyVersion}`;

/** Ограничения на вложения из настроек: максимальный размер файла и квота хранилища (0 — без ограничения). */
export async function attachmentLimits(db: AppContext['db']) {
  const rows = await db.select().from(settings);
  const num = (key: string, d: number) => {
    const v = rows.find((r) => r.key === key)?.value;
    return typeof v === 'number' ? v : d;
  };
  return {
    maxBytes: num('storage.attachmentMaxMiB', DEFAULT_MAX_MIB) * MIB,
    vaultQuotaBytes: num('storage.vaultQuotaMiB', 0) * MIB,
  };
}

export const registerAttachmentRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db, blobs } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  // Содержимое вложения приходит потоком «как есть» (уже зашифрованный файл); размер проверяется при записи.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
  );

  const entryParams = z.object({ vaultId: uuid, entryId: uuid });
  const attParams = z.object({ vaultId: uuid, attachmentId: uuid });

  function requireStorage(): void {
    if (!blobs.enabled)
      throw new AppError(503, 'storage_unavailable', 'Attachment storage is not configured');
  }

  async function entryFor(
    vaultId: string,
    entryId: string,
    access: VaultAccess,
    min: 'reader' | 'editor',
  ) {
    const [e] = await db
      .select()
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.vaultId, vaultId)));
    if (!e || e.deletedAt) throw notFound();
    const a = access.entry(e.id, e.branchId);
    if (!a) throw notFound();
    if (min === 'editor' && a === 'reader') throw forbidden();
    return e;
  }

  async function attachmentFor(vaultId: string, id: string) {
    const [a] = await db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, id), eq(attachments.vaultId, vaultId)));
    if (!a) throw notFound();
    return a;
  }

  const record = (a: typeof attachments.$inferSelect): AttachmentRecord => ({
    id: a.id,
    entryId: a.entryId,
    wrappedKey: a.wrappedKey,
    metaCipher: a.metaCipher,
    keyVersion: a.keyVersion,
    size: a.size,
    createdAt: a.createdAt.toISOString(),
  });

  /** Готовые вложения записи. */
  app.get('/vaults/:vaultId/entries/:entryId/attachments', async (req) => {
    const { user } = authOf(req);
    const { vaultId, entryId } = parse(entryParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    await entryFor(vaultId, entryId, access, 'reader');
    const rows = await db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.entryId, entryId),
          eq(attachments.vaultId, vaultId),
          eq(attachments.status, 'ready'),
        ),
      )
      .orderBy(attachments.createdAt);
    return rows.map(record);
  });

  /** Вложения всего хранилища, к которым есть доступ (для ротации ключа и счётчиков). */
  app.get('/vaults/:vaultId/attachments', async (req) => {
    const { user } = authOf(req);
    const { vaultId } = parse(z.object({ vaultId: uuid }), req.params);
    const access = await requireVault(db, vaultId, user.id);
    const rows = await db
      .select({ a: attachments, branchId: entries.branchId })
      .from(attachments)
      .innerJoin(entries, eq(entries.id, attachments.entryId))
      .where(and(eq(attachments.vaultId, vaultId), eq(attachments.status, 'ready')));
    return rows.filter((r) => access.entry(r.a.entryId, r.branchId)).map((r) => record(r.a));
  });

  /** Шаг 1: регистрация вложения (метаданные и ключ). Содержимое загружается отдельным запросом. */
  app.post('/vaults/:vaultId/entries/:entryId/attachments', async (req, reply) => {
    requireStorage();
    const { user } = authOf(req);
    const { vaultId, entryId } = parse(entryParams, req.params);
    const body = parse(attachmentCreate, req.body);
    const access = await requireVault(db, vaultId, user.id);
    await entryFor(vaultId, entryId, access, 'editor');
    const [v] = await db.select().from(vaults).where(eq(vaults.id, vaultId));
    if (!v) throw notFound();
    if (body.keyVersion !== v.keyVersion)
      throw new AppError(409, 'stale_key_version', 'Vault key was rotated, re-fetch the key', {
        keyVersion: v.keyVersion,
      });
    const limits = await attachmentLimits(db);
    if (limits.maxBytes === 0 || body.size > limits.maxBytes)
      throw new AppError(413, 'attachment_too_large', 'The file exceeds the allowed size', {
        maxBytes: limits.maxBytes,
      });
    if (limits.vaultQuotaBytes > 0) {
      const [used] = await db
        .select({ n: sql<number>`coalesce(sum(${attachments.size}), 0)::float8` })
        .from(attachments)
        .where(eq(attachments.vaultId, vaultId));
      if ((used?.n ?? 0) + body.size > limits.vaultQuotaBytes)
        throw new AppError(413, 'quota_exceeded', 'The vault storage quota is exhausted');
    }
    const [dup] = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.id, body.id));
    if (dup) throw new AppError(409, 'conflict', 'Attachment already exists');
    await db.insert(attachments).values({
      id: body.id,
      vaultId,
      entryId,
      wrappedKey: body.wrappedKey,
      metaCipher: body.metaCipher,
      keyVersion: body.keyVersion,
      size: body.size,
      status: 'pending',
      createdBy: user.id,
    });
    return reply.status(201).send({ id: body.id });
  });

  /** Шаг 2: загрузка зашифрованного файла (ровно объявленное число байт). */
  app.put('/vaults/:vaultId/attachments/:attachmentId/content', async (req, reply) => {
    requireStorage();
    const { user } = authOf(req);
    const { vaultId, attachmentId } = parse(attParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    const a = await attachmentFor(vaultId, attachmentId);
    await entryFor(vaultId, a.entryId, access, 'editor');
    if (a.status !== 'pending') throw new AppError(409, 'conflict', 'Content is already uploaded');
    try {
      await blobs.write(a.id, req.body as Readable, a.size, blobSuffix(a.keyVersion));
    } catch (e) {
      if (e instanceof BlobSizeError)
        throw new AppError(400, 'size_mismatch', 'Uploaded size differs from the declared size');
      throw e;
    }
    // Ключ мог смениться, пока файл загружался: такое вложение уже не соответствует ключу хранилища.
    const [v] = await db.select().from(vaults).where(eq(vaults.id, vaultId));
    if (!v || v.keyVersion !== a.keyVersion) {
      await blobs.remove([a.id]);
      await db.delete(attachments).where(eq(attachments.id, a.id));
      throw new AppError(409, 'stale_key_version', 'Vault key was rotated during upload');
    }
    await db.update(attachments).set({ status: 'ready' }).where(eq(attachments.id, a.id));
    await audit(db, `user:${user.id}`, 'attachment.add', `entry:${a.entryId}`, {
      vault: vaultId,
      size: a.size,
    });
    return reply.status(204).send();
  });

  /** Скачивание зашифрованного файла. */
  app.get('/vaults/:vaultId/attachments/:attachmentId/content', async (req, reply) => {
    requireStorage();
    const { user } = authOf(req);
    const { vaultId, attachmentId } = parse(attParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    const a = await attachmentFor(vaultId, attachmentId);
    if (a.status !== 'ready') throw notFound();
    await entryFor(vaultId, a.entryId, access, 'reader');
    const suffix = blobSuffix(a.keyVersion);
    const size = await blobs.size(a.id, suffix);
    if (size === null) throw new AppError(410, 'blob_missing', 'The stored file is missing');
    await audit(db, `user:${user.id}`, 'attachment.download', `entry:${a.entryId}`, {
      vault: vaultId,
    });
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', size)
      .header('cache-control', 'no-store')
      .send(blobs.read(a.id, suffix));
  });

  /** Подготовка файла, перешифрованного новым ключом, для ротации ключа хранилища (применяется вызовом rotate). */
  app.put('/vaults/:vaultId/attachments/:attachmentId/rotation', async (req, reply) => {
    requireStorage();
    const { user } = authOf(req);
    const { vaultId, attachmentId } = parse(attParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.isAdmin) throw forbidden();
    const a = await attachmentFor(vaultId, attachmentId);
    if (a.status !== 'ready') throw notFound();
    try {
      await blobs.write(a.id, req.body as Readable, a.size, blobSuffix(a.keyVersion + 1));
    } catch (e) {
      if (e instanceof BlobSizeError)
        throw new AppError(400, 'size_mismatch', 'Uploaded size differs from the original size');
      throw e;
    }
    return reply.status(204).send();
  });

  app.delete('/vaults/:vaultId/attachments/:attachmentId', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId, attachmentId } = parse(attParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    const a = await attachmentFor(vaultId, attachmentId);
    await entryFor(vaultId, a.entryId, access, 'editor');
    await db.delete(attachments).where(eq(attachments.id, a.id));
    await blobs.remove([a.id]);
    await audit(db, `user:${user.id}`, 'attachment.delete', `entry:${a.entryId}`, {
      vault: vaultId,
    });
    return reply.status(204).send();
  });
};

/** Идентификаторы вложений, подпадающих под условие (до удаления записей, чтобы затем убрать файлы). */
export async function attachmentIdsWhere(
  db: AppContext['db'],
  where: SQL | undefined,
): Promise<string[]> {
  const rows = await db
    .select({ id: attachments.id })
    .from(attachments)
    .innerJoin(entries, eq(entries.id, attachments.entryId))
    .where(where);
  return rows.map((r) => r.id);
}
export const attachmentIdsOfEntries = (db: AppContext['db'], entryIds: string[]) =>
  entryIds.length
    ? attachmentIdsWhere(db, inArray(attachments.entryId, entryIds))
    : Promise.resolve([]);
export const attachmentIdsOfVault = (db: AppContext['db'], vaultId: string) =>
  attachmentIdsWhere(db, eq(attachments.vaultId, vaultId));
export const attachmentIdsExpired = (db: AppContext['db'], cutoff: Date) =>
  attachmentIdsWhere(db, and(isNotNull(entries.deletedAt), lt(entries.deletedAt, cutoff)));

/** Сверка хранилища с базой: файлы без записи, незавершённые загрузки и устаревшие версии удаляются (с запасом по времени). */
export async function sweepBlobs(
  ctx: Pick<AppContext, 'db' | 'blobs'>,
  now = new Date(),
  graceMs = 3_600_000,
) {
  if (!ctx.blobs.enabled) return { orphans: 0, pending: 0 };
  const rows = await ctx.db.select().from(attachments);
  const byId = new Map(rows.map((r) => [r.id, r]));
  let orphans = 0;
  for (const f of await ctx.blobs.scan()) {
    const row = byId.get(f.id);
    // Файл без записи в базе — точно сирота (запись создаётся до загрузки); остальные — с запасом по времени
    if (row && now.getTime() - f.mtimeMs < graceMs) continue;
    const live = row && f.suffix === blobSuffix(row.keyVersion);
    if (!live) {
      await ctx.blobs.removeVersion(f.id, f.suffix.replace(/\.part$/, ''));
      orphans++;
    }
  }
  // Регистрации без загруженного файла, оставленные дольше срока
  const stale = rows.filter(
    (r) => r.status === 'pending' && now.getTime() - r.createdAt.getTime() > graceMs,
  );
  for (const r of stale) {
    await ctx.db.delete(attachments).where(eq(attachments.id, r.id));
    await ctx.blobs.remove([r.id]);
  }
  return { orphans, pending: stale.length };
}
