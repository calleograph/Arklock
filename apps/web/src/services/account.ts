import {
  DEFAULT_KDF,
  deriveMasterKeys,
  deriveRecoveryProof,
  fromBase64Url,
  generateAccountKeyPair,
  generateRecoveryKey,
  generateSalt,
  createVaultKey,
  parseRecoveryCode,
  rewrapAccountPrivateKey,
  sealVaultKeyFor,
  toBase64Url,
  unwrapAccountPrivateKey,
  unwrapPrivateKeyWithRecovery,
  wrapAccountPrivateKey,
  wrapPrivateKeyForRecovery,
} from '@arklock/crypto';
import type {
  AuthParamsResponse,
  SessionResponse,
  UserBundle,
  RegistrationStatus,
} from '@arklock/contracts';
import { api } from './api';

/** Минимальная длина мастер-пароля (NIST SP 800-63B: длина важнее правил состава). */
export const MIN_MASTER_PASSWORD = 12;

export interface UnlockedAccount {
  user: UserBundle;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export const registrationStatus = () =>
  api<RegistrationStatus>('GET', '/auth/registration', undefined, { auth: false });

/** Создаёт учётную запись. Все ключи генерируются здесь; на сервер уходят только производные и шифртекст. */
export async function createAccount(
  email: string,
  displayName: string,
  password: string,
  setupToken?: string,
): Promise<{ recoveryCode: string }> {
  const userId = crypto.randomUUID();
  const salt = generateSalt();
  const keys = await deriveMasterKeys(password, salt, userId, DEFAULT_KDF);
  const kp = await generateAccountKeyPair();
  const recovery = await generateRecoveryKey();
  const lockerId = crypto.randomUUID();
  const lockerKey = createVaultKey();
  try {
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
        wrappedPrivateKey: await wrapAccountPrivateKey(keys.wrapKey, kp.privateKey, userId),
        recoveryProof: toBase64Url(await deriveRecoveryProof(recovery.key, userId)),
        recoveryWrappedPrivateKey: await wrapPrivateKeyForRecovery(
          recovery.key,
          kp.privateKey,
          userId,
        ),
        locker: {
          vaultId: lockerId,
          sealedKey: await sealVaultKeyFor(lockerKey, kp.publicKey, lockerId, userId, 1),
        },
      },
      { auth: false },
    );
  } finally {
    lockerKey.fill(0);
    kp.privateKey.fill(0);
    keys.wrapKey.fill(0);
    keys.authKey.fill(0);
    recovery.key.fill(0);
  }
  return { recoveryCode: recovery.code };
}

async function keysFor(email: string, password: string) {
  const params = await api<AuthParamsResponse>(
    'GET',
    `/auth/params?email=${encodeURIComponent(email)}`,
    undefined,
    { auth: false },
  );
  // deriveMasterKeys отвергает параметры слабее допустимого минимума — защита от понижения сервером.
  const keys = await deriveMasterKeys(
    password,
    fromBase64Url(params.salt),
    params.userId,
    params.kdf,
  );
  return { params, keys };
}

export async function signIn(
  email: string,
  password: string,
): Promise<{ session: SessionResponse; account: UnlockedAccount }> {
  const { keys } = await keysFor(email, password);
  const session = await api<SessionResponse>(
    'POST',
    '/auth/login',
    { email, authKey: toBase64Url(keys.authKey) },
    { auth: false },
  );
  const privateKey = await unwrapAccountPrivateKey(
    keys.wrapKey,
    session.user.wrappedPrivateKey,
    session.user.id,
  );
  keys.wrapKey.fill(0);
  keys.authKey.fill(0);
  return {
    session,
    account: { user: session.user, privateKey, publicKey: fromBase64Url(session.user.publicKey) },
  };
}

/** Повторная разблокировка (после автоблокировки или перезагрузки страницы): сессия уже есть, нужен только мастер-пароль. */
export async function unlock(user: UserBundle, password: string): Promise<UnlockedAccount> {
  const { keys } = await keysFor(user.email, password);
  try {
    const privateKey = await unwrapAccountPrivateKey(keys.wrapKey, user.wrappedPrivateKey, user.id);
    return { user, privateKey, publicKey: fromBase64Url(user.publicKey) };
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
  const next = await deriveMasterKeys(newPassword, salt, user.id, DEFAULT_KDF);
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
  });
}

/** Сброс мастер-пароля по ключу восстановления. Возвращает новый код восстановления. */
export async function recoverAccount(
  email: string,
  recoveryCode: string,
  newPassword: string,
): Promise<{ recoveryCode: string }> {
  const recoveryKey = await parseRecoveryCode(recoveryCode);
  const start = await api<{ userId: string; recoveryWrappedPrivateKey: string }>(
    'POST',
    '/auth/recovery/start',
    { email },
    { auth: false },
  );
  const privateKey = await unwrapPrivateKeyWithRecovery(
    recoveryKey,
    start.recoveryWrappedPrivateKey,
    start.userId,
  );
  const salt = generateSalt();
  const keys = await deriveMasterKeys(newPassword, salt, start.userId, DEFAULT_KDF);
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
      newRecoveryProof: toBase64Url(await deriveRecoveryProof(fresh.key, start.userId)),
      newRecoveryWrappedPrivateKey: await wrapPrivateKeyForRecovery(
        fresh.key,
        privateKey,
        start.userId,
      ),
    },
    { auth: false },
  );
  privateKey.fill(0);
  return { recoveryCode: fresh.code };
}
