import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { settings, users } from '../db/schema.js';
import { openSetting } from '../secretbox.js';
import { smtpSession, type SmtpConfig } from './smtp.js';

export const SMTP_KEY = 'smtp.config';
export const SMTP_PURPOSE = 'smtp-password';

export interface StoredSmtp {
  host: string;
  port: number;
  security: SmtpConfig['security'];
  user: string;
  passwordCipher: string;
  from: string;
}

export async function loadStoredSmtp(ctx: AppContext): Promise<StoredSmtp | null> {
  const [row] = await ctx.db.select().from(settings).where(eq(settings.key, SMTP_KEY));
  return (row?.value as StoredSmtp | undefined) ?? null;
}

export function toSmtpConfig(ctx: AppContext, s: StoredSmtp): SmtpConfig {
  return {
    host: s.host,
    port: s.port,
    security: s.security,
    user: s.user,
    from: s.from,
    password: s.passwordCipher
      ? openSetting(ctx.config.APP_SECRET, SMTP_PURPOSE, s.passwordCipher)
      : '',
    allowSelfSigned: ctx.config.NODE_ENV === 'test',
  };
}

/**
 * Отправка письма, если почта настроена. Сбой не прерывает вызывающее действие: возвращает false.
 * В письма не попадают пароли, ключи и содержимое записей — только сведения о событии.
 */
export async function sendMail(
  ctx: AppContext,
  to: string,
  subject: string,
  text: string,
): Promise<boolean> {
  try {
    const s = await loadStoredSmtp(ctx);
    if (!s) return false;
    await smtpSession(toSmtpConfig(ctx, s), { to, subject, text });
    return true;
  } catch {
    return false;
  }
}

/** Уведомление пользователю о событии безопасности его учётной записи (если включено в настройках и настроена почта). */
export async function notifySecurity(
  ctx: AppContext,
  userId: string,
  subject: string,
  text: string,
): Promise<void> {
  const [flag] = await ctx.db
    .select()
    .from(settings)
    .where(eq(settings.key, 'notifications.security'));
  if (flag?.value === false) return;
  const [u] = await ctx.db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (u) await sendMail(ctx, u.email, subject, text);
}
