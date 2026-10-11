import { statfs } from 'node:fs/promises';

export type Level = 'ok' | 'warn' | 'fail';

export const GIB = 1024 ** 3;

/**
 * Состояние свободного места: предупреждение при < 10 % или < 2 ГиБ, ошибка при < 5 % или < 500 МиБ.
 * Пороги едины для панели «Ресурсы» и диагностики.
 */
export function diskLevel(freeBytes: number, totalBytes: number): Level {
  if (totalBytes <= 0) return 'ok';
  const pct = (freeBytes / totalBytes) * 100;
  if (pct < 5 || freeBytes < 500 * 1024 * 1024) return 'fail';
  if (pct < 10 || freeBytes < 2 * GIB) return 'warn';
  return 'ok';
}

export interface DiskInfo {
  id: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedPct: number;
  level: Level;
}

export async function diskInfo(id: string, path: string): Promise<DiskInfo | null> {
  try {
    const s = await statfs(path);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return {
      id,
      path,
      totalBytes: total,
      freeBytes: free,
      usedPct: total ? Math.round(((total - free) / total) * 1000) / 10 : 0,
      level: diskLevel(free, total),
    };
  } catch {
    return null;
  }
}
