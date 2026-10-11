import type { Config } from './config.js';
import type { Database, Db } from './db/connect.js';
import { AttemptLimiter } from './rateLimit.js';

/** Общие зависимости маршрутов. */
export interface AppContext {
  config: Config;
  database: Database;
  db: Db;
  /** Ограничитель попыток входа/восстановления по адресу и по IP. */
  attempts: { byEmail: AttemptLimiter; byIp: AttemptLimiter };
}

export function createContext(config: Config, database: Database): AppContext {
  const windowMs = config.LOGIN_WINDOW_MINUTES * 60_000;
  return {
    config,
    database,
    db: database.db,
    attempts: {
      byEmail: new AttemptLimiter(config.LOGIN_MAX_ATTEMPTS, windowMs),
      byIp: new AttemptLimiter(config.LOGIN_MAX_ATTEMPTS * 5, windowMs),
    },
  };
}
