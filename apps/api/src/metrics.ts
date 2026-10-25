import os from 'node:os';
import { asc, gte, lt, sql } from 'drizzle-orm';
import type { Db } from './db/connect.js';
import { metricSamples } from './db/schema.js';
import { diskInfo } from './resources.js';
import { rowsOf } from './db/connect.js';

/** Сколько дней хранится история ресурсов. */
export const METRICS_DAYS = 14;

/** Одна точка истории: нагрузка процессора, занятая память, самый заполненный из дисков, размер базы. */
export async function sampleMetrics(db: Db, dirs: string[], now = new Date()): Promise<void> {
  const cores = os.cpus().length || 1;
  const cpu = Math.min(100, Math.round(((os.loadavg()[0] ?? 0) / cores) * 100));
  const mem = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
  const disks = (await Promise.all(dirs.map((d, i) => diskInfo(String(i), d)))).filter(
    (d): d is NonNullable<typeof d> => !!d,
  );
  const disk = Math.round(Math.max(0, ...disks.map((d) => d.usedPct)));
  let dbBytes = 0;
  try {
    const r = await db.execute(sql`select pg_database_size(current_database())::float8 as n`);
    dbBytes = Math.round(Number(rowsOf<{ n: number }>(r)[0]?.n ?? 0));
  } catch {
    /* размер базы не определился: точка записывается без него */
  }
  await db
    .insert(metricSamples)
    .values({ at: now, cpuPct: cpu, memPct: mem, diskPct: disk, dbBytes })
    .onConflictDoNothing();
  await db
    .delete(metricSamples)
    .where(lt(metricSamples.at, new Date(now.getTime() - METRICS_DAYS * 86_400_000)));
}

export interface MetricPoint {
  at: string;
  cpu: number;
  mem: number;
  disk: number;
  dbBytes: number;
}

/** История за последние `hours` часов, не больше 240 точек: соседние усредняются. */
export async function metricsHistory(
  db: Db,
  hours: number,
  now = new Date(),
): Promise<MetricPoint[]> {
  const since = new Date(now.getTime() - hours * 3_600_000);
  const rows = await db
    .select()
    .from(metricSamples)
    .where(gte(metricSamples.at, since))
    .orderBy(asc(metricSamples.at));
  const step = Math.max(1, Math.ceil(rows.length / 240));
  const out: MetricPoint[] = [];
  for (let i = 0; i < rows.length; i += step) {
    const chunk = rows.slice(i, i + step);
    const avg = (f: (r: (typeof rows)[number]) => number) =>
      Math.round(chunk.reduce((a, r) => a + f(r), 0) / chunk.length);
    out.push({
      at: chunk[chunk.length - 1]!.at.toISOString(),
      cpu: avg((r) => r.cpuPct),
      mem: avg((r) => r.memPct),
      disk: avg((r) => r.diskPct),
      dbBytes: avg((r) => r.dbBytes),
    });
  }
  return out;
}
