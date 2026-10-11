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
  users,
  vaults,
} from '../db/schema.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';

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

  function branchRecord(b: typeof branches.$inferSelect, access: Access): BranchRecord {
    return {
      id: b.id,
      vaultId: b.vaultId,
      parentId: b.parentId,
      nameCipher: b.nameCipher,
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
    for (const b of brRows) {
      if (trash ? !b.deletedAt : !!b.deletedAt) continue;
      const a = access.branch(b.id);
      if (a) outBranches.push(branchRecord(b, a));
    }
    return { branches: outBranches, entries: outEntries };
  });

  app.get('/vaults/:vaultId/entries/:entryId', async (req): Promise<EntryRecord> => {
    const { user } = authOf(req);
    const { vaultId, entryId } = parse(entryParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    const e = await loadEntry(vaultId, entryId, true);
    const a = entryAccess(access, e, 'reader');
    return entryRecord(e, a, (await pinnedSet(user.id, [e.id])).has(e.id));
  });

  // ------------------------------------------------------------------ записи

  app.post('/vaults/:vaultId/entries', async (req, reply): Promise<EntryRecord> => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const body = parse(entryWrite, req.body);
    const access = await requireVault(db, vaultId, user.id);
    const branchId = body.branchId ?? null;
    if (branchId) await branchRow(vaultId, branchId);
    if (!atLeast(access.branch(branchId), 'editor')) throw forbidden();
    const kv = await vaultKeyVersion(vaultId);
    if (body.keyVersion !== kv) throw staleKey(kv);
    const id = body.id ?? crypto.randomUUID();
    const [dupe] = await db.select({ id: entries.id }).from(entries).where(eq(entries.id, id));
    if (dupe) throw new AppError(409, 'already_exists', 'Entry already exists');
    const [row] = await db
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
    await audit(db, `user:${user.id}`, 'entry.update', `entry:${entryId}`, { vault: vaultId });
    return entryRecord(updated, a, (await pinnedSet(user.id, [entryId])).has(entryId));
  });

  /** Мягкое удаление записи (корзина). */
  app.delete('/vaults/:vaultId/entries/:entryId', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId, entryId } = parse(entryParams, req.params);
    const q = req.query as { expectedVersion?: string; purge?: string };
    const access = await requireVault(db, vaultId, user.id);
    if (q.purge === '1') {
      const e = await loadEntry(vaultId, entryId, true);
      entryAccess(access, e, 'editor');
      if (!e.deletedAt)
        throw new AppError(409, 'not_in_trash', 'Move the entry to the trash first');
      await db.delete(entries).where(eq(entries.id, entryId));
      await audit(db, `user:${user.id}`, 'entry.purge', `entry:${entryId}`, { vault: vaultId });
      return reply.status(204).send();
    }
    const { expectedVersion } = parse(entryDelete, { expectedVersion: Number(q.expectedVersion) });
    const e = await loadEntry(vaultId, entryId);
    entryAccess(access, e, 'editor');
    if (e.version !== expectedVersion) {
      throw new AppError(409, 'version_conflict', 'Entry was modified by someone else', {
        currentVersion: e.version,
      });
    }
    await db
      .update(entries)
      .set({
        deletedAt: new Date(),
        trashGroup: crypto.randomUUID(),
        version: e.version + 1,
        updatedBy: user.id,
      })
      .where(eq(entries.id, entryId));
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
    await restoreGroup(vaultId, e.trashGroup, e.id, 'entry');
    await audit(db, `user:${user.id}`, 'entry.restore', `entry:${entryId}`, { vault: vaultId });
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ ревизии

  app.get('/vaults/:vaultId/entries/:entryId/revisions', async (req): Promise<RevisionRecord[]> => {
    const { user } = authOf(req);
    const { vaultId, entryId } = parse(entryParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
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

  // ------------------------------------------------------------------ ветви

  app.post('/vaults/:vaultId/branches', async (req, reply): Promise<BranchRecord> => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const body = parse(branchWrite, req.body);
    const access = await requireVault(db, vaultId, user.id);
    if (body.parentId) await branchRow(vaultId, body.parentId);
    if (!atLeast(access.branch(body.parentId), 'editor')) throw forbidden();
    const kv = await vaultKeyVersion(vaultId);
    if (body.keyVersion !== kv) throw staleKey(kv);
    const [dupe] = await db
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.id, body.id));
    if (dupe) throw new AppError(409, 'already_exists', 'Branch already exists');
    const [row] = await db
      .insert(branches)
      .values({ ...body, vaultId, createdBy: user.id })
      .returning();
    await audit(db, `user:${user.id}`, 'branch.create', `branch:${body.id}`, { vault: vaultId });
    reply.status(201);
    return branchRecord(row!, 'manager');
  });

  /** Переименование и перемещение. Перемещение в собственного потомка (цикл) отклоняется. */
  app.patch('/vaults/:vaultId/branches/:branchId', async (req): Promise<BranchRecord> => {
    const { user } = authOf(req);
    const { vaultId, branchId } = parse(branchParams, req.params);
    const body = parse(branchPatch, req.body);
    const access = await requireVault(db, vaultId, user.id);
    const b = await branchRow(vaultId, branchId);
    const a = access.branch(branchId);
    if (!a) throw notFound();
    if (!atLeast(a, 'editor')) throw forbidden();
    const patch: Partial<typeof branches.$inferInsert> = {
      updatedAt: new Date(),
      version: b.version + 1,
    };
    if (body.nameCipher !== undefined) {
      const kv = await vaultKeyVersion(vaultId);
      if ((body.keyVersion ?? kv) !== kv) throw staleKey(kv);
      patch.nameCipher = body.nameCipher;
      patch.keyVersion = kv;
    }
    if (body.parentId !== undefined && body.parentId !== b.parentId) {
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
    const [row] = await db.update(branches).set(patch).where(eq(branches.id, branchId)).returning();
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

  /** Удаление ветви: она и всё внутри уходят в корзину одной группой и восстанавливаются вместе. */
  app.delete('/vaults/:vaultId/branches/:branchId', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId, branchId } = parse(branchParams, req.params);
    const purge = (req.query as { purge?: string }).purge === '1';
    const access = await requireVault(db, vaultId, user.id);
    const b = await branchRow(vaultId, branchId, purge);
    const a = access.branch(branchId);
    if (!a) throw notFound();
    if (!atLeast(a, 'editor')) throw forbidden();
    const ids = await subtree(vaultId, branchId);
    // Удалять ветвь целиком может только тот, кто вправе менять всё её содержимое.
    for (const id of ids) if (!atLeast(access.branch(id), 'editor')) throw forbidden();
    if (purge) {
      if (!b.deletedAt)
        throw new AppError(409, 'not_in_trash', 'Move the branch to the trash first');
      await db
        .delete(entries)
        .where(and(eq(entries.vaultId, vaultId), inArray(entries.branchId, ids)));
      await db.delete(branches).where(inArray(branches.id, ids));
      await audit(db, `user:${user.id}`, 'branch.purge', `branch:${branchId}`, { vault: vaultId });
      return reply.status(204).send();
    }
    const group = crypto.randomUUID();
    const now = new Date();
    await db.transaction(async (tx) => {
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
      if (group) {
        await tx
          .update(branches)
          .set({ deletedAt: null, trashGroup: null })
          .where(and(eq(branches.vaultId, vaultId), eq(branches.trashGroup, group)));
        await tx
          .update(entries)
          .set({ deletedAt: null, trashGroup: null })
          .where(and(eq(entries.vaultId, vaultId), eq(entries.trashGroup, group)));
      } else if (kind === 'entry') {
        await tx.update(entries).set({ deletedAt: null }).where(eq(entries.id, rootId));
      }
      // Родитель восстановленного элемента мог остаться в корзине (удалён отдельно): поднимаем элемент в корень.
      const live = tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.vaultId, vaultId), isNull(branches.deletedAt)));
      await tx
        .update(branches)
        .set({ parentId: null })
        .where(
          and(
            eq(branches.vaultId, vaultId),
            isNull(branches.deletedAt),
            isNotNull(branches.parentId),
            sql`${branches.parentId} not in (${live})`,
          ),
        );
      await tx
        .update(entries)
        .set({ branchId: null })
        .where(
          and(
            eq(entries.vaultId, vaultId),
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
    if (!access.branch(branchId)) throw notFound();
    if (!atLeast(access.branch(branchId), 'editor')) throw forbidden();
    if (!b.deletedAt) throw new AppError(409, 'not_in_trash', 'The branch is not in the trash');
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
      await db
        .update(entries)
        .set({ branchId: target, updatedAt: new Date(), updatedBy: user.id })
        .where(inArray(entries.id, body.ids));
    } else if (body.action === 'trash') {
      await db
        // у каждой записи своя группа корзины: восстановление одной не возвращает остальные
        .update(entries)
        .set({ deletedAt: new Date(), trashGroup: sql`gen_random_uuid()`, updatedBy: user.id })
        .where(and(inArray(entries.id, body.ids), isNull(entries.deletedAt)));
    } else if (body.action === 'restore') {
      for (const e of rows)
        if (e.deletedAt) await restoreGroup(vaultId, e.trashGroup, e.id, 'entry');
    } else {
      if (rows.some((e) => !e.deletedAt))
        throw new AppError(409, 'not_in_trash', 'Only entries in the trash can be purged');
      await db.delete(entries).where(inArray(entries.id, body.ids));
    }
    await audit(db, `user:${user.id}`, `entry.bulk.${body.action}`, null, {
      vault: vaultId,
      count: body.ids.length,
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
    const visible = rows.filter((g) => {
      if (q.targetId && g.targetId !== q.targetId) return false;
      if (access.isAdmin) return true;
      const a =
        g.targetType === 'branch' ? access.branch(g.targetId) : access.entry(g.targetId, null);
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
    let mine: Access | null;
    if (body.targetType === 'branch') {
      await branchRow(vaultId, body.targetId, true);
      mine = access.branch(body.targetId);
    } else {
      const e = await loadEntry(vaultId, body.targetId, true);
      mine = access.entry(e.id, e.branchId);
    }
    if (!mine) throw notFound();
    if (mine !== 'manager') throw forbidden();
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
      role: body.role,
    });
    return reply.status(200).send({ id: row!.id });
  });

  app.delete('/vaults/:vaultId/grants/:grantId', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId, grantId } = parse(z.object({ vaultId: uuid, grantId: uuid }), req.params);
    const access = await requireVault(db, vaultId, user.id);
    const [g] = await db
      .select()
      .from(grants)
      .where(and(eq(grants.id, grantId), eq(grants.vaultId, vaultId)));
    if (!g) throw notFound();
    const mine =
      g.targetType === 'branch' ? access.branch(g.targetId) : access.entry(g.targetId, null);
    if (mine !== 'manager') throw notFound();
    await db.delete(grants).where(eq(grants.id, grantId));
    await audit(db, `user:${user.id}`, 'grant.delete', `${g.targetType}:${g.targetId}`, {
      vault: vaultId,
      subject: g.subjectId,
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
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const e = await db
    .delete(entries)
    .where(and(isNotNull(entries.deletedAt), lt(entries.deletedAt, cutoff)))
    .returning({ id: entries.id });
  const b = await db
    .delete(branches)
    .where(and(isNotNull(branches.deletedAt), lt(branches.deletedAt, cutoff)))
    .returning({ id: branches.id });
  return e.length + b.length;
}
