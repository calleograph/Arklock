import { eq, like, or } from 'drizzle-orm';
import { z } from 'zod';
import { email, uuid } from '@arklock/contracts';
import type { AppContext } from '../context.js';
import { settings } from '../db/schema.js';
import { openSetting } from '../secretbox.js';
import type { SmtpConfig } from './smtp.js';

export const SMTP_KEY = 'smtp.config';
export const SMTP_ACTIVE_KEY = 'smtp.activeProfile';
export const SMTP_PURPOSE = 'smtp-password';
export const smtpProfileId = z.union([z.literal('default'), uuid]);
export const smtpPut = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[^\s/\\\0]+$/),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['none', 'starttls', 'tls']),
  user: z.string().trim().max(200).default(''),
  password: z.string().max(500).optional(),
  from: email,
});
const storedSmtp = smtpPut
  .omit({ password: true })
  .extend({ passwordCipher: z.string().max(2000), name: z.string().max(100).optional() });
export type StoredSmtp = z.infer<typeof storedSmtp> & { profileId?: string };
export const smtpProfileKey = (id: string) => (id === 'default' ? SMTP_KEY : `smtp.profile.${id}`);
export const smtpPasswordPurpose = (id: string) =>
  id === 'default' ? SMTP_PURPOSE : `${SMTP_PURPOSE}:${id}`;

export async function loadSmtpProfile(ctx: AppContext, id: string): Promise<StoredSmtp | null> {
  const [row] = await ctx.db
    .select()
    .from(settings)
    .where(eq(settings.key, smtpProfileKey(id)));
  const parsed = storedSmtp.safeParse(row?.value);
  return parsed.success ? { ...parsed.data, profileId: id } : null;
}
export async function activeSmtpId(ctx: AppContext): Promise<string | null> {
  const [row] = await ctx.db.select().from(settings).where(eq(settings.key, SMTP_ACTIVE_KEY));
  if (!row) return 'default';
  return smtpProfileId.safeParse(row.value).success ? (row.value as string) : null;
}
export async function loadStoredSmtp(ctx: AppContext): Promise<StoredSmtp | null> {
  const id = await activeSmtpId(ctx);
  return id ? loadSmtpProfile(ctx, id) : null;
}
export async function smtpProfiles(ctx: AppContext) {
  const [rows, activeId] = await Promise.all([
    ctx.db
      .select()
      .from(settings)
      .where(or(eq(settings.key, SMTP_KEY), like(settings.key, 'smtp.profile.%'))),
    activeSmtpId(ctx),
  ]);
  const profiles = rows.flatMap((row) => {
    const id = row.key === SMTP_KEY ? 'default' : row.key.slice('smtp.profile.'.length);
    const parsed = storedSmtp.safeParse(row.value);
    return smtpProfileId.safeParse(id).success && parsed.success
      ? [publicSmtp({ ...parsed.data, profileId: id })]
      : [];
  });
  return {
    activeId: profiles.some((profile) => profile.id === activeId) ? activeId : null,
    profiles,
  };
}
export function publicSmtp(s: StoredSmtp) {
  return {
    id: s.profileId ?? 'default',
    name: s.name ?? 'Default',
    host: s.host,
    port: s.port,
    security: s.security,
    user: s.user,
    from: s.from,
    hasPassword: !!s.passwordCipher,
  };
}
export function toSmtpConfig(ctx: AppContext, s: StoredSmtp): SmtpConfig {
  return {
    host: s.host,
    port: s.port,
    security: s.security,
    user: s.user,
    from: s.from,
    password: s.passwordCipher
      ? openSetting(
          ctx.config.APP_SECRET,
          smtpPasswordPurpose(s.profileId ?? 'default'),
          s.passwordCipher,
        )
      : '',
    allowSelfSigned: ctx.config.NODE_ENV === 'test',
  };
}
