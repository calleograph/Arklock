import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { settings } from '../db/schema.js';
import { AppError, parse } from '../errors.js';
import { assertSafeUrl, safeGet, UnsafeUrlError } from '../net/safeFetch.js';
import { AttemptLimiter } from '../rateLimit.js';

export const DEFAULT_RANGE_URL = 'https://api.pwnedpasswords.com/range/';

/** Проверка адреса сервиса проверки утечек при сохранении настройки. */
export function validateRangeUrl(raw: string, allowInsecure = false): string {
  const url = assertSafeUrl(raw, allowInsecure);
  if (!url.pathname.endsWith('/')) throw new UnsafeUrlError('the address must end with a slash');
  return url.toString();
}

/**
 * Проверка скомпрометированных паролей по k-anonymity: клиент вычисляет SHA-1 пароля и передаёт только первые 5 символов.
 * Запрос к внешнему сервису выполняет сервер по адресу из настроек (защищён от SSRF), поэтому IP пользователей сервису не виден.
 */
export const registerSecurityRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db, config } = ctx;
  const limiter = new AttemptLimiter(600, 60_000);
  const insecure = config.NODE_ENV === 'test';

  async function rangeUrl(): Promise<string> {
    const [s] = await db.select().from(settings).where(eq(settings.key, 'security.rangeUrl'));
    return typeof s?.value === 'string' ? s.value : DEFAULT_RANGE_URL;
  }

  async function query(prefix: string, base?: string) {
    const url = validateRangeUrl(base ?? (await rangeUrl()), insecure) + prefix;
    return safeGet(url, {
      headers: { 'Add-Padding': 'true' },
      allowInsecureForTests: insecure,
      maxBytes: 1024 * 1024,
    });
  }

  app.get('/security/range/:prefix', { preHandler: requireAuth(ctx) }, async (req, reply) => {
    const { user } = authOf(req);
    const { prefix } = parse(
      z.object({ prefix: z.string().regex(/^[0-9A-Fa-f]{5}$/) }),
      req.params,
    );
    if (limiter.retryAfter(user.id) > 0)
      throw new AppError(429, 'too_many_attempts', 'Too many requests');
    limiter.fail(user.id);
    try {
      const res = await query(prefix.toUpperCase());
      if (res.status !== 200)
        throw new AppError(502, 'range_unavailable', 'The breach-check service returned an error');
      return reply.type('text/plain; charset=utf-8').send(res.body);
    } catch (e) {
      if (e instanceof AppError) throw e;
      // Недоступность — не «пароль безопасен»: клиент получает явную ошибку и показывает «не удалось проверить».
      throw new AppError(502, 'range_unavailable', 'The breach-check service is unavailable');
    }
  });

  // ---- администрирование адреса

  const adminOnly = async (req: FastifyRequest) => {
    await adminGate(ctx, req);
  };

  app.get('/admin/security/range', { preHandler: [requireAuth(ctx), adminOnly] }, async () => ({
    url: await rangeUrl(),
    default: DEFAULT_RANGE_URL,
  }));

  /** Проверка соединения: тестовый запрос по известному префиксу и проверка формата ответа. До сохранения адрес не применяется. */
  app.post(
    '/admin/security/range/test',
    { preHandler: [requireAuth(ctx), adminOnly] },
    async (req) => {
      const { url } = parse(z.object({ url: z.string().max(500) }), req.body);
      try {
        validateRangeUrl(url, insecure);
        const res = await query('5BAA6', url);
        if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
        const lines = res.body
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const valid = lines.length > 100 && lines.every((l) => /^[0-9A-F]{35}:\d+$/i.test(l));
        return valid
          ? { ok: true, lines: lines.length }
          : { ok: false, reason: 'unexpected response format' };
      } catch (e) {
        return { ok: false, reason: e instanceof UnsafeUrlError ? e.message : 'connection failed' };
      }
    },
  );

  app.put('/admin/security/range', { preHandler: [requireAuth(ctx), adminOnly] }, async (req) => {
    const { user } = authOf(req);
    const { url } = parse(z.object({ url: z.string().max(500) }), req.body);
    let normalized: string;
    try {
      normalized = validateRangeUrl(url, insecure);
    } catch (e) {
      throw new AppError(400, 'invalid_url', e instanceof Error ? e.message : 'invalid URL');
    }
    const old = await rangeUrl();
    await db
      .insert(settings)
      .values({ key: 'security.rangeUrl', value: normalized, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: normalized, updatedAt: new Date(), updatedBy: user.id },
      });
    await audit(db, `user:${user.id}`, 'admin.setting.change', 'security.rangeUrl', {
      old,
      new: normalized,
    });
    return { url: normalized };
  });
};
