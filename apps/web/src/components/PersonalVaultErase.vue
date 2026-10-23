<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { authKeyFor } from '../services/account';
import { errorMessage } from '../services/helpers';
import { useAuthStore } from '../stores/auth';
import { useWorkspaceStore } from '../stores/workspace';

/** Сотрудник удаляет свой прежний личный сейф, когда личные сейфы отключены: явное подтверждение и мастер-пароль. */
const { t } = useI18n();
const auth = useAuthStore();
const ws = useWorkspaceStore();
const password = ref('');
const understood = ref(false);
const busy = ref(false);
const error = ref('');
const done = ref(false);

async function erase(): Promise<void> {
  if (!auth.user || !understood.value || !password.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api('POST', '/auth/personal-vault/erase', {
      authKey: await authKeyFor(auth.user, password.value),
      confirm: true,
    });
    password.value = '';
    done.value = true;
    await ws.loadVaults();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div id="personal" data-testid="personal-erase">
    <h2>{{ t('personal.title') }}</h2>
    <p v-if="done" class="notice notice-ok mt-2" role="status">{{ t('personal.erased') }}</p>
    <template v-else>
      <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
        {{ t('personal.intro', { n: ws.personalEntries }) }}
      </p>
      <p class="mt-1 text-xs text-slate-500">{{ t('personal.exportHint') }}</p>
      <details
        class="mt-3 max-w-lg rounded-[10px] border border-red-200 p-3 text-sm dark:border-red-900"
      >
        <summary class="cursor-pointer font-medium text-red-700 dark:text-red-300">
          {{ t('personal.eraseTitle') }}
        </summary>
        <form class="mt-2 space-y-2" @submit.prevent="erase">
          <p class="text-xs text-slate-600 dark:text-slate-300">{{ t('personal.eraseWarn') }}</p>
          <label class="flex items-start gap-2"
            ><input
              v-model="understood"
              type="checkbox"
              class="mt-1"
              data-testid="personal-erase-ack"
            />{{ t('personal.eraseConfirm') }}</label
          >
          <label class="block"
            ><span class="field-label">{{ t('personal.password') }}</span
            ><input
              v-model="password"
              type="password"
              autocomplete="current-password"
              class="input"
              data-testid="personal-erase-password"
          /></label>
          <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
          <button
            type="submit"
            class="btn-danger"
            :disabled="busy || !understood || !password"
            :aria-busy="busy || undefined"
            data-testid="personal-erase-submit"
          >
            {{ t('personal.erase') }}
          </button>
        </form>
      </details>
    </template>
  </div>
</template>
