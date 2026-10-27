import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/connect.js';
import { settings } from '../db/schema.js';

export const SHIELD_KEY = 'security.shield';

/**
 * Настройки защиты входа. Границы заданы так, чтобы защиту нельзя было выключить: порог проверки не больше 20 ошибок,
 * блокировка источника не короче минуты, окно не короче минуты.
 */
export const shieldPolicy = z.object({
  /** Окно подсчёта неудачных входов, минут. */
  windowMinutes: z.number().int().min(1).max(240).default(15),
  /** Ошибок в окне до дополнительной проверки (для сочетания «адрес + учётная запись» и для адреса). */
  captchaAfter: z.number().int().min(2).max(20).default(5),
  /** Ошибок в окне с одного адреса до временного ограничения адреса. */
  blockIpAfter: z.number().int().min(5).max(200).default(25),
  /** Ошибок на одну пару «адрес + учётная запись» до временного ограничения пары. */
  blockPairAfter: z.number().int().min(3).max(100).default(10),
  /** Первое ограничение, минут; повторные нарушения удваивают срок. */
  blockMinutes: z.number().int().min(1).max(1440).default(5),
  /** Предел увеличения срока, минут. */
  blockMaxMinutes: z.number().int().min(5).max(10080).default(1440),
  /** Сложность проверки: число нулевых бит; растёт с числом ошибок, но не выше предела. */
  captchaBits: z.number().int().min(12).max(22).default(17),
  captchaMaxBits: z.number().int().min(12).max(22).default(20),
  /** Срок хранения событий безопасности, дней. */
  retentionDays: z.number().int().min(7).max(365).default(90),
  /** Не чаще одного оповещения об одинаковом событии за столько минут. */
  alertMinutes: z.number().int().min(1).max(1440).default(15),
  /** Дублировать оповещения письмом (если почта настроена). */
  alertMail: z.boolean().default(true),
});
export type ShieldPolicy = z.infer<typeof shieldPolicy>;
export const DEFAULT_POLICY: ShieldPolicy = shieldPolicy.parse({});

export async function loadPolicy(db: Db): Promise<ShieldPolicy> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SHIELD_KEY));
  const parsed = shieldPolicy.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : DEFAULT_POLICY;
}
