import { and, count, eq, inArray, lt, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import { email } from '@arklock/contracts';
import type { AppContext } from '../context.js';
import { mailQueue, settings, users } from '../db/schema.js';
import { openSetting, sealSetting } from '../secretbox.js';
import { activeSmtpId, loadSmtpProfile, toSmtpConfig } from './profiles.js';
import { smtpSession, SmtpError } from './smtp.js';
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
export const MAIL_MAX_ROWS = 1000;
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

export function mailFailure(error: unknown) {
  if (!(error instanceof SmtpError))
    return {
      code: 'error',
      smtpStatus: null,
      retry: false,
      message: 'Mail configuration or delivery failed',
    };
  const smtpStatus = error.smtpStatus ?? null;
  return {
    code: error.code,
    smtpStatus,
    retry: smtpStatus
      ? smtpStatus >= 400 && smtpStatus < 500
      : ['connect', 'closed', 'timeout', 'aborted'].includes(error.code),
    message: error.message,
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
) {
  const payload = payloadSchema.safeParse({ to, subject, text, category });
  if (!payload.success) return null;
  if (!(await mailCategoryEnabled(ctx, category))) return null;
  const profileId = selectedProfile ?? (await activeSmtpId(ctx));
  if (!profileId || !(await loadSmtpProfile(ctx, profileId))) return null;
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
      to: payload.data.to,
      type,
      payloadCipher: sealSetting(ctx.config.APP_SECRET, purpose(id), JSON.stringify(payload.data)),
      expiresAt: new Date(now.getTime() + PAYLOAD_TTL_MS),
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
  try {
    if (claimed.expiresAt <= now) throw new SmtpError('Message expired', 'expired');
    const profile = await loadSmtpProfile(ctx, claimed.profileId);
    if (!profile) throw new SmtpError('SMTP profile was removed', 'profile_removed');
    const payload = payloadSchema.parse(
      JSON.parse(openSetting(ctx.config.APP_SECRET, purpose(claimed.id), claimed.payloadCipher)),
    );
    if (!(await mailCategoryEnabled(ctx, payload.category)))
      throw new SmtpError('This mail category is disabled', 'disabled');
    // shortcut: SMTP cannot atomically commit delivery and this DB row, a crash may resend the same Message-ID.
    await smtpSession(toSmtpConfig(ctx, profile), { ...payload, id: claimed.id }, 15_000, signal);
  } catch (error) {
    outcome = mailFailure(error);
  }
  const retry = !!outcome?.retry && claimed.attempts < MAIL_MAX_ATTEMPTS && claimed.expiresAt > now;
  const finishedAt = new Date();
  await ctx.db
    .update(mailQueue)
    .set({
      status: outcome ? (retry ? 'queued' : 'failed') : 'sent',
      payloadCipher:
        !outcome || ['expired', 'disabled', 'profile_removed'].includes(outcome.code)
          ? ''
          : claimed.payloadCipher,
      lastCode: outcome?.code ?? null,
      lastSmtpStatus: outcome?.smtpStatus ?? null,
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
): Promise<boolean> {
  try {
    const id = await enqueueMail(ctx, to, subject, text, type, undefined, category);
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
