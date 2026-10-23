import { and, asc, count, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { circleWrite, uuid } from '@arklock/contracts';
import { audit } from '../audit.js';
import { notifyUsers } from '../notifications.js';
import { isEnrolled, resetMfaPolicyCache } from '../auth/mfa.js';
import { resetSessionLimitsCache } from '../auth/session.js';
import { adminGate } from '../auth/adminperm.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import {
  circleMembers,
  circles,
  entries,
  ledger,
  roles,
  sessions,
  settings,
  spaces,
  users,
  vaults,
  vaultCircles,
} from '../db/schema.js';
import { chiefRequired } from './chief.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';
import { corporateAccessRisks } from '../corporate-continuity.js';

/** Настройки, которые администратор может менять через API, и их допустимые значения. */
const SETTINGS: Record<string, z.ZodType> = {
  'registration.mode': z.enum(['closed', 'open']),
  'vaults.creators': z.enum(['admins', 'members']),
  /** false permits only explicit user/group exceptions. */
  'vaults.personalLockers': z.boolean(),
  'vaults.personalLockerUsers': z.array(uuid).max(10000),
  'vaults.personalLockerCircles': z.array(uuid).max(10000),
  'trash.retentionDays': z.number().int().min(1).max(3650),
  'session.idleHours': z.number().min(0.25).max(720),
  /** Предельная длительность сеанса от входа, часов; 0 — без ограничения (кроме общего срока SESSION_MAX_DAYS). */
  'session.maxHours': z.number().min(0).max(8760),
  'security.passwordMaxAgeDays': z.number().int().min(0).max(3650),
  'security.mfaRequired': z.enum(['off', 'admins', 'all']),
  'storage.attachmentMaxMiB': z.number().int().min(0).max(102_400),
  'storage.vaultQuotaMiB': z.number().int().min(0).max(10_000_000),
  'notifications.security': z.boolean(),
  'security.pinUnlock': z.boolean(),
  'security.reloadUnlock': z.boolean(),
  'policy.password.minLength': z.number().int().min(0).max(128),
  'policy.password.classes': z.number().int().min(0).max(4),
};
export const SETTING_DEFAULTS: Record<string, unknown> = {
  'registration.mode': 'closed',
  'vaults.creators': 'admins',
  'vaults.personalLockers': false,
  'vaults.personalLockerUsers': [],
  'vaults.personalLockerCircles': [],
  'trash.retentionDays': 30,
  'session.idleHours': 12,
  'session.maxHours': 0,
  'security.passwordMaxAgeDays': 365,
  'security.mfaRequired': 'off',
  'storage.attachmentMaxMiB': 1024,
  'storage.vaultQuotaMiB': 0,
  'notifications.security': true,
  'security.pinUnlock': false,
  'security.reloadUnlock': true,
  'policy.password.minLength': 0,
  'policy.password.classes': 0,
};

