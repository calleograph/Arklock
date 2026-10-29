import { and, count, eq, inArray, lt, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import { email } from '@arklock/contracts';
import type { AppContext } from '../context.js';
import { mailQueue, settings, users } from '../db/schema.js';
import { openSetting, sealSetting } from '../secretbox.js';
import {
  allStoredSmtp,
  loadSmtpProfile,
  profileIdFor,
  recordSmtpStatus,
  toSmtpConfig,
  type StoredSmtp,
} from './profiles.js';
import { serverText, smtpSession, SmtpError } from './smtp.js';
import {
  mailCategory,
  mailCategoryEnabled,
  renderMail,
  type MailCategory,
  type MailType,
} from './templates.js';
export {
  SMTP_KEY,
  SMTP_PURPOSE,
  loadStoredSmtp,
  toSmtpConfig,
  type StoredSmtp,
} from './profiles.js';

export const MAIL_MAX_ATTEMPTS = 5;
export const MAIL_MAX_ROWS = 5000;
const LEASE_MS = 5 * 60_000;
const PAYLOAD_TTL_MS = 24 * 3_600_000;
const payloadSchema = z.object({
  to: email,
  subject: z
    .string()
    .max(300)
    .refine((s) => !/[\r\n\0]/.test(s)),
  text: z.string().max(64 * 1024),
  category: mailCategory,
});
const purpose = (id: string) => `mail-queue:${id}`;

/** Причины, при которых повтор имеет смысл: сервер временно занят или недоступен. Остальное исправляет администратор. */
export const RETRYABLE = new Set([
  'temporary',
  'limit',
  'connect',
  'timeout',
  'closed',
  'aborted',
  'dns',
]);
/** Сбои соединения: тут помогает резервный профиль. */
const CONNECTION = new Set(['connect', 'timeout', 'closed', 'dns']);
/** Причины, которые говорят о самом профиле (а не об одном адресате). */
const PROFILE_LEVEL = new Set([
  'dns',
  'connect',
  'timeout',
  'closed',
  'tls',
  'certificate',
  'starttls',
  'auth_failed',
  'auth_unsupported',
  'auth_ntlm',
  'protocol',
  'sender_rejected',
  'relay_denied',
  'forbidden_target',
  'forbidden_port',
]);

export function mailFailure(error: unknown) {
  if (!(error instanceof SmtpError))
    return {
      code: 'error',
      smtpStatus: null as number | null,
      retry: false,
      message: 'Mail configuration or delivery failed',
      stage: null as string | null,
      text: null as string | null,
    };
  const smtpStatus = error.smtpStatus ?? null;
  return {
    code: error.code,
    smtpStatus,
    retry: RETRYABLE.has(error.code),
    message: error.message,
    stage: error.stage ?? null,
    text: error.serverText ?? null,
  };
}

/** Bodies (including activation links) are encrypted at rest and erased after delivery or expiry. */
export async function enqueueMail(
  ctx: AppContext,
  to: string,
  subject: string,
  text: string,
  type: MailType = 'security',
  selectedProfile?: string,
  category: MailCategory = type,
  /** Срок, после которого письмо бессмысленно (ссылка приглашения, код): позже оно не отправляется и не повторяется. */
  validUntil?: Date,
) {
  const payload = payloadSchema.safeParse({ to, subject, text, category });
  if (!payload.success) return null;
  if (!(await mailCategoryEnabled(ctx, category))) return null;
  const profileId = selectedProfile ?? (await profileIdFor(ctx, type));
  const stored = profileId ? await loadSmtpProfile(ctx, profileId) : null;
  if (!profileId || !stored) return null;
  const now = new Date();
  const id = crypto.randomUUID();
  return ctx.db.transaction(async (tx) => {
    await tx.insert(settings).values({ key: 'smtp.queueGuard', value: true }).onConflictDoNothing();
    await tx
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.key, 'smtp.queueGuard'))
      .for('update');
    const [total] = await tx.select({ n: count() }).from(mailQueue);
    if ((total?.n ?? 0) >= MAIL_MAX_ROWS) {
      const [old] = await tx
        .select({ id: mailQueue.id })
        .from(mailQueue)
        .where(inArray(mailQueue.status, ['sent', 'failed']))
        .orderBy(mailQueue.createdAt)
        .limit(1);
      if (!old) return null;
      await tx.delete(mailQueue).where(eq(mailQueue.id, old.id));
    }
    await tx.insert(mailQueue).values({
      id,
      profileId,
      profileName: stored.name ?? null,
      category,
      to: payload.data.to,
      type,
      payloadCipher: sealSetting(ctx.config.APP_SECRET, purpose(id), JSON.stringify(payload.data)),
      expiresAt: new Date(
        Math.min(now.getTime() + PAYLOAD_TTL_MS, validUntil?.getTime() ?? Infinity),
      ),
      nextAttemptAt: now,
    });
    return id;
  });
}

