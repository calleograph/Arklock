import {
  DEFAULT_KDF,
  createVaultKey,
  deriveRecoveryProof,
  fromBase64Url,
  generateAccountKeyPair,
  generateRecoveryKey,
  generateSalt,
  generateSigningKeyPair,
  parseRecoveryCode,
  rewrapAccountPrivateKey,
  sealVaultKeyFor,
  signKeyGrant,
  toBase64Url,
  unwrapAccountPrivateKey,
  unwrapPrivateKeyWithRecovery,
  unwrapSignPrivateKey,
  wrapAccountPrivateKey,
  wrapPrivateKeyForRecovery,
  wrapSignPrivateKey,
} from '@arklock/crypto';
import type {
  AuthParamsResponse,
  RegistrationStatus,
  SessionResponse,
  UserBundle,
} from '@arklock/contracts';
import { api } from './api';
import { deriveKeys } from './kdf';

/** Минимальная длина мастер-пароля (NIST SP 800-63B: длина важнее правил состава). */
export const MIN_MASTER_PASSWORD = 12;

export interface UnlockedAccount {
  user: UserBundle;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  signPrivateKey: Uint8Array;
  signPublicKey: Uint8Array;
}

export const registrationStatus = () =>
  api<RegistrationStatus>('GET', '/auth/registration', undefined, { auth: false });

/** Создаёт учётную запись. Все ключи генерируются здесь; на сервер уходят только производные и шифртекст. */
export async function createAccount(
  email: string,
  displayName: string,
  password: string,
  setupToken?: string,
  signal?: AbortSignal,
): Promise<{ recoveryCode: string }> {
  const userId = crypto.randomUUID();
  const salt = generateSalt();
  const keys = await deriveKeys(password, salt, userId, DEFAULT_KDF, signal);
  const kp = await generateAccountKeyPair();
  const sk = await generateSigningKeyPair();
  const recovery = await generateRecoveryKey();
  const lockerId = crypto.randomUUID();
  const lockerKey = createVaultKey();
  try {
    const sealedKey = await sealVaultKeyFor(lockerKey, kp.publicKey, lockerId, userId, 1);
    await api(
      'POST',
      '/auth/register',
      {
        userId,
        email,
        displayName,
        setupToken: setupToken || undefined,
        kdf: DEFAULT_KDF,
        salt: toBase64Url(salt),
        authKey: toBase64Url(keys.authKey),
        publicKey: toBase64Url(kp.publicKey),
        signPublicKey: toBase64Url(sk.publicKey),
        wrappedPrivateKey: await wrapAccountPrivateKey(keys.wrapKey, kp.privateKey, userId),
        wrappedSignPrivateKey: await wrapSignPrivateKey(keys.wrapKey, sk.privateKey, userId),
        recoveryProof: toBase64Url(await deriveRecoveryProof(recovery.key, userId)),
        recoveryWrappedPrivateKey: await wrapPrivateKeyForRecovery(
          recovery.key,
          kp.privateKey,
          userId,
        ),
        recoveryWrappedSignPrivateKey: await wrapPrivateKeyForRecovery(
          recovery.key,
          sk.privateKey,
          userId,
        ),
        locker: {
          vaultId: lockerId,
          sealedKey,
          signature: await signKeyGrant(sk.privateKey, lockerId, userId, 1, sealedKey),
        },
      },
      { auth: false },
    );
  } finally {
    for (const k of [
      lockerKey,
      kp.privateKey,
      sk.privateKey,
      keys.wrapKey,
      keys.authKey,
      recovery.key,
    ])
      k.fill(0);
  }
  return { recoveryCode: recovery.code };
}

async function keysFor(email: string, password: string, signal?: AbortSignal) {
  const params = await api<AuthParamsResponse>(
    'GET',
    `/auth/params?email=${encodeURIComponent(email)}`,
    undefined,
    { auth: false },
  );
  // Параметры слабее допустимого минимума отвергаются — защита от понижения сервером.
  const keys = await deriveKeys(
    password,
    fromBase64Url(params.salt),
    params.userId,
    params.kdf,
    signal,
  );
  return { params, keys };
}

async function unwrapAll(user: UserBundle, wrapKey: Uint8Array): Promise<UnlockedAccount> {
  const [privateKey, signPrivateKey] = await Promise.all([
    unwrapAccountPrivateKey(wrapKey, user.wrappedPrivateKey, user.id),
    unwrapSignPrivateKey(wrapKey, user.wrappedSignPrivateKey, user.id),
  ]);
  return {
    user,
    privateKey,
    publicKey: fromBase64Url(user.publicKey),
    signPrivateKey,
    signPublicKey: fromBase64Url(user.signPublicKey),
  };
}

