import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateTotpSecret, otpauthUri } from '@arklock/crypto';
import { authKey, mfaVerifyRequest, uuid } from '@arklock/contracts';
import type { SessionResponse } from '@arklock/contracts';
import { audit } from '../audit.js';
import { notifySecurity } from '../mail/send.js';
import {
  backupHash,
  checkSecondFactor,
  hasTotp,
  hasPasskey,
  mfaPolicy,
  newBackupCodes,
  sealSecret,
} from '../auth/mfa.js';
import { adminGate } from '../auth/adminperm.js';
import { authOf, createSession, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { mfaBackupCodes, mfaFactors, users, webauthnCredentials } from '../db/schema.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';
import { verifyProof } from '../security.js';
import { bundle } from './auth.js';

const ipOf = (req: FastifyRequest) => req.ip ?? null;
const code = z.string().min(6).max(12);

export const registerMfaRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, config } = ctx;
  const auth = requireAuth(ctx);

  function throttle(userId: string): void {
    const wait = ctx.attempts.byEmail.retryAfter(`mfa:${userId}`);
    if (wait > 0)
      throw new AppError(429, 'too_many_attempts', 'Too many attempts, try again later', {
        retryAfterSeconds: wait,
      });
  }

  const checkCode = async (userId: string, value: string, allowPending = false) => {
    throttle(userId);
    const kind = await checkSecondFactor(ctx, userId, value, { allowPending });
    if (!kind) {
      ctx.attempts.byEmail.fail(`mfa:${userId}`);
      throw new AppError(401, 'invalid_code', 'The code is invalid or already used');
    }
    ctx.attempts.byEmail.reset(`mfa:${userId}`);
    return kind;
  };

  function checkPassword(u: typeof users.$inferSelect, key: string): void {
    throttle(u.id);
    if (!verifyProof(u.authSalt, key, u.authHash)) {
      ctx.attempts.byEmail.fail(`mfa:${u.id}`);
      throw new AppError(401, 'invalid_credentials', 'Invalid master password');
    }
  }

  async function issueBackupCodes(userId: string): Promise<string[]> {
    const codes = newBackupCodes();
    await db.transaction(async (tx) => {
      await tx.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, userId));
      await tx.insert(mfaBackupCodes).values(
        codes.map((c) => ({
          id: crypto.randomUUID(),
          userId,
          codeHash: backupHash(config.APP_SECRET, userId, c),
        })),
      );
    });
    return codes;
  }

  /** Состояние второго фактора текущего пользователя и действующая политика. */
  app.get('/auth/mfa', { preHandler: auth }, async (req) => {
    const { user } = authOf(req);
    const enabled = await hasTotp(ctx, user.id);
    const remaining = enabled
      ? (
          await db
            .select({ id: mfaBackupCodes.id })
            .from(mfaBackupCodes)
            .where(and(eq(mfaBackupCodes.userId, user.id), isNull(mfaBackupCodes.usedAt)))
        ).length
      : 0;
    const policy = await mfaPolicy(ctx);
    const passkeys = await hasPasskey(ctx, user.id);
    return {
      enabled,
      passkeys,
      backupCodesRemaining: remaining,
      policy,
      required: policy === 'all' || (policy === 'admins' && user.role === 'admin'),
    };
  });

  /** Начало настройки: новый секрет; пока код не подтверждён, вход его не требует. */
  app.post('/auth/mfa/setup', { preHandler: auth }, async (req) => {
    const { user } = authOf(req);
    if (await hasTotp(ctx, user.id))
      throw new AppError(409, 'mfa_already_enabled', 'Two-factor authentication is already on');
    const secret = generateTotpSecret();
    const sealed = sealSecret(config.APP_SECRET, user.id, secret);
    await db
      .insert(mfaFactors)
      .values({ userId: user.id, secretCipher: sealed })
      .onConflictDoUpdate({
        target: mfaFactors.userId,
        set: { secretCipher: sealed, enabledAt: null, lastStep: 0 },
      });
    return { secret, uri: otpauthUri('Arklock', user.email, { secret }) };
  });

  /** Подтверждение настройки кодом из приложения; в ответе — резервные коды (показываются один раз). */
  app.post('/auth/mfa/enable', { preHandler: auth }, async (req) => {
    const { user } = authOf(req);
    const body = parse(z.object({ code }), req.body);
    if (await hasTotp(ctx, user.id))
      throw new AppError(409, 'mfa_already_enabled', 'Two-factor authentication is already on');
    await checkCode(user.id, body.code, true);
    await db
      .update(mfaFactors)
      .set({ enabledAt: new Date() })
      .where(eq(mfaFactors.userId, user.id));
    const backupCodes = await issueBackupCodes(user.id);
    await audit(db, `user:${user.id}`, 'auth.mfa.enable', `user:${user.id}`);
    void notifySecurity(
      ctx,
      user.id,
      'Arklock: включена двухфакторная аутентификация',
      'К вашей учётной записи подключено приложение-аутентификатор. Если это были не вы — срочно обратитесь к администратору.\n\nAn authenticator app was added to your account. If this was not you, contact your administrator immediately.',
    );
    return { backupCodes };
  });

  /** Отключение: нужен мастер-пароль и действующий код. Запрещено, если политика требует MFA. */
  app.post('/auth/mfa/disable', { preHandler: auth }, async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(z.object({ authKey, code }), req.body);
    checkPassword(user, body.authKey);
    const policy = await mfaPolicy(ctx);
    if (policy === 'all' || (policy === 'admins' && user.role === 'admin'))
      throw new AppError(403, 'mfa_required_by_policy', 'Two-factor authentication is required');
    await checkCode(user.id, body.code);
    await db.delete(mfaFactors).where(eq(mfaFactors.userId, user.id));
    await db.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, user.id));
    await audit(db, `user:${user.id}`, 'auth.mfa.disable', `user:${user.id}`);
    void notifySecurity(
      ctx,
      user.id,
      'Arklock: отключена двухфакторная аутентификация',
      'Приложение-аутентификатор отключено в вашей учётной записи. Если это были не вы — срочно обратитесь к администратору.\n\nThe authenticator app was removed from your account. If this was not you, contact your administrator immediately.',
    );
    return reply.status(204).send();
  });

  /** Новые резервные коды (прежние перестают действовать). */
  app.post('/auth/mfa/backup-codes', { preHandler: auth }, async (req) => {
    const { user } = authOf(req);
    const body = parse(z.object({ authKey, code }), req.body);
    checkPassword(user, body.authKey);
    if (!(await hasTotp(ctx, user.id)))
      throw new AppError(409, 'mfa_not_enabled', 'Two-factor authentication is off');
    await checkCode(user.id, body.code);
    const backupCodes = await issueBackupCodes(user.id);
    await audit(db, `user:${user.id}`, 'auth.mfa.backup-codes', `user:${user.id}`);
    void notifySecurity(
      ctx,
      user.id,
      'Arklock: выпущены новые резервные коды',
      'Для вашей учётной записи выпущены новые резервные коды, прежние недействительны.\n\nNew backup codes were issued for your account; the old ones no longer work.',
    );
    return { backupCodes };
  });

  /** Завершение входа после проверки мастер-пароля: код приложения или резервный код. */
  app.post('/auth/mfa/verify', async (req, reply): Promise<SessionResponse> => {
    const body = parse(mfaVerifyRequest, req.body);
    const userId = ctx.mfa.peek(body.challenge);
    if (!userId)
      throw new AppError(401, 'invalid_challenge', 'The sign-in step expired, start again');
    const wait = ctx.attempts.byIp.retryAfter(ipOf(req) ?? 'unknown');
    if (wait > 0)
      throw new AppError(429, 'too_many_attempts', 'Too many attempts, try again later', {
        retryAfterSeconds: wait,
      });
    let kind: 'totp' | 'backup';
    try {
      kind = await checkCode(userId, body.code);
    } catch (e) {
      ctx.mfa.fail(body.challenge);
      ctx.attempts.byIp.fail(ipOf(req) ?? 'unknown');
      await audit(db, `user:${userId}`, 'auth.mfa.failed', `user:${userId}`, { ip: ipOf(req) });
      throw e;
    }
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u || u.disabledAt)
      throw new AppError(401, 'invalid_challenge', 'The sign-in step expired');
    ctx.mfa.done(body.challenge);
    const s = await createSession(ctx, u.id, ipOf(req), req.headers['user-agent'] ?? null);
    await audit(db, `user:${u.id}`, 'auth.login', `session:${s.id}`, { ip: ipOf(req), mfa: kind });
    reply.status(200);
    return { token: s.token, expiresAt: s.expiresAt.toISOString(), user: await bundle(ctx, u) };
  });

  /** Сброс второго фактора администратором (потеря устройства и резервных кодов). */
  app.post('/admin/users/:id/mfa-reset', { preHandler: auth }, async (req, reply) => {
    const { user } = authOf(req);
    await adminGate(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [target] = await db.select().from(users).where(eq(users.id, id));
    if (!target) throw notFound();
    // делегированный администратор не затрагивает полных администраторов
    if (target.role === 'admin' && user.role !== 'admin') throw forbidden();
    await db.delete(mfaFactors).where(eq(mfaFactors.userId, id));
    await db.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, id));
    // ключи доступа — такой же второй фактор: без их удаления сброс не снял бы требование кода при входе
    await db.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, id));
    await audit(db, `user:${user.id}`, 'admin.mfa.reset', `user:${id}`);
    void notifySecurity(
      ctx,
      id,
      'Arklock: сброшен второй фактор',
      'Администратор сбросил второй фактор вашей учётной записи. Настройте его заново.\n\nAn administrator reset the second factor of your account. Set it up again.',
    );
    return reply.status(204).send();
  });
};
