import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  entryClientEvent,
  objectPasswordPolicy,
  objectPolicyPatch,
  uuid,
} from '@arklock/contracts';
import { loadAccess, requireVault, type VaultAccess } from '../access.js';
import { audit } from '../audit.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import {
  branches,
  circleMembers,
  circles,
  entries,
  grants,
  ledger,
  settings,
  users,
  vaultCircles,
  vaultKeys,
  vaultMembers,
  vaults,
} from '../db/schema.js';
import { forbidden, notFound, parse } from '../errors.js';

type Policy = z.infer<typeof objectPasswordPolicy>;
type Scope = 'vault' | 'branch' | 'entry';
const policyKey = (scope: Scope, id: string) => `policy.object.${scope}:${id}`;

export const registerObjectDetailsRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  const entryParams = z.object({ vaultId: uuid, entryId: uuid });

  async function readableEntry(vaultId: string, entryId: string, userId: string) {
    const access = await requireVault(db, vaultId, userId);
    const [entry] = await db
      .select()
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.vaultId, vaultId)));
    if (!entry || !access.entry(entryId, entry.branchId)) throw notFound();
    return { access, entry };
  }

  for (const scope of ['entry', 'branch'] as const) {
    const objectUrl =
      scope === 'entry'
        ? '/vaults/:vaultId/entries/:entryId'
        : '/vaults/:vaultId/branches/:branchId';
    const objectParams = z.object({
      vaultId: uuid,
      entryId: uuid.optional(),
      branchId: uuid.optional(),
    });
    async function readableObject(vaultId: string, targetId: string, userId: string) {
      if (scope === 'entry') return readableEntry(vaultId, targetId, userId);
      const access = await requireVault(db, vaultId, userId);
      const [branch] = await db
        .select()
        .from(branches)
        .where(and(eq(branches.id, targetId), eq(branches.vaultId, vaultId)));
      if (!branch || !access.branch(targetId)) throw notFound();
      return { access, entry: { branchId: targetId } };
    }
    app.get(`${objectUrl}/access`, async (req) => {
      const { user } = authOf(req);
      const { vaultId, entryId, branchId } = parse(objectParams, req.params);
      const targetId = (entryId ?? branchId)!;
      const { access, entry } = await readableObject(vaultId, targetId, user.id);
      const objectAccess = (candidate: VaultAccess) =>
        scope === 'entry' ? candidate.entry(targetId, entry.branchId) : candidate.branch(targetId);
      const canManage =
        access.allows('grant.manage') && (access.isAdmin || objectAccess(access) === 'manager');
      const ancestorIds = access.ancestors(entry.branchId);
      const [allGrants, direct, groupAssignments, groups, memberships, keys, vault] =
        await Promise.all([
          db.select().from(grants).where(eq(grants.vaultId, vaultId)),
          db.select().from(vaultMembers).where(eq(vaultMembers.vaultId, vaultId)),
          db.select().from(vaultCircles).where(eq(vaultCircles.vaultId, vaultId)),
          db.select({ id: circles.id, name: circles.name }).from(circles),
          db.select().from(circleMembers),
          db
            .select({ userId: vaultKeys.userId, keyVersion: vaultKeys.keyVersion })
            .from(vaultKeys)
            .where(eq(vaultKeys.vaultId, vaultId)),
          db.select({ keyVersion: vaults.keyVersion }).from(vaults).where(eq(vaults.id, vaultId)),
        ]);
      const relevant = allGrants.filter((g) =>
        g.targetType === 'entry'
          ? scope === 'entry' && g.targetId === targetId
          : ancestorIds.includes(g.targetId),
      );
      const now = Date.now();
      const active = (row: { expiresAt: Date | null }) =>
        !row.expiresAt || row.expiresAt.getTime() > now;
      const relevantGroups = new Set([
        ...groupAssignments.filter(active).map((g) => g.circleId),
        ...relevant.filter((g) => g.subjectType === 'circle' && active(g)).map((g) => g.subjectId),
      ]);
      const candidateIds = new Set([
        ...direct.filter(active).map((m) => m.userId),
        ...relevant.filter((g) => g.subjectType === 'user').map((g) => g.subjectId),
        ...memberships.filter((m) => relevantGroups.has(m.circleId)).map((m) => m.userId),
      ]);
      // The roster contains personal information; readers only see their own effective access.
      if (!canManage) {
        candidateIds.clear();
        candidateIds.add(user.id);
      }
      const roster = candidateIds.size
        ? await db
            .select({
              id: users.id,
              name: users.displayName,
              email: users.email,
              disabledAt: users.disabledAt,
              authSource: users.authSource,
            })
            .from(users)
            .where(inArray(users.id, [...candidateIds]))
        : [];
      const groupNames = new Map(groups.map((g) => [g.id, g.name]));
      const names = new Map(roster.map((u) => [u.id, `${u.name} <${u.email}>`]));
      const members = await Promise.all(
        roster.map(async (u) => {
          const ownGroups = memberships.filter((m) => m.userId === u.id).map((m) => m.circleId);
          const sources = [
            ...direct
              .filter((m) => m.userId === u.id && active(m))
              .map((m) => `member:${m.customRoleId ?? m.role}`),
            ...groupAssignments
              .filter((g) => ownGroups.includes(g.circleId) && active(g))
              .map((g) => `group:${groupNames.get(g.circleId) ?? g.circleId}`),
            ...relevant
              .filter(
                (g) =>
                  active(g) &&
                  (g.subjectType === 'user'
                    ? g.subjectId === u.id
                    : ownGroups.includes(g.subjectId)),
              )
              .map((g) => `${g.targetType}:${g.targetId}:${g.role}`),
          ];
          const effective = await loadAccess(db, vaultId, u.id);
          const level = objectAccess(effective);
          const hasKey = keys.some(
            (k) => k.userId === u.id && k.keyVersion === vault[0]?.keyVersion,
          );
          return {
            userId: u.id,
            displayName: u.name,
            email: u.email,
            disabled: !!u.disabledAt,
            authSource: u.authSource,
            access: level,
            source: sources.join(', '),
            sources,
            hasKey,
            pendingKey: !!level && !hasKey,
          };
        }),
      );
      const visibleGrants = canManage
        ? relevant
        : relevant.filter((g) => g.subjectType === 'user' && g.subjectId === user.id);
      return {
        canManage,
        effectiveAccess: objectAccess(access),
        inheritance: { branchIds: ancestorIds, vault: true },
        grants: visibleGrants.map((g) => ({
          id: g.id,
          targetType: g.targetType,
          targetId: g.targetId,
          subjectType: g.subjectType,
          subjectId: g.subjectId,
          subjectName:
            g.subjectType === 'circle'
              ? (groupNames.get(g.subjectId) ?? '')
              : (names.get(g.subjectId) ?? ''),
          role: g.role,
          expiresAt: g.expiresAt?.toISOString() ?? null,
          expired: !active(g),
          inherited: g.targetType !== scope || g.targetId !== targetId,
        })),
        members,
        cryptoScope: 'vault',
      };
    });

    app.get(`${objectUrl}/journal`, async (req) => {
      const { user } = authOf(req);
      const { vaultId, entryId, branchId } = parse(objectParams, req.params);
      const targetId = (entryId ?? branchId)!;
      const { access } = await readableObject(vaultId, targetId, user.id);
      if (!access.allows('entry.history')) throw forbidden();
      const rows = await db
        .select()
        .from(ledger)
        .where(eq(ledger.target, `${scope}:${targetId}`))
        .orderBy(desc(ledger.id))
        .limit(100);
      const actorIds = [
        ...new Set(
          rows.filter((row) => row.actor.startsWith('user:')).map((row) => row.actor.slice(5)),
        ),
      ];
      const actors = actorIds.length
        ? await db
            .select({ id: users.id, name: users.displayName, email: users.email })
            .from(users)
            .where(inArray(users.id, actorIds))
        : [];
      const actorNames = new Map(
        actors.map((actor) => [`user:${actor.id}`, `${actor.name} <${actor.email}>`]),
      );
      return rows.map((row) => ({
        ...row,
        actorName: actorNames.get(row.actor) ?? null,
        at: row.at.toISOString(),
        clientReported: (row.detail as Record<string, unknown> | null)?.clientReported === true,
      }));
    });
  }

  app.post('/vaults/:vaultId/entries/:entryId/events', async (req, reply) => {
    const { user } = authOf(req);
    const { vaultId, entryId } = parse(entryParams, req.params);
    const body = parse(entryClientEvent, req.body);
    await readableEntry(vaultId, entryId, user.id);
    await audit(db, `user:${user.id}`, `entry.client.${body.action}`, `entry:${entryId}`, {
      vault: vaultId,
      field: body.field,
      clientReported: true,
    });
    return reply.status(204).send();
  });

  async function policyContext(
    scope: Scope,
    vaultId: string,
    targetId: string,
    access: VaultAccess,
  ) {
    let branchId: string | null = null;
    let canManage = false;
    if (scope === 'entry') {
      const [entry] = await db
        .select()
        .from(entries)
        .where(and(eq(entries.id, targetId), eq(entries.vaultId, vaultId)));
      if (!entry || !access.entry(entry.id, entry.branchId)) throw notFound();
      branchId = entry.branchId;
      canManage = access.entry(entry.id, entry.branchId) === 'manager';
    } else if (scope === 'branch') {
      const [branch] = await db
        .select()
        .from(branches)
        .where(and(eq(branches.id, targetId), eq(branches.vaultId, vaultId)));
      if (!branch || !access.branch(targetId)) throw notFound();
      branchId = targetId;
      canManage = access.branch(targetId) === 'manager';
    }
    const chain: { scope: Scope; id: string }[] = [{ scope: 'vault', id: vaultId }];
    for (const id of access.ancestors(branchId).reverse()) chain.push({ scope: 'branch', id });
    if (scope === 'entry') chain.push({ scope, id: targetId });
    return { chain, canManage: access.allows('grant.manage') && (access.isAdmin || canManage) };
  }

  async function policyResult(
    scope: Scope,
    vaultId: string,
    targetId: string,
    access: VaultAccess,
  ) {
    const { chain, canManage } = await policyContext(scope, vaultId, targetId, access);
    const keys = [
      'policy.password.minLength',
      'policy.password.classes',
      'security.passwordMaxAgeDays',
      ...chain.map((p) => policyKey(p.scope, p.id)),
    ];
    const rows = await db.select().from(settings).where(inArray(settings.key, keys));
    const values = new Map(rows.map((r) => [r.key, r.value]));
    const numeric = (value: unknown, max: number) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
        ? value
        : 0;
    const sources: { scope: 'organization' | Scope; id: string | null; policy: Policy }[] = [
      {
        scope: 'organization',
        id: null,
        policy: {
          minLength: numeric(values.get('policy.password.minLength'), 128),
          classes: numeric(values.get('policy.password.classes'), 4),
          maxAgeDays: values.has('security.passwordMaxAgeDays')
            ? numeric(values.get('security.passwordMaxAgeDays'), 3650)
            : 365,
        },
      },
    ];
    for (const item of chain) {
      const parsed = objectPasswordPolicy.safeParse(values.get(policyKey(item.scope, item.id)));
      if (parsed.success) sources.push({ ...item, policy: parsed.data });
    }
    const effective = { minLength: 0, classes: 0, maxAgeDays: 0 };
    for (const { policy } of sources) {
      effective.minLength = Math.max(effective.minLength, policy.minLength ?? 0);
      effective.classes = Math.max(effective.classes, policy.classes ?? 0);
      if (policy.maxAgeDays)
        effective.maxAgeDays = effective.maxAgeDays
          ? Math.min(effective.maxAgeDays, policy.maxAgeDays)
          : policy.maxAgeDays;
    }
    const own = objectPasswordPolicy.safeParse(values.get(policyKey(scope, targetId)));
    return {
      own: own.success ? own.data : null,
      effective,
      sources,
      canManage,
      clientEnforced: true,
    };
  }

  for (const scope of ['vault', 'branch', 'entry'] as const) {
    const url =
      scope === 'vault'
        ? '/vaults/:vaultId/policy'
        : `/vaults/:vaultId/${scope === 'branch' ? 'branches/:branchId' : 'entries/:entryId'}/policy`;
    const params = z.object({ vaultId: uuid, branchId: uuid.optional(), entryId: uuid.optional() });
    app.get(url, async (req) => {
      const { user } = authOf(req);
      const { vaultId, branchId, entryId } = parse(params, req.params);
      const access = await requireVault(db, vaultId, user.id);
      return policyResult(scope, vaultId, branchId ?? entryId ?? vaultId, access);
    });
    app.patch(url, async (req) => {
      const { user } = authOf(req);
      const { vaultId, branchId, entryId } = parse(params, req.params);
      const body = parse(objectPolicyPatch, req.body);
      const access = await requireVault(db, vaultId, user.id);
      const targetId = branchId ?? entryId ?? vaultId;
      if (!(await policyContext(scope, vaultId, targetId, access)).canManage) throw forbidden();
      const key = policyKey(scope, targetId);
      if (body.policy === null) await db.delete(settings).where(eq(settings.key, key));
      else
        await db
          .insert(settings)
          .values({ key, value: body.policy, updatedBy: user.id })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: body.policy, updatedAt: new Date(), updatedBy: user.id },
          });
      await audit(db, `user:${user.id}`, `${scope}.policy.update`, `${scope}:${targetId}`, {
        vault: vaultId,
        inherited: body.policy === null,
      });
      return policyResult(scope, vaultId, targetId, access);
    });
  }
};
