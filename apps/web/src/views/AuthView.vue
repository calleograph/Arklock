<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import * as account from '../services/account';
import { errorMessage } from '../services/helpers';
import { api, ApiError } from '../services/api';

type Mode = 'signin' | 'register' | 'recover' | 'unlock';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const inviteToken = typeof route.query.invite === 'string' ? route.query.invite : '';
const inviteEmail = ref('');
const inviteBad = ref(false);
const ldapAvailable = ref(false);
const sso = ref<{ enabled: boolean; buttonText: string }>({ enabled: false, buttonText: 'SSO' });
const ldapMode = ref(false);
const ldapEnrollStep = ref(false);
const ldapUser = ref('');
const ldapEnrolled = ref(false);
const mfaStep = ref(false);
const mfaCode = ref('');
const mode = ref<Mode>(route.name === 'unlock' ? 'unlock' : 'signin');
const email = ref('');
const displayName = ref('');
const password = ref('');
const repeat = ref('');
const recoveryInput = ref('');
const busy = ref(false);
const error = ref('');
const registrationOpen = ref(true);
const firstUser = ref(false);
const setupRequired = ref(false);
const setupToken = ref(typeof route.query.setup === 'string' ? route.query.setup : '');
/** Показ ключа восстановления: после регистрации и после восстановления доступа. */
const shownRecovery = ref('');
const recoverySaved = ref(false);
const recoveryContext = ref<'register' | 'recover'>('register');

// Один и тот же компонент обслуживает /login и /unlock: режим следует за маршрутом.
watch(
  () => route.name,
  (name) => {
    if (name === 'unlock') mode.value = 'unlock';
    else if (mode.value === 'unlock') mode.value = 'signin';
    password.value = '';
    error.value = '';
  },
);

onMounted(async () => {
  try {
    const status = await account.registrationStatus();
    registrationOpen.value = status.open;
    firstUser.value = status.firstUser;
    setupRequired.value = status.setupTokenRequired;
    if (status.firstUser && mode.value === 'signin') mode.value = 'register';
    if (inviteToken) {
      try {
        const inv = await api<{ email: string }>(
          'GET',
          `/auth/invitation?token=${encodeURIComponent(inviteToken)}`,
          undefined,
          { auth: false },
        );
        inviteEmail.value = inv.email;
        email.value = inv.email;
        mode.value = 'register';
        registrationOpen.value = true;
      } catch {
        inviteBad.value = true;
      }
    }
    sso.value = await api<{ enabled: boolean; buttonText: string }>('GET', '/auth/sso', undefined, {
      auth: false,
    });
    // возврат со страницы SSO: продолжаем начатый внешний вход
    if (route.query.external === 'enroll' && auth.ldapIdentity()) {
      ldapMode.value = true;
      ldapEnrollStep.value = true;
    } else if (route.query.external === 'mfa' && auth.hasLdapChallenge()) {
      ldapMode.value = true;
      mfaStep.value = true;
    }
    ldapAvailable.value = (
      await api<{ enabled: boolean }>('GET', '/auth/ldap', undefined, { auth: false })
    ).enabled;
  } catch {
    /* сервер недоступен — форма покажет ошибку при отправке */
  }
});

const title = computed(
  () =>
    ({
      signin: t('auth.signIn'),
      register: t('auth.register'),
      recover: t('auth.recover'),
      unlock: t('auth.unlock'),
    })[mode.value],
);

function validateNewPassword(): string | null {
  if (password.value.length < account.MIN_MASTER_PASSWORD) return t('auth.tooShort');
  if (password.value.toLowerCase() === email.value.trim().toLowerCase())
    return t('auth.sameAsEmail');
  if (password.value !== repeat.value) return t('auth.mismatch');
  return null;
}

async function useKey(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    await auth.completeWebauthn();
    mfaStep.value = false;
    mfaCode.value = '';
    leaveLdap();
    await router.replace(auth.unlocked ? '/' : '/unlock');
  } catch (e) {
    error.value =
      e instanceof ApiError && e.code === 'invalid_challenge'
        ? t('mfa.expired')
        : t('mfa.keyFailed');
  } finally {
    busy.value = false;
  }
}

