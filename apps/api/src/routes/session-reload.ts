import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { sessions, settings } from '../db/schema.js';
import { AppError, forbidden } from '../errors.js';
import { randomB64url } from '../security.js';
import { openSetting, sealSetting } from '../secretbox.js';

const purpose = (sessionId: string) => `reload-share:${sessionId}`;

/**
 * Разблокировка после обновления страницы (F5) без мастер-пароля. При разблокировке браузер шифрует свои ключи
 * случайным ключом, половину которого хранит сервер в строке сеанса, а шифртекст — только вкладка (sessionStorage).
 * Сервер без вкладки ничего не расшифрует; вкладка без действующего сеанса — тоже. Блокировка и выход стирают долю.
 */
export const registerSessionReloadRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  const human = (req: FastifyRequest) => {
    const auth = authOf(req);
    if (auth.viaToken) throw forbidden();
    return auth;
  };
  const enabled = async (): Promise<boolean> => {
    const [row] = await db.select().from(settings).where(eq(settings.key, 'security.reloadUnlock'));
    return row?.value !== false;
  };

  app.put('/auth/session/reload-key', async (req) => {
    const { session } = human(req);
    if (!(await enabled()))
      throw new AppError(403, 'reload_disabled', 'Unlocking after a page reload is disabled');
    // одна доля на сеанс: вкладки одного сеанса делят её, иначе новая вкладка ломала бы F5 в соседней;
    // запись только если доли ещё нет — две вкладки одновременно не перезапишут друг друга
    const share = randomB64url(32);
    const [won] = await db
      .update(sessions)
      .set({ reloadShare: sealSetting(ctx.config.APP_SECRET, purpose(session.id), share) })
      .where(and(eq(sessions.id, session.id), isNull(sessions.reloadShare)))
      .returning({ id: sessions.id });
    if (won) return { share };
    const [row] = await db
      .select({ share: sessions.reloadShare })
      .from(sessions)
      .where(eq(sessions.id, session.id));
    return { share: openSetting(ctx.config.APP_SECRET, purpose(session.id), row!.share!) };
  });

  app.get('/auth/session/reload-key', async (req) => {
    const { session } = human(req);
    const [row] = await db
      .select({ share: sessions.reloadShare })
      .from(sessions)
      .where(eq(sessions.id, session.id));
    if (!row?.share || !(await enabled()))
      throw new AppError(404, 'reload_unavailable', 'Unlock with the master password');
    return { share: openSetting(ctx.config.APP_SECRET, purpose(session.id), row.share) };
  });

  app.delete('/auth/session/reload-key', async (req, reply) => {
    const { session } = human(req);
    await db.update(sessions).set({ reloadShare: null }).where(eq(sessions.id, session.id));
    return reply.status(204).send();
  });
};
