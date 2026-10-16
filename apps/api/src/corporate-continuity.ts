import { and, eq, isNull } from 'drizzle-orm';
import { loadAccess } from './access.js';
import type { Db } from './db/connect.js';
import { corporateRecoveryKeys, users, vaultKeys, vaults } from './db/schema.js';
import { corporateRecoveryRecipientOf } from './corporate-recovery.js';

/** Only active key holders who can issue keys count as custodians; a server role alone cannot recover data. */
export async function corporateContinuity(db: Db) {
  const shared = await db.select().from(vaults).where(eq(vaults.kind, 'shared'));
  const recipient = await corporateRecoveryRecipientOf(db);
  const recoveryKeys = recipient
    ? await db
        .select({
          vaultId: corporateRecoveryKeys.vaultId,
          keyVersion: corporateRecoveryKeys.keyVersion,
        })
        .from(corporateRecoveryKeys)
        .where(eq(corporateRecoveryKeys.recipientId, recipient.id))
    : [];
  const holders = await db
    .select({
      vaultId: vaultKeys.vaultId,
      keyVersion: vaultKeys.keyVersion,
      userId: users.id,
      name: users.displayName,
    })
    .from(vaultKeys)
    .innerJoin(users, and(eq(users.id, vaultKeys.userId), isNull(users.disabledAt)));
  const result: {
    id: string;
    name: string;
    custodians: { userId: string; name: string }[];
    recovery: string;
  }[] = [];
  for (const vault of shared) {
    const custodians: { userId: string; name: string }[] = [];
    for (const holder of holders) {
      if (holder.vaultId !== vault.id || holder.keyVersion !== vault.keyVersion) continue;
      const access = await loadAccess(db, vault.id, holder.userId);
      if (access.isAdmin && access.can('entry.read'))
        custodians.push({ userId: holder.userId, name: holder.name });
    }
    result.push({
      id: vault.id,
      name: vault.name ?? '',
      custodians,
      recovery: !recipient
        ? 'unconfigured'
        : !recipient.enabled
          ? 'disabled'
          : recoveryKeys.some(
                (key) => key.vaultId === vault.id && key.keyVersion === vault.keyVersion,
              )
            ? 'ready'
            : 'missing',
    });
  }
  return result;
}

export async function corporateAccessRisks(db: Db, userId: string) {
  return (await corporateContinuity(db))
    .filter((v) => v.custodians.length === 1 && v.custodians[0]!.userId === userId)
    .map((v) => ({ id: v.id, name: v.name }));
}