async function submit(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    if (mfaStep.value) {
      await auth.completeMfa(mfaCode.value.trim());
      mfaStep.value = false;
      mfaCode.value = '';
      // вход через каталог: ключей ещё нет, нужен мастер-пароль
      leaveLdap();
      await router.replace(auth.unlocked ? '/' : '/unlock');
    } else if (ldapEnrollStep.value) {
      const invalid = validateNewPassword();
      if (invalid) {
        error.value = invalid;
        return;
      }
      const { recoveryCode } = await auth.enrollLdap(password.value);
      ldapEnrolled.value = true;
      recoveryContext.value = 'register';
      shownRecovery.value = recoveryCode;
    } else if (ldapMode.value) {
      const next = await auth.signInLdap(ldapUser.value.trim(), password.value);
      password.value = '';
      if (next === 'mfa') mfaStep.value = true;
      else if (next === 'enroll') ldapEnrollStep.value = true;
      else {
        leaveLdap();
        await router.replace('/unlock');
      }
      return;
    } else if (mode.value === 'signin') {
      if ((await auth.signIn(email.value.trim().toLowerCase(), password.value)) === 'mfa') {
        mfaStep.value = true;
        password.value = '';
        return;
      }
      await router.replace('/');
    } else if (mode.value === 'unlock') {
      await auth.unlock(password.value);
      await router.replace('/');
    } else if (mode.value === 'register') {
      const invalid = validateNewPassword();
      if (invalid) {
        error.value = invalid;
        return;
      }
      const { recoveryCode } = await account.createAccount(
        email.value.trim().toLowerCase(),
        displayName.value.trim(),
        password.value,
        setupToken.value.trim(),
        undefined,
        undefined,
        inviteEmail.value ? inviteToken : undefined,
      );
      recoveryContext.value = 'register';
      shownRecovery.value = recoveryCode;
    } else {
      const invalid = validateNewPassword();
      if (invalid) {
        error.value = invalid;
        return;
      }
      const { recoveryCode } = await account.recoverAccount(
        email.value.trim().toLowerCase(),
        recoveryInput.value,
        password.value,
      );
      recoveryContext.value = 'recover';
      shownRecovery.value = recoveryCode;
    }
  } catch (e) {
    error.value =
      ldapMode.value && !mfaStep.value && !ldapEnrollStep.value
        ? ldapMessage(e)
        : mfaStep.value
          ? e instanceof ApiError && e.code === 'invalid_challenge'
            ? t('mfa.expired')
            : t('mfa.invalidCode')
          : mode.value === 'recover'
            ? t('auth.recoveryFailed')
            : mode.value === 'unlock'
              ? t('auth.invalid')
              : errorMessage(e, t);
  } finally {
    busy.value = false;
    if (!shownRecovery.value) password.value = mode.value === 'unlock' ? '' : password.value;
  }
}

async function afterRecoveryShown(): Promise<void> {
  const keepEmail = email.value;
  const keepPassword = password.value;
  shownRecovery.value = '';
  recoverySaved.value = false;
  repeat.value = '';
  recoveryInput.value = '';
  mode.value = 'signin';
  email.value = keepEmail;
  password.value = '';
  if (ldapEnrolled.value) {
    ldapEnrolled.value = false;
    ldapMode.value = false;
    ldapEnrollStep.value = false;
    await router.replace('/');
    return;
  }
  if (recoveryContext.value === 'register') {
    // сразу входим, чтобы не заставлять вводить пароль второй раз
    busy.value = true;
    try {
      await auth.signIn(keepEmail.trim().toLowerCase(), keepPassword);
      await router.replace('/');
    } catch (e) {
      error.value = errorMessage(e, t);
    } finally {
      busy.value = false;
    }
  }
}

function ldapMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'invalid_credentials') return t('ldap.invalid');
    if (e.code === 'ldap_unavailable') return t('ldap.unavailable');
    if (e.code === 'ldap_not_provisioned') return t('ldap.notProvisioned');
    if (e.code === 'account_exists_local') return t('ldap.localExists');
    if (e.code === 'too_many_attempts') return t('auth.locked');
  }
  return errorMessage(e, t);
}

function leaveLdap(): void {
  ldapMode.value = false;
  ldapEnrollStep.value = false;
  ldapUser.value = '';
  password.value = '';
  repeat.value = '';
  error.value = '';
}

function cancelMfaStep(): void {
  auth.cancelMfa();
  mfaStep.value = false;
  mfaCode.value = '';
  error.value = '';
  leaveLdap();
}

function switchMode(next: Mode): void {
  mode.value = next;
  error.value = '';
  password.value = '';
  repeat.value = '';
}

async function copyRecovery(): Promise<void> {
  try {
    await navigator.clipboard.writeText(shownRecovery.value);
  } catch {
    /* буфер обмена недоступен — код виден на экране */
  }
}
</script>

