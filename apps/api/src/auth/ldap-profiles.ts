import { eq } from 'drizzle-orm';
import type { Db } from '../db/connect.js';
import { settings } from '../db/schema.js';
import { openSetting } from '../secretbox.js';
import type { LdapConfig } from './ldap.js';

export const LDAP_PROFILES_KEY = 'ldap.profiles';
export const LDAP_SETTING_KEY = 'ldap.config';
export interface LdapProfile extends LdapConfig {
  id: string;
  name: string;
  syncEnabled?: boolean;
  bindPasswordCipher: string;
}

/** The legacy connection keeps its identity and secret encryption purpose. */
export async function readLdapProfiles(db: Db): Promise<LdapProfile[]> {
  const [row] = await db.select().from(settings).where(eq(settings.key, LDAP_PROFILES_KEY));
  if (row) return row.value as LdapProfile[];
  const [legacy] = await db.select().from(settings).where(eq(settings.key, LDAP_SETTING_KEY));
  return legacy ? [{ ...(legacy.value as LdapProfile), id: 'default', name: 'LDAP' }] : [];
}

export const ldapSecretPurpose = (id: string) =>
  id === 'default' ? 'ldap-bind-password' : `ldap-bind-password:${id}`;
export const ldapBindSecret = (profile: LdapProfile, appSecret: string) =>
  profile.bindPasswordCipher
    ? openSetting(appSecret, ldapSecretPurpose(profile.id), profile.bindPasswordCipher)
    : '';

export const ldapExternalId = (profileId: string, dn: string): string =>
  profileId === 'default' ? dn : JSON.stringify([profileId, dn]);

export function ldapIdentityProfile(externalId: string | null): string {
  if (externalId?.startsWith('[')) {
    try {
      const parts: unknown = JSON.parse(externalId);
      if (
        Array.isArray(parts) &&
        parts.length === 2 &&
        typeof parts[0] === 'string' &&
        typeof parts[1] === 'string'
      )
        return parts[0];
    } catch {
      /* Legacy DN identities are never JSON. */
    }
  }
  return 'default';
}

export async function writeLdapProfiles(
  db: Db,
  profiles: LdapProfile[],
  actor: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const save = async (key: string, value: unknown) =>
      tx
        .insert(settings)
        .values({ key, value, updatedBy: actor })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: new Date(), updatedBy: actor },
        });
    await save(LDAP_PROFILES_KEY, profiles);
    const legacy = profiles.find((p) => p.id === 'default');
    if (legacy) await save(LDAP_SETTING_KEY, legacy);
    else await tx.delete(settings).where(eq(settings.key, LDAP_SETTING_KEY));
  });
}
