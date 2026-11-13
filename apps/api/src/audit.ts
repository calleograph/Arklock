import type { Db } from './db/connect.js';
import { ledger } from './db/schema.js';
import { fireAutomation, triggersOf } from './automation.js';
import { notifyAudit } from './notifications.js';

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
  // введённое при входе имя остаётся только в журнале: во внешние системы (syslog, вебхуки, правила) оно не уходит
  const outward = detail
    ? Object.fromEntries(Object.entries(detail).filter(([k]) => k !== 'login'))
    : null;
  const ev = {
    at: row?.at ?? new Date(),
    actor,
    action,
    target: target ?? null,
    detail: outward,
  };
  sinks.get(db)?.(ev);
  await notifyAudit(db, ev);
  // правила автоматизации — в своей точке сохранения: их сбой не отменяет действие, вызвавшее событие
  if (triggersOf(action).length)
    await db.transaction((tx) => fireAutomation(tx as unknown as Db, ev)).catch(() => undefined);
}
