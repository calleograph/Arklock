<script setup lang="ts">
import { when } from '../services/helpers';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { UpdatesOverview } from '@arklock/contracts';
import { api, ApiError } from '../services/api';
import { confirmStepUp, stepUpHeaders } from '../services/stepup';
import { useAuthStore } from '../stores/auth';
import { openWhatsNew } from '../services/releases';
import InstallInventory from '../components/InstallInventory.vue';
import AutoUpdateSettings from '../components/AutoUpdateSettings.vue';

const { t, te } = useI18n();
const label = (group: string, v: string) =>
  te(`updates.${group}.${v}`) ? t(`updates.${group}.${v}`) : v;
const auth = useAuthStore();

const data = ref<UpdatesOverview | null>(null);
const error = ref('');

/** Строки консоли: служебные отметки уже отфильтрованы на сервере. */
const consoleLines = computed(() =>
  (data.value?.updateLog ?? '').split('\n').filter((line) => line.trim() !== ''),
);

/** Цвет строки по маркеру вывода: ошибки, предупреждения, успешные этапы, ход работы. */
function lineTone(line: string): string {
  if (/\[FAIL\]|ОШИБКА|ошибка|не удалось|не прошёл|не пройден/i.test(line)) return 'tone-error';
  if (/\[warn\]|предупрежд/i.test(line)) return 'tone-warn';
  if (/\[ok\]/.test(line)) return 'tone-ok';
  if (/\[\.\.\]/.test(line)) return 'tone-info';
  return '';
}
const busy = ref(false);
/** Последняя успешная установка версии (из журнала действий помощника). */
const lastInstall = computed(() =>
  data.value?.history.find((h) => h.action === 'update' && h.result === 'success'),
);

// Повторное подтверждение пароля: токен живёт 5 минут и хранится только в памяти.
const askPassword = ref(false);
const password = ref('');
const pendingAction = ref<null | (() => Promise<void>)>(null);
const withRestore = ref(false);

let timer: ReturnType<typeof setTimeout> | null = null;
let alive = true;

/** Идентификатор запроса, поставленного из этого окна (обновление или откат): по нему отличаем свою операцию от старого статуса. */
const activeRequest = ref<string | null>(null);
const shown = computed(() => {
  const s = data.value!.status;
  if (activeRequest.value && s.requestId !== activeRequest.value) {
    return {
      ...s,
      state: 'running' as const,
      action: s.action,
      stepNo: 0,
      stepTotal: 0,
      stepName: t('updates.queued'),
      message: null,
    };
  }
  return s;
});
const showProgress = computed(
  () =>
    !!activeRequest.value ||
    running.value ||
    (data.value!.status.state !== 'idle' && data.value!.status.action !== 'check'),
);

const running = computed(
  () => data.value?.status.state === 'running' || data.value?.pending === true,
);
const latestPlain = computed(() => (data.value?.remote?.latest ?? '').replace(/^v/, ''));
/** Сервер уже работает в другой версии, а во вкладке старый интерфейс — нужен F5. */
const staleUi = computed(
  () =>
    !!data.value &&
    !running.value &&
    data.value.installed.version !== '0.0.0' &&
    data.value.installed.version !== __APP_VERSION__,
);
const reloadPage = () => location.reload();
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
    const headers: Record<string, string> = (needsReauth && stepUpHeaders()) || {};
    const res = await api<{ requestId: string }>('POST', '/admin/updates', payload, { headers });
    if ((payload as { action: string }).action !== 'check') activeRequest.value = res.requestId;
    await load();
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}

