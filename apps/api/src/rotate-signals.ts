import { and, eq, gt, inArray, isNull, lt, lte } from 'drizzle-orm';
import { loadAccess } from './access.js';
import { audit } from './audit.js';
import type { Db } from './db/connect.js';
import {
  circleMembers,
  entries,
  grants,
  settings,
  signals,
  vaultCircles,
  vaultMembers,
} from './db/schema.js';

// shortcut: не больше ROTATE_MAX событий на сейф; для сейфов крупнее остаётся ротация ключа сейфа
export const ROTATE_MAX = 2000;

/** Живые записи сейфа, которые сотрудник видит сейчас (с учётом групп, правил и запретов). */
export async function visibleEntries(
  db: Db,
  vaultId: string,
  userId: string,
  at?: Date,
): Promise<Set<string>> {
  const acc = await loadAccess(db, vaultId, userId, at);
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

const SWEPT_KEY = 'access.expirySweptAt';

/**
 * Истёкшие с прошлой проверки правила, участие группы и прямое участие: доступ по ним пропал сам,
 * без действия, поэтому «смените пароль» открывает плановое обслуживание — по записям, видимым за миг
 * до истечения и не видимым сейчас. Строки не удаляются: администратор видит истёкшее и может продлить.
 * При первой проверке учитываются истечения за последние 7 дней. Возвращает число открытых событий.
 */
export async function rotateExpiredAccess(db: Db, now = new Date()): Promise<number> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SWEPT_KEY));
  const since =
    typeof row?.value === 'string' ? new Date(row.value) : new Date(now.getTime() - 7 * 86_400_000);
  const [rules, groups, direct] = await Promise.all([
    db
      .select()
      .from(grants)
      .where(and(gt(grants.expiresAt, since), lte(grants.expiresAt, now))),
    db
      .select()
      .from(vaultCircles)
      .where(and(gt(vaultCircles.expiresAt, since), lte(vaultCircles.expiresAt, now))),
    db
      .select()
      .from(vaultMembers)
      .where(and(gt(vaultMembers.expiresAt, since), lte(vaultMembers.expiresAt, now))),
  ]);
  const lapses: { vaultId: string; userId: string; at: Date }[] = direct.map((m) => ({
    vaultId: m.vaultId,
    userId: m.userId,
    at: m.expiresAt!,
  }));
  for (const g of groups)
    for (const userId of await subjectUsers(db, 'circle', g.circleId))
      lapses.push({ vaultId: g.vaultId, userId, at: g.expiresAt! });
  for (const r of rules)
    for (const userId of await subjectUsers(db, r.subjectType, r.subjectId))
      lapses.push({ vaultId: r.vaultId, userId, at: r.expiresAt! });
  let opened = 0;
  for (const l of lapses) {
    const before = await visibleEntries(db, l.vaultId, l.userId, new Date(l.at.getTime() - 1));
    const after = await visibleEntries(db, l.vaultId, l.userId, now);
    const gone = [...before].filter((e) => !after.has(e));
    // записи, созданные после истечения, сотрудник по этому доступу не видел
    // shortcut: у участия в группе нет времени вступления — вступивший после истечения тоже попадёт; при жалобах — хранить время вступления
    const seen = gone.length
      ? (
          await db
            .select({ id: entries.id })
            .from(entries)
            .where(and(inArray(entries.id, gone), lt(entries.createdAt, l.at)))
        ).map((r) => r.id)
      : [];
    const ids = await openRotateSignals(db, {
      vaultId: l.vaultId,
      entryIds: seen,
      cause: l.userId,
      reason: 'revoked',
      // у события нет автора-человека: «сообщил» сам сотрудник, потерявший доступ (столбец обязателен)
      reportedBy: l.userId,
    });
    await auditRotations(
      db,
      'system',
      ids.map((id) => ({ id, vaultId: l.vaultId, userId: l.userId })),
    );
    opened += ids.length;
  }
  await db
    .insert(settings)
    .values({ key: SWEPT_KEY, value: now.toISOString() })
    .onConflictDoUpdate({ target: settings.key, set: { value: now.toISOString() } });
  return opened;
}
