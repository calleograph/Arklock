import { eq } from 'drizzle-orm';
import type { Db } from './db/connect.js';
import { vaults } from './db/schema.js';
import { AppError, notFound } from './errors.js';

/** Every ciphertext writer and rotation locks the same vault before checking its key version. */
export async function lockVaultForWrite(tx: Db, vaultId: string, keyVersion?: number) {
  const [vault] = await tx
    .select({ keyVersion: vaults.keyVersion })
    .from(vaults)
    .where(eq(vaults.id, vaultId))
    .for('update');
  if (!vault) throw notFound();
  if (keyVersion !== undefined && vault.keyVersion !== keyVersion)
    throw new AppError(409, 'stale_key_version', 'Vault key was rotated, re-fetch the key', {
      keyVersion: vault.keyVersion,
    });
  return vault.keyVersion;
}
