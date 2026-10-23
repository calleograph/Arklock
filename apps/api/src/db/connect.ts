import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Строки результата db.execute: pg отдаёт { rows }, PGlite — сам массив. */
export const rowsOf = <T>(r: unknown): T[] => (r as { rows?: T[] }).rows ?? (r as T[]);

export interface Database {
  db: Db;
  /** Применяет миграции из каталога drizzle/. Повторный вызов безопасен. */
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function connect(url: string): Promise<Database> {
  if (url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const target = url.slice('pglite:'.length);
    const client = new PGlite(target === 'memory' || target === '' ? undefined : target);
    const db = drizzle(client, { schema });
    return {
      db: db as unknown as Db,
      migrate: () => migrate(db, { migrationsFolder: MIGRATIONS }),
      ping: async () => {
        try {
          await db.execute(sql`select 1`);
          return true;
        } catch {
          return false;
        }
      },
      close: () => client.close(),
    };
  }

  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error('DATABASE_URL must start with postgres://, postgresql:// or pglite:');
  }
  const { default: pg } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000 });
  const db = drizzle(pool, { schema });
  return {
    db: db as unknown as Db,
    migrate: () => migrate(db, { migrationsFolder: MIGRATIONS }),
    ping: async () => {
      try {
        await pool.query('select 1');
        return true;
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
  };
}
