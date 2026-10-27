import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { API_PREFIX, type ErrorResponse } from '@arklock/contracts';
import type { Config } from './config.js';
import { createContext } from './context.js';
import { loadPublicUrl } from './public-url.js';
import type { Database } from './db/connect.js';
import { AppError } from './errors.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerRoleRoutes } from './routes/admin-roles.js';
import { registerInvitationRoutes } from './routes/admin-invitations.js';
import { registerAdminSyslogRoutes } from './routes/admin-syslog.js';
import { registerPinRoutes } from './routes/pin.js';
import { registerAdminNetworkRoutes } from './routes/admin-network.js';
import { registerChiefRoutes } from './routes/chief.js';
import { registerSessionReloadRoutes } from './routes/session-reload.js';
import { registerAdminWebhookRoutes } from './routes/admin-webhooks.js';
import { registerAdminAutomationRoutes } from './routes/admin-automation.js';
import { registerAdminOpsRoutes } from './routes/admin-ops.js';
import { registerAdminSystemRoutes } from './routes/admin-system.js';
import { registerAdminSmtpRoutes } from './routes/admin-smtp.js';
import { deliverQueuedMail } from './mail/send.js';
import { registerAdminDirectoryRoutes } from './routes/admin-directory.js';
import { registerAdminShieldRoutes } from './routes/admin-shield.js';
import { registerContinuityRoutes } from './routes/continuity.js';
import { registerOffboardingRoutes } from './routes/admin-offboarding.js';
import { registerCorporateRecoveryRoutes } from './routes/corporate-recovery.js';
import { registerAttachmentRoutes } from './routes/attachments.js';
import { registerTokenRoutes } from './routes/tokens.js';
import { registerWebauthnRoutes } from './routes/webauthn.js';
import { registerSsoRoutes } from './routes/sso.js';
import { registerSamlRoutes } from './routes/saml.js';
import { registerLdapRoutes } from './routes/ldap.js';
import { registerMfaRoutes } from './routes/mfa.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerContentRoutes } from './routes/content.js';
import { registerSecurityRoutes } from './routes/security.js';
import { registerSharingRoutes } from './routes/sharing.js';
import { registerVaultRoutes } from './routes/vaults.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerSpaceRoutes } from './routes/spaces.js';

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

declare module 'fastify' {
  interface FastifyInstance {
    routeTable: { method: string; url: string }[];
    shield: import('./shield/throttle.js').Shield;
    access: import('./shield/access.js').AccessControl;
    securityLog: import('./shield/events.js').SecurityLog;
  }
}

export async function buildApp({ config, database }: AppDeps): Promise<FastifyInstance> {
  // доверие к proxy: по числу звеньев, пока не создан контекст со списком доверенных адресов из панели
  let trustFn: (address: string, hop: number) => boolean = (_a, hop) =>
    hop < config.TRUSTED_PROXY_HOPS;
  const trust = (address: string, hop: number) => trustFn(address, hop);
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
    // hop 0 — сам сокет: он считается прокси, только если перед сервером стоит хотя бы один прокси; N прокси доверяются ровно N звеньев
    trustProxy: (address: string, hop: number) => trust(address, hop),
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });
  // Таблица маршрутов нужна тестам, проверяющим права на все маршруты по списку, а не по памяти
  const routeTable: { method: string; url: string }[] = [];
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) routeTable.push({ method: String(m), url: r.url });
  });
  app.decorate('routeTable', routeTable);
  const ctx = createContext(config, database);
  await loadPublicUrl(ctx);
  app.decorate('shield', ctx.shield);
  app.decorate('access', ctx.access);
  app.decorate('securityLog', ctx.securityLog);
  await ctx.shield.start();
  await ctx.access.start();
  trustFn = ctx.access.trust(config.TRUSTED_PROXY_HOPS);
  // разрешённые клиентские подсети: проверка до любой обработки запроса (веб-интерфейс и API)
  const deniedSeen = new Map<string, number>();
  app.addHook('onRequest', async (req, reply) => {
    if (ctx.access.permits(req.ip)) return;
    const last = deniedSeen.get(req.ip) ?? 0;
    if (Date.now() - last > 60_000) {
      deniedSeen.set(req.ip, Date.now());
      if (deniedSeen.size > 5000) deniedSeen.clear();
      ctx.securityLog.record({
        kind: 'ip_not_allowed',
        level: 'warn',
        result: 'denied',
        ip: req.ip,
        rule: 'access.subnets',
        requestId: req.id,
      });
    }
    return reply.status(403).send({
      error: { code: 'ip_not_allowed', message: 'Access from this address is not allowed' },
    });
  });
  app.addHook('onClose', async () => {
    ctx.shield.stop();
    ctx.access.stop();
    await ctx.securityLog.flush();
  });

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
  await app.register(registerTokenRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerWebauthnRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerSsoRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerSamlRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerLdapRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerMfaRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerVaultRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerNotificationRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerSpaceRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerContentRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerAttachmentRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerSharingRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerSecurityRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerAdminRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerRoleRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerInvitationRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerAdminSyslogRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerAdminWebhookRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerAdminAutomationRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerPinRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerAdminNetworkRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerChiefRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerSessionReloadRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerAdminOpsRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerAdminSystemRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerAdminSmtpRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerAdminDirectoryRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerAdminShieldRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerContinuityRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerOffboardingRoutes, { prefix: API_PREFIX, ctx });
  await app.register(registerCorporateRecoveryRoutes, { prefix: API_PREFIX, ctx });

  const webDist = config.WEB_DIST ? path.resolve(config.WEB_DIST) : '';
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    // SPA: неизвестные пути интерфейса отдают index.html, неизвестные пути API — JSON-ошибку 404.
    app.setNotFoundHandler((req, reply) => {
      // Файл с расширением (/assets/*.js и т.п.) — это не маршрут интерфейса: отсутствующий файл сборки получает 404,
      // иначе браузер и service worker приняли бы HTML за скрипт и закэшировали его.
      const pathname = req.url.split('?')[0] ?? '';
      if (
        req.method === 'GET' &&
        !pathname.startsWith(API_PREFIX) &&
        !/\.[a-z0-9]+$/i.test(pathname)
      )
        return reply.sendFile('index.html');
      return reply.status(404).send(notFound(req.id));
    });
  } else {
    app.setNotFoundHandler((req, reply) => reply.status(404).send(notFound(req.id)));
  }

  const mailAbort = new AbortController();
  let mailRun: Promise<void> | null = null;
  const runMail = () => {
    if (!mailRun && !mailAbort.signal.aborted)
      mailRun = deliverQueuedMail(ctx, new Date(), mailAbort.signal)
        .catch(() => {
          app.log.error('mail delivery queue failed');
        })
        .finally(() => {
          mailRun = null;
        });
    return mailRun;
  };
  const mailTimer = setInterval(() => {
    void runMail();
  }, 10_000);
  mailTimer.unref();
  app.addHook('onReady', async () => {
    await runMail();
  });
  app.addHook('onClose', async () => {
    clearInterval(mailTimer);
    mailAbort.abort();
    await mailRun;
    await database.close();
  });
  return app;
}
