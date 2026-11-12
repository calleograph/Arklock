import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { uuid } from '@arklock/contracts';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import {
  classifyLdapError,
  ldapBrowse,
  ldapGroupMembers,
  withinBaseDn,
  type LdapError,
} from '../auth/ldap.js';
import {
  identityIds,
  ldapBindSecret,
  ldapIdentityProfile,
  readLdapProfiles,
  writeLdapProfiles,
  type LdapProfile,
} from '../auth/ldap-profiles.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db/connect.js';
import {
  circleMembers,
  circles,
  roles,
  spaceCircles,
  spaceMembers,
  spaces,
  users,
  vaultCircles,
  vaults,
} from '../db/schema.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';
import { notifyUsers } from '../notifications.js';
import { auditRotations, circleVaults, rotateLostAccess } from '../rotate-signals.js';

const normDn = (dn: string) => dn.toLowerCase().replace(/\s*,\s*/g, ',');
/** Имя группы из её DN: значение первого RDN («CN=Бухгалтерия,OU=…» → «Бухгалтерия»). */
const nameOfDn = (dn: string) =>
  (/^[^=]+=((?:\\.|[^,])+)/.exec(dn)?.[1] ?? dn).replace(/\\(.)/g, '$1').trim();

const linkBody = z.object({
  profileId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  dn: z.string().trim().min(3).max(500),
});

/**
 * Группы доступа: группа Arklock может получать участников из групп каталога («домен → Arklock»). Здесь поиск групп
 * домена, привязка и отвязка, и предпросмотр: кого и какие права это затронет, до того как что-то сохранится.
 */