function dangerous(payload: object): void {
  const run = async () => send(payload, true);
  if (stepUpHeaders()) {
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
    await confirmStepUp(auth.user!, password.value);
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
// штатное обновление выполняется по административному сеансу; подтверждение — только для отката
const update = () => send({ action: 'update', version: data.value?.remote?.latest }, false);
const rollback = () => dangerous({ action: 'rollback', withRestore: withRestore.value });

const fmt = (iso: string | null) => (iso ? when(iso) : '—');
</script>

<template>
  <section class="space-y-6">
    <h2>{{ t('updates.title') }}</h2>
    <p
      v-if="error && !askPassword"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      role="alert"
      data-testid="updates-error"
    >
      {{ error }}
    </p>

    <template v-if="data">
      <!-- состояние одной фразой: есть ли что ставить, и что делать -->
      <p
        v-if="staleUi"
        class="notice notice-warn items-center justify-between"
        role="status"
        data-testid="update-state"
      >
        <span>{{ t('updates.state.staleUi', { v: data.installed.version }) }}</span>
        <button type="button" class="btn" @click="reloadPage">{{ t('updates.reloadPage') }}</button>
      </p>
      <p v-else-if="running" class="notice notice-warn" role="status" data-testid="update-state">
        {{ t('updates.state.running') }}
      </p>
      <p
        v-else-if="updateAvailable"
        class="notice border-brand-100 bg-brand-50 text-brand-700"
        role="status"
        data-testid="update-state"
      >
        {{ t('updates.state.available', { v: latestPlain, cur: data.installed.version }) }}
      </p>
      <p
        v-else-if="data.remote?.status === 'up_to_date'"
        class="notice notice-ok"
        role="status"
        data-testid="update-state"
      >
        {{ t('updates.state.upToDate', { v: data.installed.version }) }}
      </p>
      <p
        v-else-if="data.remote"
        class="notice notice-error"
        role="status"
        data-testid="update-state"
      >
        {{ t('updates.state.failed') }}
      </p>
      <p
        v-else
        class="notice border-slate-200 text-slate-600"
        role="status"
        data-testid="update-state"
      >
        {{ t('updates.state.notChecked') }}
      </p>
      <dl
        class="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white text-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900"
        data-testid="updates-info"
      >
        <div class="flex justify-between gap-4 px-4 py-2.5">
          <dt class="text-slate-500">{{ t('updates.installed') }}</dt>
          <dd class="flex items-center gap-3 font-medium">
            <span data-testid="installed-version">{{ data.installed.version }}</span>
            <button
              type="button"
              class="btn"
              data-testid="updates-whatsnew"
              @click="openWhatsNew()"
            >
              {{ t('whatsnew.menu') }}
            </button>
          </dd>
        </div>
        <div class="flex justify-between gap-4 px-4 py-2.5">
          <dt class="text-slate-500">{{ t('whatsnew.installedAt') }}</dt>
          <dd data-testid="last-install">
            {{ lastInstall ? `${fmt(lastInstall.at)} · ${lastInstall.versionTo ?? ''}` : '—' }}
          </dd>
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

      <AutoUpdateSettings
        :auto="data.auto"
        :checked-at="data.remote?.checkedAt ?? null"
        @saved="load"
      />

      <div
        v-if="showProgress"
        class="rounded-lg border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900"
        data-testid="updates-progress"
      >
        <div class="mb-2 flex justify-between">
          <span class="font-medium">
            {{ shown.action }} · {{ shown.versionFrom ?? '' }} →
            {{ shown.versionTo ?? '' }}
          </span>
          <span data-testid="progress-state">{{ shown.state }}</span>
        </div>
        <div class="h-2 overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
          <div
            class="h-full bg-brand-500 transition-all"
            :style="{ width: `${shown.state === 'success' ? 100 : progress}%` }"
          />
        </div>
        <p class="mt-2 text-slate-500">
          {{ shown.stepNo }}/{{ shown.stepTotal }} · {{ shown.stepName }}
        </p>
        <p
          v-if="shown.message"
          class="mt-1"
          :class="shown.state === 'failed' ? 'text-red-600' : ''"
          data-testid="progress-message"
        >
          {{ shown.message }}
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="btn"
          :disabled="busy || running || !data.helper.alive"
          data-testid="btn-check"
          @click="check"
        >
          {{ t('updates.check') }}
        </button>
        <button
          v-if="updateAvailable"
          type="button"
          class="btn-primary"
          :disabled="busy || running || !data.helper.alive"
          data-testid="btn-update"
          @click="update"
        >
          {{ t('updates.updateTo', { v: latestPlain }) }}
        </button>
        <button
          type="button"
          class="btn"
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

      <!-- Журнал обновления в виде консоли: все этапы, команды помощника и ошибки как есть -->
      <div>
        <h2 class="mb-2 font-medium">{{ t('updates.console') }}</h2>
        <div class="update-console" role="log" aria-live="polite" data-testid="update-console">
          <p v-if="!consoleLines.length" class="text-slate-500">{{ t('updates.consoleEmpty') }}</p>
          <div
            v-for="(line, i) in consoleLines"
            :key="i"
            class="update-console-line"
            :class="lineTone(line)"
          >
            {{ line }}
          </div>
        </div>
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
              >{{ fmt(h.at) }} · {{ label('historyAction', h.action) }}
              <template v-if="h.versionTo"
                >{{ h.versionFrom ?? '' }} → {{ h.versionTo }}</template
              ></span
            >
            <span :class="h.result === 'success' ? 'text-emerald-600' : 'text-red-600'">{{
              label('historyResult', h.result)
            }}</span>
          </li>
        </ul>
      </div>

      <InstallInventory />
    </template>

    <div
      v-if="askPassword"
      class="modal-scrim flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <form class="modal w-full max-w-sm space-y-3 p-5" @submit.prevent="confirmPassword">
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