/** Пользователи, круги, настройки и журнал — только для администратора. */
export const registerAdminDirectoryRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', async (req: FastifyRequest) => {
    await adminGate(ctx, req);
  });
  const idParam = z.object({ id: uuid });

  /** Состав группы с административной ролью меняет только полный администратор: иначе делегат мог бы выдать себе полномочия. */
  async function assertCircleWritable(user: { role: string }, circleId: string): Promise<void> {
    if (user.role === 'admin') return;
    const [c] = await db
      .select({ r: circles.adminRoleId })
      .from(circles)
      .where(eq(circles.id, circleId));
    if (c?.r) throw forbidden();
  }

  // ------------------------------------------------------------------ пользователи

  app.get('/admin/users', async () => {
    const rows = await db.select().from(users).orderBy(asc(users.displayName));
    const lastSeen = await db
      .select({ userId: sessions.userId, at: sql<Date>`max(${sessions.lastSeenAt})` })
      .from(sessions)
      .groupBy(sessions.userId);
    const seen = new Map(lastSeen.map((s) => [s.userId, s.at]));
    return rows.map((u) => ({
      id: u.id,
      name: u.displayName,
      email: u.email,
      role: u.role,
      chief: u.chief,
      adminRoleId: u.adminRoleId,
      disabled: !!u.disabledAt,
      authSource: u.authSource,
      createdAt: u.createdAt.toISOString(),
      lastSeenAt: seen.get(u.id) ? new Date(seen.get(u.id)!).toISOString() : null,
    }));
  });

  app.patch('/admin/users/:id', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        role: z.enum(['admin', 'member']).optional(),
        disabled: z.boolean().optional(),
        acknowledgeAccessRisk: z.boolean().optional(),
        /** Административная роль (делегирование); null — снять. */
        adminRoleId: uuid.nullable().optional(),
      }),
      req.body,
    );
    const [target] = await db.select().from(users).where(eq(users.id, id));
    if (!target) throw notFound();
    // Делегированный администратор не затрагивает полных администраторов и не назначает роли
    if (user.role !== 'admin') {
      if (target.role === 'admin') throw forbidden();
      if (body.role !== undefined || body.adminRoleId !== undefined) throw forbidden();
    }
    if (body.adminRoleId) {
      const [r] = await db.select().from(roles).where(eq(roles.id, body.adminRoleId));
      if (!r || r.scope !== 'admin')
        throw new AppError(400, 'validation_error', 'Unknown administrative role');
    }
    const demoting = body.role === 'member' && target.role === 'admin';
    const disabling = body.disabled === true && !target.disabledAt;
    // полных администраторов назначает, снимает и блокирует только главный; сам главный сначала передаёт роль
    const promoting = body.role === 'admin' && target.role !== 'admin';
    if (target.chief && (demoting || disabling))
      throw new AppError(409, 'chief_admin', 'Transfer the chief administrator role first');
    if ((promoting || ((demoting || disabling) && target.role === 'admin')) && !user.chief)
      throw chiefRequired();
    if ((demoting || disabling) && target.role === 'admin') {
      const [{ n } = { n: 0 }] = await db
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, id)));
      if (n === 0)
        throw new AppError(
          409,
          'last_admin',
          'The last active administrator cannot be demoted or disabled',
        );
    }
    if (id === user.id && disabling)
      throw new AppError(409, 'self_disable', 'You cannot disable your own account');
    const accessRisks = disabling ? await corporateAccessRisks(db, id) : [];
    if (accessRisks.length && !body.acknowledgeAccessRisk)
      throw new AppError(
        409,
        'corporate_access_at_risk',
        'Transfer corporate vault access before disabling this user, or acknowledge the risk',
        { vaults: accessRisks },
      );
    await db
      .update(users)
      .set({
        ...(body.role ? { role: body.role } : {}),
        ...(body.adminRoleId !== undefined ? { adminRoleId: body.adminRoleId } : {}),
        ...(body.disabled !== undefined ? { disabledAt: body.disabled ? new Date() : null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));
    // Отключение и смена роли немедленно завершают все сеансы пользователя.
    if (disabling || body.role || body.adminRoleId !== undefined) {
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)));
    }
    await audit(db, `user:${user.id}`, 'admin.user.update', `user:${id}`, {
      role: body.role ?? null,
      disabled: body.disabled ?? null,
      adminRole: body.adminRoleId ?? null,
      accessRiskAcknowledged: accessRisks.length > 0 && body.acknowledgeAccessRisk === true,
    });
    return { id };
  });

  app.post('/admin/users/:id/revoke-sessions', async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)));
    await audit(db, `user:${user.id}`, 'admin.user.revoke-sessions', `user:${id}`);
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ круги

  app.get('/admin/circles', async () => {
    const rows = await db.select().from(circles).orderBy(asc(circles.name));
    const counts = await db
      .select({ id: circleMembers.circleId, n: count() })
      .from(circleMembers)
      .groupBy(circleMembers.circleId);
    const m = new Map(counts.map((c) => [c.id, c.n]));
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      adminRoleId: c.adminRoleId,
      members: m.get(c.id) ?? 0,
    }));
  });

  app.post('/admin/circles', async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(circleWrite, req.body);
    const id = crypto.randomUUID();
    try {
      await db.insert(circles).values({ id, ...body });
    } catch {
      throw new AppError(409, 'already_exists', 'A circle with this name already exists');
    }
    await audit(db, `user:${user.id}`, 'admin.circle.create', `circle:${id}`);
    return reply.status(201).send({ id });
  });

  app.patch('/admin/circles/:id', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    const { adminRoleId, ...body } = parse(
      circleWrite.partial().extend({ adminRoleId: uuid.nullable().optional() }),
      req.body,
    );
    if (adminRoleId !== undefined) {
      if (user.role !== 'admin') throw forbidden();
      if (adminRoleId) {
        const [r] = await db.select().from(roles).where(eq(roles.id, adminRoleId));
        if (!r || r.scope !== 'admin')
          throw new AppError(400, 'validation_error', 'Unknown administrative role');
      }
    } else await assertCircleWritable(user, id);
    const res = await db
      .update(circles)
      .set({ ...body, ...(adminRoleId !== undefined ? { adminRoleId } : {}) })
      .where(eq(circles.id, id))
      .returning({ id: circles.id });
    if (!res.length) throw notFound();
    await audit(db, `user:${user.id}`, 'admin.circle.update', `circle:${id}`, {
      adminRole: adminRoleId ?? null,
    });
    return { id };
  });

  app.delete('/admin/circles/:id', async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    const members = await db
      .select({ id: circleMembers.userId })
      .from(circleMembers)
      .where(eq(circleMembers.circleId, id));
    const res = await db.delete(circles).where(eq(circles.id, id)).returning({ id: circles.id });
    if (!res.length) throw notFound();
    await notifyUsers(
      db,
      members.map((row) => row.id),
      { category: 'access', event: 'admin.circle.deleted', resourceType: 'circle', resourceId: id },
    );
    await audit(db, `user:${user.id}`, 'admin.circle.delete', `circle:${id}`);
    return reply.status(204).send();
  });

  app.get('/admin/circles/:id/members', async (req) => {
    const { id } = parse(idParam, req.params);
    const rows = await db
      .select({ id: users.id, name: users.displayName, email: users.email })
      .from(circleMembers)
      .innerJoin(users, eq(users.id, circleMembers.userId))
      .where(eq(circleMembers.circleId, id))
      .orderBy(asc(users.displayName));
    return rows;
  });

  app.put('/admin/circles/:id/members/:userId', async (req, reply) => {
    const { user } = authOf(req);
    const { id, userId } = parse(z.object({ id: uuid, userId: uuid }), req.params);
    await assertCircleWritable(user, id);
    const [c] = await db.select({ id: circles.id }).from(circles).where(eq(circles.id, id));
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!c || !u) throw notFound();
    const added = await db
      .insert(circleMembers)
      .values({ circleId: id, userId })
      .onConflictDoNothing()
      .returning({ id: circleMembers.userId });
    await audit(db, `user:${user.id}`, 'admin.circle.member.add', `circle:${id}`, {
      member: userId,
      changed: added.length > 0,
    });
    return reply.status(204).send();
  });

  app.patch('/admin/circles/:id/members', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        add: z.array(uuid).max(500).default([]),
        remove: z.array(uuid).max(500).default([]),
      }),
      req.body,
    );
    const add = [...new Set(body.add)];
    const remove = [...new Set(body.remove)];
    if (add.some((uid) => remove.includes(uid)))
      throw new AppError(400, 'validation_error', 'A user cannot be both added and removed');
    await assertCircleWritable(user, id);
    const [circle] = await db.select({ id: circles.id }).from(circles).where(eq(circles.id, id));
    if (!circle) throw notFound();
    const found = add.length
      ? await db.select({ id: users.id }).from(users).where(inArray(users.id, add))
      : [];
    if (found.length !== add.length) throw notFound();
    const changed = await db.transaction(async (tx) => {
      const added = add.length
        ? await tx
            .insert(circleMembers)
            .values(add.map((userId) => ({ circleId: id, userId })))
            .onConflictDoNothing()
            .returning({ userId: circleMembers.userId })
        : [];
      const removed = remove.length
        ? await tx
            .delete(circleMembers)
            .where(and(eq(circleMembers.circleId, id), inArray(circleMembers.userId, remove)))
            .returning({ userId: circleMembers.userId })
        : [];
      await notifyUsers(
        tx,
        added.map((row) => row.userId),
        {
          category: 'access',
          event: 'admin.circle.member.add',
          resourceType: 'circle',
          resourceId: id,
        },
      );
      await notifyUsers(
        tx,
        removed.map((row) => row.userId),
        {
          category: 'access',
          event: 'admin.circle.member.remove',
          resourceType: 'circle',
          resourceId: id,
        },
      );
      return { added: added.length, removed: removed.length };
    });
    await audit(db, `user:${user.id}`, 'admin.circle.members.update', `circle:${id}`, changed);
    return changed;
  });

  app.get('/admin/circles/:id/vaults', async (req) => {
    const { id } = parse(idParam, req.params);
    const [circle] = await db.select({ id: circles.id }).from(circles).where(eq(circles.id, id));
    if (!circle) throw notFound();
    return db
      .select({
        id: vaults.id,
        name: vaults.name,
        role: vaultCircles.role,
        customRoleId: vaultCircles.customRoleId,
        expiresAt: vaultCircles.expiresAt,
      })
      .from(vaultCircles)
      .innerJoin(vaults, eq(vaults.id, vaultCircles.vaultId))
      .where(eq(vaultCircles.circleId, id));
  });

  app.delete('/admin/circles/:id/members/:userId', async (req, reply) => {
    const { user } = authOf(req);
    const { id, userId } = parse(z.object({ id: uuid, userId: uuid }), req.params);
    await assertCircleWritable(user, id);
    const res = await db
      .delete(circleMembers)
      .where(and(eq(circleMembers.circleId, id), eq(circleMembers.userId, userId)))
      .returning();
    if (!res.length) throw notFound();
    await audit(db, `user:${user.id}`, 'admin.circle.member.remove', `circle:${id}`, {
      member: userId,
    });
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ настройки

  /** Inventory contains only ownership/counts; no personal ciphertext or keys are disclosed. */
  app.get('/admin/settings/personal-lockers', async () => {
    const [people, groups, memberships, lockers, stored] = await Promise.all([
      db
        .select({ id: users.id, name: users.displayName, email: users.email })
        .from(users)
        .orderBy(asc(users.displayName)),
      db.select({ id: circles.id, name: circles.name }).from(circles).orderBy(asc(circles.name)),
      db.select().from(circleMembers),
      db
        .select({
          id: vaults.id,
          userId: vaults.createdBy,
          createdAt: vaults.createdAt,
          entries: count(entries.id),
        })
        .from(vaults)
        .leftJoin(entries, eq(entries.vaultId, vaults.id))
        .where(eq(vaults.kind, 'locker'))
        .groupBy(vaults.id, vaults.createdBy, vaults.createdAt),
      db
        .select()
        .from(settings)
        .where(
          inArray(settings.key, [
            'vaults.personalLockers',
            'vaults.personalLockerUsers',
            'vaults.personalLockerCircles',
          ]),
        ),
    ]);
    const value = (key: string) => stored.find((r) => r.key === key)?.value;
    const everyone = value('vaults.personalLockers') === true;
    const allowedUsers = value('vaults.personalLockerUsers');
    const allowedCircles = value('vaults.personalLockerCircles');
    return {
      circles: groups,
      users: people.map((u) => ({
        ...u,
        allowed:
          everyone ||
          (Array.isArray(allowedUsers) && allowedUsers.includes(u.id)) ||
          (Array.isArray(allowedCircles) &&
            memberships.some((m) => m.userId === u.id && allowedCircles.includes(m.circleId))),
        lockers: lockers.filter((v) => v.userId === u.id),
      })),
    };
  });

  app.get('/admin/settings', async () => {
    const rows = await db.select().from(settings);
    const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
    for (const r of rows) if (r.key in SETTINGS) out[r.key] = r.value;
    return out;
  });

  app.put('/admin/settings', async (req) => {
    const { user } = authOf(req);
    const body = parse(z.record(z.string(), z.unknown()), req.body);
    for (const [key, value] of Object.entries(body)) {
      const schema = SETTINGS[key];
      if (!schema)
        throw new AppError(400, 'validation_error', 'Unknown setting', [
          { path: key, code: 'unknown' },
        ]);
      parse(schema, value);
    }
    for (const [key, table] of [
      ['vaults.personalLockerUsers', users],
      ['vaults.personalLockerCircles', circles],
    ] as const) {
      const ids = body[key] as string[] | undefined;
      if (ids?.length) {
        const found = await db.select({ id: table.id }).from(table).where(inArray(table.id, ids));
        if (new Set(ids).size !== found.length)
          throw new AppError(400, 'validation_error', 'Unknown personal vault policy subject');
      }
    }
    // Нельзя включить обязательный MFA, не настроив его самому: иначе администратор закроет себе доступ
    if (
      ['admins', 'all'].includes(String(body['security.mfaRequired'])) &&
      !(await isEnrolled(ctx, user.id))
    )
      throw new AppError(
        409,
        'mfa_admin_not_enrolled',
        'Set up two-factor authentication for yourself first',
      );
    for (const [key, value] of Object.entries(body)) {
      await db
        .insert(settings)
        .values({ key, value: value as never, updatedBy: user.id })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: value as never, updatedAt: new Date(), updatedBy: user.id },
        });
      if (key === 'security.mfaRequired') resetMfaPolicyCache(ctx);
      if (key === 'session.idleHours' || key === 'session.maxHours') resetSessionLimitsCache(ctx);
      await audit(db, `user:${user.id}`, 'admin.setting.change', key, {
        value: Array.isArray(value)
          ? value.join(',')
          : typeof value === 'object'
            ? 'object'
            : (value as string | number | boolean),
      });
    }
    return { updated: Object.keys(body) };
  });

  // ------------------------------------------------------------------ журнал действий

  app.get('/admin/ledger', async (req) => {
    const q = parse(
      z.object({
        action: z.string().max(100).optional(),
        actor: z.string().max(100).optional(),
        // журнал сотрудника: его действия и действия над его учётной записью
        user: z.string().uuid().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        q: z.string().max(100).optional(),
        before: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        format: z.enum(['json', 'csv']).default('json'),
      }),
      req.query,
    );
    const like = q.q ? '%' + q.q.replace(/[%_\\]/g, '\\$&') + '%' : '';
    const conds = [
      q.action
        ? sql`${ledger.action} like ${q.action.replace(/[%_\\]/g, '\\$&') + '%'}`
        : undefined,
      q.actor ? eq(ledger.actor, q.actor) : undefined,
      q.user
        ? or(eq(ledger.actor, `user:${q.user}`), eq(ledger.target, `user:${q.user}`))
        : undefined,
      q.from ? sql`${ledger.at} >= ${q.from}` : undefined,
      q.to ? sql`${ledger.at} <= ${q.to}` : undefined,
      q.before ? sql`${ledger.id} < ${q.before}` : undefined,
      // поиск и по сотруднику: имя или почта автора и затронутой учётной записи
      q.q
        ? sql`(${ledger.action} ilike ${like} or ${ledger.target} ilike ${like} or ${ledger.detail}->>'ip' ilike ${like} or ${ledger.actor} in (select 'user:' || ${users.id}::text from ${users} where ${users.displayName} ilike ${like} or ${users.email} ilike ${like}) or ${ledger.target} in (select 'user:' || ${users.id}::text from ${users} where ${users.displayName} ilike ${like} or ${users.email} ilike ${like}))`
        : undefined,
    ].filter((c) => c !== undefined);
    const rows = await db
      .select()
      .from(ledger)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(sql`${ledger.id} desc`)
      .limit(q.limit);
    const ids = [
      ...new Set(
        rows
          .flatMap((r) => [r.actor, r.target ?? ''])
          .filter((x) => /^user:[0-9a-f-]{36}$/.test(x))
          .map((x) => x.slice(5)),
      ),
    ];
    const people = ids.length
      ? await db
          .select({ id: users.id, name: users.displayName, email: users.email })
          .from(users)
          .where(inArray(users.id, ids))
      : [];
    const idsOf = (prefix: string) => [
      ...new Set(
        rows
          .map((r) => r.target ?? '')
          .filter((x) => x.startsWith(prefix) && /^[a-z]+:[0-9a-f-]{36}$/.test(x))
          .map((x) => x.slice(prefix.length)),
      ),
    ];
    const [vaultNames, spaceNames, circleNames] = await Promise.all([
      idsOf('vault:').length
        ? db
            .select({ id: vaults.id, name: vaults.name, kind: vaults.kind })
            .from(vaults)
            .where(inArray(vaults.id, idsOf('vault:')))
        : [],
      idsOf('space:').length
        ? db
            .select({ id: spaces.id, name: spaces.name })
            .from(spaces)
            .where(inArray(spaces.id, idsOf('space:')))
        : [],
      idsOf('circle:').length
        ? db
            .select({ id: circles.id, name: circles.name })
            .from(circles)
            .where(inArray(circles.id, idsOf('circle:')))
        : [],
    ]);
    // названия сейфов, пространств и групп — метаданные, их администратор и так видит; записи зашифрованы и остаются кодом
    const nameOf = (ref: string | null) => {
      if (!ref) return null;
      const [kind, id] = ref.split(':') as [string, string | undefined];
      if (kind === 'user') {
        const p = people.find((x) => x.id === id);
        return p ? `${p.name} <${p.email}>` : null;
      }
      const named =
        kind === 'vault'
          ? vaultNames.find((x) => x.id === id && x.kind === 'shared')
          : kind === 'space'
            ? spaceNames.find((x) => x.id === id)
            : kind === 'circle'
              ? circleNames.find((x) => x.id === id)
              : undefined;
      return named?.name ?? null;
    };
    const items = rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actor: r.actor,
      actorName: nameOf(r.actor),
      action: r.action,
      target: r.target,
      targetName: nameOf(r.target),
      detail: r.detail,
    }));
    if (q.format === 'csv') {
      const esc = (v: unknown) =>
        `"${String(v ?? '')
          .replace(/"/g, '""')
          .replace(/^([=+\-@])/, "'$1")}"`;
      const csv = [
        'id,at,actor,actor_name,action,target,target_name,detail',
        ...items.map((i) =>
          [
            i.id,
            i.at,
            i.actor,
            i.actorName,
            i.action,
            i.target,
            i.targetName,
            JSON.stringify(i.detail ?? ''),
          ]
            .map(esc)
            .join(','),
        ),
      ].join('\n');
      return { csv };
    }
    return { items, next: items.length === q.limit ? items[items.length - 1]!.id : null };
  });
};