async function deliverOne(ctx: AppContext, now: Date, onlyId?: string, signal?: AbortSignal) {
  const claimed = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(mailQueue)
      .where(
        and(
          onlyId ? eq(mailQueue.id, onlyId) : undefined,
          or(
            and(eq(mailQueue.status, 'queued'), lte(mailQueue.nextAttemptAt, now)),
            and(
              eq(mailQueue.status, 'sending'),
              lt(mailQueue.lockedAt, new Date(now.getTime() - LEASE_MS)),
            ),
          ),
        ),
      )
      .orderBy(mailQueue.nextAttemptAt)
      .limit(1)
      .for('update', { skipLocked: true });
    if (!row) return null;
    const lockToken = crypto.randomUUID();
    const [claimed] = await tx
      .update(mailQueue)
      .set({
        status: 'sending',
        attempts: row.attempts + 1,
        lockToken,
        lockedAt: now,
        updatedAt: now,
      })
      .where(eq(mailQueue.id, row.id))
      .returning();
    return claimed!;
  });
  if (!claimed) return false;
  let outcome: ReturnType<typeof mailFailure> | null = null;
  let used: { id: string; name: string | null } = {
    id: claimed.profileId,
    name: claimed.profileName,
  };
  let accepted: { ref: string | null; messageId: string } | null = null;
  try {
    if (claimed.expiresAt <= now) throw new SmtpError('Message expired', 'expired');
    const profile = await loadSmtpProfile(ctx, claimed.profileId);
    if (!profile) throw new SmtpError('SMTP profile was removed', 'profile_removed');
    const payload = payloadSchema.parse(
      JSON.parse(openSetting(ctx.config.APP_SECRET, purpose(claimed.id), claimed.payloadCipher)),
    );
    if (!(await mailCategoryEnabled(ctx, payload.category)))
      throw new SmtpError('This mail category is disabled', 'disabled');
    const attempt = (p: StoredSmtp) =>
      toSmtpConfig(ctx, p).then((cfg) =>
        smtpSession(cfg, { ...payload, id: claimed.id }, { signal }),
      );
    used = { id: claimed.profileId, name: profile.name ?? null };
    let result;
    try {
      // shortcut: SMTP cannot atomically commit delivery and this DB row, a crash may resend the same Message-ID.
      result = await attempt(profile);
    } catch (error) {
      // сбой соединения с основным профилем: один раз пробуем резервный, в журнале остаётся тот, что принял письмо
      const backup =
        error instanceof SmtpError && CONNECTION.has(error.code)
          ? (await allStoredSmtp(ctx)).find((p) => p.fallback && p.profileId !== claimed.profileId)
          : undefined;
      if (!backup) throw error;
      await recordSmtpStatus(ctx, claimed.profileId, {
        ok: false,
        stage: (error as SmtpError).stage,
        code: (error as SmtpError).code,
      });
      result = await attempt(backup);
      used = { id: backup.profileId!, name: backup.name ?? null };
    }
    accepted = { ref: result.accepted?.ref ?? null, messageId: result.accepted?.messageId ?? '' };
    await recordSmtpStatus(ctx, used.id, { ok: true });
  } catch (error) {
    outcome = mailFailure(error);
    if (PROFILE_LEVEL.has(outcome.code))
      await recordSmtpStatus(ctx, used.id, { ok: false, stage: outcome.stage, code: outcome.code });
  }
  const retry = !!outcome?.retry && claimed.attempts < MAIL_MAX_ATTEMPTS && claimed.expiresAt > now;
  const finishedAt = new Date();
  await ctx.db
    .update(mailQueue)
    .set({
      status: outcome ? (retry ? 'queued' : 'failed') : 'sent',
      profileId: used.id,
      profileName: used.name,
      payloadCipher:
        !outcome || ['expired', 'disabled', 'profile_removed'].includes(outcome.code)
          ? ''
          : claimed.payloadCipher,
      lastCode: outcome?.code ?? null,
      lastSmtpStatus: outcome?.smtpStatus ?? null,
      lastStage: outcome?.stage ?? null,
      lastText: outcome ? serverText(outcome.text ?? outcome.message, '', 300) : null,
      messageId: accepted?.messageId || claimed.messageId,
      smtpRef: accepted?.ref ?? null,
      nextAttemptAt: retry
        ? new Date(
            finishedAt.getTime() + Math.min(15 * 60_000, 60_000 * 2 ** (claimed.attempts - 1)),
          )
        : finishedAt,
      deliveredAt: outcome ? null : finishedAt,
      updatedAt: finishedAt,
      lockToken: null,
      lockedAt: null,
    })
    .where(and(eq(mailQueue.id, claimed.id), eq(mailQueue.lockToken, claimed.lockToken!)));
  return true;
}

