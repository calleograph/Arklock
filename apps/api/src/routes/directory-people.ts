import { randomUUID } from 'node:crypto';
import { inArray, and, eq, sql } from 'drizzle-orm';
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
  app.addHook('preHandler', (req) => adminGate(ctx, req));

  const enabledProfiles = async (only?: string): Promise<LdapProfile[]> =>
    (await readLdapProfiles(db)).filter((p) => p.enabled && (!only || p.id === only));

  const stateOf = (u: {
    disabledAt: Date | null;
    pendingActivation: boolean;
  }): Existing['state'] => (u.disabledAt ? 'disabled' : u.pendingActivation ? 'pending' : 'active');

  /** Поиск в каталоге: по имени, логину и почте; в ответе видно, кто уже есть в Arklock. */
  app.get('/admin/people/directory', async (req) => {
    const o = parse(
      z.object({
        q: z.string().trim().max(100).default(''),
        limit: z.coerce.number().int().min(1).max(25).default(12),
        profileId: z.string().max(60).optional(),
      }),
      req.query,
    );
    const profiles = await enabledProfiles(o.profileId);
    // короткий запрос выбрал бы весь каталог; подсказка в поле просит ввести хотя бы две буквы
    if (o.q.length < 2) return { configured: profiles.length > 0, items: [], problems: [] };
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
    for (const p of profiles) {
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
        for (const e of found) {
          const u = linked.find((l) => l.externalId && e.ids.includes(l.externalId));
          items.push({
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
          });
        }
      } catch (e) {
        const c: LdapError = classifyLdapError(e, 'search');
        problems.push({ profileId: p.id, profileName: p.name, reason: c.reason, detail: c.detail });
      }
    }
    return { configured: profiles.length > 0, items, problems };
  });

  /**
   * Профиль для выбранного в каталоге человека. Данные берутся из каталога по DN, а не из запроса; повторный выбор
   * того же человека возвращает уже созданный профиль (дублей нет). Допуск по настройке «кто может входить» проверяется.
   */
  app.post('/admin/people/directory/provision', async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(
      z.object({ profileId: z.string().min(1).max(60), dn: z.string().min(3).max(1000) }),
      req.body,
    );
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
    reply.status(result.created ? 201 : 200);
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
  });
};
