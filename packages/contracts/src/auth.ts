import { z } from 'zod';
import { b64url, sealedBox, sealedValue, uuid } from './common.js';

export const kdfParams = z.object({
  memoryKiB: z.number().int().min(8).max(1_048_576),
  iterations: z.number().int().min(1).max(64),
  parallelism: z.number().int().min(1).max(16),
});
export type KdfParamsDto = z.infer<typeof kdfParams>;

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);

const authKey = b64url(43, 43); // 32 байта
const proof = b64url(43, 43);
const publicKey = b64url(86, 88); // 65 байт
const wrappedKey = sealedValue(4096);

/** Параметры получения ключей. Для неизвестных адресов сервер возвращает правдоподобные значения. */
export const authParamsQuery = z.object({ email });
export const authParamsResponse = z.object({ userId: uuid, salt: b64url(22, 22), kdf: kdfParams });
export type AuthParamsResponse = z.infer<typeof authParamsResponse>;

export const registerRequest = z.object({
  userId: uuid,
  email,
  displayName: z.string().trim().min(1).max(100),
  kdf: kdfParams,
  salt: b64url(22, 22),
  authKey,
  publicKey,
  wrappedPrivateKey: wrappedKey,
  recoveryProof: proof,
  recoveryWrappedPrivateKey: wrappedKey,
  /** Личное хранилище (сейф) создаётся при регистрации; ключ запечатан открытым ключом владельца. */
  locker: z.object({ vaultId: uuid, sealedKey: sealedBox }),
});
export type RegisterRequest = z.infer<typeof registerRequest>;

export const userBundle = z.object({
  id: uuid,
  email: z.string(),
  displayName: z.string(),
  role: z.enum(['admin', 'member']),
  publicKey,
  wrappedPrivateKey: wrappedKey,
});
export type UserBundle = z.infer<typeof userBundle>;

export const loginRequest = z.object({ email, authKey });
export const sessionResponse = z.object({
  token: z.string(),
  expiresAt: z.string(),
  user: userBundle,
});
export type SessionResponse = z.infer<typeof sessionResponse>;

export const changePasswordRequest = z.object({
  currentAuthKey: authKey,
  kdf: kdfParams,
  salt: b64url(22, 22),
  newAuthKey: authKey,
  wrappedPrivateKey: wrappedKey,
});

export const recoveryStartRequest = z.object({ email });
export const recoveryStartResponse = z.object({
  userId: uuid,
  recoveryWrappedPrivateKey: wrappedKey,
  publicKey,
});
export const recoveryCompleteRequest = z.object({
  email,
  recoveryProof: proof,
  kdf: kdfParams,
  salt: b64url(22, 22),
  newAuthKey: authKey,
  wrappedPrivateKey: wrappedKey,
  /** Новый ключ восстановления: прежний после использования считается скомпрометированным. */
  newRecoveryProof: proof,
  newRecoveryWrappedPrivateKey: wrappedKey,
});

export const sessionInfo = z.object({
  id: uuid,
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof sessionInfo>;

/** Публичный признак: можно ли сейчас создать учётную запись (первая запись или режим открытой регистрации). */
export const registrationStatus = z.object({ open: z.boolean(), firstUser: z.boolean() });
export type RegistrationStatus = z.infer<typeof registrationStatus>;
