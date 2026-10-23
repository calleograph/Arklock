import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/connect.js';
import { circleMembers, circles, sessions, settings, users } from '../db/schema.js';
import { audit } from '../audit.js';
import { corporateAccessRisks } from '../corporate-continuity.js';
import { notifyUsers } from '../notifications.js';
import {
  circlesFor,
  ldapBrowse,
  ldapLookup,
  profileAttrs,
  type DirectoryUser,
  type LdapConfig,
} from './ldap.js';
import {
  ldapBindSecret,
  ldapExternalId,
  ldapIdentityProfile,
  readLdapProfiles,
  type LdapProfile,
} from './ldap-profiles.js';

/**
 * Справочные поля карточки (ФИО, должность, подразделение, телефон) из каталога. Пустое значение в каталоге
 * не стирает поле; пришедшее из каталога поле помечается и в панели не меняется. Доступ по этим полям не выдаётся.
 */
export async function syncProfileFor(
  db: Db,
  userId: string,
  found: Pick<DirectoryUser, 'name' | 'profile'>,
  cfg: LdapConfig,
): Promise<void> {
  const [u] = await db
    .select({ source: users.profileSource })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) return;
  const values = { displayName: found.name.trim(), ...found.profile };
  const set: Partial<typeof users.$inferInsert> = {};
  const source = { ...u.source };
  for (const [k, v] of Object.entries(values) as [keyof typeof values, string][])
    if (v) {
      set[k] = v;
      source[k] = 'ldap';
    }
  // атрибут больше не берётся из каталога — поле снова можно менять в панели
  let unlocked = false;
  for (const [k, attr] of Object.entries(profileAttrs(cfg)))
    if (!attr && source[k]) {
      delete source[k];
      unlocked = true;
    }
  if (Object.keys(set).length || unlocked)
    await db
      .update(users)
      .set({ ...set, profileSource: source })
      .where(eq(users.id, userId));
}

export async function syncCirclesFor(
  db: Db,
  userId: string,
  cfg: LdapConfig,
  groups: string[],
): Promise<void> {
  const { want, managed } = circlesFor(cfg, groups);
  if (!managed.length) return;
  const existing = await db
    .select({ id: circles.id })
    .from(circles)
    .where(inArray(circles.id, managed));
  const valid = new Set(existing.map((c) => c.id));
  await db.transaction(async (tx) => {
    for (const cid of managed) {
      if (!valid.has(cid)) continue;
      if (want.includes(cid))
        await tx.insert(circleMembers).values({ circleId: cid, userId }).onConflictDoNothing();
      else
        await tx
          .delete(circleMembers)
          .where(and(eq(circleMembers.circleId, cid), eq(circleMembers.userId, userId)));
    }
  });
}

export async function revokeLdapProfileSessions(db: Db, profileId: string): Promise<void> {
  const linked = (
    await db
      .select({ id: users.id, externalId: users.externalId })
      .from(users)
      .where(eq(users.authSource, 'ldap'))
  ).filter((u) => ldapIdentityProfile(u.externalId) === profileId);
  if (linked.length)
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        inArray(
          sessions.userId,
          linked.map((u) => u.id),
        ),
      );
}

/**
 * Предпросмотр сверки: те же правила, что у `syncLdapProfile`, без записи. Кого отключат, у кого изменятся
 * группы и поля карточки, кто есть в каталоге, но ещё не входил (учётная запись появится при первом входе:
 * мастер-пароль и ключи создаёт сам человек), и пример данных из каталога.
 */