export async function signIn(
  email: string,
  password: string,
  signal?: AbortSignal,
): Promise<{ session: SessionResponse; account: UnlockedAccount }> {
  const { keys } = await keysFor(email, password, signal);
  try {
    const session = await api<SessionResponse>(
      'POST',
      '/auth/login',
      { email, authKey: toBase64Url(keys.authKey) },
      { auth: false },
    );
    return { session, account: await unwrapAll(session.user, keys.wrapKey) };
  } finally {
    keys.wrapKey.fill(0);
    keys.authKey.fill(0);
  }
}

/** Повторная разблокировка (после автоблокировки или перезагрузки страницы): сессия уже есть, нужен только мастер-пароль. */
export async function unlock(
  user: UserBundle,
  password: string,
  signal?: AbortSignal,
): Promise<UnlockedAccount> {
  const { keys } = await keysFor(user.email, password, signal);
  try {
    return await unwrapAll(user, keys.wrapKey);
  } finally {
    keys.wrapKey.fill(0);
    keys.authKey.fill(0);
  }
}

/** Повторное подтверждение мастер-пароля для опасных операций администратора (токен действует 5 минут). */
export async function reauth(
  user: UserBundle,
  password: string,
): Promise<{ token: string; expiresAt: string }> {
  const { keys } = await keysFor(user.email, password);
  try {
    return await api('POST', '/admin/reauth', { authKey: toBase64Url(keys.authKey) });
  } finally {
    keys.wrapKey.fill(0);
    keys.authKey.fill(0);
  }
}

export async function changePassword(
  user: UserBundle,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const current = await keysFor(user.email, currentPassword);
  const salt = generateSalt();
  const next = await deriveKeys(newPassword, salt, user.id, DEFAULT_KDF);
  const signPriv = await unwrapSignPrivateKey(
    current.keys.wrapKey,
    user.wrappedSignPrivateKey,
    user.id,
  );
  await api('POST', '/auth/change-password', {
    currentAuthKey: toBase64Url(current.keys.authKey),
    kdf: DEFAULT_KDF,
    salt: toBase64Url(salt),
    newAuthKey: toBase64Url(next.authKey),
    wrappedPrivateKey: await rewrapAccountPrivateKey(
      current.keys.wrapKey,
      next.wrapKey,
      user.wrappedPrivateKey,
      user.id,
    ),
    wrappedSignPrivateKey: await wrapSignPrivateKey(next.wrapKey, signPriv, user.id),
  });
  signPriv.fill(0);
}

/** Сброс мастер-пароля по ключу восстановления. Возвращает новый код восстановления. */
export async function recoverAccount(
  email: string,
  recoveryCode: string,
  newPassword: string,
): Promise<{ recoveryCode: string }> {
  const recoveryKey = await parseRecoveryCode(recoveryCode);
  const start = await api<{
    userId: string;
    recoveryWrappedPrivateKey: string;
    recoveryWrappedSignPrivateKey: string;
  }>('POST', '/auth/recovery/start', { email }, { auth: false });
  const privateKey = await unwrapPrivateKeyWithRecovery(
    recoveryKey,
    start.recoveryWrappedPrivateKey,
    start.userId,
  );
  const signPrivate = await unwrapPrivateKeyWithRecovery(
    recoveryKey,
    start.recoveryWrappedSignPrivateKey,
    start.userId,
  );
  const salt = generateSalt();
  const keys = await deriveKeys(newPassword, salt, start.userId, DEFAULT_KDF);
  const fresh = await generateRecoveryKey();
  await api(
    'POST',
    '/auth/recovery/complete',
    {
      email,
      recoveryProof: toBase64Url(await deriveRecoveryProof(recoveryKey, start.userId)),
      kdf: DEFAULT_KDF,
      salt: toBase64Url(salt),
      newAuthKey: toBase64Url(keys.authKey),
      wrappedPrivateKey: await wrapAccountPrivateKey(keys.wrapKey, privateKey, start.userId),
      wrappedSignPrivateKey: await wrapSignPrivateKey(keys.wrapKey, signPrivate, start.userId),
      newRecoveryProof: toBase64Url(await deriveRecoveryProof(fresh.key, start.userId)),
      newRecoveryWrappedPrivateKey: await wrapPrivateKeyForRecovery(
        fresh.key,
        privateKey,
        start.userId,
      ),
      newRecoveryWrappedSignPrivateKey: await wrapPrivateKeyForRecovery(
        fresh.key,
        signPrivate,
        start.userId,
      ),
    },
    { auth: false },
  );
  privateKey.fill(0);
  signPrivate.fill(0);
  return { recoveryCode: fresh.code };
}
