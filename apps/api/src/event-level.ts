/** Важность события журнала по его названию: одна классификация для фильтра журнала, значка и syslog. */
export const CRITICAL_RE = /failed|denied|reject|blocked/;
export const WARNING_RE = /delete|purge|revoke|disable|restore|reset/;
export type EventLevel = 'critical' | 'warning' | 'info';

export const eventLevel = (action: string): EventLevel =>
  CRITICAL_RE.test(action) ? 'critical' : WARNING_RE.test(action) ? 'warning' : 'info';
