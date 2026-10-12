<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SessionInfo } from '@arklock/contracts';
import { api, ApiError } from '../services/api';
import { changePassword, MIN_MASTER_PASSWORD } from '../services/account';
import { useAuthStore } from '../stores/auth';
import { errorMessage } from '../services/helpers';
import MfaSettings from '../components/MfaSettings.vue';
import TokensSettings from '../components/TokensSettings.vue';

const { t } = useI18n();
const auth = useAuthStore();
const sessions = ref<SessionInfo[]>([]);
const error = ref('');
const done = ref('');
const busy = ref(false);
const current = ref('');
const next = ref('');
const repeat = ref('');

async function load(): Promise<void> {
  try {
    sessions.value = await api<SessionInfo[]>('GET', '/auth/sessions');
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
onMounted(load);

async function revoke(id: string): Promise<void> {
  await api('DELETE', `/auth/sessions/${id}`);
  await load();
}

async function revokeOthers(): Promise<void> {
  await api('POST', '/auth/sessions/revoke-others');
  await load();
}

async function submit(): Promise<void> {
  error.value = '';
  done.value = '';
  if (next.value.length < MIN_MASTER_PASSWORD) {
    error.value = t('auth.tooShort');
    return;
  }
  if (next.value !== repeat.value) {
    error.value = t('auth.mismatch');
    return;
  }
  busy.value = true;
  try {
    await changePassword(auth.user!, current.value, next.value);
    done.value = t('security.changed');
    current.value = next.value = repeat.value = '';
    await load();
  } catch (e) {
    error.value =
      e instanceof ApiError && e.code === 'invalid_credentials'
        ? t('security.wrongPassword')
        : errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="space-y-8">
    <h1 class="text-xl font-semibold">{{ t('security.title') }}</h1>

    <div>
      <div class="mb-2 flex items-center justify-between">
        <h2 class="font-medium">{{ t('security.sessions') }}</h2>
        <button
          type="button"
          class="text-sm underline"
          data-testid="revoke-others"
          @click="revokeOthers"
        >
          {{ t('security.revokeOthers') }}
        </button>
      </div>
      <ul
        class="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900"
        data-testid="sessions"
      >
        <li
          v-for="s in sessions"
          :key="s.id"
          class="flex items-center justify-between gap-3 px-4 py-3 text-sm"
        >
          <div class="min-w-0">
            <div class="truncate">
              {{ s.userAgent ?? '—' }}
              <span
                v-if="s.current"
                class="ml-1 rounded bg-emerald-100 px-1.5 text-xs text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                >{{ t('security.current') }}</span
              >
            </div>
            <div class="text-xs text-slate-500">
              {{ s.ip ?? '—' }} · {{ t('security.lastSeen') }}:
              {{ new Date(s.lastSeenAt).toLocaleString() }}
            </div>
          </div>
          <button
            v-if="!s.current"
            type="button"
            class="shrink-0 rounded border border-slate-300 px-2 py-1 dark:border-slate-700"
            @click="revoke(s.id)"
          >
            {{ t('security.revoke') }}
          </button>
        </li>
      </ul>
    </div>

    <MfaSettings />

    <TokensSettings />

    <form class="max-w-md space-y-3" @submit.prevent="submit">
      <h2 class="font-medium">{{ t('security.changePassword') }}</h2>
      <label class="block text-sm">
        <span class="mb-1 block">{{ t('security.currentPassword') }}</span>
        <input
          v-model="current"
          type="password"
          required
          autocomplete="current-password"
          class="field"
        />
      </label>
      <label class="block text-sm">
        <span class="mb-1 block">{{ t('security.newPassword') }}</span>
        <input v-model="next" type="password" required autocomplete="new-password" class="field" />
      </label>
      <label class="block text-sm">
        <span class="mb-1 block">{{ t('auth.repeat') }}</span>
        <input
          v-model="repeat"
          type="password"
          required
          autocomplete="new-password"
          class="field"
        />
      </label>
      <p v-if="error" class="text-sm text-red-600 dark:text-red-400" role="alert">{{ error }}</p>
      <p v-if="done" class="text-sm text-emerald-700 dark:text-emerald-400" role="status">
        {{ done }}
      </p>
      <button
        type="submit"
        class="rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-60"
        :disabled="busy"
      >
        {{ busy ? t('common.working') : t('common.save') }}
      </button>
    </form>
  </section>
</template>

<style scoped>
.field {
  width: 100%;
  border-radius: 0.375rem;
  border: 1px solid rgb(203 213 225);
  background: transparent;
  padding: 0.4rem 0.6rem;
}
:global(html.dark) .field {
  border-color: rgb(51 65 85);
}
</style>
