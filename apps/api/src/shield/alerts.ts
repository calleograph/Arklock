import { and, eq, isNull } from 'drizzle-orm';
import { audit } from '../audit.js';
import type { AppContext } from '../context.js';
import { users } from '../db/schema.js';
import { notifySecurity } from '../mail/send.js';
import { notifyUsers } from '../notifications.js';
import type { SecurityEventInput } from './events.js';

/** События, о которых оповещаются главные администраторы (остальные остаются в журнале). */
const ALERT_KINDS = new Set([
  'ip_blocked',
  'protection_changed',
  'access_restriction_rollback',
  'access_restriction_off',
  'protection_failure',
  'mass_failures',
  'admin_login_suspicious',
  'object_probing',
  'export_secrets',
]);

/**
 * Оповещения главных администраторов о нападениях и об ослаблении защиты: центр уведомлений, почта (если настроена),
 * syslog и вебхуки через общий журнал действий. Одинаковые события не повторяются чаще заданного интервала
 * (по умолчанию 15 минут), поэтому одна атака не порождает тысячи писем.
 */
export class Alerts {
  private readonly last = new Map<string, number>();

  constructor(private readonly ctx: AppContext) {}

  handle(e: SecurityEventInput): void {
    if (!ALERT_KINDS.has(e.kind)) return;
    const key = `${e.kind}|${e.rule ?? ''}`;
    const now = Date.now();
    if (now - (this.last.get(key) ?? 0) < this.ctx.shield.policy.alertMinutes * 60_000) return;
    this.last.set(key, now);
    if (this.last.size > 500) this.last.clear();
    void this.deliver(e).catch(() => undefined);
  }

  private async deliver(e: SecurityEventInput): Promise<void> {
    const { db } = this.ctx;
    // в syslog и вебхуки событие уходит как действие системы (без паролей и тел запросов)
    await audit(db, 'system:shield', `shield.${e.kind}`, e.ip ? `ip:${e.ip}` : null, {
      rule: e.rule ?? null,
      result: e.result,
      level: e.level,
    });
    const chiefs = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.chief, true), isNull(users.disabledAt)));
    const ids = chiefs.map((c) => c.id);
    await notifyUsers(db, ids, {
      category: 'security',
      event: `shield_${e.kind}`,
      resourceType: 'security',
      detail: { ip: e.ip ?? null, rule: e.rule ?? null },
    });
    if (!this.ctx.shield.policy.alertMail) return;
    for (const id of ids)
      await notifySecurity(
        this.ctx,
        id,
        `Arklock: событие безопасности (${e.kind})`,
        `Защита веб-приложения зафиксировала событие «${e.kind}»${e.rule ? ` по правилу ${e.rule}` : ''}${e.ip ? `, адрес ${e.ip}` : ''}. Подробности — «Администрирование → Защита веб-приложения → События безопасности».\n\nArklock web protection recorded the event "${e.kind}". Details: Administration → Web application protection → Security events.`,
      ).catch(() => undefined);
  }
}
