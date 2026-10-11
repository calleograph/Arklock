import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { sessions, users } from '../db/schema.js';
import { AppError, unauthorized } from '../errors.js';
import { isEnrolled, mfaPolicy } from './mfa.js';
import { randomB64url, sha256Hex } from '../security.js';

export interface AuthInfo {
  user: typeof users.$inferSelect;
  session: typeof sessions.$inferSelect;
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