export const registerDirectoryGroupRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db, config } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', (req) => adminGate(ctx, req));

  /** Состав группы с административной ролью меняет только полный администратор (иначе делегат выдал бы себе полномочия). */
  async function assertCircleWritable(user: { role: string }, circleId: string): Promise<void> {
    if (user.role === 'admin') return;
    const [c] = await db
      .select({ r: circles.adminRoleId })
      .from(circles)
      .where(eq(circles.id, circleId));
    if (c?.r) throw forbidden();
  }
  async function circleOr404(id: string) {
    const [c] = await db.select().from(circles).where(eq(circles.id, id));
    if (!c) throw notFound();
    return c;
  }
  async function profileOf(id: string): Promise<LdapProfile> {
    const p = (await readLdapProfiles(db)).find((x) => x.id === id);
    if (!p) throw new AppError(409, 'ldap_not_saved', 'Save the connection first');
    if (!p.enabled) throw new AppError(409, 'ldap_disabled', 'Directory sign-in is turned off');
    return p;
  }
  const secretOf = (p: LdapProfile) => ldapBindSecret(p, config.APP_SECRET);
  const unavailable = (e: unknown) => {
    const c: LdapError = classifyLdapError(e, 'search');
    return c.code === 'config'
      ? new AppError(400, 'dn_outside_base', 'DN is outside the Base DN')
      : new AppError(503, 'ldap_unavailable', 'Directory is unavailable', {
          reason: c.reason,
          detail: c.detail,
        });
  };

  /** Люди группы каталога, у которых уже есть профиль Arklock (в том числе «ждёт первого входа»). */
  async function membersWithProfiles(p: LdapProfile, dn: string) {
    let r;
    try {
      r = await ldapGroupMembers(p, secretOf(p), dn);
    } catch (e) {
      throw unavailable(e);
    }
    const ids = r.members.flatMap((m) => identityIds(p.id, m));
    const known = ids.length
      ? await db
          .select({
            id: users.id,
            externalId: users.externalId,
            pendingActivation: users.pendingActivation,
            disabledAt: users.disabledAt,
          })
          .from(users)
          .where(and(eq(users.authSource, 'ldap'), inArray(users.externalId, ids)))
      : [];
    const byId = new Map(known.map((u) => [u.externalId!, u]));
    const have = r.members.flatMap((m) => {
      const u = identityIds(p.id, m)
        .map((i) => byId.get(i))
        .find(Boolean);
      return u && !u.disabledAt ? [{ ...m, userId: u.id, pending: u.pendingActivation }] : [];
    });
    return { all: r.members, have, truncated: r.truncated };
  }

  /** Что получает участник группы: сейфы с ролью и административная роль. */
  async function circleEffect(circleId: string) {
    const [c, vs, members] = await Promise.all([
      circleOr404(circleId),
      db
        .select({ name: vaults.name, role: vaultCircles.role })
        .from(vaultCircles)
        .innerJoin(vaults, eq(vaults.id, vaultCircles.vaultId))
        .where(eq(vaultCircles.circleId, circleId))
        .orderBy(asc(vaults.name)),
      db
        .select({ id: circleMembers.userId })
        .from(circleMembers)
        .where(eq(circleMembers.circleId, circleId)),
    ]);
    let adminRole: string | null = null;
    if (c.adminRoleId) {
      const [r] = await db
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, c.adminRoleId));
      adminRole = r?.name ?? '';
    }
    return {
      circle: { id: c.id, name: c.name },
      memberIds: new Set(members.map((m) => m.id)),
      vaults: vs,
      adminRole,
    };
  }

  // ------------------------------------------------------------------ поиск групп домена

  app.get('/admin/directory/groups', async (req) => {
    const o = parse(
      z.object({
        q: z.string().trim().max(100).default(''),
        limit: z.coerce.number().int().min(1).max(25).default(12),
        profileId: z.string().max(60).optional(),
      }),
      req.query,
    );
    const profiles = (await readLdapProfiles(db)).filter(
      (p) => p.enabled && (!o.profileId || p.id === o.profileId),
    );
    if (o.q.length < 2) return { configured: profiles.length > 0, items: [], problems: [] };
    const circleRows = await db.select({ id: circles.id, name: circles.name }).from(circles);
    const circleName = new Map(circleRows.map((c) => [c.id, c.name]));
    const items: {
      profileId: string;
      profileName: string;
      dn: string;
      name: string;
      linked: { circleId: string; circleName: string }[];
    }[] = [];
    const problems: { profileId: string; profileName: string; reason: string; detail: string }[] =
      [];
    for (const p of profiles) {
      try {
        const r = await ldapBrowse(p, secretOf(p), { kind: 'groups', q: o.q, limit: o.limit });
        for (const e of r.entries)
          items.push({
            profileId: p.id,
            profileName: p.name,
            dn: e.dn,
            name: e.name || nameOfDn(e.dn),
            linked: p.groups
              .filter((g) => normDn(g.dn) === normDn(e.dn) && circleName.has(g.circleId))
              .map((g) => ({ circleId: g.circleId, circleName: circleName.get(g.circleId)! })),
          });
      } catch (e) {
        const c: LdapError = classifyLdapError(e, 'search');
        problems.push({ profileId: p.id, profileName: p.name, reason: c.reason, detail: c.detail });
      }
    }
    return { configured: profiles.length > 0, items, problems };
  });

  /** Привязки группы Arklock к группам домена (из всех подключений). */
  app.get('/admin/circles/:id/directory-links', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await circleOr404(id);
    const profiles = await readLdapProfiles(db);
    return {
      configured: profiles.some((p) => p.enabled),
      links: profiles.flatMap((p) =>
        p.groups
          .filter((g) => g.circleId === id)
          .map((g) => ({
            profileId: p.id,
            profileName: p.name,
            enabled: p.enabled,
            dn: g.dn,
            name: nameOfDn(g.dn),
          })),
      ),
    };
  });

  // ------------------------------------------------------------------ подразделения

  /**
   * Созданные подразделения: закрытое пространство, к которому подключена группа с тем же названием (так их создаёт
   * мастер «Подразделения»). Показаны руководители (администраторы пространства), состав группы и число сейфов.
   */
  app.get('/admin/departments', async (req) => {
    const o = parse(
      z.object({
        q: z.string().trim().max(100).default(''),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        /** Показывать и архивные подразделения (их можно вернуть из архива). */
        archived: z.enum(['0', '1']).default('0'),
      }),
      req.query,
    );
    const rows = await db
      .select({
        spaceId: spaces.id,
        name: spaces.name,
        circleId: circles.id,
        description: spaces.description,
        archived: spaces.archived,
      })
      .from(spaces)
      .innerJoin(spaceCircles, eq(spaceCircles.spaceId, spaces.id))
      .innerJoin(circles, and(eq(circles.id, spaceCircles.circleId), eq(circles.name, spaces.name)))
      .where(
        and(
          o.archived === '1' ? undefined : eq(spaces.archived, false),
          eq(spaces.publicToOrg, false),
          eq(spaces.isDefault, false),
        ),
      )
      .orderBy(asc(spaces.name))
      .limit(o.limit);
    const list = o.q ? rows.filter((r) => r.name.toLowerCase().includes(o.q.toLowerCase())) : rows;
    if (!list.length) return { items: [] };
    const spaceIds = list.map((r) => r.spaceId);
    const circleIds = list.map((r) => r.circleId);
    const [heads, members, vs] = await Promise.all([
      db
        .select({
          spaceId: spaceMembers.spaceId,
          id: users.id,
          name: users.displayName,
          pending: users.pendingActivation,
        })
        .from(spaceMembers)
        .innerJoin(users, eq(users.id, spaceMembers.userId))
        .where(and(inArray(spaceMembers.spaceId, spaceIds), eq(spaceMembers.role, 'admin'))),
      db
        .select({
          circleId: circleMembers.circleId,
          pending: users.pendingActivation,
        })
        .from(circleMembers)
        .innerJoin(users, eq(users.id, circleMembers.userId))
        .where(inArray(circleMembers.circleId, circleIds)),
      db
        .select({ spaceId: vaults.spaceId })
        .from(vaults)
        .where(and(inArray(vaults.spaceId, spaceIds), eq(vaults.kind, 'shared'))),
    ]);
    return {
      items: list.map((r) => ({
        spaceId: r.spaceId,
        circleId: r.circleId,
        name: r.name,
        description: r.description,
        archived: r.archived,
        heads: heads
          .filter((h) => h.spaceId === r.spaceId)
          .map(({ id, name, pending }) => ({ id, name, pending })),
        members: members.filter((m) => m.circleId === r.circleId).length,
        waiting: members.filter((m) => m.circleId === r.circleId && m.pending).length,
        vaults: vs.filter((v) => v.spaceId === r.spaceId).length,
      })),
    };
  });

  // ------------------------------------------------------------------ предпросмотр

  /** Кого и какие права затронет привязка (link) или отвязка (unlink) группы домена. Ничего не меняет. */
  app.post('/admin/directory/groups/preview', async (req) => {
    const body = parse(
      linkBody.extend({ circleId: uuid, action: z.enum(['link', 'unlink']) }),
      req.body,
    );
    const p = await profileOf(body.profileId);
    if (!withinBaseDn(p, body.dn))
      throw new AppError(400, 'dn_outside_base', 'DN is outside the Base DN');
    const eff = await circleEffect(body.circleId);
    const { all, have, truncated } = await membersWithProfiles(p, body.dn);
    if (body.action === 'link')
      return {
        action: 'link' as const,
        group: nameOfDn(body.dn),
        circle: eff.circle,
        domainMembers: all.length,
        truncated,
        withProfile: have.length,
        waiting: have.filter((m) => m.pending).length,
        withoutProfile: all.length - have.length,
        willJoin: have.filter((m) => !eff.memberIds.has(m.userId)).length,
        alreadyMembers: have.filter((m) => eff.memberIds.has(m.userId)).length,
        vaults: eff.vaults,
        adminRole: eff.adminRole,
      };
    // отвязка: кто из участников группы Arklock пришёл из каталога и потеряет ли доступ
    const members = (
      await db
        .select({ id: users.id, externalId: users.externalId })
        .from(circleMembers)
        .innerJoin(users, eq(users.id, circleMembers.userId))
        .where(and(eq(circleMembers.circleId, body.circleId), eq(users.authSource, 'ldap')))
    ).filter((u) => ldapIdentityProfile(u.externalId) === p.id);
    const stillMapped = p.groups.some(
      (g) => g.circleId === body.circleId && normDn(g.dn) !== normDn(body.dn),
    );
    return {
      action: 'unlink' as const,
      group: nameOfDn(body.dn),
      circle: eff.circle,
      directoryMembers: members.length,
      stillMapped,
      vaults: eff.vaults,
      adminRole: eff.adminRole,
    };
  });

  // ------------------------------------------------------------------ привязка и отвязка

  /** Добавляет привязку в подключение и вносит в группу тех, у кого уже есть профиль. */
  async function link(actor: string, p: LdapProfile, dn: string, circleId: string) {
    const { have } = await membersWithProfiles(p, dn);
    let added: string[] = [];
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('arklock.ldap.profiles'))`);
      const profiles = await readLdapProfiles(tx);
      const cur = profiles.find((x) => x.id === p.id);
      if (!cur?.enabled)
        throw new AppError(409, 'ldap_changed', 'The directory settings changed; try again');
      if (!cur.groups.some((g) => g.circleId === circleId && normDn(g.dn) === normDn(dn))) {
        if (cur.groups.length >= 200)
          throw new AppError(409, 'too_many_links', 'At most 200 group links per directory');
        await writeLdapProfiles(
          tx,
          profiles.map((x) =>
            x.id === p.id ? { ...x, groups: [...x.groups, { dn, circleId }] } : x,
          ),
          actor,
        );
      }
      if (have.length)
        added = (
          await tx
            .insert(circleMembers)
            .values(have.map((m) => ({ circleId, userId: m.userId })))
            .onConflictDoNothing()
            .returning({ userId: circleMembers.userId })
        ).map((r) => r.userId);
      await notifyUsers(tx, added, {
        category: 'access',
        event: 'admin.circle.member.add',
        resourceType: 'circle',
        resourceId: circleId,
      });
      await audit(tx, actor, 'admin.directory.group.link', `circle:${circleId}`, {
        profile: p.id,
        added: added.length,
      });
    });
    return added.length;
  }

  app.put('/admin/circles/:id/directory-links', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      linkBody.extend({
        action: z.enum(['link', 'unlink']),
        /** При отвязке: оставить участников группы (по умолчанию) или убрать пришедших из каталога. */
        keepMembers: z.boolean().default(true),
      }),
      req.body,
    );
    await assertCircleWritable(user, id);
    await circleOr404(id);
    const p = await profileOf(body.profileId);
    if (body.action === 'link') {
      if (!withinBaseDn(p, body.dn))
        throw new AppError(400, 'dn_outside_base', 'DN is outside the Base DN');
      return { ok: true, added: await link(`user:${user.id}`, p, body.dn, id), removed: 0 };
    }
    let removed = 0;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('arklock.ldap.profiles'))`);
      const profiles = await readLdapProfiles(tx);
      const cur = profiles.find((x) => x.id === p.id);
      if (!cur)
        throw new AppError(409, 'ldap_changed', 'The directory settings changed; try again');
      const groups = cur.groups.filter(
        (g) => !(g.circleId === id && normDn(g.dn) === normDn(body.dn)),
      );
      if (groups.length === cur.groups.length) throw notFound();
      await writeLdapProfiles(
        tx,
        profiles.map((x) => (x.id === p.id ? { ...x, groups } : x)),
        user.id,
      );
      // группа осталась привязанной к другой группе домена: её участников каталог по-прежнему ведёт
      const stillMapped = groups.some((g) => g.circleId === id);
      if (!body.keepMembers && !stillMapped) {
        const linked = (
          await tx
            .select({ id: users.id, externalId: users.externalId })
            .from(circleMembers)
            .innerJoin(users, eq(users.id, circleMembers.userId))
            .where(and(eq(circleMembers.circleId, id), eq(users.authSource, 'ldap')))
        )
          .filter((u) => ldapIdentityProfile(u.externalId) === p.id)
          .map((u) => u.id);
        if (linked.length) {
          const txDb = tx as unknown as Db;
          const vaultIds = await circleVaults(txDb, id);
          const { opened } = await rotateLostAccess(
            txDb,
            linked.flatMap((userId) => vaultIds.map((vaultId) => ({ vaultId, userId }))),
            () =>
              tx
                .delete(circleMembers)
                .where(and(eq(circleMembers.circleId, id), inArray(circleMembers.userId, linked))),
            user.id,
          );
          await auditRotations(txDb, `user:${user.id}`, opened);
          removed = linked.length;
        }
      }
      await audit(tx, `user:${user.id}`, 'admin.directory.group.unlink', `circle:${id}`, {
        profile: p.id,
        keepMembers: body.keepMembers,
        removed,
      });
    });
    return { ok: true, added: 0, removed };
  });

  /**
   * «Добавить группу домена» там, где выбирают группу (доступ к сейфу, пространству): если группа домена уже
   * привязана — возвращается её группа Arklock; иначе создаётся группа с тем же именем и привязывается.
   */
  app.post('/admin/directory/groups/use', async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(linkBody, req.body);
    const p = await profileOf(body.profileId);
    if (!withinBaseDn(p, body.dn))
      throw new AppError(400, 'dn_outside_base', 'DN is outside the Base DN');
    const mapped = p.groups.find((g) => normDn(g.dn) === normDn(body.dn));
    if (mapped) {
      const [c] = await db.select().from(circles).where(eq(circles.id, mapped.circleId));
      if (c) return { circle: { id: c.id, name: c.name }, created: false, added: 0 };
    }
    // проверяем, что группа существует и не пуста по нашей части: данные берутся из каталога, а не от браузера
    const base = nameOfDn(body.dn);
    let name = base.slice(0, 100);
    const [taken] = await db.select({ id: circles.id }).from(circles).where(eq(circles.name, name));
    if (taken) name = `${base.slice(0, 80)} (${p.name.slice(0, 15)})`;
    const [taken2] = await db
      .select({ id: circles.id })
      .from(circles)
      .where(eq(circles.name, name));
    if (taken2)
      throw new AppError(409, 'circle_name_taken', 'A group with this name already exists', {
        circleId: taken2.id,
      });
    const id = randomUUID();
    await db.insert(circles).values({
      id,
      name,
      description: `${p.name}: ${base}`.slice(0, 500),
    });
    try {
      const added = await link(`user:${user.id}`, p, body.dn, id);
      reply.status(201);
      return { circle: { id, name }, created: true, added };
    } catch (e) {
      // привязка не удалась (каталог не ответил): пустая группа не остаётся
      await db.delete(circles).where(eq(circles.id, id));
      throw e;
    }
  });
};
