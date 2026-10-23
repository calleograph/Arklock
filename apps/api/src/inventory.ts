import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { AppContext } from './context.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Версия установленного пакета: его package.json в ближайшем node_modules вверх по дереву (так ищет и Node). */
function installed(name: string): string | null {
  for (let dir = here; ; dir = path.dirname(dir)) {
    const file = path.join(dir, 'node_modules', name, 'package.json');
    if (existsSync(file))
      return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? null;
    if (path.dirname(dir) === dir) return null;
  }
}

function osName(): string | null {
  try {
    return (
      /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Состав работающей установки: фактические версии среды и зависимостей сервера (а не версии из исходников).
 * Полный список зависимостей выпуска — в SBOM, приложенном к выпуску.
 */
export async function inventory(ctx: AppContext) {
  const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  let database: string | null = null;
  try {
    const r = await ctx.db.execute(sql`select version() as v`);
    const rows =
      (r as unknown as { rows?: { v: string }[] }).rows ?? (r as unknown as { v: string }[]);
    database = rows[0]?.v ?? null;
  } catch {
    database = null;
  }
  const host = ctx.updater.configured ? (await ctx.updater.containers()).host : null;
  return {
    app: {
      version: ctx.config.APP_VERSION,
      commit: ctx.config.APP_GIT_COMMIT,
      builtAt: ctx.config.APP_BUILT_AT,
    },
    runtime: {
      node: process.versions.node,
      openssl: process.versions.openssl,
      os: osName(),
      arch: process.arch,
    },
    database,
    host,
    dependencies: Object.keys(pkg.dependencies ?? {})
      .filter((n) => !n.startsWith('@arklock/'))
      .map((name) => ({ name, version: installed(name) })),
  };
}
