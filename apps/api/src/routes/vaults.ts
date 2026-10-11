import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { entryDelete, entryUpdate, entryWrite, uuid } from '@arklock/contracts';
import type { EntryRecord, VaultInfo, VaultRole } from '@arklock/contracts';
import { audit } from '../audit.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { entries, vaultMembers, vaults } from '../db/schema.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';

const WRITERS: VaultRole[] = ['owner', 'admin', 'editor'];

function record(e: typeof entries.$inferSelect): EntryRecord {
  return {
    id: e.id,
    vaultId: e.vaultId,
    wrappedEntryKey: e.wrappedEntryKey,
    ciphertext: e.ciphertext,
    keyVersion: e.keyVersion,
    version: e.version,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

const staleKey = (keyVersion: number) =>
  new AppError(409, 'stale_key_version', 'Vault key was rotated, re-fetch the key', { keyVersion });

export const registerVaultRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));

  /**
   * Доступ к хранилищу. Не участнику хранилище неотличимо от несуществующего (404), чтобы
   * нельзя было перебирать идентификаторы.
   */
  async function membership(vaultId: string, userId: string) {
    const [row] = await db
      .select({ vault: vaults, member: vaultMembers })
      .from(vaultMembers)
      .innerJoin(vaults, eq(vaults.id, vaultMembers.vaultId))
      .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, userId)))
      .limit(1);
    if (!row) throw notFound();
    return row;
  }

  async function currentVersion(vaultId: string, entryId: string) {
    const [cur] = await db
      .select({ version: entries.version })
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.vaultId, vaultId), isNull(entries.deletedAt)));
    if (!cur) throw notFound();
    return new AppError(409, 'version_conflict', 'Entry was modified by someone else', {
      currentVersion: cur.version,
    });
  }

  app.get('/vaults', async (req): Promise<VaultInfo[]> => {
    const { user } = authOf(req);
    const rows = await db
      .select({ vault: vaults, member: vaultMembers })
      .from(vaultMembers)
      .innerJoin(vaults, eq(vaults.id, vaultMembers.vaultId))
      .where(eq(vaultMembers.userId, user.id));
    return rows.map(({ vault, member }) => ({
      id: vault.id,
      kind: vault.kind,
      name: vault.name,
      keyVersion: vault.keyVersion,
      role: member.role,
      sealedKey: member.sealedKey,
      sealedKeyVersion: member.sealedKeyVersion,
    }));
  });

  const vaultParams = z.object({ vaultId: uuid });
  const entryParams = z.object({ vaultId: uuid, entryId: uuid });

  app.get('/vaults/:vaultId/entries', async (req): Promise<EntryRecord[]> => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    await membership(vaultId, user.id);
    const rows = await db
      .select()
      .from(entries)
      .where(and(eq(entries.vaultId, vaultId), isNull(entries.deletedAt)));
    return rows.map(record);
  });

  app.get('/vaults/:vaultId/entries/:entryId', async (req): Promise<EntryRecord> => {
    const { user } = authOf(req);
    const { vaultId, entryId } = parse(entryParams, req.params);
    await membership(vaultId, user.id);
    const [row] = await db
      .select()
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.vaultId, vaultId), isNull(entries.deletedAt)));
    if (!row) throw notFound();
    return record(row);
  });

  app.post('/vaults/:vaultId/entries', async (req, reply): Promise<EntryRecord> => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const body = parse(entryWrite, req.body);
    const { vault, member } = await membership(vaultId, user.id);
    if (!WRITERS.includes(member.role)) throw forbidden();
    if (body.keyVersion !== vault.keyVersion) throw staleKey(vault.keyVersion);
    const id = body.id ?? crypto.randomUUID();
    const [dupe] = await db.select({ id: entries.id }).from(entries).where(eq(entries.id, id));
    if (dupe) throw new AppError(409, 'already_exists', 'Entry already exists');
    const [row] = await db
      .insert(entries)
      .values({
        id,
        vaultId,
        wrappedEntryKey: body.wrappedEntryKey,
        ciphertext: body.ciphertext,
        keyVersion: body.keyVersion,
        createdBy: user.id,
      })
      .returning();
    await audit(db, `user:${user.id}`, 'entry.create', `entry:${id}`, { vault: vaultId });
    reply.status(201);
    return record(row!);
  });

  app.put('/vaults/:vaultId/entries/:entryId', async (req): Promise<EntryRecord> => {
    const { user } = authOf(req);
    const { vaultId, entryId } = parse(entryParams, req.params);
    const body = parse(entryUpdate, req.body);
    const { vault, member } = await membership(vaultId, user.id);
    if (!WRITERS.includes(member.role)) throw forbidden();
    if (body.keyVersion !== vault.keyVersion) throw staleKey(vault.keyVersion);
    // Условное обновление выполняется одним оператором: параллельная правка не теряется.
    const [row] = await db
      .update(entries)
      .set({
        wrappedEntryKey: body.wrappedEntryKey,
        ciphertext: body.ciphertext,
        keyVersion: body.keyVersion,
        version: body.expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(entries.id, entryId),
          eq(entries.vaultId, vaultId),
          eq(entries.version, body.expectedVersion),
          isNull(entries.deletedAt),
        ),
      )
      .returning();
    if (!row) throw await currentVersion(vaultId, entryId);
    await audit(db, `user:${user.id}`, 'entry.update', `entry:${entryId}`, { vault: vaultId });
    return record(row);
  });

  app.delete('/vaults/:vaultId/entries/:entryId', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId, entryId } = parse(entryParams, req.params);
    const { expectedVersion } = parse(entryDelete, {
      expectedVersion: Number((req.query as { expectedVersion?: string }).expectedVersion),
    });
    const { member } = await membership(vaultId, user.id);
    if (!WRITERS.includes(member.role)) throw forbidden();
    const res = await db
      .update(entries)
      .set({ deletedAt: new Date(), version: expectedVersion + 1, updatedAt: new Date() })
      .where(
        and(
          eq(entries.id, entryId),
          eq(entries.vaultId, vaultId),
          eq(entries.version, expectedVersion),
          isNull(entries.deletedAt),
        ),
      )
      .returning({ id: entries.id });
    if (!res.length) throw await currentVersion(vaultId, entryId);
    await audit(db, `user:${user.id}`, 'entry.delete', `entry:${entryId}`, { vault: vaultId });
    return reply.status(204).send();
  });
};
