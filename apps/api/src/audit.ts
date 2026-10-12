import type { Db } from './db/connect.js';
import { ledger } from './db/schema.js';

export interface AuditSinkEvent {
  at: Date;
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
}

/** Получатели копий событий (например, syslog) по экземпляру базы: несколько приложений в одном процессе не мешают друг другу. */
const sinks = new WeakMap<Db, (ev: AuditSinkEvent) => void>();
export const setAuditSink = (db: Db, fn: (ev: AuditSinkEvent) => void): void =>
  void sinks.set(db, fn);

/** Запись в Ledger. В detail допускаются только несекретные метаданные (идентификаторы, коды причин). */
export async function audit(
  db: Db,
  actor: string,
  action: string,
  target?: string | null,
  detail?: Record<string, string | number | boolean | null>,
): Promise<void> {
  const [row] = await db
    .insert(ledger)
    .values({ actor, action, target: target ?? null, detail: detail ?? null })
    .returning({ at: ledger.at });
  sinks.get(db)?.({
    at: row?.at ?? new Date(),
    actor,
    action,
    target: target ?? null,
    detail: detail ?? null,
  });
}
