import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  branchPatch,
  branchWrite,
  bulkRequest,
  entryDelete,
  entryUpdate,
  entryWrite,
  grantPut,
  uuid,
} from '@arklock/contracts';
import type { BranchRecord, EntryRecord, RevisionRecord } from '@arklock/contracts';
import { loadAccess, requireVault, type Access, type VaultAccess } from '../access.js';
import { audit } from '../audit.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import {
  branches,
  circles,
  entries,
  entryRevisions,
  grants,
  pins,
  signals,
  branchPins,
  users,
  vaults,
} from '../db/schema.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';
import { attachmentIdsExpired, attachmentIdsOfEntries } from './attachments.js';
import { registerObjectDetailsRoutes } from './object-details.js';
import { lockVaultForWrite } from '../vault-mutation.js';

const REVISIONS_KEEP = 100;
const atLeast = (a: Access | null, min: Access): boolean =>
  a !== null &&
  ['reader', 'editor', 'manager'].indexOf(a) >= ['reader', 'editor', 'manager'].indexOf(min);

const staleKey = (keyVersion: number) =>
  new AppError(409, 'stale_key_version', 'Vault key was rotated, re-fetch the key', { keyVersion });

export const registerContentRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  await app.register(registerObjectDetailsRoutes, { ctx });

  const vaultParams = z.object({ vaultId: uuid });
  const entryParams = z.object({ vaultId: uuid, entryId: uuid });
  const branchParams = z.object({ vaultId: uuid, branchId: uuid });

  async function vaultKeyVersion(vaultId: string): Promise<number> {
    const [v] = await db
      .select({ k: vaults.keyVersion })
      .from(vaults)
      .where(eq(vaults.id, vaultId));
    if (!v) throw notFound();
    return v.k;
  }

  function entryRecord(
    e: typeof entries.$inferSelect,
    access: Access,
    pinned: boolean,
  ): EntryRecord {
    return {
      id: e.id,
      vaultId: e.vaultId,
      branchId: e.branchId,
      wrappedEntryKey: e.wrappedEntryKey,
      ciphertext: e.ciphertext,
      keyVersion: e.keyVersion,
      version: e.version,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
      deletedAt: e.deletedAt?.toISOString() ?? null,
      pinned,
      access,
    };
  }

  function branchRecord(
    b: typeof branches.$inferSelect,
    access: BranchRecord['access'],
    pinned?: boolean,
  ): BranchRecord {
    return {
      ...(pinned === undefined ? {} : { pinned }),
      id: b.id,
      vaultId: b.vaultId,
      parentId: b.parentId,
      nameCipher: b.nameCipher,
      metaCipher: b.metaCipher,
      keyVersion: b.keyVersion,
      version: b.version,
      deletedAt: b.deletedAt?.toISOString() ?? null,
      access,
    };
  }

  async function pinnedSet(userId: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await db
      .select({ id: pins.entryId })
      .from(pins)
      .where(and(eq(pins.userId, userId), inArray(pins.entryId, ids)));
    return new Set(rows.map((r) => r.id));
  }

  async function pinnedBranches(userId: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await db
      .select({ id: branchPins.branchId })
      .from(branchPins)
      .where(and(eq(branchPins.userId, userId), inArray(branchPins.branchId, ids)));
    return new Set(rows.map((r) => r.id));
  }

  async function loadEntry(vaultId: string, entryId: string, includeDeleted = false) {
    const [row] = await db
      .select()
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.vaultId, vaultId)));
    if (!row || (!includeDeleted && row.deletedAt)) throw notFound();
    return row;
  }

  /** Право на запись; нет доступа — 404 (запись неотличима от несуществующей). */
  function entryAccess(access: VaultAccess, e: typeof entries.$inferSelect, min: Access): Access {
    const a = access.entry(e.id, e.branchId);
    if (!a) throw notFound();
    if (!atLeast(a, min)) throw forbidden();
    return a;
  }

  async function branchRow(vaultId: string, branchId: string, includeDeleted = false) {
    const [b] = await db
      .select()
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.vaultId, vaultId)));
    if (!b || (!includeDeleted && b.deletedAt)) throw notFound();
    return b;
  }

  // ------------------------------------------------------------------ чтение

  /** Дерево хранилища: ветви и записи, доступные пользователю. ?trash=1 — содержимое корзины. */
  app.get('/vaults/:vaultId/tree', async (req) => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const trash = (req.query as { trash?: string }).trash === '1';
    const access = await requireVault(db, vaultId, user.id);
    const [brRows, enRows] = await Promise.all([
      db.select().from(branches).where(eq(branches.vaultId, vaultId)),
      db
        .select()
        .from(entries)
        .where(
          and(
            eq(entries.vaultId, vaultId),
            trash ? isNotNull(entries.deletedAt) : isNull(entries.deletedAt),
          ),
        ),
    ]);
    const pinned = await pinnedSet(
      user.id,
      enRows.map((e) => e.id),
    );
    const outEntries: EntryRecord[] = [];
    for (const e of enRows) {
      const a = access.entry(e.id, e.branchId);
      if (a) outEntries.push(entryRecord(e, a, pinned.has(e.id)));
    }
    const outBranches: BranchRecord[] = [];
    const pinnedB = await pinnedBranches(
      user.id,
      brRows.map((b) => b.id),
    );
    for (const b of brRows) {
      if (trash ? !b.deletedAt : !!b.deletedAt) continue;
      const a = access.branch(b.id) ?? (access.structureAt(b.id) ? 'structure' : null);
      if (a) outBranches.push(branchRecord(b, a, pinnedB.has(b.id)));
    }
    return { branches: outBranches, entries: outEntries };
  });

  app.get('/vaults/:vaultId/entries/:entryId', async (req): Promise<EntryRecord> => {
    const { user } = authOf(req);
    const { vaultId, entryId } = parse(entryParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    const e = await loadEntry(vaultId, entryId, true);
    const a = entryAccess(access, e, 'reader');
    await audit(db, `user:${user.id}`, 'entry.fetch', `entry:${entryId}`, { vault: vaultId });
    return entryRecord(e, a, (await pinnedSet(user.id, [e.id])).has(e.id));
  });

  // ------------------------------------------------------------------ записи

  app.post('/vaults/:vaultId/entries', async (req, reply): Promise<EntryRecord> => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const body = parse(entryWrite, req.body);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.allows('entry.create')) throw forbidden();
    const branchId = body.branchId ?? null;
    if (branchId) await branchRow(vaultId, branchId);
    if (!access.canCreateIn(branchId)) throw forbidden();
    const kv = await vaultKeyVersion(vaultId);
    if (body.keyVersion !== kv) throw staleKey(kv);
    const id = body.id ?? crypto.randomUUID();
    const [dupe] = await db.select({ id: entries.id }).from(entries).where(eq(entries.id, id));
    if (dupe) throw new AppError(409, 'already_exists', 'Entry already exists');
    const [row] = await db.transaction(async (tx) => {
      await lockVaultForWrite(tx, vaultId, body.keyVersion);
      return tx
        .insert(entries)
        .values({
          id,
          vaultId,
          branchId,
          wrappedEntryKey: body.wrappedEntryKey,
          ciphertext: body.ciphertext,
          keyVersion: body.keyVersion,
          createdBy: user.id,
          updatedBy: user.id,
        })
        .returning();
    });
    await audit(db, `user:${user.id}`, 'entry.create', `entry:${id}`, { vault: vaultId });
    reply.status(201);
    return entryRecord(row!, access.entry(id, branchId) ?? 'editor', false);
  });

  app.put('/vaults/:vaultId/entries/:entryId', async (req): Promise<EntryRecord> => {
    const { user } = authOf(req);
    const { vaultId, entryId } = parse(entryParams, req.params);
    const body = parse(entryUpdate, req.body);
    const access = await requireVault(db, vaultId, user.id);
    const cur = await loadEntry(vaultId, entryId);
    const a = entryAccess(access, cur, 'editor');
    const kv = await vaultKeyVersion(vaultId);
    if (body.keyVersion !== kv) throw staleKey(kv);
    let branchId = cur.branchId;
    if (body.branchId !== undefined && body.branchId !== cur.branchId) {
      if (body.branchId) await branchRow(vaultId, body.branchId);
      if (!atLeast(access.branch(body.branchId), 'editor')) throw forbidden();
      branchId = body.branchId;
    }
    if (cur.version !== body.expectedVersion) {
      throw new AppError(409, 'version_conflict', 'Entry was modified by someone else', {
        currentVersion: cur.version,
      });
    }
    const now = new Date();
    const updated = await db.transaction(async (tx) => {
      await lockVaultForWrite(tx, vaultId, body.keyVersion);
      // Условное обновление одним оператором: параллельная правка не теряется.
      const [row] = await tx
        .update(entries)
        .set({
          wrappedEntryKey: body.wrappedEntryKey,
          ciphertext: body.ciphertext,
          keyVersion: body.keyVersion,
          branchId,
          version: body.expectedVersion + 1,
          updatedAt: now,
          updatedBy: user.id,
        })
        .where(
          and(
            eq(entries.id, entryId),
            eq(entries.version, body.expectedVersion),
            isNull(entries.deletedAt),
          ),
        )
        .returning();
      if (!row) return null;
      await tx.insert(entryRevisions).values({
        id: crypto.randomUUID(),
        entryId,
        vaultId,
        version: cur.version,
        wrappedEntryKey: cur.wrappedEntryKey,
        ciphertext: cur.ciphertext,
        keyVersion: cur.keyVersion,
        savedBy: cur.updatedBy,
        savedAt: cur.updatedAt,
      });
      const old = await tx
        .select({ id: entryRevisions.id })
        .from(entryRevisions)
        .where(eq(entryRevisions.entryId, entryId))
        .orderBy(desc(entryRevisions.version))
        .offset(REVISIONS_KEEP);
      if (old.length) {
        await tx.delete(entryRevisions).where(
          inArray(
            entryRevisions.id,
            old.map((o) => o.id),
          ),
        );
      }
      return row;
    });
    if (!updated) {
      throw new AppError(409, 'version_conflict', 'Entry was modified by someone else');
    }
    await audit(
      db,
      `user:${user.id}`,
      branchId !== cur.branchId ? 'entry.move' : 'entry.update',
      `entry:${entryId}`,
      { vault: vaultId, branch: branchId },
    );
    if (body.passwordChanged) {
      const closed = await db
        .update(signals)
        .set({ status: 'resolved', updatedAt: now })
        .where(
          and(
            eq(signals.entryId, entryId),
            eq(signals.type, 'rotate'),
            inArray(signals.status, ['open', 'in_progress']),
          ),
        )
        .returning({ id: signals.id });
      for (const c of closed)
        await audit(db, `user:${user.id}`, 'signal.resolve', `signal:${c.id}`, {
          vault: vaultId,
          clientReported: true,
        });
    }
    return entryRecord(updated, a, (await pinnedSet(user.id, [entryId])).has(entryId));
  });

  /** Мягкое удаление записи (корзина). */
  app.delete('/vaults/:vaultId/entries/:entryId', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId, entryId } = parse(entryParams, req.params);
    const q = req.query as { expectedVersion?: string; purge?: string };
    const access = await requireVault(db, vaultId, user.id);
    if (q.purge === '1') {
      if (!access.allows('trash.purge')) throw forbidden();
      const e = await loadEntry(vaultId, entryId, true);
      entryAccess(access, e, 'editor');
      if (!e.deletedAt)
        throw new AppError(409, 'not_in_trash', 'Move the entry to the trash first');
      const blobIds = await attachmentIdsOfEntries(db, [entryId]);
      await db.delete(entries).where(eq(entries.id, entryId));
      await ctx.blobs.remove(blobIds);
      await audit(db, `user:${user.id}`, 'entry.purge', `entry:${entryId}`, { vault: vaultId });
      return reply.status(204).send();
    }
    if (!access.allows('entry.delete')) throw forbidden();
    const { expectedVersion } = parse(entryDelete, { expectedVersion: Number(q.expectedVersion) });
    const e = await loadEntry(vaultId, entryId);
    entryAccess(access, e, 'editor');
    if (e.version !== expectedVersion) {
      throw new AppError(409, 'version_conflict', 'Entry was modified by someone else', {
        currentVersion: e.version,
      });
    }
    const removed = await db.transaction(async (tx) => {
      await lockVaultForWrite(tx, vaultId);
      return tx
        .update(entries)
        .set({
          deletedAt: new Date(),
          trashGroup: crypto.randomUUID(),
          version: e.version + 1,
          updatedBy: user.id,
        })
        .where(
          and(
            eq(entries.id, entryId),
            eq(entries.version, expectedVersion),
            isNull(entries.deletedAt),
          ),
        )
        .returning({ id: entries.id });
    });
    if (!removed.length)
      throw new AppError(409, 'version_conflict', 'Entry was modified by someone else');
    await audit(db, `user:${user.id}`, 'entry.delete', `entry:${entryId}`, { vault: vaultId });
    return reply.status(204).send();
  });

  app.post('/vaults/:vaultId/entries/:entryId/restore', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId, entryId } = parse(entryParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    const e = await loadEntry(vaultId, entryId, true);
    entryAccess(access, e, 'editor');
    if (!e.deletedAt) throw new AppError(409, 'not_in_trash', 'The entry is not in the trash');
    await requireRestoreGroupEdit(access, e.trashGroup);
    await restoreGroup(vaultId, e.trashGroup, e.id, 'entry');
    await audit(db, `user:${user.id}`, 'entry.restore', `entry:${entryId}`, { vault: vaultId });
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ ревизии

  app.get('/vaults/:vaultId/entries/:entryId/revisions', async (req): Promise<RevisionRecord[]> => {
    const { user } = authOf(req);
    const { vaultId, entryId } = parse(entryParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.allows('entry.history')) throw forbidden();
    const e = await loadEntry(vaultId, entryId, true);
    entryAccess(access, e, 'reader'); // история доступна только при действующих правах: отозванный доступ не обойти старыми ревизиями
    const rows = await db
      .select()
      .from(entryRevisions)
      .where(eq(entryRevisions.entryId, entryId))
      .orderBy(desc(entryRevisions.version));
    return rows.map((r) => ({
      id: r.id,
      version: r.version,
      wrappedEntryKey: r.wrappedEntryKey,
      ciphertext: r.ciphertext,
      keyVersion: r.keyVersion,
      savedAt: r.savedAt.toISOString(),
      savedBy: r.savedBy,
    }));
  });

  /** Возврат к ревизии: содержимое копируется на сервере без повторного шифрования (текущее состояние сохраняется как новая ревизия). */
  app.post('/vaults/:vaultId/entries/:entryId/revisions/:revisionId/restore', async (req) => {
    const { user } = authOf(req);
    const { vaultId, entryId, revisionId } = parse(
      z.object({ vaultId: uuid, entryId: uuid, revisionId: uuid }),
      req.params,
    );
    const { expectedVersion } = parse(entryDelete, req.body);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.allows('entry.history')) throw forbidden();
    const cur = await loadEntry(vaultId, entryId);
    const a = entryAccess(access, cur, 'editor');
    const [rev] = await db
      .select()
      .from(entryRevisions)
      .where(and(eq(entryRevisions.id, revisionId), eq(entryRevisions.entryId, entryId)));
    if (!rev) throw notFound();
    if (rev.keyVersion !== (await vaultKeyVersion(vaultId)))
      throw staleKey(await vaultKeyVersion(vaultId));
    if (cur.version !== expectedVersion) {
      throw new AppError(409, 'version_conflict', 'Entry was modified by someone else', {
        currentVersion: cur.version,
      });
    }
    const updated = await db.transaction(async (tx) => {
      await lockVaultForWrite(tx, vaultId, rev.keyVersion);
      const [latest] = await tx
        .select({ version: entries.version })
        .from(entries)
        .where(eq(entries.id, entryId));
      if (latest?.version !== expectedVersion)
        throw new AppError(409, 'version_conflict', 'Entry was modified by someone else');
      await tx.insert(entryRevisions).values({
        id: crypto.randomUUID(),
        entryId,
        vaultId,
        version: cur.version,
        wrappedEntryKey: cur.wrappedEntryKey,
        ciphertext: cur.ciphertext,
        keyVersion: cur.keyVersion,
        savedBy: cur.updatedBy,
        savedAt: cur.updatedAt,
      });
      const [row] = await tx
        .update(entries)
        .set({
          wrappedEntryKey: rev.wrappedEntryKey,
          ciphertext: rev.ciphertext,
          keyVersion: rev.keyVersion,
          version: cur.version + 1,
          updatedAt: new Date(),
          updatedBy: user.id,
        })
        .where(and(eq(entries.id, entryId), eq(entries.version, cur.version)))
        .returning();
      return row;
    });
    if (!updated) throw new AppError(409, 'version_conflict', 'Entry was modified by someone else');
    await audit(db, `user:${user.id}`, 'entry.revert', `entry:${entryId}`, {
      vault: vaultId,
      to: rev.version,
    });
    return entryRecord(updated, a, (await pinnedSet(user.id, [entryId])).has(entryId));
  });

  // ------------------------------------------------------------------ закрепление

  app.put('/vaults/:vaultId/entries/:entryId/pin', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId, entryId } = parse(entryParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    const e = await loadEntry(vaultId, entryId);
    entryAccess(access, e, 'reader');
    await db.insert(pins).values({ userId: user.id, entryId }).onConflictDoNothing();
    return reply.status(204).send();
  });

  app.delete('/vaults/:vaultId/entries/:entryId/pin', async (req, reply) => {
    const { user } = authOf(req);
    const { entryId } = parse(entryParams, req.params);
    await db.delete(pins).where(and(eq(pins.userId, user.id), eq(pins.entryId, entryId)));
    return reply.status(204).send();
  });

  // избранная папка: видна только самому сотруднику, требует доступа к папке
  app.put('/vaults/:vaultId/branches/:branchId/pin', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId, branchId } = parse(branchParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    await branchRow(vaultId, branchId);
    if (!access.branch(branchId) && !access.structureAt(branchId)) throw notFound();
    await db.insert(branchPins).values({ userId: user.id, branchId }).onConflictDoNothing();
    return reply.status(204).send();
  });

  app.delete('/vaults/:vaultId/branches/:branchId/pin', async (req, reply) => {
    const { user } = authOf(req);
    const { branchId } = parse(branchParams, req.params);
    await db
      .delete(branchPins)
      .where(and(eq(branchPins.userId, user.id), eq(branchPins.branchId, branchId)));
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ ветви

  app.post('/vaults/:vaultId/branches', async (req, reply): Promise<BranchRecord> => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const body = parse(branchWrite, req.body);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.allows('branch.manage')) throw forbidden();
    if (body.parentId) await branchRow(vaultId, body.parentId);
    if (!access.canCreateIn(body.parentId)) throw forbidden();
    const kv = await vaultKeyVersion(vaultId);
    if (body.keyVersion !== kv) throw staleKey(kv);
    const [dupe] = await db
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.id, body.id));
    if (dupe) throw new AppError(409, 'already_exists', 'Branch already exists');
    const [row] = await db.transaction(async (tx) => {
      await lockVaultForWrite(tx, vaultId, body.keyVersion);
      return tx
        .insert(branches)
        .values({ ...body, vaultId, createdBy: user.id })
        .returning();
    });
    await audit(db, `user:${user.id}`, 'branch.create', `branch:${body.id}`, { vault: vaultId });
    reply.status(201);
    // подпапка наследует «Структуру»: создавший её по этому праву не получает управления
    return branchRecord(
      row!,
      atLeast(access.branch(body.parentId), 'editor') ? 'manager' : 'structure',
    );
  });

  /** Переименование и перемещение. Перемещение в собственного потомка (цикл) отклоняется. */
  app.patch('/vaults/:vaultId/branches/:branchId', async (req): Promise<BranchRecord> => {
    const { user } = authOf(req);
    const { vaultId, branchId } = parse(branchParams, req.params);
    const body = parse(branchPatch, req.body);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.allows('branch.manage')) throw forbidden();
    const b = await branchRow(vaultId, branchId);
    const a = access.branch(branchId);
    if (!a) throw notFound();
    if (!atLeast(a, 'editor')) throw forbidden();
    const patch: Partial<typeof branches.$inferInsert> = {
      updatedAt: new Date(),
      version: b.version + 1,
    };
    // название и оформление зашифрованы текущим ключом хранилища: устаревший ключ отклоняется
    const encrypted = body.nameCipher !== undefined || !!body.metaCipher;
    if (encrypted) {
      const kv = await vaultKeyVersion(vaultId);
      if ((body.keyVersion ?? kv) !== kv) throw staleKey(kv);
      // оформление другой версии ключа, чем название, не прочитать: меняются только вместе с текущей версией
      if (body.nameCipher === undefined && b.keyVersion !== kv)
        throw new AppError(409, 'stale_key_version', 'Re-encrypt the branch name first');
      patch.keyVersion = kv;
    }
    if (body.nameCipher !== undefined) patch.nameCipher = body.nameCipher;
    if (body.metaCipher !== undefined) patch.metaCipher = body.metaCipher;
    if (body.parentId !== undefined && body.parentId !== b.parentId) {
      await requireSubtreeEdit(access, await subtree(vaultId, branchId));
      if (body.parentId) {
        await branchRow(vaultId, body.parentId);
        if (access.ancestors(body.parentId).includes(branchId)) {
          throw new AppError(
            409,
            'cycle',
            'A branch cannot be moved into itself or its descendant',
          );
        }
      }
      if (!atLeast(access.branch(body.parentId), 'editor')) throw forbidden();
      patch.parentId = body.parentId;
    }
    const [row] = await db.transaction(async (tx) => {
      await lockVaultForWrite(tx, vaultId, encrypted ? body.keyVersion : undefined);
      return tx
        .update(branches)
        .set(patch)
        .where(and(eq(branches.id, branchId), eq(branches.version, b.version)))
        .returning();
    });
    if (!row) throw new AppError(409, 'version_conflict', 'Branch was modified by someone else');
    await audit(db, `user:${user.id}`, 'branch.update', `branch:${branchId}`, { vault: vaultId });
    return branchRecord(row!, a);
  });

  /** Все потомки ветви (включая её саму) по текущему дереву хранилища. */
  async function subtree(vaultId: string, rootId: string): Promise<string[]> {
    const rows = await db
      .select({ id: branches.id, parentId: branches.parentId })
      .from(branches)
      .where(eq(branches.vaultId, vaultId));
    const children = new Map<string, string[]>();
    for (const r of rows)
      if (r.parentId) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r.id]);
    const out = [rootId];
    for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]!) ?? []));
    return out;
  }

  async function requireSubtreeEdit(access: VaultAccess, ids: string[]) {
    for (const id of ids) if (!atLeast(access.branch(id), 'editor')) throw forbidden();
    const contents = await db
      .select()
      .from(entries)
      .where(and(eq(entries.vaultId, access.vaultId), inArray(entries.branchId, ids)));
    for (const entry of contents) entryAccess(access, entry, 'editor');
  }

  async function requireRestoreGroupEdit(access: VaultAccess, group: string | null) {
    if (!group) return;
    const [groupBranches, groupEntries] = await Promise.all([
      db
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.vaultId, access.vaultId), eq(branches.trashGroup, group))),
      db
        .select()
        .from(entries)
        .where(and(eq(entries.vaultId, access.vaultId), eq(entries.trashGroup, group))),
    ]);
    for (const branch of groupBranches)
      if (!atLeast(access.branch(branch.id), 'editor')) throw forbidden();
    for (const entry of groupEntries) entryAccess(access, entry, 'editor');
  }

  /** Удаление ветви: она и всё внутри уходят в корзину одной группой и восстанавливаются вместе. */
  app.delete('/vaults/:vaultId/branches/:branchId', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId, branchId } = parse(branchParams, req.params);
    const purge = (req.query as { purge?: string }).purge === '1';
    const access = await requireVault(db, vaultId, user.id);
    const b = await branchRow(vaultId, branchId, purge);
    if (!access.allows('branch.manage') || (!purge && !access.allows('entry.delete')))
      throw forbidden();
    const a = access.branch(branchId);
    if (!a) throw notFound();
    if (!atLeast(a, 'editor')) throw forbidden();
    const ids = await subtree(vaultId, branchId);
    // Удалять ветвь целиком может только тот, кто вправе менять всё её содержимое.
    await requireSubtreeEdit(access, ids);
    if (purge) {
      if (!access.allows('trash.purge')) throw forbidden();
      if (!b.deletedAt)
        throw new AppError(409, 'not_in_trash', 'Move the branch to the trash first');
      const doomed = await db
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.vaultId, vaultId), inArray(entries.branchId, ids)));
      const blobIds = await attachmentIdsOfEntries(
        db,
        doomed.map((d) => d.id),
      );
      await db
        .delete(entries)
        .where(and(eq(entries.vaultId, vaultId), inArray(entries.branchId, ids)));
      await ctx.blobs.remove(blobIds);
      await db.delete(branches).where(inArray(branches.id, ids));
      await audit(db, `user:${user.id}`, 'branch.purge', `branch:${branchId}`, { vault: vaultId });
      return reply.status(204).send();
    }
    const group = crypto.randomUUID();
    const now = new Date();
    await db.transaction(async (tx) => {
      await lockVaultForWrite(tx, vaultId);
      await tx
        .update(branches)
        .set({ deletedAt: now, trashGroup: group })
        .where(and(inArray(branches.id, ids), isNull(branches.deletedAt)));
      await tx
        .update(entries)
        .set({ deletedAt: now, trashGroup: group })
        .where(
          and(
            eq(entries.vaultId, vaultId),
            inArray(entries.branchId, ids),
            isNull(entries.deletedAt),
          ),
        );
    });
    await audit(db, `user:${user.id}`, 'branch.delete', `branch:${branchId}`, { vault: vaultId });
    return reply.status(204).send();
  });

  async function restoreGroup(
    vaultId: string,
    group: string | null,
    rootId: string,
    kind: 'entry' | 'branch',
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await lockVaultForWrite(tx, vaultId);
      let restoredBranchIds: string[] = [];
      let restoredEntryIds: string[] = [];
      if (group) {
        const restoredBranches = await tx
          .update(branches)
          .set({ deletedAt: null, trashGroup: null })
          .where(and(eq(branches.vaultId, vaultId), eq(branches.trashGroup, group)))
          .returning({ id: branches.id });
        const restoredEntries = await tx
          .update(entries)
          .set({ deletedAt: null, trashGroup: null })
          .where(and(eq(entries.vaultId, vaultId), eq(entries.trashGroup, group)))
          .returning({ id: entries.id });
        restoredBranchIds = restoredBranches.map((branch) => branch.id);
        restoredEntryIds = restoredEntries.map((entry) => entry.id);
      } else if (kind === 'entry') {
        await tx.update(entries).set({ deletedAt: null }).where(eq(entries.id, rootId));
        restoredEntryIds = [rootId];
      }
      // Родитель восстановленного элемента мог остаться в корзине (удалён отдельно): поднимаем элемент в корень.
      const live = tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.vaultId, vaultId), isNull(branches.deletedAt)));
      if (restoredBranchIds.length)
        await tx
          .update(branches)
          .set({ parentId: null })
          .where(
            and(
              eq(branches.vaultId, vaultId),
              inArray(branches.id, restoredBranchIds),
              isNull(branches.deletedAt),
              isNotNull(branches.parentId),
              sql`${branches.parentId} not in (${live})`,
            ),
          );
      if (restoredEntryIds.length)
        await tx
          .update(entries)
          .set({ branchId: null })
          .where(
            and(
              eq(entries.vaultId, vaultId),
              inArray(entries.id, restoredEntryIds),
              isNull(entries.deletedAt),
              isNotNull(entries.branchId),
              sql`${entries.branchId} not in (${live})`,
            ),
          );
    });
  }

  app.post('/vaults/:vaultId/branches/:branchId/restore', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId, branchId } = parse(branchParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    const b = await branchRow(vaultId, branchId, true);
    if (!access.allows('branch.manage')) throw forbidden();
    if (!access.branch(branchId)) throw notFound();
    if (!atLeast(access.branch(branchId), 'editor')) throw forbidden();
    if (!b.deletedAt) throw new AppError(409, 'not_in_trash', 'The branch is not in the trash');
    await requireRestoreGroupEdit(access, b.trashGroup);
    await restoreGroup(vaultId, b.trashGroup, branchId, 'branch');
    await audit(db, `user:${user.id}`, 'branch.restore', `branch:${branchId}`, { vault: vaultId });
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ массовые операции

  app.post('/vaults/:vaultId/entries/bulk', async (req) => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const body = parse(bulkRequest, req.body);
    const access = await requireVault(db, vaultId, user.id);
    if (body.action === 'trash' && !access.allows('entry.delete')) throw forbidden();
    const rows = await db
      .select()
      .from(entries)
      .where(and(eq(entries.vaultId, vaultId), inArray(entries.id, body.ids)));
    if (rows.length !== body.ids.length) throw notFound();
    for (const e of rows) entryAccess(access, e, 'editor'); // вся операция отклоняется, если хоть на одну запись нет права
    if (body.action === 'move') {
      const target = body.branchId ?? null;
      if (target) await branchRow(vaultId, target);
      if (!atLeast(access.branch(target), 'editor')) throw forbidden();
      await db.transaction(async (tx) => {
        await lockVaultForWrite(tx, vaultId);
        return tx
          .update(entries)
          .set({ branchId: target, updatedAt: new Date(), updatedBy: user.id })
          .where(inArray(entries.id, body.ids));
      });
    } else if (body.action === 'trash') {
      await db.transaction(async (tx) => {
        await lockVaultForWrite(tx, vaultId);
        return (
          tx
            // у каждой записи своя группа корзины: восстановление одной не возвращает остальные
            .update(entries)
            .set({ deletedAt: new Date(), trashGroup: sql`gen_random_uuid()`, updatedBy: user.id })
            .where(and(inArray(entries.id, body.ids), isNull(entries.deletedAt)))
        );
      });
    } else if (body.action === 'restore') {
      for (const e of rows) if (e.deletedAt) await requireRestoreGroupEdit(access, e.trashGroup);
      for (const e of rows)
        if (e.deletedAt) await restoreGroup(vaultId, e.trashGroup, e.id, 'entry');
    } else {
      if (!access.allows('trash.purge')) throw forbidden();
      if (rows.some((e) => !e.deletedAt))
        throw new AppError(409, 'not_in_trash', 'Only entries in the trash can be purged');
      const blobIds = await attachmentIdsOfEntries(db, body.ids);
      await db.delete(entries).where(inArray(entries.id, body.ids));
      await ctx.blobs.remove(blobIds);
    }
    await audit(db, `user:${user.id}`, `entry.bulk.${body.action}`, null, {
      vault: vaultId,
      count: body.ids.length,
    });
    for (const entry of rows)
      await audit(db, `user:${user.id}`, `entry.bulk.${body.action}`, `entry:${entry.id}`, {
        vault: vaultId,
      });
    return { affected: body.ids.length };
  });

  // ------------------------------------------------------------------ гранты на ветви и записи

  app.get('/vaults/:vaultId/grants', async (req) => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const q = req.query as { targetId?: string };
    const access = await requireVault(db, vaultId, user.id);
    const rows = await db.select().from(grants).where(eq(grants.vaultId, vaultId));
    const entryRows = await db
      .select({ id: entries.id, branchId: entries.branchId })
      .from(entries)
      .where(eq(entries.vaultId, vaultId));
    const entryBranches = new Map(entryRows.map((e) => [e.id, e.branchId]));
    const visible = rows.filter((g) => {
      if (q.targetId && g.targetId !== q.targetId) return false;
      if (access.isAdmin) return true;
      const a =
        g.targetType === 'branch'
          ? access.branch(g.targetId)
          : access.entry(g.targetId, entryBranches.get(g.targetId) ?? null);
      return a === 'manager';
    });
    const userIds = visible.filter((g) => g.subjectType === 'user').map((g) => g.subjectId);
    const circleIds = visible.filter((g) => g.subjectType === 'circle').map((g) => g.subjectId);
    const [us, cs] = await Promise.all([
      userIds.length
        ? db
            .select({ id: users.id, name: users.displayName, email: users.email })
            .from(users)
            .where(inArray(users.id, userIds))
        : [],
      circleIds.length
        ? db
            .select({ id: circles.id, name: circles.name })
            .from(circles)
            .where(inArray(circles.id, circleIds))
        : [],
    ]);
    const names = new Map<string, string>([
      ...us.map((u) => [u.id, `${u.name} <${u.email}>`] as const),
      ...cs.map((c) => [c.id, c.name] as const),
    ]);
    return visible.map((g) => ({
      id: g.id,
      targetType: g.targetType,
      targetId: g.targetId,
      subjectType: g.subjectType,
      subjectId: g.subjectId,
      subjectName: names.get(g.subjectId) ?? '',
      role: g.role,
      expiresAt: g.expiresAt?.toISOString() ?? null,
    }));
  });

  /** Выдать или изменить грант. Право — у администратора хранилища и у менеджера цели; выдать больше собственного права нельзя. */
  app.put('/vaults/:vaultId/grants', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const body = parse(grantPut, req.body);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.allows('grant.manage')) throw forbidden();
    let mine: Access | null;
    if (body.targetType === 'branch') {
      await branchRow(vaultId, body.targetId, true);
      mine = access.branch(body.targetId);
    } else {
      const e = await loadEntry(vaultId, body.targetId, true);
      mine = access.entry(e.id, e.branchId);
    }
    if (!mine && !access.isAdmin) throw notFound();
    if (mine !== 'manager' && !access.isAdmin) throw forbidden();
    // запрет самому себе отрезал бы управляющего от объекта; администратора сейфа запрет не ограничивает
    if (
      body.subjectType === 'user' &&
      body.subjectId === user.id &&
      body.role === 'none' &&
      !access.isAdmin
    ) {
      throw new AppError(400, 'self_deny', 'You cannot deny access to yourself');
    }
    if (body.role === 'structure' && body.targetType !== 'branch') {
      throw new AppError(400, 'validation_error', 'The structure level applies to folders only');
    }
    if (body.subjectType === 'user') {
      const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, body.subjectId));
      if (!u) throw notFound();
    } else {
      const [c] = await db
        .select({ id: circles.id })
        .from(circles)
        .where(eq(circles.id, body.subjectId));
      if (!c) throw notFound();
    }
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new AppError(400, 'validation_error', 'Expiry must be in the future');
    }
    const id = crypto.randomUUID();
    const [row] = await db
      .insert(grants)
      .values({ id, vaultId, ...body, expiresAt, createdBy: user.id })
      .onConflictDoUpdate({
        target: [grants.targetType, grants.targetId, grants.subjectType, grants.subjectId],
        set: { role: body.role, expiresAt },
      })
      .returning();
    await audit(db, `user:${user.id}`, 'grant.put', `${body.targetType}:${body.targetId}`, {
      vault: vaultId,
      subject: body.subjectId,
      subjectType: body.subjectType,
      role: body.role,
    });
    return reply.status(200).send({ id: row!.id });
  });

  app.delete('/vaults/:vaultId/grants/:grantId', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId, grantId } = parse(z.object({ vaultId: uuid, grantId: uuid }), req.params);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.allows('grant.manage')) throw forbidden();
    const [g] = await db
      .select()
      .from(grants)
      .where(and(eq(grants.id, grantId), eq(grants.vaultId, vaultId)));
    if (!g) throw notFound();
    const entry = g.targetType === 'entry' ? await loadEntry(vaultId, g.targetId, true) : null;
    const mine =
      g.targetType === 'branch'
        ? access.branch(g.targetId)
        : access.entry(g.targetId, entry?.branchId ?? null);
    if (mine !== 'manager' && !access.isAdmin) throw notFound();
    await db.delete(grants).where(eq(grants.id, grantId));
    await audit(db, `user:${user.id}`, 'grant.delete', `${g.targetType}:${g.targetId}`, {
      vault: vaultId,
      subject: g.subjectId,
      subjectType: g.subjectType,
    });
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ избранное пользователя

  app.get('/pins', async (req) => {
    const { user } = authOf(req);
    const rows = await db
      .select({ entryId: pins.entryId, vaultId: entries.vaultId })
      .from(pins)
      .innerJoin(entries, eq(entries.id, pins.entryId))
      .where(and(eq(pins.userId, user.id), isNull(entries.deletedAt)));
    // Закрепления записей, к которым доступ уже отозван, не показываются.
    const out: { entryId: string; vaultId: string }[] = [];
    const cache = new Map<string, VaultAccess>();
    for (const r of rows) {
      let acc = cache.get(r.vaultId);
      if (!acc) {
        acc = await loadAccess(db, r.vaultId, user.id);
        cache.set(r.vaultId, acc);
      }
      if (!acc.isMember) continue;
      const [e] = await db
        .select({ branchId: entries.branchId })
        .from(entries)
        .where(eq(entries.id, r.entryId));
      if (e && acc.entry(r.entryId, e.branchId)) out.push(r);
    }
    return out;
  });
};

/** Окончательное удаление записей и ветвей, пролежавших в корзине дольше срока хранения. */
export async function purgeExpiredTrash(
  db: AppContext['db'],
  retentionDays: number,
  now = new Date(),
  blobs?: AppContext['blobs'],
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const blobIds = await attachmentIdsExpired(db, cutoff);
  const e = await db
    .delete(entries)
    .where(and(isNotNull(entries.deletedAt), lt(entries.deletedAt, cutoff)))
    .returning({ id: entries.id });
  const b = await db
    .delete(branches)
    .where(and(isNotNull(branches.deletedAt), lt(branches.deletedAt, cutoff)))
    .returning({ id: branches.id });
  await blobs?.remove(blobIds);
  return e.length + b.length;
}
