import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { parseTotpInput, totp } from '@arklock/crypto';
import type { AppContext } from '../context.js';
import { mfaBackupCodes, mfaFactors, webauthnCredentials } from '../db/schema.js';

const STEP_MS = 30_000;

const derive = (appSecret: string, info: string): Buffer =>
  Buffer.from(hkdfSync('sha256', appSecret, 'arklock-mfa', info, 32));

/** Шифрование секрета TOTP для хранения (AES-256-GCM, привязка к пользователю). */
export function sealSecret(appSecret: string, userId: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', derive(appSecret, 'totp-secret'), iv);
  c.setAAD(Buffer.from(`totp|${userId}`));
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final(), c.getAuthTag()]);
  return `m1.${iv.toString('base64url')}.${ct.toString('base64url')}`;
}

export function openSecret(appSecret: string, userId: string, sealed: string): string {
  const [v, iv, ct] = sealed.split('.');
  if (v !== 'm1' || !iv || !ct) throw new Error('bad secret format');
  const raw = Buffer.from(ct, 'base64url');
  const d = createDecipheriv(
    'aes-256-gcm',
    derive(appSecret, 'totp-secret'),
    Buffer.from(iv, 'base64url'),
  );
  d.setAAD(Buffer.from(`totp|${userId}`));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8');
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Десять резервных кодов вида abcde-fghjk (около 50 бит каждый). */
export function newBackupCodes(count = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const b = randomBytes(10);
    const chars = Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('');
    out.push(`${chars.slice(0, 5)}-${chars.slice(5)}`);
  }
  return out;
}

const normalizeBackup = (code: string) => code.toLowerCase().replace(/[\s-]/g, '');
export const looksLikeBackup = (code: string) => /^[a-z0-9]{10}$/.test(normalizeBackup(code));

export function backupHash(appSecret: string, userId: string, code: string): string {
  return createHmac('sha256', derive(appSecret, 'backup-code'))
    .update(`${userId}|${normalizeBackup(code)}`)
    .digest('base64url');
}

/** Ожидающие второго фактора входы: токен живёт 5 минут и допускает 5 неверных кодов. */
export class MfaChallenges {
  private readonly items = new Map<string, { userId: string; expiresAt: number; tries: number }>();
  private key = (token: string) => createHash('sha256').update(token).digest('hex');

  issue(userId: string, now = Date.now()): string {
    for (const [k, v] of this.items) if (v.expiresAt <= now) this.items.delete(k);
    const token = `mc_${randomBytes(24).toString('base64url')}`;
    this.items.set(this.key(token), { userId, expiresAt: now + 5 * 60_000, tries: 0 });
    return token;
  }

  /** Вызов WebAuthn, выданный для этого входа (ожидаемое значение при проверке ответа аутентификатора). */
  private readonly webauthn = new Map<string, string>();
  setWebauthn(token: string, challenge: string): void {
    this.webauthn.set(this.key(token), challenge);
  }
  getWebauthn(token: string): string | undefined {
    return this.webauthn.get(this.key(token));
  }

  peek(token: string, now = Date.now()): string | null {
    const r = this.items.get(this.key(token));
    return r && r.expiresAt > now ? r.userId : null;
  }

  fail(token: string): void {
    const k = this.key(token);
    const r = this.items.get(k);
    if (!r) return;
    r.tries++;
    if (r.tries >= 5) this.items.delete(k);
  }

  done(token: string): void {
    this.webauthn.delete(this.key(token));
    this.items.delete(this.key(token));
  }
}

/**
 * Проверка кода второго фактора: TOTP (шаг времени можно использовать один раз) или резервный код (одноразовый).
 * Возвращает вид принятого кода или null.
 */
export async function checkSecondFactor(
  ctx: AppContext,
  userId: string,
  code: string,
  opts: { allowPending?: boolean } = {},
): Promise<'totp' | 'backup' | null> {
  const { db, config } = ctx;
  const [f] = await db.select().from(mfaFactors).where(eq(mfaFactors.userId, userId));
  if (!f || (!f.enabledAt && !opts.allowPending)) return null;
  const clean = code.trim();
  if (/^\d{6}$/.test(clean)) {
    const params = parseTotpInput(openSecret(config.APP_SECRET, userId, f.secretCipher));
    const now = Date.now();
    let step: number | null = null;
    for (let i = -1; i <= 1; i++) {
      if ((await totp(params, now + i * STEP_MS)) === clean) step = Math.floor(now / STEP_MS) + i;
    }
    if (step === null || step <= f.lastStep) return null;
    const moved = await db
      .update(mfaFactors)
      .set({ lastStep: step })
      .where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.lastStep, f.lastStep)))
      .returning({ u: mfaFactors.userId });
    return moved.length ? 'totp' : null;
  }
  if (f.enabledAt && looksLikeBackup(clean)) {
    const used = await db
      .update(mfaBackupCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(mfaBackupCodes.userId, userId),
          eq(mfaBackupCodes.codeHash, backupHash(config.APP_SECRET, userId, clean)),
          isNull(mfaBackupCodes.usedAt),
        ),
      )
      .returning({ id: mfaBackupCodes.id });
    return used.length ? 'backup' : null;
  }
  return null;
}

export type MfaPolicy = 'off' | 'admins' | 'all';

/** Политика обязательного MFA из настроек (короткий кэш, чтобы не читать БД на каждый запрос). */
export async function mfaPolicy(ctx: AppContext, now = Date.now()): Promise<MfaPolicy> {
  if (ctx.mfaPolicyCache && ctx.mfaPolicyCache.until > now) return ctx.mfaPolicyCache.value;
  const rows = await ctx.db.query.settings.findFirst({
    where: (s, { eq: e }) => e(s.key, 'security.mfaRequired'),
  });
  const v = rows?.value;
  const value: MfaPolicy = v === 'admins' || v === 'all' ? v : 'off';
  ctx.mfaPolicyCache = { value, until: now + 3000 };
  return value;
}

export function resetMfaPolicyCache(ctx: AppContext): void {
  ctx.mfaPolicyCache = undefined;
}

/** Включён ли второй фактор TOTP. */
export async function hasTotp(ctx: AppContext, userId: string): Promise<boolean> {
  const [f] = await ctx.db.select().from(mfaFactors).where(eq(mfaFactors.userId, userId));
  return !!f?.enabledAt;
}

export async function hasPasskey(ctx: AppContext, userId: string): Promise<boolean> {
  const rows = await ctx.db
    .select({ id: webauthnCredentials.id })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
    .limit(1);
  return rows.length > 0;
}

/** Есть ли у пользователя какой-либо второй фактор (TOTP или ключ доступа). */
export async function isEnrolled(ctx: AppContext, userId: string): Promise<boolean> {
  return (await hasTotp(ctx, userId)) || (await hasPasskey(ctx, userId));
}

/** Ответ на вход, когда нужен второй фактор: способы подтверждения и одноразовый «вызов» без сессии. */
export async function mfaChallenge(ctx: AppContext, userId: string) {
  return {
    mfaRequired: true as const,
    challenge: ctx.mfa.issue(userId),
    methods: { totp: await hasTotp(ctx, userId), webauthn: await hasPasskey(ctx, userId) },
  };
}
