import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { MfaChallengeResponse, SessionResponse, UserBundle } from '@arklock/contracts';
import {
  api,
  loadToken,
  setMfaRequiredHandler,
  setToken,
  setUnauthorizedHandler,
} from '../services/api';
import * as account from '../services/account';
import { useWorkspaceStore } from './workspace';
import { applyTheme, type ThemeId } from '../services/theme';

/**
 * Закрытый ключ аккаунта живёт ТОЛЬКО в памяти модуля (не в состоянии Pinia, не в хранилищах браузера):
 * перезагрузка страницы или автоблокировка стирают его, дальше нужен мастер-пароль.
 */
let privateKey: Uint8Array | null = null;
let publicKey: Uint8Array | null = null;
let signPrivateKey: Uint8Array | null = null;
let signPublicKey: Uint8Array | null = null;

export const AUTO_LOCK_MS = 5 * 60_000;

export const useAuthStore = defineStore('auth', () => {
  const user = ref<UserBundle | null>(null);
  const hasToken = ref(false);
  const unlocked = ref(false);
  const ready = ref(false);
  let lockTimer: ReturnType<typeof setTimeout> | null = null;

  const isSignedIn = computed(() => hasToken.value && user.value !== null);

  function keys() {
    if (!privateKey || !publicKey || !signPrivateKey || !signPublicKey) throw new Error('locked');
    return { privateKey, publicKey, signPrivateKey, signPublicKey };
  }

  /** Пока идёт длительная операция с ключами (передача большого файла, ротация), автоблокировка откладывается. */
  let holds = 0;
  function hold(): () => void {
    holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds = Math.max(0, holds - 1);
      touch();
    };
  }

  function touch(): void {
    if (!unlocked.value) return;
    if (lockTimer) clearTimeout(lockTimer);
    lockTimer = setTimeout(() => (holds > 0 ? touch() : lock()), AUTO_LOCK_MS);
  }

  function wipe(): void {
    privateKey?.fill(0);
    signPrivateKey?.fill(0);
    privateKey = null;
    publicKey = null;
    signPrivateKey = null;
    signPublicKey = null;
    if (lockTimer) clearTimeout(lockTimer);
    lockTimer = null;
    useWorkspaceStore().clear();
  }

  function lock(): void {
    wipe();
    unlocked.value = false;
  }

  function setUnlocked(acc: {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
    signPrivateKey: Uint8Array;
    signPublicKey: Uint8Array;
  }): void {
    wipe();
    privateKey = acc.privateKey;
    publicKey = acc.publicKey;
    signPrivateKey = acc.signPrivateKey;
    signPublicKey = acc.signPublicKey;
    unlocked.value = true;
    touch();
  }

  function clearSession(): void {
    wipe();
    setToken(null);
    hasToken.value = false;
    unlocked.value = false;
    user.value = null;
  }

  let pendingMfa: Extract<account.SignInResult, { kind: 'mfa' }> | null = null;

  function accept(
    session: { token: string; user: UserBundle },
    acc: Parameters<typeof setUnlocked>[0],
  ): void {
    setToken(session.token);
    hasToken.value = true;
    user.value = session.user;
    setUnlocked(acc);
  }

  /** Возвращает 'mfa', если требуется код второго фактора (вход завершается вызовом completeMfa). */
  async function signIn(email: string, password: string): Promise<'ok' | 'mfa'> {
    pendingMfa?.cancel();
    pendingMfa = null;
    const res = await account.signIn(email, password);
    if (res.kind === 'mfa') {
      pendingMfa = res;
      mfaMethods = res.methods;
      return 'mfa';
    }
    accept(res.session, res.account);
    return 'ok';
  }

  // Вход через каталог (LDAP): пароль каталога проверяет сервер, мастер-пароль нужен только для ключей
  let ldapChallenge: string | null = null;
  let mfaMethods: { totp: boolean; webauthn: boolean } = { totp: true, webauthn: false };
  let ldapEnroll: { token: string; email: string; name: string } | null = null;

  /** ok — сессия есть, нужна разблокировка; mfa — нужен код; enroll — нужно создать мастер-пароль. */
  async function signInLdap(
    username: string,
    password: string,
  ): Promise<'unlock' | 'mfa' | 'enroll'> {
    const res = await api<
      | SessionResponse
      | MfaChallengeResponse
      | { enroll: true; enrollToken: string; email: string; name: string }
    >('POST', '/auth/ldap/login', { username, password }, { auth: false });
    if ('enroll' in res) {
      ldapEnroll = { token: res.enrollToken, email: res.email, name: res.name };
      return 'enroll';
    }
    if ('mfaRequired' in res) {
      ldapChallenge = res.challenge;
      mfaMethods = res.methods;
      return 'mfa';
    }
    setToken(res.token);
    hasToken.value = true;
    user.value = res.user;
    return 'unlock';
  }

  const ldapIdentity = () => ldapEnroll;

  /** Возврат от SSO: билет обменивается на сессию / шаг второго фактора / создание учётной записи. */
  async function exchangeSso(
    ticket: string,
    verifier?: string,
  ): Promise<'unlock' | 'mfa' | 'enroll'> {
    const res = await api<
      | SessionResponse
      | MfaChallengeResponse
      | { enroll: true; enrollToken: string; email: string; name: string }
    >('POST', '/auth/sso/exchange', { ticket, verifier }, { auth: false });
    if ('enroll' in res) {
      ldapEnroll = { token: res.enrollToken, email: res.email, name: res.name };
      return 'enroll';
    }
    if ('mfaRequired' in res) {
      ldapChallenge = res.challenge;
      mfaMethods = res.methods;
      return 'mfa';
    }
    setToken(res.token);
    hasToken.value = true;
    user.value = res.user;
    return 'unlock';
  }

  /** Создание учётной записи для пользователя каталога: мастер-пароль остаётся только у него. */
  async function enrollLdap(masterPassword: string): Promise<{ recoveryCode: string }> {
    if (!ldapEnroll) throw new Error('no pending enrolment');
    const made = await account.createAccount(
      ldapEnroll.email,
      ldapEnroll.name,
      masterPassword,
      undefined,
      undefined,
      { enrollToken: ldapEnroll.token },
    );
    ldapEnroll = null;
    if (!made.session) throw new Error('enrolment failed');
    setToken(made.session.token);
    hasToken.value = true;
    user.value = made.session.user;
    // ключи только что созданы из этого же пароля: открываем их
    setUnlocked(await account.unlock(made.session.user, masterPassword));
    return { recoveryCode: made.recoveryCode };
  }

  async function completeLdapMfa(code: string): Promise<void> {
    if (!ldapChallenge) throw new Error('no pending sign-in');
    const session = await api<SessionResponse>(
      'POST',
      '/auth/mfa/verify',
      { challenge: ldapChallenge, code },
      { auth: false },
    );
    ldapChallenge = null;
    setToken(session.token);
    hasToken.value = true;
    user.value = session.user;
  }
  const hasLdapChallenge = () => ldapChallenge !== null;

  async function completeMfa(code: string): Promise<void> {
    if (ldapChallenge) return completeLdapMfa(code);
    if (!pendingMfa) throw new Error('no pending sign-in');
    const p = pendingMfa;
    const { session, account: acc } = await p.complete(code);
    p.cancel();
    pendingMfa = null;
    accept(session, acc);
  }

  /** Подтверждение входа ключом доступа (WebAuthn). */
  async function completeWebauthn(): Promise<void> {
    if (ldapChallenge) {
      const session = await account.completeWithKey(ldapChallenge);
      ldapChallenge = null;
      setToken(session.token);
      hasToken.value = true;
      user.value = session.user;
      return;
    }
    if (!pendingMfa) throw new Error('no pending sign-in');
    const p = pendingMfa;
    const { session, account: acc } = await p.completeWebauthn();
    p.cancel();
    pendingMfa = null;
    accept(session, acc);
  }
  const mfaOffers = () => mfaMethods;

  function cancelMfa(): void {
    pendingMfa?.cancel();
    pendingMfa = null;
    ldapChallenge = null;
  }

  async function unlock(password: string): Promise<void> {
    if (!user.value) throw new Error('no user');
    setUnlocked(await account.unlock(user.value, password));
  }

  async function signOut(): Promise<void> {
    try {
      await api('POST', '/auth/logout');
    } catch {
      /* сессия могла уже истечь */
    }
    clearSession();
  }

  /** Восстановление состояния после перезагрузки страницы: токен есть, ключей нет — потребуется разблокировка. */
  async function restore(): Promise<void> {
    setUnauthorizedHandler(clearSession);
    // Политика требует второй фактор, а он не настроен: ведём на страницу настройки
    setMfaRequiredHandler(() => {
      void import('../router').then(({ router }) => {
        if (router.currentRoute.value.path !== '/security') void router.replace('/security');
      });
    });
    if (loadToken()) {
      hasToken.value = true;
      try {
        const me = await api<{ user: UserBundle }>('GET', '/auth/me');
        user.value = me.user;
      } catch {
        clearSession();
      }
    }
    ready.value = true;
  }

  /** Меняет цветовую тему сразу и сохраняет выбор в профиле (на других устройствах он подхватится при входе). */
  async function setTheme(id: ThemeId): Promise<void> {
    applyTheme(id);
    if (user.value) user.value = { ...user.value, theme: id };
    if (hasToken.value) await api('PUT', '/auth/preferences', { theme: id });
  }

  return {
    setTheme,
    hold,
    user,
    unlocked,
    ready,
    isSignedIn,
    keys,
    touch,
    lock,
    signIn,
    completeMfa,
    completeWebauthn,
    mfaOffers,
    cancelMfa,
    signInLdap,
    exchangeSso,
    enrollLdap,
    ldapIdentity,
    hasLdapChallenge,
    unlock,
    signOut,
    restore,
    clearSession,
  };
});
