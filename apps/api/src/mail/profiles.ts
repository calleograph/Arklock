import { X509Certificate } from 'node:crypto';
import { eq, like, or } from 'drizzle-orm';
import { z } from 'zod';
import { email, uuid } from '@arklock/contracts';
import type { AppContext } from '../context.js';
import { settings } from '../db/schema.js';
import { openSetting } from '../secretbox.js';
import type { SmtpConfig } from './smtp.js';
import { isForbiddenSmtpPort } from './target.js';
import { mailType } from './templates.js';

export const SMTP_KEY = 'smtp.config';
export const SMTP_ACTIVE_KEY = 'smtp.activeProfile';
export const SMTP_PURPOSE = 'smtp-password';
export const SMTP_CA_KEY = 'smtp.trustedCas';
export const smtpProfileId = z.union([z.literal('default'), uuid]);

const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[^\s/\\\0]+$/);
export const smtpPut = z.object({
  host,
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .refine((p) => !isForbiddenSmtpPort(p), 'port_not_allowed'),
  security: z.enum(['none', 'starttls', 'tls']),
  /** Без поля: прежнее поведение — вход по логину, если он указан. */
  auth: z.enum(['none', 'password', 'ntlm']).optional(),
  user: z.string().trim().max(200).default(''),
  password: z.string().max(500).optional(),
  from: email,
  fromName: z
    .string()
    .trim()
    .max(200)
    .refine((s) => !/[\r\n\0]/.test(s))
    .default(''),
  timeoutSec: z.number().int().min(3).max(120).default(15),
  /** Проверка сертификата сервера. Отключить может только главный администратор (подтверждение паролем, запись в журнале). */
  verifyCert: z.boolean().default(true),
  /** Доверенный центр сертификации из хранилища; пусто — только системные. */
  caId: uuid.nullable().default(null),
  /** Типы писем, которые уходят через этот профиль; пусто — только как активный по умолчанию. */
  purposes: z.array(mailType).max(8).default([]),
  /** Резервный: используется, когда активный недоступен по соединению. */
  fallback: z.boolean().default(false),
});
const storedSmtp = smtpPut
  .omit({ password: true })
  .extend({ passwordCipher: z.string().max(2000), name: z.string().max(100).optional() });
export type StoredSmtp = z.infer<typeof storedSmtp> & { profileId?: string };
export const smtpProfileKey = (id: string) => (id === 'default' ? SMTP_KEY : `smtp.profile.${id}`);
export const smtpPasswordPurpose = (id: string) =>
  id === 'default' ? SMTP_PURPOSE : `${SMTP_PURPOSE}:${id}`;
export const smtpStatusKey = (id: string) => `smtp.status.${id}`;

/** Способ входа профиля: у профилей, сохранённых до появления выбора, он определяется логином. */
export const authOf = (s: Pick<StoredSmtp, 'auth' | 'user'>): 'none' | 'password' | 'ntlm' =>
  s.auth ?? (s.user ? 'password' : 'none');

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

