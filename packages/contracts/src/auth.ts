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

export const accountIdentifier = z.union([
  email,
  z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/),
]);

export const authKey = b64url(43, 43); // 32 байта
const proof = b64url(43, 43);
const publicKey = b64url(86, 88); // 65 байт
const wrappedKey = sealedValue(4096);
const signSig = b64url(80, 100);

/** Параметры получения ключей. Для неизвестных адресов сервер возвращает правдоподобные значения. */
export const authParamsQuery = z.object({ email: accountIdentifier });
export const authParamsResponse = z.object({ userId: uuid, salt: b64url(22, 22), kdf: kdfParams });
export type AuthParamsResponse = z.infer<typeof authParamsResponse>;

export const registerRequest = z.object({
  userId: uuid,
  email: accountIdentifier,
  displayName: z.string().trim().min(1).max(100),
  /** Код первоначальной настройки (нужен только для первой, администраторской записи). */
  setupToken: z.string().max(200).optional(),
  /** Токен приглашения: позволяет зарегистрироваться при закрытой регистрации (адрес должен совпасть с приглашённым). */
  inviteToken: z.string().min(10).max(100).optional(),
  kdf: kdfParams,
  salt: b64url(22, 22),
  authKey,
  publicKey,
  signPublicKey: publicKey,
  wrappedPrivateKey: wrappedKey,
  wrappedSignPrivateKey: wrappedKey,
  recoveryProof: proof,
  recoveryWrappedPrivateKey: wrappedKey,
  recoveryWrappedSignPrivateKey: wrappedKey,
  /** Личное хранилище (сейф) создаётся при регистрации; ключ запечатан открытым ключом владельца и подписан им же. */
  locker: z.object({ vaultId: uuid, sealedKey: sealedBox, signature: signSig }),
});
export type RegisterRequest = z.infer<typeof registerRequest>;

/** Цветовые темы интерфейса: первые четыре — многослойные оформления со стеклом и фоновой графикой. */
export const THEME_IDS = [
  'glass',
  'night',
  'grove',
  'aurora',
  'corporate',
  'light',
  'dark',
  'forest',
  'emerald',
  'sunset',
] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const userBundle = z.object({
  id: uuid,
  email: z.string(),
  displayName: z.string(),
  role: z.enum(['admin', 'member']),
  /** Назначена административная роль (делегированное администрирование отдельных разделов). */
  delegated: z.boolean().optional(),
  /** Главный администратор организации. */
  chief: z.boolean().optional(),
  /** Выбранная цветовая тема; пусто — тема по умолчанию. */
  theme: z.string().nullable().optional(),
  /** Пространство, которое открывается при входе: id, «personal» или пусто — пространство организации по умолчанию. */
  homeSpace: z.string().nullable().optional(),
  publicKey,
  signPublicKey: publicKey,
  wrappedPrivateKey: wrappedKey,
  wrappedSignPrivateKey: wrappedKey,
});
export type UserBundle = z.infer<typeof userBundle>;

export const loginRequest = z.object({ email: accountIdentifier, authKey });
export const sessionResponse = z.object({
  token: z.string(),
  expiresAt: z.string(),
  user: userBundle,
});
export type SessionResponse = z.infer<typeof sessionResponse>;

/** Ответ на вход, когда включён второй фактор: сессия выдаётся только после проверки кода. */
export interface MfaChallengeResponse {
  mfaRequired: true;
  challenge: string;
  /** Доступные способы подтверждения. */
  methods: { totp: boolean; webauthn: boolean };
}
export const mfaVerifyRequest = z.object({
  challenge: z.string().min(10).max(100),
  code: z.string().min(6).max(12),
});

export const changePasswordRequest = z.object({
  currentAuthKey: authKey,
  kdf: kdfParams,
  salt: b64url(22, 22),
  newAuthKey: authKey,
  wrappedPrivateKey: wrappedKey,
  wrappedSignPrivateKey: wrappedKey,
});

export const recoveryStartRequest = z.object({ email: accountIdentifier });
export const recoveryStartResponse = z.object({
  userId: uuid,
  recoveryWrappedPrivateKey: wrappedKey,
  recoveryWrappedSignPrivateKey: wrappedKey,
  publicKey,
  signPublicKey: publicKey,
});
export const recoveryCompleteRequest = z.object({
  email: accountIdentifier,
  recoveryProof: proof,
  kdf: kdfParams,
  salt: b64url(22, 22),
  newAuthKey: authKey,
  wrappedPrivateKey: wrappedKey,
  wrappedSignPrivateKey: wrappedKey,
  /** Новый ключ восстановления: прежний после использования считается скомпрометированным. */
  newRecoveryProof: proof,
  newRecoveryWrappedPrivateKey: wrappedKey,
  newRecoveryWrappedSignPrivateKey: wrappedKey,
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
export const registrationStatus = z.object({
  open: z.boolean(),
  firstUser: z.boolean(),
  /** Для создания первого администратора нужен код настройки (выдаётся установщиком). */
  setupTokenRequired: z.boolean(),
});
export type RegistrationStatus = z.infer<typeof registrationStatus>;

export const tokenCreate = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(['read', 'write']),
  /** Срок действия в днях; 0 — без срока. */
  expiresInDays: z.number().int().min(0).max(3650),
  authKey,
  /** Код второго фактора, если он включён. */
  code: z.string().min(6).max(12).optional(),
});
export interface ApiTokenInfo {
  id: string;
  name: string;
  prefix: string;
  scope: 'read' | 'write';
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}
