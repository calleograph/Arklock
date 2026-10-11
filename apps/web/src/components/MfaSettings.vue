<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import qrcode from 'qrcode-generator';
import { api, ApiError } from '../services/api';
import { authKeyFor } from '../services/account';
import { errorMessage } from '../services/helpers';
import { useAuthStore } from '../stores/auth';

const { t } = useI18n();
const auth = useAuthStore();

const state = ref<{
  enabled: boolean;
  backupCodesRemaining: number;
  policy: string;
  required: boolean;
} | null>(null);
const setup = ref<{ secret: string; uri: string } | null>(null);
const code = ref('');
const password = ref('');
const shownCodes = ref<string[]>([]);
const mode = ref<'' | 'disable' | 'regenerate'>('');
const error = ref('');
const busy = ref(false);

const qr = computed(() => {
  if (!setup.value) return '';
  const q = qrcode(0, 'M');
  q.addData(setup.value.uri);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
});

async function load(): Promise<void> {
  state.value = await api('GET', '/auth/mfa');
}
onMounted(() => load().catch((e) => (error.value = errorMessage(e, t))));

function fail(e: unknown): void {
  error.value =
    e instanceof ApiError && e.code === 'invalid_code'
      ? t('mfa.invalidCode')
      : e instanceof ApiError && e.code === 'invalid_credentials'
        ? t('security.wrongPassword')
        : e instanceof ApiError && e.code === 'mfa_required_by_policy'
          ? t('mfa.requiredByPolicy')
          : e instanceof ApiError && e.code === 'too_many_attempts'
            ? t('auth.locked')
            : errorMessage(e, t);
}

async function start(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    setup.value = await api('POST', '/auth/mfa/setup');
    code.value = '';
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

async function enable(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    const res = await api<{ backupCodes: string[] }>('POST', '/auth/mfa/enable', {
      code: code.value.trim(),
    });
    shownCodes.value = res.backupCodes;
    setup.value = null;
    code.value = '';
    await load();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

async function confirmAction(): Promise<void> {
  if (!auth.user) return;
  error.value = '';
  busy.value = true;
  try {
    const key = await authKeyFor(auth.user, password.value);
    if (mode.value === 'disable') {
      await api('POST', '/auth/mfa/disable', { authKey: key, code: code.value.trim() });
    } else {
      const res = await api<{ backupCodes: string[] }>('POST', '/auth/mfa/backup-codes', {
        authKey: key,
        code: code.value.trim(),
      });
      shownCodes.value = res.backupCodes;
    }
    mode.value = '';
    password.value = '';
    code.value = '';
    await load();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

const copyCodes = () => navigator.clipboard.writeText(shownCodes.value.join('\n')).catch(() => {});
</script>

<template>
  <div class="max-w-md space-y-3" data-testid="mfa-section">
    <h2 class="font-medium">{{ t('mfa.section') }}</h2>
    <p
      v-if="state?.required && !state.enabled"
      class="rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200"
      role="alert"
      data-testid="mfa-required"
    >
      {{ t('mfa.requiredNotice') }}
    </p>

    <div
      v-if="shownCodes.length"
      class="space-y-2 rounded-md border border-slate-300 p-3 dark:border-slate-700"
    >
      <p class="text-sm">{{ t('mfa.backupShown') }}</p>
      <ul class="grid grid-cols-2 gap-1 font-mono text-sm" data-testid="mfa-backup-codes">
        <li v-for="c in shownCodes" :key="c">{{ c }}</li>
      </ul>
      <div class="flex gap-2">
        <button type="button" class="btn" @click="copyCodes">{{ t('common.copy') }}</button>
        <button type="button" class="btn" data-testid="mfa-codes-saved" @click="shownCodes = []">
          {{ t('mfa.saved') }}
        </button>
      </div>
    </div>

    <template v-else-if="setup">
      <p class="text-sm">{{ t('mfa.scan') }}</p>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="h-44 w-44 rounded bg-white p-1" v-html="qr"></div>
      <p class="break-all text-xs text-slate-500">
        {{ t('mfa.manualKey') }}:
        <span class="font-mono" data-testid="mfa-secret">{{ setup.secret }}</span>
      </p>
      <form class="space-y-2" @submit.prevent="enable">
        <input
          v-model="code"
          required
          inputmode="numeric"
          autocomplete="one-time-code"
          class="field font-mono"
          :placeholder="t('mfa.code')"
          data-testid="mfa-enable-code"
        />
        <button type="submit" class="btn-primary" :disabled="busy" data-testid="mfa-enable">
          {{ t('mfa.enable') }}
        </button>
      </form>
    </template>

    <template v-else-if="state">
      <p class="text-sm" data-testid="mfa-state">
        {{ state.enabled ? t('mfa.on', { n: state.backupCodesRemaining }) : t('mfa.off') }}
      </p>
      <button
        v-if="!state.enabled"
        type="button"
        class="btn"
        :disabled="busy"
        data-testid="mfa-start"
        @click="start"
      >
        {{ t('mfa.setup') }}
      </button>
      <div v-else-if="!mode" class="flex flex-wrap gap-2">
        <button type="button" class="btn" data-testid="mfa-regenerate" @click="mode = 'regenerate'">
          {{ t('mfa.regenerate') }}
        </button>
        <button
          v-if="!state.required"
          type="button"
          class="btn"
          data-testid="mfa-disable"
          @click="mode = 'disable'"
        >
          {{ t('mfa.disable') }}
        </button>
      </div>
      <form v-else class="space-y-2" @submit.prevent="confirmAction">
        <input
          v-model="password"
          type="password"
          required
          autocomplete="current-password"
          class="field"
          :placeholder="t('common.password')"
          data-testid="mfa-password"
        />
        <input
          v-model="code"
          required
          autocomplete="one-time-code"
          class="field font-mono"
          :placeholder="t('mfa.code')"
          data-testid="mfa-action-code"
        />
        <div class="flex gap-2">
          <button type="submit" class="btn-primary" :disabled="busy" data-testid="mfa-confirm">
            {{ mode === 'disable' ? t('mfa.disable') : t('mfa.regenerate') }}
          </button>
          <button type="button" class="btn" @click="mode = ''">{{ t('common.cancel') }}</button>
        </div>
      </form>
    </template>
    <p
      v-if="error"
      class="text-sm text-red-600 dark:text-red-400"
      role="alert"
      data-testid="mfa-error"
    >
      {{ error }}
    </p>
  </div>
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
