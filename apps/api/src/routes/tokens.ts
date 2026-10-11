import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { tokenCreate, uuid } from '@arklock/contracts';
import type { ApiTokenInfo } from '@arklock/contracts';
import { audit } from '../audit.js';
import { checkSecondFactor, isEnrolled } from '../auth/mfa.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { apiTokens } from '../db/schema.js';
import { AppError, notFound, parse } from '../errors.js';
import { randomB64url, sha256Hex, verifyProof } from '../security.js';

/** Токены API создаёт и отзывает только человек с действующей сессией (не токен), подтвердив пароль и второй фактор. */
export const registerTokenRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));

  const info = (t: typeof apiTokens.$inferSelect): ApiTokenInfo => ({
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scope: t.scope,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  });

  app.get('/auth/tokens', async (req): Promise<ApiTokenInfo[]> => {
    const { user } = authOf(req);
    const rows = await db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, user.id), isNull(apiTokens.revokedAt)))
      .orderBy(desc(apiTokens.createdAt));
    return rows.map(info);
  });

  app.post('/auth/tokens', async (req, reply) => {
    const { user, viaToken } = authOf(req);
    if (viaToken) throw new AppError(403, 'token_not_allowed', 'Tokens cannot create tokens');
    const body = parse(tokenCreate, req.body);
    const wait = ctx.attempts.byEmail.retryAfter(`mfa:${user.id}`);
    if (wait > 0)
      throw new AppError(429, 'too_many_attempts', 'Too many attempts, try again later', {
        retryAfterSeconds: wait,
      });
    if (!verifyProof(user.authSalt, body.authKey, user.authHash)) {
      ctx.attempts.byEmail.fail(`mfa:${user.id}`);
      throw new AppError(401, 'invalid_credentials', 'Invalid master password');
    }
    if (await isEnrolled(ctx, user.id)) {
      const kind = body.code ? await checkSecondFactor(ctx, user.id, body.code) : null;
      if (!kind) {
        ctx.attempts.byEmail.fail(`mfa:${user.id}`);
        throw new AppError(401, 'invalid_code', 'The code is invalid or already used');
      }
    }
    ctx.attempts.byEmail.reset(`mfa:${user.id}`);
    const token = `akt_${randomB64url(32)}`;
    const id = crypto.randomUUID();
    const [row] = await db
      .insert(apiTokens)
      .values({
        id,
        userId: user.id,
        name: body.name,
        tokenHash: sha256Hex(token),
        prefix: token.slice(0, 8),
        scope: body.scope,
        expiresAt: body.expiresInDays
          ? new Date(Date.now() + body.expiresInDays * 86_400_000)
          : null,
      })
      .returning();
    await audit(db, `user:${user.id}`, 'auth.token.create', `token:${id}`, { scope: body.scope });
    return reply.status(201).send({ token, info: info(row!) });
  });

  app.delete('/auth/tokens/:id', async (req, reply) => {
    const { user, viaToken } = authOf(req);
    if (viaToken) throw new AppError(403, 'token_not_allowed', 'Tokens cannot revoke tokens');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const res = await db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, user.id), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id });
    if (!res.length) throw notFound();
    await audit(db, `user:${user.id}`, 'auth.token.revoke', `token:${id}`);
    return reply.status(204).send();
  });
};