<template>
  <section class="mx-auto max-w-md">
    <div
      v-if="shownRecovery"
      class="rounded-lg border border-amber-300 bg-amber-50 p-5 dark:border-amber-700 dark:bg-amber-950"
    >
      <h1 class="mb-2 text-lg font-semibold">{{ t('auth.recoveryTitle') }}</h1>
      <p class="mb-3 text-sm">
        {{ recoveryContext === 'recover' ? t('auth.recoveryDone') : t('auth.recoveryWarn') }}
      </p>
      <p
        class="mb-3 break-all rounded-md bg-white p-3 font-mono text-sm tracking-wide dark:bg-slate-900"
        data-testid="recovery-code"
      >
        {{ shownRecovery }}
      </p>
      <button
        type="button"
        class="mb-4 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-white dark:border-slate-600 dark:hover:bg-slate-800"
        @click="copyRecovery"
      >
        {{ t('common.copy') }}
      </button>
      <label class="mb-4 flex items-center gap-2 text-sm">
        <input v-model="recoverySaved" type="checkbox" data-testid="recovery-saved" />
        {{ t('auth.recoverySaved') }}
      </label>
      <button
        type="button"
        class="w-full rounded-md bg-brand-500 px-4 py-2 font-medium text-white hover:bg-brand-600 disabled:opacity-50"
        :disabled="!recoverySaved || busy"
        data-testid="recovery-continue"
        @click="afterRecoveryShown"
      >
        {{ t('auth.continue') }}
      </button>
    </div>

    <form
      v-else
      class="space-y-4 rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"
      @submit.prevent="submit"
    >
      <h1 class="text-xl font-semibold">{{ mfaStep ? t('mfa.title') : title }}</h1>
      <p v-if="mode === 'unlock'" class="text-sm text-slate-500 dark:text-slate-400">
        {{ t('auth.unlockHint') }}
      </p>
      <p
        v-if="inviteEmail"
        class="rounded-md bg-emerald-50 p-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
        data-testid="invite-banner"
      >
        {{ t('invite.banner') }}
      </p>
      <p
        v-if="inviteBad"
        class="rounded-md bg-red-50 p-2 text-sm text-red-700"
        role="alert"
        data-testid="invite-bad"
      >
        {{ t('invite.badLink') }}
      </p>
      <p v-if="mode === 'register' && firstUser" class="text-sm text-slate-500 dark:text-slate-400">
        {{ t('auth.firstUser') }}
      </p>
      <p
        v-if="mode === 'register' && !registrationOpen"
        class="text-sm text-amber-700 dark:text-amber-300"
      >
        {{ t('auth.registrationClosedNote') }}
      </p>

      <label v-if="mode !== 'unlock' && !mfaStep && !ldapMode" class="block text-sm">
        <span class="mb-1 block">{{ t('common.email') }}</span>
        <input
          v-model="email"
          type="email"
          required
          autocomplete="username"
          :readonly="!!inviteEmail"
          class="field"
          data-testid="email"
        />
      </label>
      <label v-if="mode === 'register'" class="block text-sm">
        <span class="mb-1 block">{{ t('common.name') }}</span>
        <input
          v-model="displayName"
          type="text"
          required
          maxlength="100"
          autocomplete="name"
          class="field"
          data-testid="name"
        />
      </label>
      <label v-if="mode === 'register' && setupRequired" class="block text-sm">
        <span class="mb-1 block">{{ t('auth.setupCode') }}</span>
        <input
          v-model="setupToken"
          type="password"
          required
          autocomplete="off"
          class="field font-mono"
          data-testid="setup-token"
        />
        <span class="mt-1 block text-xs text-slate-500">{{ t('auth.setupCodeHint') }}</span>
      </label>
      <label v-if="mode === 'recover'" class="block text-sm">
        <span class="mb-1 block">{{ t('auth.recoveryCode') }}</span>
        <input
          v-model="recoveryInput"
          type="text"
          required
          autocomplete="off"
          spellcheck="false"
          class="field font-mono"
          data-testid="recovery-input"
        />
      </label>
      <label v-if="ldapMode && !mfaStep && !ldapEnrollStep" class="block text-sm">
        <span class="mb-1 block">{{ t('ldap.username') }}</span>
        <input
          v-model="ldapUser"
          type="text"
          required
          autocomplete="username"
          class="field"
          data-testid="ldap-user"
        />
      </label>
      <p v-if="ldapEnrollStep" class="text-sm text-slate-500" data-testid="ldap-enroll-hint">
        {{ t('ldap.enrollHint') }}
      </p>
      <label v-if="mfaStep" class="block text-sm">
        <span class="mb-1 block">{{ t('mfa.code') }}</span>
        <input
          v-model="mfaCode"
          type="text"
          :required="!auth.mfaOffers().webauthn"
          inputmode="numeric"
          autocomplete="one-time-code"
          spellcheck="false"
          class="field font-mono"
          data-testid="mfa-code"
        />
        <span class="mt-1 block text-xs text-slate-500">{{ t('mfa.codeHint') }}</span>
      </label>
      <label v-if="!mfaStep" class="block text-sm">
        <span class="mb-1 block">{{
          ldapMode && !ldapEnrollStep ? t('ldap.password') : t('common.password')
        }}</span>
        <input
          v-model="password"
          type="password"
          required
          :autocomplete="
            mode === 'signin' || mode === 'unlock' ? 'current-password' : 'new-password'
          "
          class="field"
          data-testid="password"
        />
      </label>
      <label
        v-if="mode === 'register' || mode === 'recover' || ldapEnrollStep"
        class="block text-sm"
      >
        <span class="mb-1 block">{{ t('auth.repeat') }}</span>
        <input
          v-model="repeat"
          type="password"
          required
          autocomplete="new-password"
          class="field"
          data-testid="repeat"
        />
      </label>
      <p
        v-if="mode === 'register' || mode === 'recover'"
        class="text-xs text-slate-500 dark:text-slate-400"
      >
        {{ t('auth.passwordHint') }}
      </p>

      <p
        v-if="error"
        class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        role="alert"
        data-testid="error"
      >
        {{ error }}
      </p>

      <button
        type="submit"
        class="w-full rounded-md bg-brand-500 px-4 py-2 font-medium text-white hover:bg-brand-600 disabled:opacity-60"
        :disabled="busy"
        data-testid="submit"
      >
        {{ busy ? t('common.working') : mfaStep ? t('mfa.confirm') : title }}
      </button>

      <button
        v-if="mfaStep && auth.mfaOffers().webauthn"
        type="button"
        class="w-full rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
        :disabled="busy"
        data-testid="mfa-webauthn"
        @click="useKey"
      >
        {{ t('mfa.useKey') }}
      </button>
      <button
        v-if="mfaStep"
        type="button"
        class="text-sm underline"
        data-testid="mfa-cancel"
        @click="cancelMfaStep"
      >
        {{ t('mfa.cancel') }}
      </button>

      <a
        v-if="sso.enabled && mode === 'signin' && !mfaStep && !ldapEnrollStep"
        href="/api/v1/auth/sso/start"
        class="block w-full rounded-md border border-slate-300 px-4 py-2 text-center text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
        data-testid="to-sso"
      >
        {{ sso.buttonText }}
      </a>

      <button
        v-if="ldapAvailable && mode === 'signin' && !mfaStep && !ldapEnrollStep"
        type="button"
        class="text-sm underline"
        data-testid="to-ldap"
        @click="ldapMode ? leaveLdap() : ((ldapMode = true), (error = ''))"
      >
        {{ ldapMode ? t('ldap.usePassword') : t('ldap.useDirectory') }}
      </button>

      <div
        v-if="mode !== 'unlock' && !mfaStep && !ldapMode"
        class="flex flex-wrap justify-between gap-2 text-sm text-brand-600 dark:text-brand-500"
      >
        <button
          v-if="mode !== 'signin'"
          type="button"
          class="underline"
          @click="switchMode('signin')"
        >
          {{ t('auth.toSignIn') }}
        </button>
        <button
          v-if="mode === 'signin' && registrationOpen"
          type="button"
          class="underline"
          data-testid="to-register"
          @click="switchMode('register')"
        >
          {{ t('auth.toRegister') }}
        </button>
        <button
          v-if="mode === 'signin'"
          type="button"
          class="underline"
          @click="switchMode('recover')"
        >
          {{ t('auth.toRecover') }}
        </button>
      </div>
      <div v-else class="text-sm">
        <button
          type="button"
          class="underline"
          @click="auth.signOut().then(() => router.replace('/login'))"
        >
          {{ t('nav.signOut') }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.field {
  width: 100%;
  border-radius: 0.375rem;
  border: 1px solid rgb(203 213 225);
  background: transparent;
  padding: 0.5rem 0.75rem;
}
.field:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 1px;
}
:global(html.dark) .field {
  border-color: rgb(51 65 85);
}
</style>
