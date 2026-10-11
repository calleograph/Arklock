import { z } from 'zod';

export const API_PREFIX = '/api/v1';

export const uuid = z.uuid();
/** base64url без дополнения: ключи, соли, доказательства. */
export const b64url = (min: number, max: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .min(min)
    .max(max);
/** Зашифрованное значение формата ak1 (AES-256-GCM): ak1.<nonce>.<ciphertext>. */
export const sealedValue = (maxLen: number) =>
  z
    .string()
    .max(maxLen)
    .regex(/^ak1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/);
/** Запечатанное для получателя значение формата as1 (ECDH P-256 sealed box). */
export const sealedBox = z
  .string()
  .max(512)
  .regex(/^as1\.[A-Za-z0-9_-]{86,88}\.ak1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/);

/** Единый формат ошибок API. Сообщения не содержат секретов и внутренних деталей. */
export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponse>;
