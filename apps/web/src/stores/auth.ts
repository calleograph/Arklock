import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { UserBundle } from '@arklock/contracts';
import {
  api,
  loadToken,
  setMfaRequiredHandler,
  setToken,
  setUnauthorizedHandler,
} from '../services/api';
import * as account from '../services/account';
import { useWorkspaceStore } from './workspace';

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

  function touch(): void {
    if (!unlocked.value) return;
    if (lockTimer) clearTimeout(lockTimer);
    lockTimer = setTimeout(lock, AUTO_LOCK_MS);
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
      return 'mfa';
    }
    accept(res.session, res.account);
    return 'ok';
  }

  async function completeMfa(code: string): Promise<void> {
    if (!pendingMfa) throw new Error('no pending sign-in');
    const p = pendingMfa;
    const { session, account: acc } = await p.complete(code);
    p.cancel();
    pendingMfa = null;
    accept(session, acc);
  }

  function cancelMfa(): void {
    pendingMfa?.cancel();
    pendingMfa = null;
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

  return {
    user,
    unlocked,
    ready,
    isSignedIn,
    keys,
    touch,
    lock,
    signIn,
    completeMfa,
    cancelMfa,
    unlock,
    signOut,
    restore,
    clearSession,
  };
});
