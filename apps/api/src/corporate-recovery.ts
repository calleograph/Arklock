import { eq } from 'drizzle-orm';
import { corporateRecoveryRecipient, type CorporateRecoveryRecipient } from '@arklock/contracts';
import type { Db } from './db/connect.js';
import { settings } from './db/schema.js';

export const CORPORATE_RECOVERY_KEY = 'recovery.corporateRecipient';

export async function corporateRecoveryRecipientOf(
  db: Db,
): Promise<CorporateRecoveryRecipient | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, CORPORATE_RECOVERY_KEY));
  const parsed = corporateRecoveryRecipient.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}
