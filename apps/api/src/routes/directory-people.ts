import { randomUUID } from 'node:crypto';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DEFAULT_KDF } from '@arklock/crypto';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import {
  accessAllowed,
  classifyLdapError,
  ldapBrowse,
  ldapReadUser,
  type LdapError,
} from '../auth/ldap.js';
import {
  adoptGuidIdentity,
  directoryExternalId,
  identityIds,
  ldapBindSecret,
  linkedLdapUser,
  readLdapProfiles,
  type LdapProfile,
} from '../auth/ldap-profiles.js';
import { syncCirclesFor, syncProfileFor } from '../auth/ldap-sync.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { users } from '../db/schema.js';
import { AppError, parse } from '../errors.js';
import { hashProof, randomB64url } from '../security.js';
import { outsideSharing } from '../sharing-policy.js';

type Existing = { id: string; state: 'active' | 'pending' | 'disabled' };

/**
 * Сотрудники подключённых каталогов в полях выбора человека: администратор ищет в каталоге, выбирает найденного,
 * и для него создаётся профиль Arklock без входа самого человека. Ключей шифрования у такого профиля нет:
 * их создаёт сам человек при первом входе, пока доступ к сейфам не выдаётся (профиль «ожидает первого входа»).
 */
export const registerDirectoryPeopleRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db, config } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  // права администратора нужны только маршрутам /admin: остальные доступны любому вошедшему и ограничены политикой
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/api/v1/admin/')) await adminGate(ctx, req);
  });

  const enabledProfiles = async (only?: string): Promise<LdapProfile[]> =>
    (await readLdapProfiles(db)).filter((p) => p.enabled && (!only || p.id === only));

  const stateOf = (u: {
    disabledAt: Date | null;
    pendingActivation: boolean;
  }): Existing['state'] => (u.disabledAt ? 'disabled' : u.pendingActivation ? 'pending' : 'active');

  /** Сводка для шагов «что дальше»: сколько профилей по каталогу ждут первого входа и сколько сотрудников уже входили. */
  app.get('/admin/people/summary', async () => {
    const [waiting] = await db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.pendingActivation, true), isNull(users.disabledAt)));
    const [signedIn] = await db
      .select({ n: count() })
      .from(users)
      .where(
        and(
          eq(users.authSource, 'ldap'),
          eq(users.pendingActivation, false),
          isNull(users.disabledAt),
        ),
      );
    return { waiting: waiting?.n ?? 0, signedIn: signedIn?.n ?? 0 };
  });

  /** Поиск в каталоге: по имени, логину и почте; в ответе видно, кто уже есть в Arklock. */
  async function search(o: { q: string; limit: number; profileId?: string }, minLength = 2) {
    const profiles = await enabledProfiles(o.profileId);
    // короткий запрос выбрал бы весь каталог; подсказка в поле просит ввести хотя бы две буквы
    if (o.q.length < minLength) return { configured: profiles.length > 0, items: [], problems: [] };
    const items: {
      profileId: string;
      profileName: string;
      dn: string;
      guid: string;
      name: string;
      email: string;
      login: string;
      title: string;
      department: string;
      existing: Existing | null;
    }[] = [];
    const problems: { profileId: string; profileName: string; reason: string; detail: string }[] =
      [];
    // подключения опрашиваются одновременно: недоступный сервер не задерживает остальные
    const parts = await Promise.all(
      profiles.map(async (p) => {
        try {
          const r = await ldapBrowse(p, ldapBindSecret(p, config.APP_SECRET), {
            kind: 'users',
            q: o.q,
            limit: o.limit,
            activeOnly: true,
          });
          const found = r.entries.map((e) => ({ ...e, ids: identityIds(p.id, e) }));
          const linked = found.length
            ? await db
                .select({
                  id: users.id,
                  externalId: users.externalId,
                  disabledAt: users.disabledAt,
                  pendingActivation: users.pendingActivation,
                })
                .from(users)
                .where(
                  and(
                    eq(users.authSource, 'ldap'),
                    inArray(users.externalId, [...new Set(found.flatMap((f) => f.ids))]),
                  ),
                )
            : [];
          return {
            items: found.map((e) => {
              const u = linked.find((l) => l.externalId && e.ids.includes(l.externalId));
              return {
                profileId: p.id,
                profileName: p.name,
                dn: e.dn,
                guid: e.guid,
                name: e.name,
                email: e.email,
                login: e.login,
                title: e.title,
                department: e.department,
                existing: u ? { id: u.id, state: stateOf(u) } : null,
              };
            }),
            problem: null,
          };
        } catch (e) {
          const c: LdapError = classifyLdapError(e, 'search');
          return {
            items: [],
            problem: { profileId: p.id, profileName: p.name, reason: c.reason, detail: c.detail },
          };
        }
      }),
    );
    for (const part of parts) {
      items.push(...part.items);
      if (part.problem) problems.push(part.problem);
    }
    return { configured: profiles.length > 0, items, problems };
  }

  /**
   * Профиль для выбранного в каталоге человека. Данные берутся из каталога по DN, а не из запроса; повторный выбор
   * того же человека возвращает уже созданный профиль (дублей нет). Допуск по настройке «кто может входить» проверяется.
   */
  /** Профиль для человека из каталога; actor — кто создаёт (запись в журнале). Возвращает карточку и признак «создан». */
  async function provision(actor: { id: string }, body: { profileId: string; dn: string }) {
    const user = actor;
    const [s] = await enabledProfiles(body.profileId);
    if (!s) throw new AppError(409, 'ldap_disabled', 'Directory sign-in is turned off');
    let found;
    try {
      found = await ldapReadUser(s, ldapBindSecret(s, config.APP_SECRET), body.dn);
    } catch (e) {
      const c = classifyLdapError(e, 'search');
      if (c.code === 'config')
        throw new AppError(400, 'dn_outside_base', 'DN is outside the Base DN');
      throw new AppError(503, 'ldap_unavailable', 'Directory is unavailable', {
        reason: c.reason,
        detail: c.detail,
      });
    }
    if (!found)
      throw new AppError(404, 'directory_person_not_found', 'Person not found in the directory');
    if (found.disabled)
      throw new AppError(409, 'directory_account_disabled', 'The directory account is disabled');
    if (!found.email)
      throw new AppError(409, 'directory_no_email', 'The directory entry has no e-mail address');
    if (!accessAllowed(s, found.groups))
      throw new AppError(
        409,
        'directory_not_allowed',
        'The sign-in rule of this directory does not allow this person',
      );

    const result = await db.transaction(async (tx) => {
      // один человек — один профиль, даже если два администратора выберут его одновременно
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('arklock.ldap.provision'))`);
      const current = (await readLdapProfiles(tx)).find((p) => p.id === s.id);
      if (!current?.enabled || JSON.stringify(current) !== JSON.stringify(s))
        throw new AppError(409, 'ldap_changed', 'The directory configuration changed; try again');
      const have = await linkedLdapUser(tx, s.id, found);
      if (have) {
        if (have.disabledAt)
          throw new AppError(
            409,
            'account_disabled_in_arklock',
            'This employee is blocked in Arklock',
          );
        await adoptGuidIdentity(tx, have, s.id, found);
        return { user: have, created: false };
      }
      const [clash] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, found.email));
      if (clash)
        throw new AppError(
          409,
          'account_exists_local',
          'An account with this e-mail already exists',
          { userId: clash.id },
        );
      const id = randomUUID();
      // у профиля нет ни ключей, ни известного пароля: случайные значения не принимают никакого доказательства
      const authSalt = randomB64url(16);
      const recoverySalt = randomB64url(16);
      const [row] = await tx
        .insert(users)
        .values({
          id,
          email: found.email,
          displayName: found.name.trim() || found.email,
          role: 'member',
          seenRelease: ctx.config.APP_VERSION,
          authSource: 'ldap',
          externalId: directoryExternalId(s.id, found),
          pendingActivation: true,
          kdf: DEFAULT_KDF,
          kdfSalt: randomB64url(16),
          authSalt,
          authHash: hashProof(authSalt, randomB64url(32)),
          publicKey: '',
          signPublicKey: '',
          wrappedPrivateKey: '',
          wrappedSignPrivateKey: '',
          recoverySalt,
          recoveryHash: hashProof(recoverySalt, randomB64url(32)),
          recoveryWrappedPrivateKey: '',
          recoveryWrappedSignPrivateKey: '',
        })
        .returning();
      await syncProfileFor(tx, id, found, s);
      await syncCirclesFor(tx, id, s, found.groups);
      await audit(tx, `user:${user.id}`, 'admin.directory.provision', `user:${id}`, {
        profile: s.id,
      });
      return { user: row!, created: true };
    });
    const [fresh] = await db.select().from(users).where(eq(users.id, result.user.id));
    const u = fresh ?? result.user;
    return {
      id: u.id,
      name: u.displayName,
      email: u.email,
      title: u.title,
      department: u.department,
      authSource: u.authSource,
      pending: u.pendingActivation,
      created: result.created,
    };
  }

  const searchQuery = z.object({
    q: z.string().trim().max(100).default(''),
    limit: z.coerce.number().int().min(1).max(25).default(12),
    profileId: z.string().max(60).optional(),
  });
  const provisionBody = z.object({
    profileId: z.string().min(1).max(60),
    dn: z.string().min(3).max(1000),
  });

  // ---- администратор: без ограничений
  app.get('/admin/people/directory', async (req) => {
    return search(parse(searchQuery, req.query));
  });
  app.post('/admin/people/directory/provision', async (req, reply) => {
    const { user } = authOf(req);
    const r = await provision(user, parse(provisionBody, req.body));
    reply.status(r.created ? 201 : 200);
    return r;
  });

  // ---- любой сотрудник: чтобы поделиться папкой или записью с человеком из домена. Условия: политика не «никто»,
  // профили при первом входе разрешено создавать, поиск от трёх букв, число созданных профилей ограничено
  const sharingActions = new Map<string, number[]>();
  const sharingAllowed = async (user: { role: string }) =>
    user.role === 'admin' || (await outsideSharing(db)) !== 'off';
  app.get('/directory/people', async (req) => {
    const { user } = authOf(req);
    if (!(await sharingAllowed(user))) return { configured: false, items: [], problems: [] };
    const o = parse(searchQuery, req.query);
    const r = await search({ ...o, limit: Math.min(o.limit, 8) }, 3);
    // от пользователя скрыты технические подробности каталога
    return {
      configured: r.configured,
      items: r.items,
      problems: r.problems.map((p) => ({ ...p, detail: '' })),
    };
  });
  app.post('/directory/people/provision', async (req, reply) => {
    const { user } = authOf(req);
    if (!(await sharingAllowed(user)))
      throw new AppError(403, 'outside_sharing_off', 'Sharing with people outside is turned off');
    const body = parse(provisionBody, req.body);
    const [p] = await enabledProfiles(body.profileId);
    if (user.role !== 'admin' && !p?.autoProvision)
      throw new AppError(
        403,
        'provision_admin_only',
        'An administrator creates the profiles of directory employees',
      );
    const now = Date.now();
    const recent = (sharingActions.get(user.id) ?? []).filter((t) => now - t < 3_600_000);
    if (user.role !== 'admin' && recent.length >= 20)
      throw new AppError(429, 'too_many_attempts', 'Too many new profiles, try again later');
    sharingActions.set(user.id, [...recent, now]);
    const r = await provision(user, body);
    reply.status(r.created ? 201 : 200);
    return r;
  });
};
