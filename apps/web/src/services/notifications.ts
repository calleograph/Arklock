import { ref } from 'vue';
import { api } from './api';
export interface NotificationRow {
  id: number;
  category: 'access' | 'security' | 'sharing' | 'system';
  event: string;
  vaultId: string | null;
  resourceType: string;
  resourceId: string | null;
  /** Несекретные подробности: у правила автоматизации — его название и действие журнала. */
  detail?: { rule?: string; action?: string } | null;
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
