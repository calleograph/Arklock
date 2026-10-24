import { ref } from 'vue';
import { api } from './api';
import { ledgerAction } from './ledger';
export interface NotificationRow {
  id: number;
  category: 'access' | 'security' | 'sharing' | 'system';
  event: string;
  vaultId: string | null;
  resourceType: string;
  resourceId: string | null;
  /** Несекретные подробности: правило автоматизации, число событий в отчёте о здоровье паролей. */
  detail?: { rule?: string; action?: string; open?: string; high?: string } | null;
  createdAt: string;
  readAt: string | null;
  archivedAt: string | null;
}
export interface NotificationList {
  items: NotificationRow[];
  unread: number;
  next: number | null;
}
export const unreadNotifications = ref(0);
let generation = 0;
export function setNotificationCount(count: number): void {
  generation++;
  unreadNotifications.value = count;
}
export async function refreshNotificationCount(): Promise<void> {
  const current = generation;
  const result = await api<NotificationList>('GET', '/notifications?view=unread&limit=1');
  if (current === generation) setNotificationCount(result.unread);
}

type T = (key: string, values?: Record<string, unknown>) => string;

/** Текст уведомления на языке интерфейса: события с подробностями — своим текстом, остальные — по коду события. */
export function notificationMessage(
  row: NotificationRow,
  t: T,
  te: (key: string) => boolean,
  vaultName: (id: string | null) => string,
): string {
  if (row.event === 'automation.denied' && row.detail?.rule)
    return t('notifications.ruleDenied', {
      rule: row.detail.rule,
      action: t(`automation.trigger.${(row.detail.action ?? '').replace('.', '_')}`),
    });
  if (row.event === 'automation.rule' && row.detail?.rule)
    return t('notifications.ruleFired', {
      rule: row.detail.rule,
      action: row.detail.action ? ledgerAction(row.detail.action, t, te) : '',
    });
  if (row.event === 'signals.digest' && row.detail?.open)
    return t('notifications.signalsDigest', {
      vault: vaultName(row.vaultId),
      open: row.detail.open,
      high: row.detail.high ?? '0',
    });
  const key = `notifications.events.${row.event.replaceAll('.', '_').replaceAll('-', '_')}`;
  return te(key) ? t(key) : t('notifications.event');
}
