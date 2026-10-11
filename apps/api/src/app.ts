import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { API_PREFIX, type ErrorResponse } from '@arklock/contracts';
import type { Config } from './config.js';
import { createContext } from './context.js';
import type { Database } from './db/connect.js';
import { AppError } from './errors.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAdminDirectoryRoutes } from './routes/admin-directory.js';
import { registerAttachmentRoutes } from './routes/attachments.js';
import { registerMfaRoutes } from './routes/mfa.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerContentRoutes } from './routes/content.js';
import { registerSecurityRoutes } from './routes/security.js';
import { registerSharingRoutes } from './routes/sharing.js';
import { registerVaultRoutes } from './routes/vaults.js';

export interface AppDeps {
  config: Config;
  database: Database;
}

/**
 * Политика содержимого: только свои ресурсы. 'wasm-unsafe-eval' нужен для WebAssembly (Argon2id);
 * исполнение произвольных строк как JS (eval) по-прежнему запрещено. Стили допускают inline из-за scoped-стилей Vue.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function notFound(requestId: string): ErrorResponse {
  return { error: { code: 'not_found', message: 'Not found', requestId } };
}

export async function buildApp({ config, database }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            // Секреты не должны попадать в журналы ни при каких ошибках маршрутов.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
                'req.body',
              ],
              censor: '[redacted]',
            },
          },
    trustProxy: (_address: string, hop: number) => hop <= config.TRUSTED_PROXY_HOPS,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });
  const ctx = createContext(config, database);

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', CSP);
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (reply.request.url.startsWith(API_PREFIX)) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const known = err instanceof AppError;
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500 && !known) {
      req.log.error({ err: { type: err.name, message: err.message } }, 'request failed');
    }
    if (known && err.code === 'too_many_attempts') {
      const retry = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      if (retry) reply.header('Retry-After', String(retry));
    }
    const body: ErrorResponse = {
      error: {
        code:
          status >= 500 && !known
            ? 'internal_error'
            : known
              ? err.code
              : (err.code ?? 'bad_request'),
        message: status >= 500 && !known ? 'Internal server error' : err.message,
        requestId: req.id,
        ...(known && err.details !== undefined ? { details: err.details } : {}),
      },
    };
    void reply.status(status).send(body);
  });

  await app.register(registerSystemRoutes, { prefix: API_PREFIX, config, database });
  await app.register(registerAuthRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerMfaRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerVaultRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerContentRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerAttachmentRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerSharingRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerSecurityRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerAdminRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerAdminDirectoryRoutes, { prefix: API_PREFIX, ctx });

  const webDist = config.WEB_DIST ? path.resolve(config.WEB_DIST) : '';
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    // SPA: неизвестные пути интерфейса отдают index.html, неизвестные пути API — JSON-ошибку 404.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith(API_PREFIX))
        return reply.sendFile('index.html');
      return reply.status(404).send(notFound(req.id));
    });
  } else {
    app.setNotFoundHandler((req, reply) => reply.status(404).send(notFound(req.id)));
  }

  app.addHook('onClose', async () => {
    await database.close();
  });
  return app;
}
