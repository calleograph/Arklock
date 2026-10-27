import { CRITICAL_RE, WARNING_RE, eventLevel } from '../event-level.js';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { circleWrite, THEME_IDS, uuid } from '@arklock/contracts';
import { audit } from '../audit.js';
import { auditRotations, circleVaults, rotateLostAccess } from '../rotate-signals.js';
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
import { syncManagedGuardians } from '../managed-vaults.js';

/** Настройки, которые администратор может менять через API, и их допустимые значения. */
const SETTINGS: Record<string, z.ZodType> = {
  /** Тема для сотрудников, которые ещё не выбрали свою; выбор сотрудника не перезаписывается. */
  'appearance.defaultTheme': z.enum(THEME_IDS),
  'registration.mode': z.enum(['closed', 'open']),
  'vaults.creators': z.enum(['admins', 'members']),
  /** false permits only explicit user/group exceptions. */
  'vaults.personalLockers': z.boolean(),
  'vaults.personalLockerUsers': z.array(uuid).max(10000),
  'vaults.personalLockerCircles': z.array(uuid).max(10000),
  /** Персональные корпоративные сейфы: можно ли создавать, какие группы имеют к ним доступ и с какой ролью. */
  'vaults.managedPersonal': z.boolean(),
  'vaults.managedGuardians': z.array(uuid).max(20),
  'vaults.managedRole': z.enum(['reader', 'editor']),
  'trash.retentionDays': z.number().int().min(1).max(3650),
  /** Срок хранения журнала действий, дней: 0 — бессрочно, иначе не меньше 30 (короче — слишком легко стереть следы). */
  'ledger.retentionDays': z
    .number()
    .int()
    .refine((v) => v === 0 || (v >= 30 && v <= 3650)),
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
  /** Не больше N одинаковых символов подряд (0 — без требования). Проверяет браузер: сервер паролей не видит. */
  'policy.password.maxRepeat': z.number().int().min(0).max(20),
  /** Через сколько секунд показанный пароль снова скрывается (0 — не скрывать). */
  'security.revealSeconds': z.number().int().min(0).max(3600),
  /** Ограничения ссылок передачи: предельный срок, минут (0 — без своего ограничения), и число просмотров. */
  'links.maxMinutes': z.number().int().min(0).max(43_200),
  'links.maxViews': z.number().int().min(1).max(100),
  /** Примечание организации, которое получатель видит на странице ссылки. */
  'links.notice': z.string().trim().max(500),
  /** Генератор паролей: значения по умолчанию организации и символы, которые он никогда не использует. */
  'generator.length': z.number().int().min(8).max(128),
  'generator.lower': z.boolean(),
  'generator.upper': z.boolean(),
  'generator.digits': z.boolean(),
  'generator.symbols': z.boolean(),
  'generator.exclude': z
    .string()
    .max(64)
    .regex(/^[\x21-\x7e]*$/),
};
export const SETTING_DEFAULTS: Record<string, unknown> = {
  'appearance.defaultTheme': 'corporate',
  'registration.mode': 'closed',
  'vaults.creators': 'admins',
  'vaults.personalLockers': false,
  'vaults.personalLockerUsers': [],
  'vaults.personalLockerCircles': [],
  'vaults.managedPersonal': false,
  'vaults.managedGuardians': [],
  'vaults.managedRole': 'reader',
  'trash.retentionDays': 30,
  'ledger.retentionDays': 0,
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
  'policy.password.maxRepeat': 0,
  'security.revealSeconds': 0,
  'links.maxMinutes': 0,
  'links.maxViews': 100,
  'links.notice': '',
  'generator.length': 20,
  'generator.lower': true,
  'generator.upper': true,
  'generator.digits': true,
  'generator.symbols': true,
  'generator.exclude': '',
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

  const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const pageQuery = z.object({
    q: z.string().trim().max(100).default(''),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
    status: z.enum(['active', 'disabled']).optional(),
    role: z.string().max(60).optional(),
    sort: z.enum(['name', 'seen']).default('name'),
    dir: z.enum(['asc', 'desc']).default('asc'),
  });
  const matchUser = (q: string): SQL | undefined => {
    if (!q) return undefined;
    const p = likeOf(q);
    return or(
      ilike(users.displayName, p),
      ilike(users.email, p),
      ilike(users.title, p),
      ilike(users.department, p),
    );
  };

  /**
   * Поиск сотрудников для выбора руководителя, участников и т. п.: серверный, страницами.
   * Полный список не отдаётся: в организации на десятки тысяч человек его не нужно ни грузить, ни листать.
   */
  app.get('/admin/people', async (req) => {
    const o = parse(pageQuery, req.query);
    const where = and(
      matchUser(o.q),
      o.status
        ? o.status === 'disabled'
          ? sql`${users.disabledAt} is not null`
          : isNull(users.disabledAt)
        : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.displayName,
          email: users.email,
          title: users.title,
          department: users.department,
          authSource: users.authSource,
          disabled: sql<boolean>`${users.disabledAt} is not null`,
        })
        .from(users)
        .where(where)
        .orderBy(asc(users.displayName), asc(users.email))
        .limit(o.limit ?? 20)
        .offset(o.offset),
      db.select({ n: count() }).from(users).where(where),
    ]);
    return { items: rows, total: total?.n ?? 0 };
  });

  app.get('/admin/users', async (req) => {
    const o = parse(pageQuery, req.query);
    const paged = o.limit !== undefined;
    const seenAt = sql`(select max(${sessions.lastSeenAt}) from ${sessions} where ${sessions.userId} = ${users.id})`;
    const where = paged
      ? and(
          matchUser(o.q),
          o.status
            ? o.status === 'disabled'
              ? sql`${users.disabledAt} is not null`
              : isNull(users.disabledAt)
            : undefined,
          o.role?.startsWith('role:')
            ? eq(users.adminRoleId, o.role.slice(5))
            : o.role === 'admin' || o.role === 'member'
              ? eq(users.role, o.role)
              : undefined,
        )
      : undefined;
    const dirOf = o.dir === 'desc' ? desc : asc;
    const base = db
      .select()
      .from(users)
      .where(where)
      .orderBy(
        ...(o.sort === 'seen'
          ? [dirOf(seenAt), asc(users.displayName)]
          : [dirOf(users.displayName), asc(users.email)]),
      );
    const rows = paged ? await base.limit(o.limit!).offset(o.offset) : await base;
    const lastSeen = await db
      .select({ userId: sessions.userId, at: sql<Date>`max(${sessions.lastSeenAt})` })
      .from(sessions)
      .where(
        paged
          ? inArray(
              sessions.userId,
              rows.map((r) => r.id),
            )
          : undefined,
      )
      .groupBy(sessions.userId);
    const seen = new Map(lastSeen.map((s) => [s.userId, s.at]));
    const list = rows.map((u) => ({
      id: u.id,
      name: u.displayName,
      email: u.email,
      role: u.role,
      chief: u.chief,
      adminRoleId: u.adminRoleId,
      disabled: !!u.disabledAt,
      disabledReason: u.disabledAt ? u.disabledReason : null,
      accessUntil: u.accessUntil?.toISOString() ?? null,
      // временная блокировка входа после неудачных попыток (пароль, второй фактор, восстановление)
      lockedFor: Math.max(
        ctx.attempts.byEmail.retryAfter(u.email),
        ctx.attempts.byEmail.retryAfter(`mfa:${u.id}`),
        ctx.attempts.byEmail.retryAfter(`recovery:${u.email}`),
      ),
      disabledNote: u.disabledAt ? u.disabledNote : null,
      authSource: u.authSource,
      createdAt: u.createdAt.toISOString(),
      lastSeenAt: seen.get(u.id) ? new Date(seen.get(u.id)!).toISOString() : null,
      title: u.title,
      department: u.department,
    }));
    if (!paged) return list;
    const [total] = await db.select({ n: count() }).from(users).where(where);
    return { items: list, total: total?.n ?? 0 };
  });

  app.patch('/admin/users/:id', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        role: z.enum(['admin', 'member']).optional(),
        disabled: z.boolean().optional(),
        /** Пояснение к отключению: сохраняется в карточке. */
        disabledNote: z.string().trim().max(200).optional(),
        acknowledgeAccessRisk: z.boolean().optional(),
        /** Административная роль (делегирование); null — снять. */
        adminRoleId: uuid.nullable().optional(),
        /** Срок действия учётной записи (в будущем); null — бессрочно. */
        accessUntil: z.string().datetime().nullable().optional(),
      }),
      req.body,
    );
    if (body.accessUntil && Date.parse(body.accessUntil) <= Date.now())
      throw new AppError(400, 'validation_error', 'The access end must be in the future');
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
    // срок действия — для сотрудников: истечение у администратора могло бы оставить организацию без него
    const until =
      body.accessUntil !== undefined
        ? body.accessUntil
        : body.disabled === false &&
            target.accessUntil &&
            target.accessUntil.getTime() <= Date.now()
          ? null // включение истёкшей учётной записи снимает прошедший срок
          : (target.accessUntil?.toISOString() ?? null);
    if (until && ((body.role ?? target.role) === 'admin' || id === user.id))
      throw new AppError(
        409,
        'expiry_not_allowed',
        'An access end date is for regular members, not administrators or yourself',
      );
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
        accessUntil: until ? new Date(until) : null,
        ...(body.disabled === true && disabling
          ? {
              disabledAt: new Date(),
              disabledReason: 'manual' as const,
              disabledNote: body.disabledNote || null,
              disabledBy: user.id,
            }
          : body.disabled === false
            ? { disabledAt: null, disabledReason: null, disabledNote: null, disabledBy: null }
            : {}),
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
      accessUntil: body.accessUntil !== undefined ? body.accessUntil : null,
      accessRiskAcknowledged: accessRisks.length > 0 && body.acknowledgeAccessRisk === true,
    });
    return { id };
  });

  /** Снять временную блокировку входа после неудачных попыток (сама учётная запись не меняется). */
  app.post('/admin/users/:id/unlock', async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    const [target] = await db.select().from(users).where(eq(users.id, id));
    if (!target) throw notFound();
    for (const key of [target.email, `mfa:${id}`, `recovery:${target.email}`])
      ctx.attempts.byEmail.reset(key);
    await audit(db, `user:${user.id}`, 'admin.user.unlock', `user:${id}`);
    return reply.status(204).send();
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

  app.get('/admin/circles', async (req) => {
    const o = parse(pageQuery, req.query);
    const paged = o.limit !== undefined;
    const where = o.q ? ilike(circles.name, likeOf(o.q)) : undefined;
    const base = db.select().from(circles).where(where).orderBy(asc(circles.name));
    const rows = paged ? await base.limit(o.limit!).offset(o.offset) : await base;
    const counts = await db
      .select({ id: circleMembers.circleId, n: count() })
      .from(circleMembers)
      .groupBy(circleMembers.circleId);
    const m = new Map(counts.map((c) => [c.id, c.n]));
    const list = rows.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      adminRoleId: c.adminRoleId,
      members: m.get(c.id) ?? 0,
    }));
    if (!paged) return list;
    const [total] = await db.select({ n: count() }).from(circles).where(where);
    return { items: list, total: total?.n ?? 0 };
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
    // исключённые из группы теряют её доступ к сейфам — по потерянным записям «смените пароль»
    const vaultIds = remove.length ? await circleVaults(db, id) : [];
    const { result: changed, opened } = await rotateLostAccess(
      db,
      remove.flatMap((userId) => vaultIds.map((vaultId) => ({ vaultId, userId }))),
      () =>
        db.transaction(async (tx) => {
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
        }),
      user.id,
    );
    await auditRotations(db, `user:${user.id}`, opened);
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
    const vaultIds = await circleVaults(db, id);
    const { result: res, opened } = await rotateLostAccess(
      db,
      vaultIds.map((vaultId) => ({ vaultId, userId })),
      () =>
        db
          .delete(circleMembers)
          .where(and(eq(circleMembers.circleId, id), eq(circleMembers.userId, userId)))
          .returning(),
      user.id,
    );
    if (!res.length) throw notFound();
    await auditRotations(db, `user:${user.id}`, opened);
    await audit(db, `user:${user.id}`, 'admin.circle.member.remove', `circle:${id}`, {
      member: userId,
    });
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ настройки

  /** Inventory contains only ownership/counts; no personal ciphertext or keys are disclosed. */
  /**
   * Личные сейфы и исключения. Страницами и с поиском: в организации на десятки тысяч человек полный список не нужен.
   * Без запроса показываются те, у кого есть личный сейф или личное разрешение; с запросом — найденные сотрудники.
   */
  app.get('/admin/settings/personal-lockers', async (req) => {
    const o = parse(
      z.object({
        q: z.string().trim().max(100).default(''),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
      }),
      req.query,
    );
    const stored = await db
      .select()
      .from(settings)
      .where(
        inArray(settings.key, [
          'vaults.personalLockers',
          'vaults.personalLockerUsers',
          'vaults.personalLockerCircles',
        ]),
      );
    const value = (key: string) => stored.find((r) => r.key === key)?.value;
    const everyone = value('vaults.personalLockers') === true;
    const allowedUsers = (
      Array.isArray(value('vaults.personalLockerUsers')) ? value('vaults.personalLockerUsers') : []
    ) as string[];
    const allowedCircles = (
      Array.isArray(value('vaults.personalLockerCircles'))
        ? value('vaults.personalLockerCircles')
        : []
    ) as string[];
    const hasLocker = sql`exists (select 1 from vaults v where v.kind = 'locker' and v.created_by = ${users.id})`;
    const where = o.q
      ? matchUser(o.q)
      : allowedUsers.length
        ? or(hasLocker, inArray(users.id, allowedUsers))
        : hasLocker;
    const [people, [total], groups] = await Promise.all([
      db
        .select({ id: users.id, name: users.displayName, email: users.email })
        .from(users)
        .where(where)
        .orderBy(asc(users.displayName), asc(users.email))
        .limit(o.limit)
        .offset(o.offset),
      db.select({ n: count() }).from(users).where(where),
      allowedCircles.length
        ? db
            .select({ id: circles.id, name: circles.name })
            .from(circles)
            .where(inArray(circles.id, allowedCircles))
            .orderBy(asc(circles.name))
        : [],
    ]);
    const ids = people.map((p) => p.id);
    const [memberships, lockers] = ids.length
      ? await Promise.all([
          allowedCircles.length
            ? db
                .select()
                .from(circleMembers)
                .where(
                  and(
                    inArray(circleMembers.userId, ids),
                    inArray(circleMembers.circleId, allowedCircles),
                  ),
                )
            : [],
          db
            .select({
              id: vaults.id,
              userId: vaults.createdBy,
              createdAt: vaults.createdAt,
              entries: count(entries.id),
            })
            .from(vaults)
            .leftJoin(entries, eq(entries.vaultId, vaults.id))
            .where(and(eq(vaults.kind, 'locker'), inArray(vaults.createdBy, ids)))
            .groupBy(vaults.id, vaults.createdBy, vaults.createdAt),
        ])
      : [[], []];
    return {
      circles: groups,
      total: total?.n ?? 0,
      users: people.map((u) => ({
        ...u,
        allowed:
          everyone || allowedUsers.includes(u.id) || memberships.some((m) => m.userId === u.id),
        direct: allowedUsers.includes(u.id),
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
      ['vaults.managedGuardians', circles],
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
      if (key === 'vaults.managedGuardians' || key === 'vaults.managedRole')
        await syncManagedGuardians(db, user.id);
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
        level: z.enum(['critical', 'warning', 'info']).optional(),
        // курсор страницы: id последней строки, при сортировке по действию — «действие|id»
        before: z
          .string()
          .regex(/^(?:[a-z0-9._-]{1,100}\|)?\d{1,18}$/)
          .optional(),
        sort: z.enum(['at', 'action']).default('at'),
        dir: z.enum(['desc', 'asc']).default('desc'),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        format: z.enum(['json', 'csv']).default('json'),
      }),
      req.query,
    );
    const like = q.q ? '%' + q.q.replace(/[%_\\]/g, '\\$&') + '%' : '';
    const desc = q.dir === 'desc';
    const cut = q.before?.split('|');
    // сравнение строк (действие, id) — продолжение страницы без пропусков и повторов при одинаковых действиях
    const cursor = !cut
      ? undefined
      : cut.length === 2
        ? desc
          ? sql`(${ledger.action}, ${ledger.id}) < (${cut[0]}, ${Number(cut[1])})`
          : sql`(${ledger.action}, ${ledger.id}) > (${cut[0]}, ${Number(cut[1])})`
        : desc
          ? sql`${ledger.id} < ${Number(cut[0])}`
          : sql`${ledger.id} > ${Number(cut[0])}`;
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
      q.level === 'critical' ? sql`${ledger.action} ~ ${CRITICAL_RE.source}` : undefined,
      q.level === 'warning'
        ? sql`${ledger.action} !~ ${CRITICAL_RE.source} and ${ledger.action} ~ ${WARNING_RE.source}`
        : undefined,
      q.level === 'info'
        ? sql`${ledger.action} !~ ${CRITICAL_RE.source} and ${ledger.action} !~ ${WARNING_RE.source}`
        : undefined,
      cursor,
      // поиск и по сотруднику: имя или почта автора и затронутой учётной записи
      q.q
        ? sql`(${ledger.action} ilike ${like} or ${ledger.target} ilike ${like} or ${ledger.detail}->>'ip' ilike ${like} or ${ledger.actor} in (select 'user:' || ${users.id}::text from ${users} where ${users.displayName} ilike ${like} or ${users.email} ilike ${like}) or ${ledger.target} in (select 'user:' || ${users.id}::text from ${users} where ${users.displayName} ilike ${like} or ${users.email} ilike ${like}))`
        : undefined,
    ].filter((c) => c !== undefined);
    const rows = await db
      .select()
      .from(ledger)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(
        ...(q.sort === 'action' ? [desc ? sql`${ledger.action} desc` : ledger.action] : []),
        desc ? sql`${ledger.id} desc` : ledger.id,
      )
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
      level: eventLevel(r.action),
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
        'id,at,actor,actor_name,action,target,target_name,detail,level',
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
            i.level,
          ]
            .map(esc)
            .join(','),
        ),
      ].join('\n');
      return { csv };
    }
    const last = items.length === q.limit ? items[items.length - 1]! : null;
    return {
      items,
      next: !last ? null : q.sort === 'action' ? `${last.action}|${last.id}` : last.id,
    };
  });
};
