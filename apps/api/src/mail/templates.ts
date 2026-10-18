import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { settings } from '../db/schema.js';

export const mailType = z.enum(['invitation', 'security', 'test']);
export type MailType = z.infer<typeof mailType>;
export const mailCategory = z.enum([
  'security',
  'password',
  'mfa',
  'tokens',
  'passkeys',
  'invitation',
  'test',
]);
export type MailCategory = z.infer<typeof mailCategory>;
export const templateWrite = z
  .object({
    subject: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine((s) => !/[\r\n\0]/.test(s)),
    text: z
      .string()
      .min(1)
      .max(16 * 1024),
  })
  .strict();
export const MAIL_TEMPLATES_KEY = 'smtp.templates';
export const MAIL_NOTIFICATIONS_KEY = 'smtp.notifications';
export const notificationWrite = z
  .object({
    security: z.boolean(),
    password: z.boolean(),
    mfa: z.boolean(),
    tokens: z.boolean(),
    passkeys: z.boolean(),
    invitation: z.boolean(),
  })
  .strict();
export const DEFAULT_MAIL_NOTIFICATIONS = {
  security: true,
  password: true,
  mfa: true,
  tokens: true,
  passkeys: true,
  invitation: true,
};
const defaults: Record<MailType, z.infer<typeof templateWrite>> = {
  invitation: {
    subject: 'Arklock: приглашение / invitation',
    text: 'Вас пригласили в Arklock. Создайте учётную запись по ссылке (действует {{days}} дн.):\n{{link}}\n\nYou have been invited to Arklock. Create your account here (valid for {{days}} days):\n{{link}}\n',
  },
  security: { subject: '{{subject}}', text: '{{text}}' },
  test: {
    subject: 'Arklock: тестовое письмо',
    text: 'Это тестовое письмо Arklock. Если вы его читаете, отправка почты настроена верно.',
  },
};
export const templateVariables: Record<MailType, { subject: string[]; text: string[] }> = {
  invitation: { subject: ['days'], text: ['link', 'days'] },
  security: { subject: ['subject'], text: ['subject', 'text'] },
  test: { subject: [], text: [] },
};
export function validTemplate(type: MailType, template: z.infer<typeof templateWrite>): boolean {
  return (['subject', 'text'] as const).every((part) => {
    const text = template[part].replace(/\{\{([a-z]+)\}\}/g, (match, name: string) =>
      templateVariables[type][part].includes(name) ? '' : match,
    );
    return !/[{}]/.test(text);
  });
}
export async function loadMailTemplates(ctx: AppContext) {
  const [row] = await ctx.db.select().from(settings).where(eq(settings.key, MAIL_TEMPLATES_KEY));
  const stored = row?.value as Partial<Record<MailType, unknown>> | undefined;
  const templates = { ...defaults };
  for (const type of mailType.options) {
    const parsed = templateWrite.safeParse(stored?.[type]);
    if (parsed.success && validTemplate(type, parsed.data)) templates[type] = parsed.data;
  }
  return templates;
}
export function renderTemplate(
  template: z.infer<typeof templateWrite>,
  values: Record<string, string>,
) {
  const fill = (text: string) =>
    text.replace(/\{\{([a-z]+)\}\}/g, (_, name: string) => values[name] ?? '');
  return { subject: fill(template.subject), text: fill(template.text) };
}
export async function renderMail(
  ctx: AppContext,
  type: MailType,
  values: Record<string, string> = {},
) {
  return renderTemplate((await loadMailTemplates(ctx))[type], values);
}
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function previewTemplate(type: MailType, template: z.infer<typeof templateWrite>) {
  const sample = renderTemplate(template, {
    link: 'https://arklock.example/login?invite=EXAMPLE-NOT-A-REAL-CODE',
    days: '7',
    subject: 'Arklock: настройки безопасности изменены',
    text: 'Настройки безопасности вашей учётной записи изменены. Если это сделали не вы, обратитесь к администратору.\n\nYour account security settings changed. Contact your administrator if you did not make this change.',
  });
  return { id: type, ...sample, html: `<pre>${escapeHtml(sample.text)}</pre>` };
}
export async function mailNotificationPreferences(ctx: AppContext) {
  const rows = await ctx.db.select().from(settings);
  const parsed = notificationWrite
    .partial()
    .safeParse(rows.find((row) => row.key === MAIL_NOTIFICATIONS_KEY)?.value);
  return {
    ...DEFAULT_MAIL_NOTIFICATIONS,
    ...(parsed.success ? parsed.data : {}),
    security: rows.find((row) => row.key === 'notifications.security')?.value !== false,
  };
}
export async function mailCategoryEnabled(ctx: AppContext, category: MailCategory) {
  if (category === 'test') return true;
  const preferences = await mailNotificationPreferences(ctx);
  return category === 'invitation'
    ? preferences.invitation
    : preferences.security && (category === 'security' || preferences[category]);
}
