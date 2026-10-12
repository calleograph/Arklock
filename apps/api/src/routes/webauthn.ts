import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { authKey, mfaVerifyRequest } from '@arklock/contracts';
import type { SessionResponse } from '@arklock/contracts';
import { audit } from '../audit.js';
import { notifySecurity } from '../mail/send.js';
import { hasTotp, mfaPolicy } from '../auth/mfa.js';
import { authOf, createSession, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { users, webauthnCredentials } from '../db/schema.js';
import { AppError, parse } from '../errors.js';
import { verifyProof } from '../security.js';
import { bundle } from './auth.js';

const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const toB64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const ipOf = (req: FastifyRequest) => req.ip ?? null;

/**
 * Ключи доступа (WebAuthn) как второй фактор. Привязка к адресу: идентификатор и источник берутся из APP_PUBLIC_URL,
 * а не из заголовков запроса, поэтому подмена Host не помогает. Без публичного адреса ключи доступа недоступны.
 */
export const registerWebauthnRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db, config } = ctx;
  const auth = requireAuth(ctx);
  const pending = new Map<string, { challenge: string; expiresAt: number }>();

  function rp(): { id: string; origin: string } {
    if (!config.APP_PUBLIC_URL)
      throw new AppError(
        409,
        'public_url_required',
        'Set the public address (APP_PUBLIC_URL) first',
      );
    const u = new URL(config.APP_PUBLIC_URL);
    return { id: u.hostname, origin: u.origin };
  }

  function checkPassword(u: typeof users.$inferSelect, key: string): void {
    const k = `mfa:${u.id}`;
    const wait = ctx.attempts.byEmail.retryAfter(k);
    if (wait > 0)
      throw new AppError(429, 'too_many_attempts', 'Too many attempts, try again later', {
        retryAfterSeconds: wait,
      });
    if (!verifyProof(u.authSalt, key, u.authHash)) {
      ctx.attempts.byEmail.fail(k);
      throw new AppError(401, 'invalid_credentials', 'Invalid master password');
    }
  }

  // ------------------------------------------------------------------ управление ключами

  app.get('/auth/webauthn', { preHandler: auth }, async (req) => {
    const { user } = authOf(req);
    const rows = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, user.id))
      .orderBy(desc(webauthnCredentials.createdAt));
    return {
      available: !!config.APP_PUBLIC_URL,
      credentials: rows.map((c) => ({
        id: c.id,
        name: c.name,
        backedUp: c.backedUp,
        createdAt: c.createdAt.toISOString(),
        lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
      })),
    };
  });

  app.post('/auth/webauthn/register/options', { preHandler: auth }, async (req) => {
    const { user, viaToken } = authOf(req);
    if (viaToken) throw new AppError(403, 'token_not_allowed', 'Not available for tokens');
    const body = parse(z.object({ authKey }), req.body);
    checkPassword(user, body.authKey);
    const r = rp();
    const existing = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, user.id));
    const options = await generateRegistrationOptions({
      rpName: 'Arklock',
      rpID: r.id,
      userName: user.email,
      userDisplayName: user.displayName,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.id,
        transports: (c.transports as string[] | null) ?? undefined,
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    pending.set(`reg:${user.id}`, {
      challenge: options.challenge,
      expiresAt: Date.now() + 5 * 60_000,
    });
    return options;
  });

  app.post('/auth/webauthn/register/verify', { preHandler: auth }, async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(60),
        response: z.record(z.string(), z.unknown()),
      }),
      req.body,
    );
    const p = pending.get(`reg:${user.id}`);
    pending.delete(`reg:${user.id}`);
    if (!p || p.expiresAt <= Date.now())
      throw new AppError(400, 'webauthn_expired', 'The registration expired, start again');
    const r = rp();
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: body.response as unknown as RegistrationResponseJSON,
        expectedChallenge: p.challenge,
        expectedOrigin: r.origin,
        expectedRPID: r.id,
        requireUserVerification: false,
      });
    } catch (e) {
      throw new AppError(
        400,
        'webauthn_failed',
        `Registration failed: ${(e as Error).message}`.slice(0, 200),
      );
    }
    if (!verified.verified || !verified.registrationInfo)
      throw new AppError(400, 'webauthn_failed', 'Registration could not be verified');
    const cred = verified.registrationInfo.credential;
    const [dupe] = await db
      .select({ id: webauthnCredentials.id })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.id, cred.id));
    if (dupe) throw new AppError(409, 'already_exists', 'This key is already registered');
    await db.insert(webauthnCredentials).values({
      id: cred.id,
      userId: user.id,
      name: body.name,
      publicKey: toB64(cred.publicKey),
      counter: cred.counter,
      transports: (cred.transports ?? null) as never,
      backedUp: verified.registrationInfo.credentialBackedUp,
    });
    await audit(db, `user:${user.id}`, 'auth.webauthn.add', `user:${user.id}`);
    void notifySecurity(
      ctx,
      user.id,
      'Arklock: добавлен ключ доступа',
      'В вашу учётную запись добавлен ключ доступа. Если это были не вы — срочно обратитесь к администратору.\n\nA security key was added to your account. If this was not you, contact your administrator immediately.',
    );
    return reply.status(201).send({ id: cred.id });
  });

  app.post('/auth/webauthn/:id/delete', { preHandler: auth }, async (req, reply) => {
    const { user, viaToken } = authOf(req);
    if (viaToken) throw new AppError(403, 'token_not_allowed', 'Not available for tokens');
    const { id } = parse(z.object({ id: z.string().min(1).max(512) }), req.params);
    const body = parse(z.object({ authKey }), req.body);
    checkPassword(user, body.authKey);
    const mine = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, user.id));
    if (!mine.some((c) => c.id === id)) throw new AppError(404, 'not_found', 'Not found');
    const policy = await mfaPolicy(ctx);
    const required = policy === 'all' || (policy === 'admins' && user.role === 'admin');
    if (required && mine.length === 1 && !(await hasTotp(ctx, user.id)))
      throw new AppError(403, 'mfa_required_by_policy', 'Two-factor authentication is required');
    await db
      .delete(webauthnCredentials)
      .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, user.id)));
    await audit(db, `user:${user.id}`, 'auth.webauthn.remove', `user:${user.id}`);
    void notifySecurity(
      ctx,
      user.id,
      'Arklock: удалён ключ доступа',
      'Из вашей учётной записи удалён ключ доступа.\n\nA security key was removed from your account.',
    );
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ вход со вторым фактором

  /** Параметры запроса подписи для выданного при входе «вызова». */
  app.post('/auth/mfa/webauthn/options', async (req) => {
    const body = parse(mfaVerifyRequest.pick({ challenge: true }), req.body);
    const userId = ctx.mfa.peek(body.challenge);
    if (!userId)
      throw new AppError(401, 'invalid_challenge', 'The sign-in step expired, start again');
    const creds = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId));
    if (!creds.length) throw new AppError(409, 'no_passkeys', 'No security keys are registered');
    const options = await generateAuthenticationOptions({
      rpID: rp().id,
      allowCredentials: creds.map((c) => ({
        id: c.id,
        transports: (c.transports as string[] | null) ?? undefined,
      })),
      userVerification: 'preferred',
    });
    ctx.mfa.setWebauthn(body.challenge, options.challenge);
    return options;
  });

  app.post('/auth/mfa/webauthn/verify', async (req, reply): Promise<SessionResponse> => {
    const body = parse(
      z.object({
        challenge: z.string().min(10).max(100),
        response: z.record(z.string(), z.unknown()),
      }),
      req.body,
    );
    const userId = ctx.mfa.peek(body.challenge);
    const expected = ctx.mfa.getWebauthn(body.challenge);
    if (!userId || !expected)
      throw new AppError(401, 'invalid_challenge', 'The sign-in step expired, start again');
    const wait = ctx.attempts.byIp.retryAfter(ipOf(req) ?? 'unknown');
    if (wait > 0)
      throw new AppError(429, 'too_many_attempts', 'Too many attempts, try again later', {
        retryAfterSeconds: wait,
      });
    const response = body.response as unknown as AuthenticationResponseJSON;
    const [cred] = await db
      .select()
      .from(webauthnCredentials)
      .where(
        and(
          eq(webauthnCredentials.id, String(response.id)),
          eq(webauthnCredentials.userId, userId),
        ),
      );
    const fail = async () => {
      ctx.mfa.fail(body.challenge);
      ctx.attempts.byIp.fail(ipOf(req) ?? 'unknown');
      await audit(db, `user:${userId}`, 'auth.mfa.failed', `user:${userId}`, {
        ip: ipOf(req),
        via: 'webauthn',
      });
      return new AppError(401, 'invalid_code', 'The security key response was not accepted');
    };
    if (!cred) throw await fail();
    const r = rp();
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: expected,
        expectedOrigin: r.origin,
        expectedRPID: r.id,
        credential: {
          id: cred.id,
          publicKey: fromB64(cred.publicKey),
          counter: cred.counter,
          transports: (cred.transports as string[] | null) ?? undefined,
        },
        requireUserVerification: false,
      });
    } catch {
      throw await fail();
    }
    if (!result.verified) throw await fail();
    // счётчик: повтор старого ответа (клон ключа) отвергается самим протоколом при ненулевых значениях
    await db
      .update(webauthnCredentials)
      .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(webauthnCredentials.id, cred.id));
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u || u.disabledAt)
      throw new AppError(401, 'invalid_challenge', 'The sign-in step expired');
    ctx.mfa.done(body.challenge);
    const s = await createSession(ctx, u.id, ipOf(req), req.headers['user-agent'] ?? null);
    await audit(db, `user:${u.id}`, 'auth.login', `session:${s.id}`, {
      ip: ipOf(req),
      mfa: 'webauthn',
    });
    reply.status(200);
    return { token: s.token, expiresAt: s.expiresAt.toISOString(), user: bundle(u) };
  });
};
