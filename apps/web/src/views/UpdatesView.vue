<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { UpdatesOverview } from '@arklock/contracts';
import { api, ApiError } from '../services/api';
import { reauth } from '../services/account';
import { useAuthStore } from '../stores/auth';

const { t } = useI18n();
const auth = useAuthStore();

const data = ref<UpdatesOverview | null>(null);
const error = ref('');
const busy = ref(false);

// Повторное подтверждение пароля: токен живёт 5 минут и хранится только в памяти.
let reauthToken: { token: string; expiresAt: number } | null = null;
const askPassword = ref(false);
const password = ref('');
const pendingAction = ref<null | (() => Promise<void>)>(null);
const withRestore = ref(false);

let timer: ReturnType<typeof setTimeout> | null = null;
let alive = true;

const running = computed(
  () => data.value?.status.state === 'running' || data.value?.pending === true,
);
const updateAvailable = computed(
  () => data.value?.remote?.status === 'available' && !!data.value.remote.latest,
);
const progress = computed(() => {
  const s = data.value?.status;
  return s && s.stepTotal > 0 ? Math.round((s.stepNo / s.stepTotal) * 100) : 0;
});

async function load(): Promise<void> {
  try {
    data.value = await api<UpdatesOverview>('GET', '/admin/updates');
  } catch (e) {
    error.value = e instanceof ApiError ? e.code : 'network_error';
  }
  if (alive) timer = setTimeout(load, running.value ? 1500 : 10_000);
}

onMounted(load);
onBeforeUnmount(() => {
  alive = false;
  if (timer) clearTimeout(timer);
});

function message(e: unknown): string {
  if (e instanceof ApiError) {
    const map: Record<string, string> = {
      update_in_progress: t('updates.errBusy'),
      updater_unavailable: t('updates.errHelper'),
      invalid_credentials: t('updates.errPassword'),
      too_many_attempts: t('auth.locked'),
    };
    return map[e.code] ?? t('error.generic');
  }
  return t('error.generic');
}

async function send(payload: object, needsReauth: boolean): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    const headers: Record<string, string> = {};
    if (needsReauth && reauthToken) headers['X-Reauth-Token'] = reauthToken.token;
    await api('POST', '/admin/updates', payload, { headers });
    await load();
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}

function dangerous(payload: object): void {
  const run = async () => send(payload, true);
  if (reauthToken && reauthToken.expiresAt > Date.now() + 5_000) {
    void run();
    return;
  }
  pendingAction.value = run;
  password.value = '';
  askPassword.value = true;
}

async function confirmPassword(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const r = await reauth(auth.user!, password.value);
    reauthToken = { token: r.token, expiresAt: Date.parse(r.expiresAt) };
    askPassword.value = false;
    password.value = '';
    const run = pendingAction.value;
    pendingAction.value = null;
    busy.value = false;
    if (run) await run();
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}

const check = () => send({ action: 'check' }, false);
const update = () => dangerous({ action: 'update', version: data.value?.remote?.latest });
const rollback = () => dangerous({ action: 'rollback', withRestore: withRestore.value });

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
</script>

