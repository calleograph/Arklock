import type { Db } from './db/connect.js';
import { ledger } from './db/schema.js';

/** Запись в Ledger. В detail допускаются только несекретные метаданные (идентификаторы, коды причин). */
export async function audit(
  db: Db,
  actor: string,
  action: string,
  target?: string | null,
  detail?: Record<string, string | number | boolean | null>,
): Promise<void> {
  await db.insert(ledger).values({ actor, action, target: target ?? null, detail: detail ?? null });
}
