import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { apiTokens, sessions, users } from '../db/schema.js';
import { AppError, unauthorized } from '../errors.js';
import { isEnrolled, mfaPolicy } from './mfa.js';
import { randomB64url, sha256Hex } from '../security.js';

export interface AuthInfo {
  user: typeof users.$inferSelect;
  session: typeof sessions.$inferSelect;
  /** Запрос выполнен по токену API, а не по сессии. */
  viaToken?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthInfo;
  }
}

const MFA_EXEMPT = [
  '/api/v1/auth/mfa',
  '/api/v1/auth/me',
  '/api/v1/auth/logout',
  '/api/v1/auth/policy',
];
const TOKEN_RE = /^Bearer (aks_[A-Za-z0-9_-]{43})$/;
const API_TOKEN_RE = /^Bearer (akt_[A-Za-z0-9_-]{43})$/;

/**
 * Что разрешено токену API. Токен не заменяет сессию человека: он не управляет учётной записью, вторым фактором,
 * сеансами и другими токенами, не использует административные маршруты и не открывает данные (ключей у него нет).
 */
const TOKEN_ALLOWED = [
  '/api/v1/vaults',
  '/api/v1/directory',
  '/api/v1/handoffs',
  '/api/v1/security/range',
  '/api/v1/auth/me',
  '/api/v1/auth/policy',
  '/api/v1/auth/params',
  '/api/v1/key-log',
];

/** Токен API: проверка срока, отзыва, отключённого пользователя, области действия (read — только чтение). */
async function authenticateToken(ctx: AppContext, req: FastifyRequest, token: string) {
  const [row] = await ctx.db
    .select({ token: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, sha256Hex(token)))
    .limit(1);
  const now = Date.now();
  if (
    !row ||
    row.token.revokedAt ||
    row.user.disabledAt ||
    (row.token.expiresAt && row.token.expiresAt.getTime() <= now)
  )
    throw unauthorized();
  const path = req.url.split('?')[0] ?? '';
  if (!TOKEN_ALLOWED.some((p) => path === p || path.startsWith(p + '/')))
    throw new AppError(403, 'token_not_allowed', 'This endpoint cannot be used with an API token');
  if (row.token.scope === 'read' && req.method !== 'GET' && req.method !== 'HEAD')
    throw new AppError(403, 'token_read_only', 'This token is read-only');
  if (!row.token.lastUsedAt || now - row.token.lastUsedAt.getTime() > 60_000)
    await ctx.db
      .update(apiTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(apiTokens.id, row.token.id));
  // Политика обязательного MFA распространяется и на токены пользователя: пока фактор не настроен, доступ закрыт
  const policy = await mfaPolicy(ctx);
  if (
    (policy === 'all' || (policy === 'admins' && row.user.role === 'admin')) &&
    !(await isEnrolled(ctx, row.user.id))
  )
    throw new AppError(403, 'mfa_enrollment_required', 'Set up two-factor authentication first');
  // Для кода, ожидающего сессию, токен представляется условной сессией (идентификатор — токена)
  const session = {
    id: row.token.id,
    userId: row.user.id,
    tokenHash: row.token.tokenHash,
    createdAt: row.token.createdAt,
    lastSeenAt: new Date(now),
    expiresAt: row.token.expiresAt ?? new Date(now + 86_400_000),
    revokedAt: null,
    ip: req.ip ?? null,
    userAgent: null,
  } as typeof sessions.$inferSelect;
  req.auth = { user: row.user, session, viaToken: true };
}

export async function createSession(
  ctx: AppContext,
  userId: string,
  ip: string | null,
  userAgent: string | null,
) {
  const token = `aks_${randomB64url(32)}`;
  const now = Date.now();
  const expiresAt = new Date(now + ctx.config.SESSION_MAX_DAYS * 86_400_000);
  const id = crypto.randomUUID();
  await ctx.db.insert(sessions).values({
    id,
    userId,
    tokenHash: sha256Hex(token),
    expiresAt,
    ip,
    userAgent: userAgent?.slice(0, 300) ?? null,
  });
  return { id, token, expiresAt };
}

/** preHandler: требует действительную сессию. Токен хранится в БД только как SHA-256. */
export function requireAuth(ctx: AppContext) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const t = API_TOKEN_RE.exec(req.headers.authorization ?? '');
    if (t) return authenticateToken(ctx, req, t[1]!);
    const m = TOKEN_RE.exec(req.headers.authorization ?? '');
    if (!m) throw unauthorized();
    const [row] = await ctx.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, sha256Hex(m[1]!)))
      .limit(1);
    if (!row) throw unauthorized();
    const now = Date.now();
    const idleMs = ctx.config.SESSION_IDLE_HOURS * 3_600_000;
    if (
      row.session.revokedAt ||
      row.user.disabledAt ||
      row.session.expiresAt.getTime() <= now ||
      row.session.lastSeenAt.getTime() + idleMs <= now
    ) {
      throw unauthorized();
    }
    if (now - row.session.lastSeenAt.getTime() > 60_000) {
      await ctx.db
        .update(sessions)
        .set({ lastSeenAt: new Date(now) })
        .where(and(eq(sessions.id, row.session.id)));
    }
    // Политика обязательного MFA: пока второй фактор не настроен, доступны только страницы его настройки
    const policy = await mfaPolicy(ctx);
    if (policy === 'all' || (policy === 'admins' && row.user.role === 'admin')) {
      const path = req.url.split('?')[0] ?? '';
      if (
        !MFA_EXEMPT.some((p) => path === p || path.startsWith(p + '/')) &&
        !(await isEnrolled(ctx, row.user.id))
      ) {
        throw new AppError(
          403,
          'mfa_enrollment_required',
          'Set up two-factor authentication first',
        );
      }
    }
    req.auth = row;
  };
}

export function authOf(req: FastifyRequest): AuthInfo {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
