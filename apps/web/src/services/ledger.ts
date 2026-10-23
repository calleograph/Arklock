/** Событие журнала действий в том виде, в каком его отдаёт `/admin/ledger`. */
export interface LedgerItem {
  id: number;
  at: string;
  actor: string;
  actorName: string | null;
  action: string;
  target: string | null;
  targetName: string | null;
  detail: Record<string, unknown> | null;
}
type T = (key: string) => string;
type Te = (key: string) => boolean;

/** Объект без имени: вид и начало идентификатора (полный — во всплывающей подсказке). */
export function ledgerTarget(l: LedgerItem, t: T, te: Te): string {
  if (l.targetName) return l.targetName;
  const m = /^([a-z]+):([0-9a-f]{8})[0-9a-f-]{28}$/.exec(l.target ?? '');
  const key = m ? `admin.ledgerTarget.${m[1]}` : '';
  return m && te(key) ? `${t(key)} ${m[2]}` : (l.target ?? '');
}

/** Подпись действия на языке интерфейса; неизвестный код показывается как есть. */
export function ledgerAction(action: string, t: T, te: Te): string {
  const k = action.replace(/[.-]/g, '_');
  for (const key of [`ledgerAction.${k}`, `entryPanel.actions.${k}`]) if (te(key)) return t(key);
  return action;
}
