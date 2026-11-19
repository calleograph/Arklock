import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from './db/connect.js';
import { handoffClaims, handoffKeys, handoffs } from './db/schema.js';

/**
 * Хранение передач по ссылке. Браузер отправителя шифрует содержимое ключом из фрагмента ссылки (сервер его не видит);
 * сервер дополнительно запечатывает полученный шифртекст своим ключом передачи (AES-256-GCM, отдельная таблица
 * handoff_keys). Уничтожение — стирание шифртекста и ключа сервера: копии базы без handoff_keys не раскрывают
 * переданное даже вместе со ссылкой.
 */
const PREFIX = 'srv1.';
/** Сколько тот же браузер может повторить получение без расхода открытия (обрыв связи, обновление страницы). */
export const CLAIM_MS = 2 * 60_000;

export function seal(id: string, clientCiphertext: string): { sealed: string; key: string } {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`arklock/handoff/${id}`));
  const body = Buffer.concat([c.update(clientCiphertext, 'utf8'), c.final()]);
  const sealed = PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
  const out = { sealed, key: key.toString('base64url') };
  key.fill(0);
  return out;
}

/** Шифртекст браузера или null, если ключа сервера уже нет (передача уничтожена, база восстановлена из копии). */
export async function unseal(
  db: Db,
  row: { id: string; ciphertext: string; wrapped: boolean },
): Promise<string | null> {
  if (!row.ciphertext) return null;
  if (!row.wrapped) return row.ciphertext;
  const [k] = await db.select().from(handoffKeys).where(eq(handoffKeys.handoffId, row.id));
  if (!k || !row.ciphertext.startsWith(PREFIX)) return null;
  const raw = Buffer.from(row.ciphertext.slice(PREFIX.length), 'base64url');
  const key = Buffer.from(k.key, 'base64url');
  try {
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(`arklock/handoff/${row.id}`));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}

export const claimHash = (claim: string) => createHash('sha256').update(claim).digest('hex');

/** Уничтожить содержимое: шифртекст, ключ сервера и квитки. Строка остаётся для списка отправителя и журнала. */
export async function burn(db: Db, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.transaction(async (tx) => {
    await tx.update(handoffs).set({ ciphertext: '' }).where(inArray(handoffs.id, ids));
    await tx.delete(handoffKeys).where(inArray(handoffKeys.handoffId, ids));
    await tx.delete(handoffClaims).where(inArray(handoffClaims.handoffId, ids));
  });
}

/**
 * Уничтожить всё, что больше не может быть получено: отозванное, истёкшее, закрытое окно, исчерпанные открытия
 * (если ни один получатель не дочитывает по квитку). Запускается раз в минуту и после каждого получения.
 */
export async function sweepHandoffs(db: Db, now = new Date()): Promise<number> {
  await db.delete(handoffClaims).where(lte(handoffClaims.until, now));
  const live = sql`exists (select 1 from ${handoffClaims} where ${handoffClaims.handoffId} = ${handoffs.id})`;
  const rows = await db
    .select({ id: handoffs.id })
    .from(handoffs)
    .where(
      and(
        ne(handoffs.ciphertext, ''),
        or(
          isNotNull(handoffs.revokedAt),
          lte(handoffs.expiresAt, now),
          sql`(${handoffs.openWindowMinutes} is not null and ${handoffs.firstOpenedAt} + ${handoffs.openWindowMinutes} * interval '1 minute' <= ${now})`,
          and(sql`${handoffs.views} >= ${handoffs.maxViews}`, sql`not ${live}`),
        ),
      ),
    );
  // ключи без шифртекста (уничтожены прежде, чем появились квитки) — тоже не нужны
  await db
    .delete(handoffKeys)
    .where(
      sql`${handoffKeys.handoffId} in (select ${handoffs.id} from ${handoffs} where ${handoffs.ciphertext} = '')`,
    );
  await burn(
    db,
    rows.map((r) => r.id),
  );
  return rows.length;
}

/** Действующий квиток этого браузера для передачи. */
export async function liveClaim(db: Db, id: string, claim: string, now = new Date()) {
  const [c] = await db
    .select()
    .from(handoffClaims)
    .where(
      and(
        eq(handoffClaims.handoffId, id),
        eq(handoffClaims.tokenHash, claimHash(claim)),
        gt(handoffClaims.until, now),
      ),
    );
  return c ?? null;
}
