import { and, eq, isNull } from 'drizzle-orm';
import { loadAccess } from './access.js';
import { audit } from './audit.js';
import type { Db } from './db/connect.js';
import { circleMembers, entries, grants, signals, vaultCircles } from './db/schema.js';

// shortcut: не больше ROTATE_MAX событий на сейф; для сейфов крупнее остаётся ротация ключа сейфа
export const ROTATE_MAX = 2000;

/** Живые записи сейфа, которые сотрудник видит сейчас (с учётом групп, правил и запретов). */
export async function visibleEntries(
  db: Db,
  vaultId: string,
  userId: string,
): Promise<Set<string>> {
  const acc = await loadAccess(db, vaultId, userId);
  const rows = await db
    .select({ id: entries.id, branchId: entries.branchId })
    .from(entries)
    .where(and(eq(entries.vaultId, vaultId), isNull(entries.deletedAt)));
  return new Set(rows.filter((r) => acc.entry(r.id, r.branchId)).map((r) => r.id));
}

/**
 * «Требуется смена пароля» по записям, которые сотрудник мог видеть и больше не видит:
 * при увольнении или отзыве доступа. Повторное событие открывает прежнее снова с новой причиной.
 */
export async function openRotateSignals(
  db: Db,
  o: {
    vaultId: string;
    entryIds: Iterable<string>;
    cause: string;
    reason: 'offboarding' | 'revoked';
    reportedBy: string;
  },
): Promise<string[]> {
  const out: string[] = [];
  for (const entryId of [...o.entryIds].slice(0, ROTATE_MAX)) {
    const [sig] = await db
      .insert(signals)
      .values({
        id: crypto.randomUUID(),
        vaultId: o.vaultId,
        entryId,
        type: 'rotate',
        reportedBy: o.reportedBy,
        causeUserId: o.cause,
        causeReason: o.reason,
      })
      .onConflictDoUpdate({
        target: [signals.entryId, signals.type],
        set: {
          status: 'open',
          assignedTo: null,
          causeUserId: o.cause,
          causeReason: o.reason,
          updatedAt: new Date(),
        },
      })
      .returning({ id: signals.id });
    out.push(sig!.id);
  }
  return out;
}

export interface OpenedRotation {
  id: string;
  vaultId: string;
  userId: string;
}

/**
 * Изменение доступа с «смените пароль» по потерянному: для каждой пары «сейф — сотрудник» видимые записи
 * считаются до и после изменения, события открываются по разнице. Доступ, оставшийся иным путём
 * (группа, правило), потерей не считается.
 */
export async function rotateLostAccess<T>(
  db: Db,
  pairs: { vaultId: string; userId: string }[],
  change: () => Promise<T>,
  reportedBy: string,
): Promise<{ result: T; opened: OpenedRotation[] }> {
  const key = (p: { vaultId: string; userId: string }) => `${p.vaultId}|${p.userId}`;
  const unique = [...new Map(pairs.map((p) => [key(p), p])).values()];
  const before = new Map<string, Set<string>>();
  for (const p of unique) before.set(key(p), await visibleEntries(db, p.vaultId, p.userId));
  const result = await change();
  const opened: OpenedRotation[] = [];
  for (const p of unique) {
    const after = await visibleEntries(db, p.vaultId, p.userId);
    const lost = [...before.get(key(p))!].filter((e) => !after.has(e));
    if (!lost.length) continue;
    const ids = await openRotateSignals(db, {
      vaultId: p.vaultId,
      entryIds: lost,
      cause: p.userId,
      reason: 'revoked',
      reportedBy,
    });
    opened.push(...ids.map((id) => ({ id, vaultId: p.vaultId, userId: p.userId })));
  }
  return { result, opened };
}

/** Запись в журнал о каждом открытом событии (оттуда — история события и уведомления). */
export async function auditRotations(
  db: Db,
  actor: string,
  opened: OpenedRotation[],
): Promise<void> {
  for (const o of opened)
    await audit(db, actor, 'signal.create', `signal:${o.id}`, {
      vault: o.vaultId,
      reason: 'revoked',
      user: o.userId,
    });
}

/** Кого касается правило: сам сотрудник или участники группы. */
export async function subjectUsers(
  db: Db,
  subjectType: 'user' | 'circle',
  subjectId: string,
): Promise<string[]> {
  if (subjectType === 'user') return [subjectId];
  const rows = await db
    .select({ id: circleMembers.userId })
    .from(circleMembers)
    .where(eq(circleMembers.circleId, subjectId));
  return rows.map((r) => r.id);
}

/** Сейфы, где у группы есть участие или правила на папки и записи. */
export async function circleVaults(db: Db, circleId: string): Promise<string[]> {
  const [member, ruled] = await Promise.all([
    db
      .select({ id: vaultCircles.vaultId })
      .from(vaultCircles)
      .where(eq(vaultCircles.circleId, circleId)),
    db
      .select({ id: grants.vaultId })
      .from(grants)
      .where(and(eq(grants.subjectType, 'circle'), eq(grants.subjectId, circleId))),
  ]);
  return [...new Set([...member, ...ruled].map((r) => r.id))];
}