export async function previewLdapProfile(db: Db, appSecret: string, profile: LdapProfile) {
  const linked = (await db.select().from(users).where(eq(users.authSource, 'ldap'))).filter(
    (u) => ldapIdentityProfile(u.externalId) === profile.id,
  );
  const secret = ldapBindSecret(profile, appSecret);
  const managed = [...new Set(profile.groups.map((g) => g.circleId))];
  const [circleRows, memberRows] = await Promise.all([
    managed.length
      ? db
          .select({ id: circles.id, name: circles.name })
          .from(circles)
          .where(inArray(circles.id, managed))
      : [],
    managed.length && linked.length
      ? db.select().from(circleMembers).where(inArray(circleMembers.circleId, managed))
      : [],
  ]);
  const circleName = new Map(circleRows.map((c) => [c.id, c.name]));
  const disable: { email: string; name: string; reason: 'missing' | 'disabled' | 'moved' }[] = [];
  const update: {
    email: string;
    name: string;
    join: string[];
    leave: string[];
    fields: string[];
  }[] = [];
  const errors: string[] = [];
  let unchanged = 0;
  let sample: Pick<DirectoryUser, 'email' | 'name' | 'profile' | 'groups'> | null = null;
  for (const user of linked) {
    try {
      const found = await ldapLookup(profile, secret, user.email);
      const reason = !found
        ? 'missing'
        : found.disabled
          ? 'disabled'
          : ldapExternalId(profile.id, found.dn) !== user.externalId
            ? 'moved'
            : null;
      if (reason || !found) {
        if (!user.disabledAt)
          disable.push({ email: user.email, name: user.displayName, reason: reason ?? 'missing' });
        continue;
      }
      sample ??= {
        email: found.email,
        name: found.name,
        profile: found.profile,
        groups: found.groups,
      };
      const { want } = circlesFor(profile, found.groups);
      const mine = new Set(memberRows.filter((m) => m.userId === user.id).map((m) => m.circleId));
      const join = want
        .filter((c) => circleName.has(c) && !mine.has(c))
        .map((c) => circleName.get(c)!);
      const leave = managed
        .filter((c) => circleName.has(c) && mine.has(c) && !want.includes(c))
        .map((c) => circleName.get(c)!);
      const values = { displayName: found.name.trim(), ...found.profile };
      const fields = (Object.entries(values) as [keyof typeof values, string][])
        .filter(([k, v]) => v && v !== (user[k] ?? ''))
        .map(([k]) => k);
      if (join.length || leave.length || fields.length)
        update.push({ email: user.email, name: user.displayName, join, leave, fields });
      else unchanged++;
    } catch (e) {
      errors.push(`${user.email}: ${(e as Error).message}`.slice(0, 200));
    }
  }
  // кто есть в каталоге, но ещё не входил: учётную запись создаст первый вход
  const known = new Set(linked.map((u) => u.email.toLowerCase()));
  let notYet = { count: 0, sample: [] as { email: string; name: string }[], truncated: false };
  try {
    const dir = await ldapBrowse(profile, secret, { kind: 'users', limit: 500 });
    const fresh = dir.entries.filter(
      (e) => e.email && !e.disabled && !known.has(e.email.toLowerCase()),
    );
    notYet = {
      count: fresh.length,
      sample: fresh.slice(0, 10).map((e) => ({ email: e.email, name: e.name })),
      truncated: dir.truncated,
    };
  } catch (e) {
    errors.push(`browse: ${(e as Error).message}`.slice(0, 200));
  }
  return { linked: linked.length, disable, update, unchanged, notYet, sample, errors };
}

export async function syncLdapProfile(
  db: Db,
  appSecret: string,
  profile: LdapProfile,
  actor: string,
) {
  const linked = (await db.select().from(users).where(eq(users.authSource, 'ldap'))).filter(
    (u) => ldapIdentityProfile(u.externalId) === profile.id,
  );
  const secret = ldapBindSecret(profile, appSecret);
  let disabled = 0;
  const newlyDisabled: string[] = [];
  let updated = 0;
  const errors: string[] = [];
  for (const user of linked) {
    try {
      const found = await ldapLookup(profile, secret, user.email);
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('arklock.ldap.profiles'))`);
        const current = (await readLdapProfiles(tx)).find((p) => p.id === profile.id);
        if (!current?.enabled || JSON.stringify(current) !== JSON.stringify(profile))
          throw new Error('Directory configuration changed during sync; run it again');
        if (!found || found.disabled || ldapExternalId(profile.id, found.dn) !== user.externalId) {
          await tx
            .update(users)
            // уже отключённого не переписываем: прежние время и причина остаются
            .set(
              user.disabledAt
                ? { disabledAt: user.disabledAt }
                : { disabledAt: new Date(), disabledReason: 'directory' as const },
            )
            .where(eq(users.id, user.id));
          await tx
            .update(sessions)
            .set({ revokedAt: new Date() })
            .where(eq(sessions.userId, user.id));
          if (!user.disabledAt) {
            disabled++;
            newlyDisabled.push(user.id);
          }
        } else {
          await syncCirclesFor(tx, user.id, current, found.groups);
          await syncProfileFor(tx, user.id, found, current);
          updated++;
        }
      });
    } catch (e) {
      errors.push(`${user.email}: ${(e as Error).message}`.slice(0, 200));
    }
  }
  // отключение в каталоге не должно тихо лишать организацию единственного хранителя ключа сейфа
  let custodyRisks = 0;
  for (const id of newlyDisabled) custodyRisks += (await corporateAccessRisks(db, id)).length;
  if (custodyRisks) {
    const admins = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)));
    await notifyUsers(
      db,
      admins.map((a) => a.id),
      {
        category: 'security',
        event: 'ldap.custody-at-risk',
        resourceType: 'ldap',
        resourceId: profile.id,
      },
    );
  }
  const result = {
    total: linked.length,
    disabled,
    updated,
    errors,
    custodyRisks,
    at: new Date().toISOString(),
  };
  const key = `ldap.sync.${profile.id}`;
  await db
    .insert(settings)
    .values({ key, value: result })
    .onConflictDoUpdate({ target: settings.key, set: { value: result, updatedAt: new Date() } });
  await audit(db, actor, 'admin.ldap.sync', `ldap:${profile.id}`, {
    disabled,
    updated,
    custodyRisks,
    errors: errors.length,
  });
  return result;
}

export async function syncScheduledLdap(db: Db, appSecret: string): Promise<void> {
  for (const profile of await readLdapProfiles(db)) {
    if (!profile.enabled || !profile.syncEnabled) continue;
    try {
      await syncLdapProfile(db, appSecret, profile, 'system:maintenance');
    } catch {
      await audit(db, 'system:maintenance', 'admin.ldap.sync.failed', `ldap:${profile.id}`);
    }
  }
}