export interface SmtpStatus {
  checkedAt: string | null;
  ok: boolean | null;
  /** Этап, на котором проверка остановилась, и код причины. */
  stage: string | null;
  code: string | null;
  lastSuccessAt: string | null;
}
const statusSchema = z.object({
  checkedAt: z.string().nullable(),
  ok: z.boolean().nullable(),
  stage: z.string().nullable(),
  code: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
});
export async function smtpStatus(ctx: AppContext, id: string): Promise<SmtpStatus> {
  const [row] = await ctx.db
    .select()
    .from(settings)
    .where(eq(settings.key, smtpStatusKey(id)));
  const parsed = statusSchema.safeParse(row?.value);
  return parsed.success
    ? parsed.data
    : { checkedAt: null, ok: null, stage: null, code: null, lastSuccessAt: null };
}
/** Результат последней проверки соединения или доставки: показывается на карточке профиля. */
export async function recordSmtpStatus(
  ctx: AppContext,
  id: string,
  result: { ok: boolean; stage?: string | null; code?: string | null },
  now = new Date(),
): Promise<void> {
  const previous = await smtpStatus(ctx, id);
  const value: SmtpStatus = {
    checkedAt: now.toISOString(),
    ok: result.ok,
    stage: result.ok ? null : (result.stage ?? null),
    code: result.ok ? null : (result.code ?? null),
    lastSuccessAt: result.ok ? now.toISOString() : previous.lastSuccessAt,
  };
  await ctx.db
    .insert(settings)
    .values({ key: smtpStatusKey(id), value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

/** Все сохранённые профили (с паролем в виде шифртекста): для выбора по назначению и резервных. */
export async function allStoredSmtp(ctx: AppContext): Promise<StoredSmtp[]> {
  const rows = await ctx.db
    .select()
    .from(settings)
    .where(or(eq(settings.key, SMTP_KEY), like(settings.key, 'smtp.profile.%')));
  return rows.flatMap((row) => {
    const id = row.key === SMTP_KEY ? 'default' : row.key.slice('smtp.profile.'.length);
    const parsed = storedSmtp.safeParse(row.value);
    return smtpProfileId.safeParse(id).success && parsed.success
      ? [{ ...parsed.data, profileId: id }]
      : [];
  });
}

/** Профиль для письма этого типа: назначенный на тип, иначе активный по умолчанию. */
export async function profileIdFor(ctx: AppContext, type: string): Promise<string | null> {
  const all = await allStoredSmtp(ctx);
  const named = all
    .filter((p) => !p.fallback && (p.purposes as string[]).includes(type))
    .sort((a, b) => (a.profileId ?? '').localeCompare(b.profileId ?? ''))[0];
  return named?.profileId ?? (await activeSmtpId(ctx));
}

export async function smtpProfiles(ctx: AppContext) {
  const [rows, activeId, cas] = await Promise.all([
    ctx.db
      .select()
      .from(settings)
      .where(or(eq(settings.key, SMTP_KEY), like(settings.key, 'smtp.profile.%'))),
    activeSmtpId(ctx),
    loadTrustedCas(ctx),
  ]);
  const profiles = await Promise.all(
    rows.flatMap((row) => {
      const id = row.key === SMTP_KEY ? 'default' : row.key.slice('smtp.profile.'.length);
      const parsed = storedSmtp.safeParse(row.value);
      return smtpProfileId.safeParse(id).success && parsed.success
        ? [
            smtpStatus(ctx, id).then((status) => ({
              ...publicSmtp({ ...parsed.data, profileId: id }),
              caName: cas.find((c) => c.id === parsed.data.caId)?.name ?? null,
              status,
            })),
          ]
        : [];
    }),
  );
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
    auth: authOf(s),
    user: s.user,
    from: s.from,
    fromName: s.fromName,
    timeoutSec: s.timeoutSec,
    verifyCert: s.verifyCert,
    caId: s.caId,
    purposes: s.purposes,
    fallback: s.fallback,
    hasPassword: !!s.passwordCipher,
  };
}

/** Доверенные центры сертификации для проверки SMTP-серверов организации (внутренний CA). */
export const trustedCa = z.object({
  id: uuid,
  name: z.string().max(100),
  pem: z.string().max(100_000),
  subject: z.string().max(500),
  fingerprint256: z.string().max(200),
  validTo: z.string().max(40),
  addedAt: z.string().max(40),
});
export type TrustedCa = z.infer<typeof trustedCa>;
export async function loadTrustedCas(ctx: AppContext): Promise<TrustedCa[]> {
  const [row] = await ctx.db.select().from(settings).where(eq(settings.key, SMTP_CA_KEY));
  const parsed = z.array(trustedCa).safeParse(row?.value);
  return parsed.success ? parsed.data : [];
}
/** Разбор PEM: только сертификаты центра сертификации, до 10 на файл. */
export function parseCaPem(pem: string): {
  pem: string;
  subject: string;
  fingerprint256: string;
  validTo: string;
}[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.slice(0, 10).flatMap((block) => {
    try {
      const c = new X509Certificate(block);
      if (!c.ca) return [];
      return [
        {
          pem: block,
          subject: c.subject.replace(/\n/g, ', ').slice(0, 500),
          fingerprint256: c.fingerprint256,
          validTo: new Date(c.validTo).toISOString(),
        },
      ];
    } catch {
      return [];
    }
  });
}

/** Адреса самого хоста допускаются только явной настройкой сервера (и в тестовом стенде). */
export const loopbackAllowed = (ctx: AppContext): boolean =>
  ctx.config.NODE_ENV === 'test' || ctx.config.SMTP_ALLOW_LOOPBACK === 'on';

export async function toSmtpConfig(ctx: AppContext, s: StoredSmtp): Promise<SmtpConfig> {
  const cas = s.caId ? await loadTrustedCas(ctx) : [];
  const ca = cas.find((c) => c.id === s.caId);
  return {
    host: s.host,
    port: s.port,
    security: s.security,
    auth: authOf(s),
    user: s.user,
    from: s.from,
    fromName: s.fromName || undefined,
    timeoutMs: s.timeoutSec * 1000,
    verifyCert: s.verifyCert,
    ca: ca ? [ca.pem] : undefined,
    password: s.passwordCipher
      ? openSetting(
          ctx.config.APP_SECRET,
          smtpPasswordPurpose(s.profileId ?? 'default'),
          s.passwordCipher,
        )
      : '',
    allowLoopback: loopbackAllowed(ctx),
  };
}
