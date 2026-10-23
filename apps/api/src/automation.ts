import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AUTOMATION_TRIGGERS } from '@arklock/contracts';
import type { AuditSinkEvent } from './audit.js';
import type { Db } from './db/connect.js';
import { automationRules, circleMembers, ledger, users } from './db/schema.js';
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

/** Правила автоматизации на событие журнала: условия (сейф, группа автора) и уведомление получателям. */
export async function fireAutomation(db: Db, ev: AuditSinkEvent): Promise<void> {
  const triggers = triggersOf(ev.action);
  if (!triggers.length) return;
  const rules = await db
    .select()
    .from(automationRules)
    .where(and(eq(automationRules.enabled, true), inArray(automationRules.trigger, triggers)));
  if (!rules.length) return;
  const vault = ev.detail?.vault;
  const vaultId =
    typeof vault === 'string' && UUID.test(vault)
      ? vault
      : ev.target?.startsWith('vault:')
        ? ev.target.slice(6)
        : null;
  const actorId = ev.actor.startsWith('user:') ? ev.actor.slice(5) : null;
  const actorCircles =
    actorId && rules.some((r) => r.actorCircleId)
      ? new Set(
          (
            await db
              .select({ c: circleMembers.circleId })
              .from(circleMembers)
              .where(eq(circleMembers.userId, actorId))
          ).map((r) => r.c),
        )
      : new Set<string>();
  const [resourceType = 'system', rawId] = (ev.target ?? '').split(':');
  const resourceId = rawId && UUID.test(rawId) ? rawId : null;
  const now = Date.now();
  if (recent.size > 10_000)
    for (const [k, at] of recent) if (at <= now - QUIET_MS) recent.delete(k);
  for (const r of rules) {
    if (r.vaultId && r.vaultId !== vaultId) continue;
    if (r.actorCircleId && !actorCircles.has(r.actorCircleId)) continue;
    const key = `${r.id}|${ev.actor}|${ev.target ?? ''}`;
    if ((recent.get(key) ?? 0) > now - QUIET_MS) continue;
    recent.set(key, now);
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
    await notifyUsers(
      db,
      [...members, ...admins].map((m) => m.id),
      {
        category: 'security',
        event: 'automation.rule',
        vaultId,
        resourceType,
        resourceId,
        detail: { rule: r.name, action: ev.action },
      },
    );
    await db
      .update(automationRules)
      .set({ fired: sql`${automationRules.fired} + 1`, firedAt: new Date() })
      .where(eq(automationRules.id, r.id));
    // прямо в журнал, не через audit(): срабатывание правила не должно запускать правила
    await db.insert(ledger).values({
      actor: 'system',
      action: 'automation.fired',
      target: `rule:${r.id}`,
      detail: { trigger: ev.action, actor: ev.actor, vault: vaultId },
    });
  }
}
