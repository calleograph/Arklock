import { and, asc, desc, eq, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { verifyKeyGrant, fromBase64Url } from '@arklock/crypto';
import {
  circleRolePut,
  createVaultRequest,
  keysPost,
  memberPut,
  rotatePost,
  uuid,
} from '@arklock/contracts';
import type { VaultInfo, VaultRole } from '@arklock/contracts';
import { loadAccess, loadRoleDefs, requireVault } from '../access.js';
import { BUILTIN_VAULT_ROLES, effective, expandRole } from '../perms.js';
import { audit } from '../audit.js';
import { enforceDenyRules } from '../automation.js';
import { notifyUsers } from '../notifications.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { rowsOf } from '../db/connect.js';
import { corporateRecoveryRecipientOf } from '../corporate-recovery.js';
import {
  attachments,
  branches,
  circleMembers,
  circles,
  corporateRecoveryKeys,
  entries,
  entryRevisions,
  grants,
  keyLog,
  pins,
  settings,
  spaces,
  users,
  vaultCircles,
  vaultKeys,
  vaultMembers,
  vaults,
} from '../db/schema.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';
import { attachmentIdsOfVault, blobSuffix, rotationSuffix } from './attachments.js';
import { lockVaultForWrite } from '../vault-mutation.js';
import { DEFAULT_SPACE_ID, requireSpace, spaceAccess } from '../spaces.js';

export const registerVaultRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  const vaultParams = z.object({ vaultId: uuid });

  async function getVault(vaultId: string) {
    const [v] = await db.select().from(vaults).where(eq(vaults.id, vaultId));
    if (!v) throw notFound();
    return v;
  }

  async function signKeyOf(userId: string, connection = db): Promise<Uint8Array> {
    const [u] = await connection
      .select({ k: users.signPublicKey })
      .from(users)
      .where(eq(users.id, userId));
    if (!u) throw notFound();
    return fromBase64Url(u.k);
  }

  /** Подпись выдачи ключа проверяется сервером (защита в глубину; клиент проверяет её сам при получении). */
  async function assertGrantSignature(
    granterId: string,
    vaultId: string,
    memberId: string,
    keyVersion: number,
    sealedKey: string,
    signature: string,
    connection = db,
  ): Promise<void> {
    const ok = await verifyKeyGrant(
      await signKeyOf(granterId, connection),
      signature,
      vaultId,
      memberId,
      keyVersion,
      sealedKey,
    ).catch(() => false);
    if (!ok) throw new AppError(400, 'bad_signature', 'Key grant signature is invalid');
  }

  async function userVaultIds(userId: string): Promise<string[]> {
    const cs = await db
      .select({ id: circleMembers.circleId })
      .from(circleMembers)
      .where(eq(circleMembers.userId, userId));
    const circleIds = cs.map((c) => c.id);
    const [direct, viaCircles, viaGrants] = await Promise.all([
      db
        .select({ id: vaultMembers.vaultId })
        .from(vaultMembers)
        .where(eq(vaultMembers.userId, userId)),
      circleIds.length
        ? db
            .select({ id: vaultCircles.vaultId })
            .from(vaultCircles)
            .where(inArray(vaultCircles.circleId, circleIds))
        : [],
      db
        .select({ id: grants.vaultId })
        .from(grants)
        .where(
          or(
            and(eq(grants.subjectType, 'user'), eq(grants.subjectId, userId)),
            circleIds.length
              ? and(eq(grants.subjectType, 'circle'), inArray(grants.subjectId, circleIds))
              : sql`false`,
          ),
        ),
    ]);
    return [...new Set([...direct, ...viaCircles, ...viaGrants].map((r) => r.id))];
  }

  /** Эффективные полномочия назначения (встроенная или пользовательская роль). Неизвестная роль не даёт ничего. */
  async function assignmentPerms(
    role: string | null | undefined,
    customRoleId: string | null | undefined,
  ): Promise<Set<string>> {
    if (customRoleId) {
      const defs = await loadRoleDefs(db);
      const d = defs.get(customRoleId);
      if (!d || d.scope !== 'vault') throw new AppError(400, 'validation_error', 'Unknown role');
      return effective([expandRole(defs, customRoleId)]);
    }
    return new Set(BUILTIN_VAULT_ROLES[role ?? 'limited'] ?? []);
  }

  /**
   * Нельзя выдать больше, чем есть у самого выдающего (повышение привилегий), а роли, позволяющие управлять участниками,
   * выдаёт и меняет только владелец (полномочие vault.delete).
   */
  function assertCanAssign(access: { can: (p: string) => boolean }, perms: Set<string>): void {
    for (const p of perms) if (!access.can(p)) throw forbidden();
    if (perms.has('members.manage') && !access.can('vault.delete')) throw forbidden();
  }

  /** Роли хранилища (пользовательские) с эффективными полномочиями — для выбора при назначении участникам. */
  app.get('/vault-roles', async (req) => {
    authOf(req);
    const defs = await loadRoleDefs(db);
    return [...defs.values()]
      .filter((d) => d.scope === 'vault')
      .map((d) => ({
        id: d.id,
        name: d.name,
        permissions: [...effective([expandRole(defs, d.id)])].sort(),
      }));
  });

  app.get('/vaults', async (req): Promise<VaultInfo[]> => {
    const { user } = authOf(req);
    const ids = await userVaultIds(user.id);
    if (!ids.length) return [];
    const vs = await db.select().from(vaults).where(inArray(vaults.id, ids));
    const keys = await db
      .select({ k: vaultKeys, signKey: users.signPublicKey })
      .from(vaultKeys)
      .innerJoin(users, eq(users.id, vaultKeys.grantedBy))
      .where(and(eq(vaultKeys.userId, user.id), inArray(vaultKeys.vaultId, ids)))
      .orderBy(desc(vaultKeys.keyVersion));
    // группы и членство в пространствах читаются один раз на весь список, а не для каждого сейфа
    const circleIds = (
      await db
        .select({ id: circleMembers.circleId })
        .from(circleMembers)
        .where(eq(circleMembers.userId, user.id))
    ).map((c) => c.id);
    const spaceMember = new Map<string, boolean>();
    for (const sid of new Set(vs.map((v) => v.spaceId).filter((x): x is string => !!x)))
      spaceMember.set(sid, (await spaceAccess(db, sid, user.id)).member);
    const out: VaultInfo[] = [];
    const now = new Date();
    for (const v of vs) {
      const a = await loadAccess(db, v.id, user.id, now, { vault: v, circleIds, spaceMember });
      if (!a.role) continue;
      const k = keys.find((x) => x.k.vaultId === v.id);
      out.push({
        id: v.id,
        kind: v.kind,
        spaceId: v.spaceId,
        name: v.name,
        keyVersion: v.keyVersion,
        role: a.role,
        canManageMembers: a.isAdmin,
        key: k
          ? {
              sealedKey: k.k.sealedKey,
              keyVersion: k.k.keyVersion,
              grantedBy: k.k.grantedBy,
              grantedBySignKey: k.signKey,
              signature: k.k.signature,
            }
          : null,
        pendingKey: !k || k.k.keyVersion !== v.keyVersion,
        permissions: [...a.perms].sort(),
      });
    }
    return out;
  });

  async function creatorsPolicy(): Promise<'admins' | 'members'> {
    const [s] = await db.select().from(settings).where(eq(settings.key, 'vaults.creators'));
    return s?.value === 'members' ? 'members' : 'admins';
  }

  app.post('/vaults', async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(createVaultRequest, req.body);
    if (user.role !== 'admin' && (await creatorsPolicy()) !== 'members') throw forbidden();
    const [dupe] = await db.select({ id: vaults.id }).from(vaults).where(eq(vaults.id, body.id));
    if (dupe) throw new AppError(409, 'already_exists', 'Vault already exists');
    await assertGrantSignature(user.id, body.id, user.id, 1, body.sealedKey, body.signature);
    await db.transaction(async (tx) => {
      const spaceId = body.spaceId ?? DEFAULT_SPACE_ID;
      await tx.select().from(spaces).where(eq(spaces.id, spaceId)).for('update');
      await requireSpace(tx, spaceId, user.id);
      await tx.insert(vaults).values({
        id: body.id,
        kind: 'shared',
        spaceId,
        name: body.name,
        keyVersion: 1,
        createdBy: user.id,
      });
      await tx.insert(vaultMembers).values({ vaultId: body.id, userId: user.id, role: 'owner' });
      await tx.insert(vaultKeys).values({
        vaultId: body.id,
        userId: user.id,
        keyVersion: 1,
        sealedKey: body.sealedKey,
        grantedBy: user.id,
        signature: body.signature,
      });
    });
    await audit(db, `user:${user.id}`, 'vault.create', `vault:${body.id}`);
    return reply.status(201).send({ id: body.id });
  });

  app.patch('/vaults/:vaultId', async (req) => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(100) }), req.body);
    const access = await requireVault(db, vaultId, user.id);
    const v = await getVault(vaultId);
    if (v.kind === 'locker') throw forbidden();
    if (!access.can('vault.settings')) throw forbidden();
    await db.update(vaults).set({ name }).where(eq(vaults.id, vaultId));
    await audit(db, `user:${user.id}`, 'vault.rename', `vault:${vaultId}`);
    return { id: vaultId, name };
  });

  /**
   * Передача владения общим хранилищем. Только владелец; новый владелец — участник хранилища с выданным ключом;
   * прежний владелец становится администратором. Владелец всегда один; личный сейф передать нельзя.
   */
  app.post('/vaults/:vaultId/transfer-ownership', async (req) => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const body = parse(z.object({ userId: uuid }), req.body);
    const access = await requireVault(db, vaultId, user.id);
    const v = await getVault(vaultId);
    if (v.kind === 'locker' || !access.can('vault.delete')) throw forbidden();
    if (body.userId === user.id)
      throw new AppError(400, 'validation_error', 'You already own this vault');
    const [me] = await db
      .select({ role: vaultMembers.role })
      .from(vaultMembers)
      .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, user.id)));
    if (me?.role !== 'owner') throw forbidden();
    const [target] = await db.select().from(users).where(eq(users.id, body.userId));
    if (!target || target.disabledAt) throw notFound();
    const [member] = await db
      .select({ userId: vaultMembers.userId })
      .from(vaultMembers)
      .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, body.userId)));
    if (!member)
      throw new AppError(
        409,
        'not_a_member',
        'The new owner must already be a member of the vault',
      );
    const [key] = await db
      .select({ userId: vaultKeys.userId })
      .from(vaultKeys)
      .where(
        and(
          eq(vaultKeys.vaultId, vaultId),
          eq(vaultKeys.userId, body.userId),
          eq(vaultKeys.keyVersion, v.keyVersion),
        ),
      );
    if (!key) throw new AppError(409, 'key_missing', 'Give the new owner the vault key first');
    await db.transaction(async (tx) => {
      await tx.select({ id: vaults.id }).from(vaults).where(eq(vaults.id, vaultId)).for('update');
      const [currentOwner] = await tx
        .select({ role: vaultMembers.role })
        .from(vaultMembers)
        .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, user.id)));
      if (currentOwner?.role !== 'owner') throw forbidden();
      await tx
        .update(vaultMembers)
        .set({ role: 'admin', customRoleId: null, expiresAt: null })
        .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, user.id)));
      await tx
        .update(vaultMembers)
        .set({ role: 'owner', customRoleId: null, expiresAt: null })
        .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, body.userId)));
    });
    await audit(db, `user:${user.id}`, 'vault.owner.transfer', `vault:${vaultId}`, {
      to: body.userId,
    });
    return { ok: true };
  });

  app.delete('/vaults/:vaultId', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    const v = await getVault(vaultId);
    if (v.kind === 'locker' || !access.can('vault.delete')) throw forbidden();
    const blobIds = await attachmentIdsOfVault(db, vaultId);
    await db.delete(vaults).where(eq(vaults.id, vaultId));
    await ctx.blobs.remove(blobIds);
    await audit(db, `user:${user.id}`, 'vault.delete', `vault:${vaultId}`);
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ участники

  app.get('/vaults/:vaultId/members', async (req) => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.isAdmin) throw forbidden();
    const v = await getVault(vaultId);
    const direct = await db
      .select({
        userId: vaultMembers.userId,
        role: vaultMembers.role,
        customRoleId: vaultMembers.customRoleId,
        expiresAt: vaultMembers.expiresAt,
      })
      .from(vaultMembers)
      .where(eq(vaultMembers.vaultId, vaultId));
    const vc = await db
      .select({
        circleId: vaultCircles.circleId,
        role: vaultCircles.role,
        customRoleId: vaultCircles.customRoleId,
        expiresAt: vaultCircles.expiresAt,
        name: circles.name,
      })
      .from(vaultCircles)
      .innerJoin(circles, eq(circles.id, vaultCircles.circleId))
      .where(eq(vaultCircles.vaultId, vaultId));
    const viaCircle = vc.length
      ? await db
          .select({ userId: circleMembers.userId, circleId: circleMembers.circleId })
          .from(circleMembers)
          .where(
            inArray(
              circleMembers.circleId,
              vc.map((c) => c.circleId),
            ),
          )
      : [];
    const grantUsers = await db
      .select({ id: grants.subjectId })
      .from(grants)
      .where(and(eq(grants.vaultId, vaultId), eq(grants.subjectType, 'user')));
    const ids = [
      ...new Set([
        ...direct.map((d) => d.userId),
        ...viaCircle.map((c) => c.userId),
        ...grantUsers.map((g) => g.id),
      ]),
    ];
    const us = ids.length ? await db.select().from(users).where(inArray(users.id, ids)) : [];
    const keys = ids.length
      ? await db
          .select({ userId: vaultKeys.userId })
          .from(vaultKeys)
          .where(
            and(
              eq(vaultKeys.vaultId, vaultId),
              eq(vaultKeys.keyVersion, v.keyVersion),
              inArray(vaultKeys.userId, ids),
            ),
          )
      : [];
    const hasKey = new Set(keys.map((k) => k.userId));
    const allowedUsers = new Set<string>();
    for (const u of us) if ((await loadAccess(db, vaultId, u.id)).isMember) allowedUsers.add(u.id);
    return {
      keyVersion: v.keyVersion,
      members: us.map((u) => ({
        userId: u.id,
        name: u.displayName,
        email: u.email,
        publicKey: u.publicKey,
        signPublicKey: u.signPublicKey,
        directRole: direct.find((d) => d.userId === u.id)?.role ?? null,
        directCustomRoleId: direct.find((d) => d.userId === u.id)?.customRoleId ?? null,
        directExpiresAt: direct.find((d) => d.userId === u.id)?.expiresAt?.toISOString() ?? null,
        circles: vc
          .filter((c) => viaCircle.some((m) => m.userId === u.id && m.circleId === c.circleId))
          .map((c) => ({
            id: c.circleId,
            name: c.name,
            role: c.role,
            customRoleId: c.customRoleId,
            expiresAt: c.expiresAt?.toISOString() ?? null,
          })),
        hasKey: hasKey.has(u.id),
        spaceAllowed: allowedUsers.has(u.id),
      })),
      circles: vc.map((c) => ({
        id: c.circleId,
        name: c.name,
        role: c.role,
        customRoleId: c.customRoleId,
        expiresAt: c.expiresAt?.toISOString() ?? null,
      })),
    };
  });

  app.put('/vaults/:vaultId/members/:userId', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId, userId } = parse(z.object({ vaultId: uuid, userId: uuid }), req.params);
    const body = parse(memberPut, req.body);
    const access = await requireVault(db, vaultId, user.id);
    const v = await getVault(vaultId);
    if (v.kind === 'locker' || !access.isAdmin) throw forbidden();
    if (!body.role && !body.customRoleId)
      throw new AppError(400, 'validation_error', 'Specify a role or a custom role');
    const newPerms = await assignmentPerms(body.role, body.customRoleId);
    assertCanAssign(access, newPerms);
    const [target] = await db.select().from(users).where(eq(users.id, userId));
    if (!target || target.disabledAt) throw notFound();
    await requireSpace(db, v.spaceId!, userId);
    const [existing] = await db
      .select({ role: vaultMembers.role, customRoleId: vaultMembers.customRoleId })
      .from(vaultMembers)
      .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, userId)));
    if (existing?.role === 'owner') throw forbidden();
    if (existing)
      assertCanAssign(access, await assignmentPerms(existing.role, existing.customRoleId));
    await enforceDenyRules(db, 'access.change', {
      actor: `user:${user.id}`,
      vaultId: vaultId,
      target: `user:${userId}`,
    });
    if (body.key) {
      if (body.key.keyVersion !== v.keyVersion)
        throw new AppError(409, 'stale_key_version', 'Vault key was rotated', {
          keyVersion: v.keyVersion,
        });
      await assertGrantSignature(
        user.id,
        vaultId,
        userId,
        body.key.keyVersion,
        body.key.sealedKey,
        body.key.signature,
      );
    }
    await db.transaction(async (tx) => {
      await tx
        .insert(vaultMembers)
        .values({
          vaultId,
          userId,
          role: body.customRoleId ? 'limited' : body.role!,
          customRoleId: body.customRoleId ?? null,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        })
        .onConflictDoUpdate({
          target: [vaultMembers.vaultId, vaultMembers.userId],
          set: {
            role: body.customRoleId ? 'limited' : body.role!,
            customRoleId: body.customRoleId ?? null,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          },
        });
      if (body.key) {
        await tx
          .insert(vaultKeys)
          .values({
            vaultId,
            userId,
            keyVersion: body.key.keyVersion,
            sealedKey: body.key.sealedKey,
            grantedBy: user.id,
            signature: body.key.signature,
          })
          .onConflictDoNothing();
      }
    });
    await audit(db, `user:${user.id}`, 'vault.member.put', `vault:${vaultId}`, {
      member: userId,
      role: body.role ?? `custom:${body.customRoleId}`,
      expires: body.expiresAt ?? null,
    });
    return reply.status(204).send();
  });

  /** Отзыв доступа. Сервер перестаёт выдавать данные и ключи немедленно; для защиты от уже полученных ключей нужна ротация. */
  app.delete('/vaults/:vaultId/members/:userId', async (req) => {
    const { user } = authOf(req);
    const { vaultId, userId } = parse(z.object({ vaultId: uuid, userId: uuid }), req.params);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.isAdmin) throw forbidden();
    const [existing] = await db
      .select({ role: vaultMembers.role, customRoleId: vaultMembers.customRoleId })
      .from(vaultMembers)
      .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, userId)));
    if (!existing) throw notFound();
    if (existing.role === 'owner') throw forbidden();
    assertCanAssign(access, await assignmentPerms(existing.role, existing.customRoleId));
    await enforceDenyRules(db, 'access.change', {
      actor: `user:${user.id}`,
      vaultId: vaultId,
      target: `user:${userId}`,
    });
    await db.transaction(async (tx) => {
      await tx
        .delete(vaultMembers)
        .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, userId)));
      await tx
        .delete(vaultKeys)
        .where(and(eq(vaultKeys.vaultId, vaultId), eq(vaultKeys.userId, userId)));
      await tx
        .delete(grants)
        .where(
          and(
            eq(grants.vaultId, vaultId),
            eq(grants.subjectType, 'user'),
            eq(grants.subjectId, userId),
          ),
        );
      const ids = await tx
        .select({ id: entries.id })
        .from(entries)
        .where(eq(entries.vaultId, vaultId));
      if (ids.length)
        await tx.delete(pins).where(
          and(
            eq(pins.userId, userId),
            inArray(
              pins.entryId,
              ids.map((i) => i.id),
            ),
          ),
        );
    });
    await audit(db, `user:${user.id}`, 'vault.member.remove', `vault:${vaultId}`, {
      member: userId,
    });
    return { rotationRecommended: true };
  });

  app.put('/vaults/:vaultId/circles/:circleId', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId, circleId } = parse(z.object({ vaultId: uuid, circleId: uuid }), req.params);
    const body = parse(circleRolePut, req.body);
    const access = await requireVault(db, vaultId, user.id);
    const v = await getVault(vaultId);
    if (v.kind === 'locker' || !access.isAdmin) throw forbidden();
    if (!body.role && !body.customRoleId)
      throw new AppError(400, 'validation_error', 'Specify a role or a custom role');
    assertCanAssign(access, await assignmentPerms(body.role, body.customRoleId));
    const [c] = await db.select({ id: circles.id }).from(circles).where(eq(circles.id, circleId));
    if (!c) throw notFound();
    await db
      .insert(vaultCircles)
      .values({
        vaultId,
        circleId,
        role: body.customRoleId ? 'limited' : body.role!,
        customRoleId: body.customRoleId ?? null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      })
      .onConflictDoUpdate({
        target: [vaultCircles.vaultId, vaultCircles.circleId],
        set: {
          role: body.customRoleId ? 'limited' : body.role!,
          customRoleId: body.customRoleId ?? null,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        },
      });
    await audit(db, `user:${user.id}`, 'vault.circle.put', `vault:${vaultId}`, {
      circle: circleId,
      role: body.role ?? `custom:${body.customRoleId}`,
      expires: body.expiresAt ?? null,
    });
    return reply.status(204).send();
  });

  app.delete('/vaults/:vaultId/circles/:circleId', async (req) => {
    const { user } = authOf(req);
    const { vaultId, circleId } = parse(z.object({ vaultId: uuid, circleId: uuid }), req.params);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.isAdmin) throw forbidden();
    const res = await db
      .delete(vaultCircles)
      .where(and(eq(vaultCircles.vaultId, vaultId), eq(vaultCircles.circleId, circleId)))
      .returning();
    if (!res.length) throw notFound();
    await db
      .delete(grants)
      .where(
        and(
          eq(grants.vaultId, vaultId),
          eq(grants.subjectType, 'circle'),
          eq(grants.subjectId, circleId),
        ),
      );
    await audit(db, `user:${user.id}`, 'vault.circle.remove', `vault:${vaultId}`, {
      circle: circleId,
    });
    return { rotationRecommended: true };
  });

  // ------------------------------------------------------------------ выдача ключей и ротация

  /** Пользователи, у которых есть доступ к хранилищу, но нет ключа текущей версии. */
  app.get('/vaults/:vaultId/pending-keys', async (req) => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.isAdmin) throw forbidden();
    const v = await getVault(vaultId);
    const ids = await db.execute<{ id: string }>(sql`
      select distinct u.id from users u
      where u.disabled_at is null and (
        exists (select 1 from vault_members m where m.vault_id = ${vaultId} and m.user_id = u.id)
        or exists (select 1 from vault_circles vc join circle_members cm on cm.circle_id = vc.circle_id
                   where vc.vault_id = ${vaultId} and cm.user_id = u.id)
        or exists (select 1 from grants g where g.vault_id = ${vaultId} and (
          (g.subject_type = 'user' and g.subject_id = u.id) or
          (g.subject_type = 'circle' and exists (select 1 from circle_members cm where cm.circle_id = g.subject_id and cm.user_id = u.id))))
      ) and not exists (select 1 from vault_keys k where k.vault_id = ${vaultId} and k.user_id = u.id and k.key_version = ${v.keyVersion})`);
    const rows = rowsOf<{ id: string }>(ids);
    const list: string[] = [];
    for (const r of rows) if ((await loadAccess(db, vaultId, r.id)).isMember) list.push(r.id);
    const us = list.length ? await db.select().from(users).where(inArray(users.id, list)) : [];
    return {
      keyVersion: v.keyVersion,
      users: us.map((u) => ({
        userId: u.id,
        name: u.displayName,
        email: u.email,
        publicKey: u.publicKey,
        signPublicKey: u.signPublicKey,
      })),
    };
  });

  app.post('/vaults/:vaultId/keys', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const body = parse(keysPost, req.body);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.isAdmin) throw forbidden();
    const v = await getVault(vaultId);
    for (const k of body.keys) {
      if (k.keyVersion !== v.keyVersion)
        throw new AppError(409, 'stale_key_version', 'Vault key was rotated', {
          keyVersion: v.keyVersion,
        });
      const target = await loadAccess(db, vaultId, k.userId);
      if (!target.isMember)
        throw new AppError(400, 'not_a_member', 'The user has no access to this vault');
      await assertGrantSignature(
        user.id,
        vaultId,
        k.userId,
        k.keyVersion,
        k.sealedKey,
        k.signature,
      );
    }
    const issued = await db
      .insert(vaultKeys)
      .values(
        body.keys.map((k) => ({
          vaultId,
          userId: k.userId,
          keyVersion: k.keyVersion,
          sealedKey: k.sealedKey,
          grantedBy: user.id,
          signature: k.signature,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: vaultKeys.userId });
    await notifyUsers(
      db,
      issued.map((row) => row.id),
      {
        category: 'access',
        event: 'vault.key.issued',
        vaultId,
        resourceType: 'vault',
        resourceId: vaultId,
      },
    );
    await audit(db, `user:${user.id}`, 'vault.keys.grant', `vault:${vaultId}`, {
      count: body.keys.length,
    });
    return reply.status(204).send();
  });

  /**
   * Ротация ключа хранилища (после отзыва доступа): клиент администратора перешифровал ключи всех записей, ревизий и названий
   * ветвей новым ключом и запечатал его для оставшихся участников. Сервер проверяет полноту набора и подписи и применяет
   * изменения одной транзакцией.
   */
  app.post('/vaults/:vaultId/rotate', async (req) => {
    const { user } = authOf(req);
    const { vaultId } = parse(vaultParams, req.params);
    const body = parse(rotatePost, req.body);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.can('vault.rotate')) throw forbidden();
    const v = await getVault(vaultId);
    if (body.newKeyVersion !== v.keyVersion + 1) {
      throw new AppError(409, 'stale_key_version', 'Vault key version changed', {
        keyVersion: v.keyVersion,
      });
    }
    const recoveryRecipient = await corporateRecoveryRecipientOf(db);
    const previousRecovery = recoveryRecipient
      ? await db
          .select({ vaultId: corporateRecoveryKeys.vaultId })
          .from(corporateRecoveryKeys)
          .where(
            and(
              eq(corporateRecoveryKeys.vaultId, vaultId),
              eq(corporateRecoveryKeys.recipientId, recoveryRecipient.id),
            ),
          )
          .limit(1)
      : [];
    if (previousRecovery.length && !body.recoveryKey)
      throw new AppError(
        409,
        'recovery_key_required',
        'Rotation must also update the configured corporate recovery envelope',
      );
    if (body.recoveryKey) {
      if (
        !recoveryRecipient ||
        body.recoveryKey.recipientId !== recoveryRecipient.id ||
        body.recoveryKey.keyVersion !== body.newKeyVersion
      )
        throw new AppError(
          409,
          'recovery_recipient_changed',
          'The recovery envelope must match the configured identity and new vault version',
        );
      await assertGrantSignature(
        user.id,
        vaultId,
        recoveryRecipient.id,
        body.newKeyVersion,
        body.recoveryKey.sealedKey,
        body.recoveryKey.signature,
      );
    }
    const { pendingAtt, allAttachments } = await db.transaction(async (tx) => {
      await lockVaultForWrite(tx, vaultId, v.keyVersion);
      const access = await requireVault(tx, vaultId, user.id);
      if (!access.can('vault.rotate')) throw forbidden();
      // Read the complete snapshot after taking the same lock used by all ciphertext writers.
      const pendingAtt = await tx
        .select({ id: attachments.id })
        .from(attachments)
        .where(and(eq(attachments.vaultId, vaultId), eq(attachments.status, 'pending')));
      const [allEntries, allRevisions, allBranches, allAttachments] = await Promise.all([
        tx
          .select({ id: entries.id, branchId: entries.branchId, version: entries.version })
          .from(entries)
          .where(eq(entries.vaultId, vaultId))
          .orderBy(entries.id)
          .for('update'),
        tx
          .select({ id: entryRevisions.id })
          .from(entryRevisions)
          .where(eq(entryRevisions.vaultId, vaultId))
          .orderBy(entryRevisions.id)
          .for('update'),
        tx
          .select({ id: branches.id, version: branches.version })
          .from(branches)
          .where(eq(branches.vaultId, vaultId))
          .orderBy(branches.id)
          .for('update'),
        tx
          .select({ id: attachments.id, size: attachments.size })
          .from(attachments)
          .where(and(eq(attachments.vaultId, vaultId), eq(attachments.status, 'ready')))
          .orderBy(attachments.id)
          .for('update'),
      ]);
      // Rotation rewrites every object, so an object denial also forbids whole-vault rotation.
      if (
        allEntries.some((e) => !access.entry(e.id, e.branchId)) ||
        allBranches.some((b) => !access.branch(b.id))
      )
        throw forbidden();
      const expectedEntries = new Map(
        body.entries.map((entry) => [entry.id, entry.expectedVersion]),
      );
      const expectedBranches = new Map(
        body.branches.map((branch) => [branch.id, branch.expectedVersion]),
      );
      if (
        allEntries.some(
          (entry) =>
            expectedEntries.has(entry.id) && expectedEntries.get(entry.id) !== entry.version,
        ) ||
        allBranches.some(
          (branch) =>
            expectedBranches.has(branch.id) && expectedBranches.get(branch.id) !== branch.version,
        )
      )
        throw new AppError(
          409,
          'version_conflict',
          'Vault contents changed while rotation was being prepared; refresh and retry',
        );
      const same = (a: string[], b: string[]) =>
        a.length === b.length && new Set(a).size === a.length && b.every((x) => new Set(a).has(x));
      if (
        !same(
          body.entries.map((e) => e.id),
          allEntries.map((e) => e.id),
        ) ||
        !same(
          body.revisions.map((e) => e.id),
          allRevisions.map((e) => e.id),
        ) ||
        !same(
          body.branches.map((e) => e.id),
          allBranches.map((e) => e.id),
        ) ||
        !same(
          body.attachments.map((e) => e.id),
          allAttachments.map((e) => e.id),
        )
      ) {
        throw new AppError(
          409,
          'incomplete_rotation',
          'The rotation must cover every entry, revision, branch and attachment',
        );
      }
      // Ключ нужен каждому, кто сейчас имеет доступ.
      const holders = await tx.execute(sql`
      select distinct u.id from users u where u.disabled_at is null and (
        exists (select 1 from vault_members m where m.vault_id = ${vaultId} and m.user_id = u.id)
        or exists (select 1 from vault_circles vc join circle_members cm on cm.circle_id = vc.circle_id where vc.vault_id = ${vaultId} and cm.user_id = u.id)
        or exists (select 1 from grants g where g.vault_id = ${vaultId} and (
          (g.subject_type = 'user' and g.subject_id = u.id) or
          (g.subject_type = 'circle' and exists (select 1 from circle_members cm where cm.circle_id = g.subject_id and cm.user_id = u.id)))))`);
      const candidates = rowsOf<{ id: string }>(holders).map((r) => r.id);
      const hrows: string[] = [];
      for (const id of candidates) if ((await loadAccess(tx, vaultId, id)).isMember) hrows.push(id);
      if (
        !same(
          body.keys.map((k) => k.userId),
          hrows,
        )
      ) {
        throw new AppError(
          409,
          'incomplete_rotation',
          'A key is required for every user who has access',
          { required: hrows.length },
        );
      }
      for (const k of body.keys)
        await assertGrantSignature(
          user.id,
          vaultId,
          k.userId,
          body.newKeyVersion,
          k.sealedKey,
          k.signature,
          tx,
        );
      // Файлы, перешифрованные новым ключом, должны быть загружены заранее и иметь прежний размер
      for (const att of allAttachments) {
        if (
          (await ctx.blobs.size(att.id, rotationSuffix(body.newKeyVersion, body.rotationId!))) !==
          att.size
        )
          throw new AppError(
            409,
            'incomplete_rotation',
            'Re-encrypted attachment files must be uploaded before rotation',
          );
      }
      const now = new Date();
      const enrolled = recoveryRecipient
        ? await tx
            .select({ vaultId: corporateRecoveryKeys.vaultId })
            .from(corporateRecoveryKeys)
            .where(
              and(
                eq(corporateRecoveryKeys.vaultId, vaultId),
                eq(corporateRecoveryKeys.recipientId, recoveryRecipient.id),
              ),
            )
            .limit(1)
        : [];
      if (enrolled.length && !body.recoveryKey)
        throw new AppError(409, 'recovery_key_required', 'Rotation must update corporate recovery');
      for (const att of allAttachments)
        await ctx.blobs.promote(
          att.id,
          rotationSuffix(body.newKeyVersion, body.rotationId!),
          blobSuffix(body.newKeyVersion),
        );
      for (const p of pendingAtt) await tx.delete(attachments).where(eq(attachments.id, p.id));
      for (const att of body.attachments) {
        await tx
          .update(attachments)
          .set({
            wrappedKey: att.wrappedKey,
            metaCipher: att.metaCipher,
            keyVersion: body.newKeyVersion,
          })
          .where(and(eq(attachments.id, att.id), eq(attachments.vaultId, vaultId)));
      }
      for (const e of body.entries) {
        await tx
          .update(entries)
          .set({
            wrappedEntryKey: e.wrappedEntryKey,
            ciphertext: e.ciphertext,
            keyVersion: body.newKeyVersion,
            version: sql`${entries.version} + 1`,
            updatedAt: now,
          })
          .where(and(eq(entries.id, e.id), eq(entries.vaultId, vaultId)));
      }
      for (const r of body.revisions) {
        await tx
          .update(entryRevisions)
          .set({
            wrappedEntryKey: r.wrappedEntryKey,
            ciphertext: r.ciphertext,
            keyVersion: body.newKeyVersion,
          })
          .where(and(eq(entryRevisions.id, r.id), eq(entryRevisions.vaultId, vaultId)));
      }
      for (const b of body.branches) {
        await tx
          .update(branches)
          .set({
            nameCipher: b.nameCipher,
            metaCipher: b.metaCipher ?? null,
            keyVersion: body.newKeyVersion,
            version: sql`${branches.version} + 1`,
          })
          .where(and(eq(branches.id, b.id), eq(branches.vaultId, vaultId)));
      }
      await tx.delete(vaultKeys).where(eq(vaultKeys.vaultId, vaultId));
      await tx.insert(vaultKeys).values(
        body.keys.map((k) => ({
          vaultId,
          userId: k.userId,
          keyVersion: body.newKeyVersion,
          sealedKey: k.sealedKey,
          grantedBy: user.id,
          signature: k.signature,
        })),
      );
      await tx.update(vaults).set({ keyVersion: body.newKeyVersion }).where(eq(vaults.id, vaultId));
      if (body.recoveryKey) {
        await tx.insert(corporateRecoveryKeys).values({
          vaultId,
          recipientId: body.recoveryKey.recipientId,
          keyVersion: body.newKeyVersion,
          sealedKey: body.recoveryKey.sealedKey,
          signature: body.recoveryKey.signature,
          grantedBy: user.id,
          grantedBySignKey: user.signPublicKey,
        });
        await audit(tx, `user:${user.id}`, 'corporate.recovery.rotate', `vault:${vaultId}`, {
          recipient: body.recoveryKey.recipientId,
          keyVersion: body.newKeyVersion,
        });
      }
      return { pendingAtt, allAttachments };
    });
    // Файлы прежней версии ключа больше не нужны
    for (const att of allAttachments)
      await ctx.blobs.removeVersion(att.id, blobSuffix(body.newKeyVersion - 1));
    for (const att of allAttachments)
      await ctx.blobs.removeVersion(att.id, rotationSuffix(body.newKeyVersion, body.rotationId!));
    for (const pending of pendingAtt)
      await ctx.blobs.removeVersion(pending.id, blobSuffix(v.keyVersion));
    await audit(db, `user:${user.id}`, 'vault.rotate', `vault:${vaultId}`, {
      keyVersion: body.newKeyVersion,
    });
    return { keyVersion: body.newKeyVersion };
  });

  // ------------------------------------------------------------------ каталог пользователей и журнал ключей

  /** Поиск пользователей для приглашения в хранилище (по имени или почте, не менее 2 символов). */
  app.get('/directory/users', async (req) => {
    authOf(req);
    const q = String((req.query as { q?: string }).q ?? '').trim();
    if (q.length < 2) return [];
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const rows = await db
      .select()
      .from(users)
      .where(
        and(isNull(users.disabledAt), or(ilike(users.email, like), ilike(users.displayName, like))),
      )
      .orderBy(asc(users.displayName))
      .limit(25);
    return rows.map((u) => ({
      id: u.id,
      name: u.displayName,
      email: u.email,
      publicKey: u.publicKey,
      signPublicKey: u.signPublicKey,
    }));
  });

  app.get('/directory/circles', async (req) => {
    authOf(req);
    const rows = await db
      .select({ id: circles.id, name: circles.name })
      .from(circles)
      .orderBy(asc(circles.name));
    return rows;
  });

  /** Журнал привязки ключей (хэш-цепочка): клиент проверяет, что ранее виденные записи не изменены. */
  app.get('/key-log', async (req) => {
    authOf(req);
    const after = Number((req.query as { after?: string }).after ?? 0) || 0;
    const rows = await db
      .select()
      .from(keyLog)
      .where(gt(keyLog.seq, after))
      .orderBy(asc(keyLog.seq))
      .limit(1000);
    return rows.map((r) => ({
      seq: r.seq,
      userId: r.userId,
      encPublic: r.encPublic,
      signPublic: r.signPublic,
      prevHash: r.prevHash,
      hash: r.hash,
    }));
  });
};

export type { VaultRole };
