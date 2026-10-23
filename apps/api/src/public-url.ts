import { eq } from 'drizzle-orm';
import type { AppContext } from './context.js';
import { settings } from './db/schema.js';

export const PUBLIC_URL_KEY = 'system.publicUrl';

/**
 * Действующий публичный адрес: заданный администратором в панели, иначе из файла установки (APP_PUBLIC_URL).
 * Никогда не берётся из заголовка Host запроса.
 * shortcut: значение панели держится в памяти процесса; при нескольких экземплярах API их нужно перечитывать.
 */
export const publicUrlOf = (ctx: AppContext): string | undefined =>
  ctx.publicUrlOverride ?? ctx.config.APP_PUBLIC_URL;

export async function loadPublicUrl(ctx: AppContext): Promise<void> {
  const [row] = await ctx.db.select().from(settings).where(eq(settings.key, PUBLIC_URL_KEY));
  ctx.publicUrlOverride = typeof row?.value === 'string' && row.value ? row.value : undefined;
}

/**
 * Проверка адреса: только схема, узел и порт (без пути, логина и параметров). HTTPS обязателен, кроме localhost —
 * по HTTP браузер не даёт шифровать и передавать мастер-пароль безопасно.
 */
export function normalizePublicUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('parse');
  }
  if (u.username || u.password) throw new Error('credentials');
  if (u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new Error('path');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('https');
  return u.origin;
}
