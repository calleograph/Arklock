import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AUTOMATION_TRIGGERS, type AutomationTrigger } from '@arklock/contracts';
import type { AuditSinkEvent } from './audit.js';
import type { Db } from './db/connect.js';
import { automationRules, circleMembers, ledger, users } from './db/schema.js';
import { AppError } from './errors.js';
import { notifyUsers } from './notifications.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const triggersOf = (action: string) =>
  Object.entries(AUTOMATION_TRIGGERS)
    .filter(([, codes]) => (codes as readonly string[]).includes(action))
    .map(([k]) => k);

// одно правило по одному сотруднику и объекту — не чаще раза в 5 минут: иначе «открытие карточки» засыпало бы уведомлениями
// shortcut: память процесса; при нескольких экземплярах сервера уведомлений может быть больше — тогда нужна общая таблица
const QUIET_MS = 5 * 60_000;
const recent = new Map<string, number>();

type Rule = typeof automationRules.$inferSelect;

/** Группы автора — только если какое-то правило проверяет группу. */
async function circlesOf(db: Db, actorId: string | null, rules: Rule[]): Promise<Set<string>> {
  if (!actorId || !rules.some((r) => r.actorCircleId)) return new Set();
  const rows = await db
    .select({ c: circleMembers.circleId })
    .from(circleMembers)
    .where(eq(circleMembers.userId, actorId));
  return new Set(rows.map((r) => r.c));
}
const matches = (r: Rule, vaultId: string | null, circles: Set<string>) =>
  (!r.vaultId || r.vaultId === vaultId) && (!r.actorCircleId || circles.has(r.actorCircleId));

async function notifyRule(
  db: Db,
  r: Rule,
  event: 'automation.rule' | 'automation.denied',
  ev: { action: string; vaultId: string | null; target: string | null },
): Promise<void> {
  const circleIds = (r.notifyCircles ?? []).filter((c) => UUID.test(c));
  const [members, admins] = await Promise.all([
    circleIds.length
      ? db
          .select({ id: circleMembers.userId })
          .from(circleMembers)
          .where(inArray(circleMembers.circleId, circleIds))
      : [],
    r.notifyAdmins
      ? db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
      : [],
  ]);
  const [resourceType = 'system', rawId] = (ev.target ?? '').split(':');
  await notifyUsers(
    db,
    [...members, ...admins].map((m) => m.id),
    {
      category: 'security',
      event,
      vaultId: ev.vaultId,
      resourceType,
      resourceId: rawId && UUID.test(rawId) ? rawId : null,
      detail: { rule: r.name, action: ev.action },
    },
  );
}

const countFired = (db: Db, id: string) =>
  db
    .update(automationRules)
    .set({ fired: sql`${automationRules.fired} + 1`, firedAt: new Date() })
    .where(eq(automationRules.id, id));

/**
 * Правило «запретить» — до действия: при совпадении условий действие отклоняется (403 с названием правила),
 * попытка записывается в журнал, получатели правила получают уведомление.
 */
export async function enforceDenyRules(
  db: Db,
  trigger: AutomationTrigger,
  ev: { actor: string; vaultId: string | null; target: string | null },
): Promise<void> {
  const rules = await db
    .select()
    .from(automationRules)
    .where(
      and(
        eq(automationRules.enabled, true),
        eq(automationRules.effect, 'deny'),
        eq(automationRules.trigger, trigger),
      ),
    );
  if (!rules.length) return;
  const actorId = ev.actor.startsWith('user:') ? ev.actor.slice(5) : null;
  const circles = await circlesOf(db, actorId, rules);
  const hit = rules.find((r) => matches(r, ev.vaultId, circles));
  if (!hit) return;
  await countFired(db, hit.id);
  await db.insert(ledger).values({
    actor: ev.actor,
    action: 'automation.denied',
    target: `rule:${hit.id}`,
    detail: { trigger, vault: ev.vaultId, object: ev.target },
  });
  await notifyRule(db, hit, 'automation.denied', { action: trigger, ...ev });
  throw new AppError(403, 'denied_by_rule', 'The action is denied by an automation rule', {
    rule: hit.name,
  });
}

/** Правила «уведомить» на событие журнала: условия (сейф, группа автора) и уведомление получателям. */
export async function fireAutomation(db: Db, ev: AuditSinkEvent): Promise<void> {
  const triggers = triggersOf(ev.action);
  if (!triggers.length) return;
  const rules = await db
    .select()
    .from(automationRules)
    .where(
      and(
        eq(automationRules.enabled, true),
        eq(automationRules.effect, 'notify'),
        inArray(automationRules.trigger, triggers),
      ),
    );
  if (!rules.length) return;
  const vault = ev.detail?.vault;
  const vaultId =
    typeof vault === 'string' && UUID.test(vault)
      ? vault
      : ev.target?.startsWith('vault:')
        ? ev.target.slice(6)
        : null;
  const actorId = ev.actor.startsWith('user:') ? ev.actor.slice(5) : null;
  const actorCircles = await circlesOf(db, actorId, rules);
  const now = Date.now();
  if (recent.size > 10_000)
    for (const [k, at] of recent) if (at <= now - QUIET_MS) recent.delete(k);
  for (const r of rules) {
    if (!matches(r, vaultId, actorCircles)) continue;
    const key = `${r.id}|${ev.actor}|${ev.target ?? ''}`;
    if ((recent.get(key) ?? 0) > now - QUIET_MS) continue;
    recent.set(key, now);
    await notifyRule(db, r, 'automation.rule', { action: ev.action, vaultId, target: ev.target });
    await countFired(db, r.id);
    // прямо в журнал, не через audit(): срабатывание правила не должно запускать правила
    await db.insert(ledger).values({
      actor: 'system',
      action: 'automation.fired',
      target: `rule:${r.id}`,
      detail: { trigger: ev.action, actor: ev.actor, vault: vaultId },
    });
  }
}
