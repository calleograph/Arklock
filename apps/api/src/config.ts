import { z } from 'zod';
import { MIN_KDF } from '@arklock/crypto';
import type { KdfParams } from '@arklock/crypto';

/** Конфигурация процесса из переменных окружения. Некорректная конфигурация — отказ запуска с понятной ошибкой. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** postgres://… — PostgreSQL; pglite:<каталог> или pglite:memory — встроенная БД (разработка, тесты). */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** Секрет приложения (не менее 32 символов): правдоподобные ответы для неизвестных адресов. Не ключ шифрования данных. */
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
  /** Одноразовый код первоначальной настройки: без него в production создать первого администратора нельзя. */
  BOOTSTRAP_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(24).optional()),
  /** Каталог обмена с помощником обновлений (пусто — раздел обновлений недоступен). */
  UPDATER_DIR: z.string().default(''),
  /** Каталог собранного веб-клиента; пусто — API без раздачи статики. */
  WEB_DIST: z.string().default(''),
  /** Сколько прокси стоит перед приложением (для корректного IP клиента). */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  SESSION_IDLE_HOURS: z.coerce.number().positive().default(12),
  SESSION_MAX_DAYS: z.coerce.number().positive().default(7),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
  LOGIN_WINDOW_MINUTES: z.coerce.number().positive().default(15),
  APP_VERSION: z.string().default('0.0.0'),
  APP_GIT_COMMIT: z.string().default('unknown'),
  APP_BUILT_AT: z.string().default('unknown'),
  UPDATE_CHANNEL: z.enum(['stable', 'edge']).default('stable'),
});

export type Config = z.infer<typeof schema> & {
  /** Нижняя граница параметров Argon2id, принимаемая сервером. В тестах занижена; в продукте — MIN_KDF. */
  kdfFloor: KdfParams;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const kdfFloor =
    parsed.data.NODE_ENV === 'test' ? { memoryKiB: 8, iterations: 1, parallelism: 1 } : MIN_KDF;
  return { ...parsed.data, kdfFloor };
}