<template>
  <section class="space-y-6">
    <h1 class="text-xl font-semibold">{{ t('updates.title') }}</h1>
    <p
      v-if="error && !askPassword"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      role="alert"
      data-testid="updates-error"
    >
      {{ error }}
    </p>

    <template v-if="data">
      <dl
        class="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white text-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900"
        data-testid="updates-info"
      >
        <div class="flex justify-between gap-4 px-4 py-2.5">
          <dt class="text-slate-500">{{ t('updates.installed') }}</dt>
          <dd class="font-medium" data-testid="installed-version">{{ data.installed.version }}</dd>
        </div>
        <div class="flex justify-between gap-4 px-4 py-2.5">
          <dt class="text-slate-500">{{ t('updates.build') }}</dt>
          <dd class="truncate font-mono text-xs">
            {{ data.installed.commit.slice(0, 12) }} · {{ data.installed.builtAt }}
          </dd>
        </div>
        <div class="flex justify-between gap-4 px-4 py-2.5">
          <dt class="text-slate-500">{{ t('updates.available') }}</dt>
          <dd class="font-medium" data-testid="remote-status">
            <template v-if="!data.remote">{{ t('updates.notChecked') }}</template>
            <template v-else-if="data.remote.status === 'available'">{{
              data.remote.latest
            }}</template>
            <template v-else-if="data.remote.status === 'up_to_date'">{{
              t('updates.upToDate')
            }}</template>
            <template v-else>{{ t('updates.unreachable') }}</template>
          </dd>
        </div>
        <div class="flex justify-between gap-4 px-4 py-2.5">
          <dt class="text-slate-500">{{ t('updates.lastCheck') }}</dt>
          <dd>{{ fmt(data.remote?.checkedAt ?? null) }}</dd>
        </div>
        <div class="flex justify-between gap-4 px-4 py-2.5">
          <dt class="text-slate-500">{{ t('updates.helper') }}</dt>
          <dd
            :class="data.helper.alive ? 'text-emerald-600' : 'text-red-600'"
            data-testid="helper-state"
          >
            {{ data.helper.alive ? t('updates.helperOk') : t('updates.helperDown') }}
          </dd>
        </div>
      </dl>

      <div
        v-if="running || data.status.state !== 'idle'"
        class="rounded-lg border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900"
        data-testid="updates-progress"
      >
        <div class="mb-2 flex justify-between">
          <span class="font-medium">
            {{ data.status.action }} · {{ data.status.versionFrom ?? '' }} →
            {{ data.status.versionTo ?? '' }}
          </span>
          <span data-testid="progress-state">{{ data.status.state }}</span>
        </div>
        <div class="h-2 overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
          <div
            class="h-full bg-brand-500 transition-all"
            :style="{ width: `${data.status.state === 'success' ? 100 : progress}%` }"
          />
        </div>
        <p class="mt-2 text-slate-500">
          {{ data.status.stepNo }}/{{ data.status.stepTotal }} · {{ data.status.stepName }}
        </p>
        <p
          v-if="data.status.message"
          class="mt-1"
          :class="data.status.state === 'failed' ? 'text-red-600' : ''"
          data-testid="progress-message"
        >
          {{ data.status.message }}
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          :disabled="busy || running || !data.helper.alive"
          data-testid="btn-check"
          @click="check"
        >
          {{ t('updates.check') }}
        </button>
        <button
          type="button"
          class="rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          :disabled="busy || running || !data.helper.alive || !updateAvailable"
          data-testid="btn-update"
          @click="update"
        >
          {{ t('updates.update') }}
          <span v-if="updateAvailable">{{ data.remote?.latest }}</span>
        </button>
        <button
          type="button"
          class="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          :disabled="busy || running || !data.helper.alive"
          data-testid="btn-rollback"
          @click="rollback"
        >
          {{ t('updates.rollback') }}
        </button>
        <label class="flex items-center gap-1 text-xs text-slate-500">
          <input v-model="withRestore" type="checkbox" />
          {{ t('updates.withRestore') }}
        </label>
      </div>

      <div v-if="data.remote?.changelog">
        <h2 class="mb-1 font-medium">{{ t('updates.changes') }}</h2>
        <pre
          class="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 text-xs dark:border-slate-800 dark:bg-slate-900"
          data-testid="changelog"
          >{{ data.remote.changelog }}</pre>
        <p v-if="data.remote.migrations !== null" class="mt-1 text-xs text-slate-500">
          {{ t('updates.migrations', { n: data.remote.migrations }) }}
        </p>
      </div>

      <div>
        <h2 class="mb-1 font-medium">{{ t('updates.history') }}</h2>
        <ul
          class="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white text-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900"
          data-testid="history"
        >
          <li v-if="!data.history.length" class="px-4 py-3 text-slate-500">—</li>
          <li
            v-for="h in data.history"
            :key="h.at + h.action"
            class="flex justify-between gap-3 px-4 py-2"
          >
            <span
              >{{ fmt(h.at) }} · {{ h.action }} {{ h.versionFrom ?? '' }} →
              {{ h.versionTo ?? '' }}</span
            >
            <span :class="h.result === 'success' ? 'text-emerald-600' : 'text-red-600'">{{
              h.result
            }}</span>
          </li>
        </ul>
      </div>
    </template>

    <div
      v-if="askPassword"
      class="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      <form
        class="w-full max-w-sm space-y-3 rounded-lg bg-white p-5 shadow-lg dark:bg-slate-900"
        @submit.prevent="confirmPassword"
      >
        <h2 class="font-semibold">{{ t('updates.confirmTitle') }}</h2>
        <p class="text-sm text-slate-500">{{ t('updates.confirmHint') }}</p>
        <input
          v-model="password"
          type="password"
          required
          autocomplete="current-password"
          class="w-full rounded-md border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700"
          data-testid="reauth-password"
        />
        <p v-if="error" class="text-sm text-red-600" role="alert">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
            @click="askPassword = false"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            :disabled="busy"
            data-testid="reauth-confirm"
          >
            {{ busy ? t('common.working') : t('updates.confirm') }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>