export async function deliverQueuedMail(ctx: AppContext, now = new Date(), signal?: AbortSignal) {
  await ctx.db
    .update(mailQueue)
    .set({
      payloadCipher: '',
      status: 'failed',
      lastCode: 'expired',
      lockToken: null,
      lockedAt: null,
      updatedAt: now,
    })
    .where(
      and(lt(mailQueue.expiresAt, now), inArray(mailQueue.status, ['queued', 'sending', 'failed'])),
    );
  await ctx.db
    .delete(mailQueue)
    .where(
      and(
        lt(mailQueue.createdAt, new Date(now.getTime() - 30 * 86_400_000)),
        inArray(mailQueue.status, ['sent', 'failed']),
      ),
    );
  for (let i = 0; i < 5 && !signal?.aborted; i++)
    if (!(await deliverOne(ctx, now, undefined, signal))) break;
}

/** false still means not delivered; a transient failure remains visible and retries through the durable queue. */
export async function sendMail(
  ctx: AppContext,
  to: string,
  subject: string,
  text: string,
  type: MailType = 'security',
  category: MailCategory = type,
  validUntil?: Date,
): Promise<boolean> {
  try {
    const id = await enqueueMail(ctx, to, subject, text, type, undefined, category, validUntil);
    if (!id) return false;
    const row = await sendQueuedMail(ctx, id);
    return row?.status === 'sent';
  } catch {
    return false;
  }
}

export async function sendQueuedMail(ctx: AppContext, id: string) {
  await deliverOne(ctx, new Date(), id);
  const [row] = await ctx.db
    .select({
      id: mailQueue.id,
      status: mailQueue.status,
      lastCode: mailQueue.lastCode,
      smtpStatus: mailQueue.lastSmtpStatus,
      stage: mailQueue.lastStage,
      text: mailQueue.lastText,
      messageId: mailQueue.messageId,
      smtpRef: mailQueue.smtpRef,
      profileId: mailQueue.profileId,
      profileName: mailQueue.profileName,
      attempts: mailQueue.attempts,
    })
    .from(mailQueue)
    .where(eq(mailQueue.id, id));
  return row;
}

export async function notifySecurity(
  ctx: AppContext,
  userId: string,
  subject: string,
  text: string,
  category: MailCategory = 'security',
): Promise<void> {
  const [flag] = await ctx.db
    .select()
    .from(settings)
    .where(eq(settings.key, 'notifications.security'));
  if (flag?.value === false) return;
  const [user] = await ctx.db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (user?.email) {
    const rendered = await renderMail(ctx, 'security', { subject, text });
    await sendMail(ctx, user.email, rendered.subject, rendered.text, 'security', category);
  }
}
