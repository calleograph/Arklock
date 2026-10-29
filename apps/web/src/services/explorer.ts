import type { BranchItem } from './model';
import { naturalCompare } from './helpers';

/**
 * Папки по родителю для проводника в центре. Папка, чей родитель сотруднику недоступен, считается
 * корневой: структуру выше своего доступа он не видит и не узнаёт её названий.
 */
export function childIndex(branches: BranchItem[]): Map<string | null, BranchItem[]> {
  const ids = new Set(branches.map((b) => b.id));
  const out = new Map<string | null, BranchItem[]>();
  for (const b of branches) {
    const key = b.parentId && ids.has(b.parentId) ? b.parentId : null;
    const list = out.get(key);
    if (list) list.push(b);
    else out.set(key, [b]);
  }
  for (const list of out.values()) list.sort((a, b) => naturalCompare(a.name, b.name));
  return out;
}

/** Путь от верхней доступной папки до `id` включительно; недоступные уровни в него не попадают. */
export function trailOf(branches: BranchItem[], id: string | null): BranchItem[] {
  const byId = new Map(branches.map((b) => [b.id, b]));
  const out: BranchItem[] = [];
  const seen = new Set<string>();
  for (let cur = id ? byId.get(id) : undefined; cur && !seen.has(cur.id);) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}
