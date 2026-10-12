import type { FastifyPluginAsync } from 'fastify';
import type { HealthResponse, ReadyResponse, VersionResponse } from '@arklock/contracts';
import type { Config } from '../config.js';
import type { Database } from '../db/connect.js';
import { buildOpenApi } from '../openapi.js';

interface Opts {
  config: Config;
  database: Database;
}

export const registerSystemRoutes: FastifyPluginAsync<Opts> = async (app, { config, database }) => {
  /** Liveness: процесс жив. Не обращается к БД. */
  app.get('/health', async (): Promise<HealthResponse> => ({ status: 'ok' }));

  /** Readiness: приложение готово принимать трафик (БД доступна, миграции применены). */
  app.get('/ready', async (_req, reply): Promise<ReadyResponse> => {
    const ok = await database.ping();
    const body: ReadyResponse = {
      status: ok ? 'ready' : 'degraded',
      checks: { database: ok ? 'ok' : 'fail' },
    };
    if (!ok) reply.status(503);
    return body;
  });

  /** Описание API для интеграций (OpenAPI 3.1); схемы получены из тех же схем, по которым сервер проверяет запросы. */
  app.get('/openapi.json', async () => buildOpenApi(config.APP_VERSION));

  app.get('/version', async (): Promise<VersionResponse> => ({
    name: 'arklock',
    version: config.APP_VERSION,
    commit: config.APP_GIT_COMMIT,
    builtAt: config.APP_BUILT_AT,
    channel: config.UPDATE_CHANNEL,
  }));
};
