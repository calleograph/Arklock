import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { UserBundle } from '@arklock/contracts';
import { api, loadToken, setToken, setUnauthorizedHandler } from '../services/api';
import * as account from '../services/account';
import { useVaultStore } from './vault';

/**
 * Закрытый ключ аккаунта живёт ТОЛЬКО в памяти модуля (не в состоянии Pinia, не в хранилищах браузера):
 * перезагрузка страницы или автоблокировка стирают его, дальше нужен мастер-пароль.
 */
let privateKey: Uint8Array | null = null;
let publicKey: Uint8Array | null = null;

export const AUTO_LOCK_MS = 5 * 60_000;

export const useAuthStore = defineStore('auth', () => {
  const user = ref<UserBundle | null>(null);
  const hasToken = ref(false);
  const unlocked = ref(false);
  const ready = ref(false);
  let lockTimer: ReturnType<typeof setTimeout> | null = null;

  const isSignedIn = computed(() => hasToken.value && user.value !== null);

  function keys() {
    if (!privateKey || !publicKey) throw new Error('locked');
    return { privateKey, publicKey };
  }

  function touch(): void {
    if (!unlocked.value) return;
    if (lockTimer) clearTimeout(lockTimer);
    lockTimer = setTimeout(lock, AUTO_LOCK_MS);
  }

  function wipe(): void {
    privateKey?.fill(0);
    privateKey = null;
    publicKey = null;
    if (lockTimer) clearTimeout(lockTimer);
    lockTimer = null;
    useVaultStore().clear();
  }

  function lock(): void {
    wipe();
    unlocked.value = false;
  }

  function setUnlocked(acc: { privateKey: Uint8Array; publicKey: Uint8Array }): void {
    wipe();
    privateKey = acc.privateKey;
    publicKey = acc.publicKey;
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

  async function signIn(email: string, password: string): Promise<void> {
    const { session, account: acc } = await account.signIn(email, password);
    setToken(session.token);
    hasToken.value = true;
    user.value = session.user;
    setUnlocked(acc);
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
    unlock,
    signOut,
    restore,
    clearSession,
  };
});
