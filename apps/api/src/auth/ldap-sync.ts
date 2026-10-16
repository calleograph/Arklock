import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/connect.js';
import { circleMembers, circles, sessions, settings, users } from '../db/schema.js';
import { audit } from '../audit.js';
import { circlesFor, ldapLookup, type LdapConfig } from './ldap.js';
import {
  ldapBindSecret,
  ldapExternalId,
  ldapIdentityProfile,
  readLdapProfiles,
  type LdapProfile,
} from './ldap-profiles.js';

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
            .set({ disabledAt: user.disabledAt ?? new Date() })
            .where(eq(users.id, user.id));
          await tx
            .update(sessions)
            .set({ revokedAt: new Date() })
            .where(eq(sessions.userId, user.id));
          if (!user.disabledAt) disabled++;
        } else {
          await syncCirclesFor(tx, user.id, current, found.groups);
          updated++;
        }
      });
    } catch (e) {
      errors.push(`${user.email}: ${(e as Error).message}`.slice(0, 200));
    }
  }
  const result = { total: linked.length, disabled, updated, errors, at: new Date().toISOString() };
  const key = `ldap.sync.${profile.id}`;
  await db
    .insert(settings)
    .values({ key, value: result })
    .onConflictDoUpdate({ target: settings.key, set: { value: result, updatedAt: new Date() } });
  await audit(db, actor, 'admin.ldap.sync', `ldap:${profile.id}`, {
    disabled,
    updated,
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
