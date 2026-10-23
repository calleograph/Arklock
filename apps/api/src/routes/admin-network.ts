import { count, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import { SAML_SETTING_KEY } from '../auth/saml.js';
import { requireReauth } from '../auth/reauth.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { settings, webauthnCredentials } from '../db/schema.js';
import { AppError, forbidden, parse } from '../errors.js';
import { normalizePublicUrl, PUBLIC_URL_KEY, publicUrlOf } from '../public-url.js';

/**
 * «Сеть и доступ»: публичный адрес (задаётся в панели без перезапуска), а также адрес и порт публикации и
 * доверенный прокси — их показываем как есть и объясняем, где они меняются (файл установки на хосте).
 */
export const registerAdminNetworkRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db, config } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', (req) => adminGate(ctx, req));

  async function view() {
    const pub = publicUrlOf(ctx) ?? null;
    const [[keys], sso] = await Promise.all([
      db.select({ n: count() }).from(webauthnCredentials),
      db
        .select({ key: settings.key })
        .from(settings)
        .where(inArray(settings.key, ['sso.oidc', SAML_SETTING_KEY])),
    ]);
    return {
      publicUrl: {
        value: pub,
        source: ctx.publicUrlOverride ? 'panel' : config.APP_PUBLIC_URL ? 'install' : null,
        install: config.APP_PUBLIC_URL ?? null,
        https: !!pub?.startsWith('https://'),
      },
      listen: {
        bind: config.APP_BIND ?? null,
        port: config.APP_HOST_PORT ?? null,
        containerPort: config.PORT,
      },
      trustedProxyHops: config.TRUSTED_PROXY_HOPS,
      // что зависит от адреса: администратор видит, на что повлияет смена
      dependents: {
        passkeys: keys?.n ?? 0,
        oidc: sso.some((r) => r.key === 'sso.oidc'),
        saml: sso.some((r) => r.key === SAML_SETTING_KEY),
      },
    };
  }

  app.get('/admin/network', view);

  app.put('/admin/network', async (req) => {
    const { user } = authOf(req);
    if (user.role !== 'admin') throw forbidden();
    // от адреса зависят ссылки в письмах и приглашениях: подмена адреса чужим сеансом — фишинг
    requireReauth(ctx, req);
    const body = parse(z.object({ publicUrl: z.string().max(300).nullable() }), req.body);
    let value: string | null = null;
    if (body.publicUrl) {
      try {
        value = normalizePublicUrl(body.publicUrl);
      } catch (e) {
        // причина кодом: интерфейс объясняет её на языке пользователя
        throw new AppError(400, 'invalid_url', 'Invalid public address', {
          reason: (e as Error).message,
        });
      }
    }
    const old = publicUrlOf(ctx) ?? null;
    if (value)
      await db
        .insert(settings)
        .values({ key: PUBLIC_URL_KEY, value, updatedBy: user.id })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: new Date(), updatedBy: user.id },
        });
    else await db.delete(settings).where(eq(settings.key, PUBLIC_URL_KEY));
    ctx.publicUrlOverride = value ?? undefined;
    await audit(db, `user:${user.id}`, 'admin.setting.change', PUBLIC_URL_KEY, {
      old,
      new: publicUrlOf(ctx) ?? null,
    });
    return view();
  });
};
