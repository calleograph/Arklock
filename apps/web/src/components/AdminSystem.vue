<script setup lang="ts">
import { when } from '../services/helpers';
import InfoHint from './InfoHint.vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError, apiBinary } from '../services/api';
import { confirmStepUp, stepUpHeaders } from '../services/stepup';
import OffsiteBackups from './OffsiteBackups.vue';
import CorporateContinuity from './CorporateContinuity.vue';
import RingGauge from './RingGauge.vue';
import TrendChart from './TrendChart.vue';
import { useAuthStore } from '../stores/auth';

type Section =
  | 'overview'
  | 'resources'
  | 'containers'
  | 'backups'
  | 'logs'
  | 'storage'
  | 'diagnostics'
  | 'certificates'
  | 'smtp';
const props = defineProps<{ section: Section }>();

const { t, te } = useI18n();
// диагностика приходит кодами состояния; текст на языке пользователя — из словаря
type Diag = { id: string; state: string; params?: Record<string, string | number> };
const diagBase = (c: Diag) => `diag.${c.state.replace(/-/g, '_')}`;
const diagParams = (c: Diag) => ({
  ...c.params,
  ...(c.params?.name ? { name: t(`diag.disk.names.${c.params.name}`) } : {}),
  ...(c.params?.scope ? { scope: t(`diag.mfa_policy.scope.${c.params.scope}`) } : {}),
});
const diagTitle = (c: Diag) =>
  t(`diag.${c.state.split('.')[0]!.replace(/-/g, '_')}.title`, diagParams(c));
const diagText = (c: Diag, part: 'detail' | 'cause' | 'fix') => {
  const key = `${diagBase(c)}.${part}`;
  return te(key) ? t(key, diagParams(c)) : '';
};
const auth = useAuthStore();
const error = ref('');
const notice = ref('');
const busy = ref(false);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const data = ref<Json>(null);
const fmtBytes = (n: number | null | undefined) => {
  if (n === null || n === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtDate = (s: string | null) => (s ? when(s) : '—');
const fmtUptime = (s: number) =>
  `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
const levelClass = (l: string) =>
  l === 'ok' ? 'text-emerald-600' : l === 'warn' ? 'text-amber-600' : 'text-red-600';
const levelText = (l: string) => t(`sys.level.${l}`);

function failMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const m: Record<string, string> = {
      update_in_progress: t('updates.errBusy'),
      updater_unavailable: t('updates.errHelper'),
      invalid_credentials: t('updates.errPassword'),
      too_many_attempts: t('auth.locked'),
      confirmation_mismatch: t('sys.confirmMismatch'),
      smtp_not_configured: t('sys.smtpNotConfigured'),
    };
    return m[e.code] ?? t('error.generic');
  }
  return t('error.generic');
}

let timer: ReturnType<typeof setTimeout> | null = null;
let alive = true;
onBeforeUnmount(() => {
  alive = false;
  if (timer) clearTimeout(timer);
});

const PATHS: Record<Section, string> = {
  overview: '/admin/overview',
  resources: '/admin/resources',
  containers: '/admin/containers',
  backups: '/admin/backups',
  logs: '/admin/logs/system',
  storage: '/admin/storage',
  diagnostics: '/admin/diagnostics',
  certificates: '/admin/certificates',
  smtp: '/admin/smtp',
};
const AUTO: Partial<Record<Section, number>> = {
  resources: 10_000,
  containers: 10_000,
  overview: 15_000,
};

async function load(): Promise<void> {
  if (timer) clearTimeout(timer);
  const section = props.section;
  try {
    const res = await api<Json>('GET', PATHS[section]);
    if (section === props.section) data.value = res;
    if (section === 'smtp' && res.configured) smtp.value = { ...smtp.value, ...res, password: '' };
    error.value = '';
  } catch (e) {
    error.value = failMessage(e);
  }
  // Если помощник временно недоступен, раздел сам перепроверяет состояние
  const every =
    AUTO[props.section] ??
    (['backups', 'logs'].includes(props.section) && data.value?.helperAlive === false
      ? 5000
      : undefined);
  if (alive && every) timer = setTimeout(load, every);
}
// ---- повторное подтверждение пароля для опасных действий
const confirm = ref<{
  label: string;
  run: (headers: Record<string, string>) => Promise<void>;
} | null>(null);
const password = ref('');
function guarded(label: string, run: (headers: Record<string, string>) => Promise<void>): void {
  if (stepUpHeaders()) {
    void exec(run);
    return;
  }
  password.value = '';
  confirm.value = { label, run };
}
async function exec(run: (h: Record<string, string>) => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await run(stepUpHeaders() ?? {});
  } catch (e) {
    error.value = failMessage(e);
  } finally {
    busy.value = false;
  }
}
async function submitConfirm(): Promise<void> {
  if (!confirm.value || !auth.user) return;
  const c = confirm.value;
  busy.value = true;
  error.value = '';
  try {
    await confirmStepUp(auth.user, password.value);
    confirm.value = null;
    password.value = '';
    busy.value = false;
    await exec(c.run);
  } catch (e) {
    error.value = failMessage(e);
  } finally {
    busy.value = false;
  }
}

/** Ожидание завершения операции помощника: опрос статуса, пока он не перестанет быть «выполняется». */
async function waitOp(
  requestId: string,
  timeoutMs = 300_000,
): Promise<{ ok: boolean; message: string }> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && alive) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const o = await api<Json>('GET', '/admin/updates');
      if (o.status.requestId === requestId && o.status.state !== 'running') {
        return { ok: o.status.state === 'success', message: o.status.message ?? '' };
      }
    } catch {
      /* во время восстановления приложение может быть недоступно — продолжаем ждать */
    }
  }
  return { ok: false, message: t('sys.timeout') };
}

async function operation(path: string, body: object, headers: Record<string, string> = {}) {
  const r = await api<{ requestId: string }>('POST', path, body, { headers });
  notice.value = t('sys.running');
  const res = await waitOp(r.requestId);
  if (res.ok) notice.value = res.message || t('sys.done');
  else {
    notice.value = '';
    error.value = res.message || t('error.generic');
  }
  return res;
}

// ---- резервные копии
const label = ref('');
const sched = ref({ enabled: false, hour: 3, keep: 14 });
watch(data, (d) => {
  if (props.section === 'backups' && d?.schedule)
    sched.value = { enabled: d.schedule.enabled, hour: d.schedule.hour, keep: d.schedule.keep };
});
const backupNow = async () => {
  busy.value = true;
  error.value = '';
  try {
    await operation('/admin/backups', { action: 'create', label: label.value || undefined });
    label.value = '';
    // обновление списка очищает ошибку операции; сохраняем её, чтобы показать результат
    const failure = error.value;
    await load();
    error.value = failure;
  } catch (e) {
    error.value = failMessage(e);
  } finally {
    busy.value = false;
  }
};
/** Загрузка копии (например, с другого сервера): помощник проверяет её ключом этого сервера. */
const uploadBackup = async (ev: Event) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  busy.value = true;
  error.value = '';
  try {
    const r = await api<{ requestId: string }>('POST', '/admin/backups/upload', undefined, {
      raw: file,
    });
    notice.value = t('sys.running');
    const res = await waitOp(r.requestId);
    if (res.ok) notice.value = res.message || t('sys.done');
    else error.value = res.message || t('error.generic');
    // обновление списка очищает ошибку операции; сохраняем её, чтобы показать результат
    const failure = error.value;
    await load();
    error.value = failure;
  } catch (e) {
    error.value = failMessage(e);
  } finally {
    busy.value = false;
  }
};
const verifyBackup = async (file: string) => {
  busy.value = true;
  error.value = '';
  try {
    await operation('/admin/backups', { action: 'verify', file });
  } catch (e) {
    error.value = failMessage(e);
  } finally {
    busy.value = false;
  }
};
const deleteBackup = (file: string) =>
  guarded(t('sys.backups.delete'), async (h) => {
    await operation('/admin/backups', { action: 'delete', file }, h);
    await load();
  });
const downloadBackup = (file: string) =>
  guarded(t('sys.backups.download'), async (h) => {
    const r = await operation('/admin/backups', { action: 'export', file }, h);
    if (!r.ok) return;
    const bytes = await apiBinary('GET', `/admin/backups/${file}/download`, undefined, h);
    const url = URL.createObjectURL(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
const restoring = ref('');
const restoreConfirm = ref('');
const restoreBackup = () =>
  guarded(t('sys.backups.restore'), async (h) => {
    await operation(
      '/admin/backups',
      { action: 'restore', file: restoring.value, confirm: restoreConfirm.value },
      h,
    );
    restoring.value = '';
    restoreConfirm.value = '';
  });
const saveSchedule = () =>
  guarded(t('sys.backups.saveSchedule'), async (h) => {
    await operation(
      '/admin/backups',
      {
        action: 'schedule',
        enabled: sched.value.enabled,
        hour: Number(sched.value.hour),
        keep: Number(sched.value.keep),
      },
      h,
    );
    await load();
  });

// ---- журналы
const logForm = ref({ service: 'app', lines: 200 });
const fetchLogs = async () => {
  busy.value = true;
  error.value = '';
  try {
    const r = await operation('/admin/logs/system', {
      service: logForm.value.service,
      lines: Number(logForm.value.lines),
    });
    if (r.ok) await load();
  } catch (e) {
    error.value = failMessage(e);
  } finally {
    busy.value = false;
  }
};

// ---- хранилища
const reconcile = async (apply: boolean) => {
  busy.value = true;
  error.value = '';
  try {
    const r = await api<Json>('POST', '/admin/storage/reconcile', { apply });
    notice.value = apply
      ? t('sys.storage.removed', { n: r.removed.orphans + r.removed.pending })
      : t('sys.storage.report', { o: r.before.orphans, m: r.before.missing });
    await load();
  } catch (e) {
    error.value = failMessage(e);
  } finally {
    busy.value = false;
  }
};

// ---- почта
const smtp = ref({
  host: '',
  port: 587,
  security: 'starttls',
  user: '',
  password: '',
  from: '',
  hasPassword: false,
});
const mailTo = ref('');
const smtpResult = ref('');
const saveSmtp = async () => {
  busy.value = true;
  error.value = '';
  try {
    await api('PUT', '/admin/smtp', {
      host: smtp.value.host,
      port: Number(smtp.value.port),
      security: smtp.value.security,
      user: smtp.value.user,
      from: smtp.value.from,
      password: smtp.value.password === '' ? undefined : smtp.value.password,
    });
    notice.value = t('admin.saved');
    await load();
  } catch (e) {
    error.value = failMessage(e);
  } finally {
    busy.value = false;
  }
};
const smtpAction = async (path: string, body?: object) => {
  busy.value = true;
  error.value = '';
  smtpResult.value = '';
  try {
    const r = await api<{ ok: boolean; message?: string }>('POST', path, body ?? {});
    smtpResult.value = r.ok ? t('sys.smtp.ok') : `${t('sys.smtp.fail')}: ${r.message ?? ''}`;
  } catch (e) {
    error.value = failMessage(e);
  } finally {
    busy.value = false;
  }
};

// Загрузка запускается после объявления всех реактивных переменных
watch(
  () => props.section,
  () => {
    data.value = null;
    notice.value = '';
    error.value = '';
    confirm.value = null;
    void load();
  },
  { immediate: true },
);

const disks = computed(() => (data.value?.disks ?? []) as Json[]);
// пороги для нагрузки и памяти: до 70 % нормально, до 90 % предупреждение, выше — критично
const envRows = computed(() => {
  const h = (data.value?.host ?? {}) as Record<string, string | null>;
  return [
    {
      id: 'docker',
      name: 'Docker Engine',
      why: t('sys.services.why.docker'),
      value: h.docker ?? null,
    },
    {
      id: 'compose',
      name: 'Docker Compose',
      why: t('sys.services.why.compose'),
      value: h.compose ?? null,
    },
    { id: 'os', name: t('sys.services.os'), why: t('sys.services.why.os'), value: h.os ?? null },
    {
      id: 'kernel',
      name: t('sys.services.kernel'),
      why: t('sys.services.why.kernel'),
      value: h.kernel ?? null,
    },
  ];
});
const pctLevel = (p: number): 'ok' | 'warn' | 'fail' =>
  p >= 90 ? 'fail' : p >= 70 ? 'warn' : 'ok';
const memPct = computed(() =>
  data.value?.memory
    ? Math.round(
        ((data.value.memory.totalBytes - data.value.memory.freeBytes) /
          data.value.memory.totalBytes) *
          100,
      )
    : 0,
);
const advice = computed(() => {
  if (!data.value?.cpu) return [];
  const out: { id: string; level: string; text: string; to?: string }[] = [];
  const cpuL = pctLevel(data.value.cpu.loadPct);
  if (cpuL !== 'ok') out.push({ id: 'cpu', level: cpuL, text: t('sys.res.adviceCpu') });
  const memL = pctLevel(memPct.value);
  if (memL !== 'ok') out.push({ id: 'mem', level: memL, text: t('sys.res.adviceMem') });
  for (const d of disks.value)
    if (d.level !== 'ok')
      out.push({
        id: `disk-${d.id}`,
        level: d.level,
        text: t('sys.res.adviceDisk', { name: t(`sys.res.disk.${d.id}`) }),
        to: '/admin/backups',
      });
  return out;
});
// история ресурсов (точка раз в несколько минут, хранится две недели)
const history = ref<{ at: string; cpu: number; mem: number; disk: number }[]>([]);
const historyHours = ref(24);
const historyFrom = computed(() => (history.value[0] ? when(history.value[0].at) : ''));
const historyTo = computed(() =>
  history.value.length ? when(history.value[history.value.length - 1]!.at) : '',
);
async function loadHistory(h = historyHours.value): Promise<void> {
  historyHours.value = h;
  try {
    history.value = (
      await api<{ points: typeof history.value }>('GET', `/admin/resources/history?hours=${h}`)
    ).points;
  } catch {
    history.value = [];
  }
}
watch(
  () => props.section,
  (s) => {
    if (s === 'resources') void loadHistory();
  },
  { immediate: true },
);
/** Куда ведёт «Перейти к настройке» из диагностики: каждое предупреждение — с местом исправления. */
const DIAG_LINK: Record<string, string> = {
  'public-url': '/admin/settings?section=network',
  smtp: '/admin/smtp',
  'mfa-policy': '/admin/settings?section=security',
  helper: '/admin/updates',
  blobs: '/admin/storage',
  'blobs-consistency': '/admin/storage',
  database: '/admin/backups',
  backups: '/admin/backups',
  integrations: '/admin/ldap',
  dns: '/admin/settings?section=network',
  cert: '/admin/certificates',
  static: '/admin/updates',
};
</script>

<template>
  <div class="space-y-4" :data-testid="`sys-${section}`">
    <p
      v-if="error"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      role="alert"
      data-testid="sys-error"
    >
      {{ error }}
    </p>
    <p
      v-if="notice"
      class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
      role="status"
      data-testid="sys-notice"
    >
      {{ notice }}
    </p>

    <form
      v-if="confirm"
      class="card flex flex-wrap items-center gap-2 p-3 text-sm"
      @submit.prevent="submitConfirm"
    >
      <span>{{ t('sys.confirmPassword') }} — {{ confirm.label }}</span>
      <input
        v-model="password"
        type="password"
        required
        autocomplete="current-password"
        class="input w-56"
        data-testid="sys-password"
      />
      <button type="submit" class="btn-primary" :disabled="busy" data-testid="sys-confirm">
        {{ t('common.save') }}
      </button>
      <button type="button" class="btn" @click="confirm = null">{{ t('common.cancel') }}</button>
    </form>

    <p v-if="!data" class="text-sm text-slate-500">{{ t('common.working') }}</p>

    <!-- Обзор -->
    <div v-else-if="section === 'overview'" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <CorporateContinuity />
      <div class="card p-3 text-sm">
        <div class="text-xs text-slate-500">{{ t('sys.overview.version') }}</div>
        <div class="text-lg font-medium" data-testid="ov-version">{{ data.version }}</div>
        <div class="text-xs text-slate-500">{{ data.commit.slice(0, 8) }} · {{ data.builtAt }}</div>
      </div>
      <div class="card p-3 text-sm" :title="t('sys.overview.uptimeHint')">
        <div class="text-xs text-slate-500">{{ t('sys.overview.uptime') }}</div>
        <div class="text-lg font-medium">{{ fmtUptime(data.uptimeSeconds) }}</div>
      </div>
      <div class="card space-y-0.5 p-3 text-sm" data-testid="ov-state">
        <div class="text-xs text-slate-500">{{ t('sys.overview.state') }}</div>
        <div>
          {{ t('sys.overview.db') }}:
          <span :class="data.database.ok ? 'text-emerald-600' : 'text-red-600'">{{
            data.database.ok ? t('sys.overview.dbOk') : t('sys.overview.dbFail')
          }}</span>
        </div>
        <div>
          {{ t('sys.overview.api') }}:
          <span class="text-emerald-600">{{ t('sys.overview.apiOk') }}</span>
        </div>
        <div :title="t('sys.overview.helperHint')">
          {{ t('sys.overview.helper') }}:
          <span :class="data.helper.alive ? 'text-emerald-600' : 'text-amber-600'">{{
            data.helper.alive ? t('sys.overview.helperOk') : t('sys.overview.helperOff')
          }}</span>
        </div>
      </div>
      <!-- сначала корпоративные сейфы, затем личные; число ведёт к подробностям -->
      <component
        :is="k === 'sharedVaults' ? 'RouterLink' : k === 'users' ? 'RouterLink' : 'div'"
        v-for="k in [
          'sharedVaults',
          'lockers',
          'users',
          'entries',
          'attachments',
          'activeSessions',
          'activeLinks',
        ]"
        :key="k"
        class="card p-3 text-sm"
        :class="
          k === 'sharedVaults' || k === 'users' ? 'hover:bg-slate-50 dark:hover:bg-slate-800' : ''
        "
        :to="
          k === 'sharedVaults' ? '/admin/organization' : k === 'users' ? '/admin/users' : undefined
        "
      >
        <div class="text-xs text-slate-500">{{ t(`sys.overview.${k}`) }}</div>
        <div class="text-lg font-medium" :data-testid="`ov-${k}`">{{ data.counts[k] }}</div>
      </component>
      <div class="card p-3 text-sm sm:col-span-2">
        <div class="text-xs text-slate-500">{{ t('sys.overview.lastUpdate') }}</div>
        <div v-if="data.lastUpdate">
          {{ fmtDate(data.lastUpdate.at) }} · {{ data.lastUpdate.action }} ·
          {{ data.lastUpdate.result }}
        </div>
        <div v-else>—</div>
        <RouterLink to="/admin/updates" class="text-xs underline">{{
          t('nav.updates')
        }}</RouterLink>
      </div>
    </div>

    <!-- Ресурсы -->
    <div v-else-if="section === 'resources'" class="space-y-3">
      <div class="card grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="res-gauges">
        <RingGauge
          :pct="data.cpu.loadPct"
          :level="pctLevel(data.cpu.loadPct)"
          label="CPU"
          :sub="`${data.cpu.cores} × · load ${data.cpu.load1.toFixed(2)} / ${data.cpu.load5.toFixed(2)} / ${data.cpu.load15.toFixed(2)}`"
          :state="t(`sys.res.state.${pctLevel(data.cpu.loadPct)}`)"
          data-testid="res-cpu"
        />
        <RingGauge
          :pct="memPct"
          :level="pctLevel(memPct)"
          :label="t('sys.res.memory')"
          :sub="`${fmtBytes(data.memory.totalBytes - data.memory.freeBytes)} / ${fmtBytes(data.memory.totalBytes)} · ${t('sys.res.process')} ${fmtBytes(data.memory.processRssBytes)}`"
          :state="t(`sys.res.state.${pctLevel(memPct)}`)"
          data-testid="res-memory"
        />
        <RingGauge
          v-for="d in disks"
          :key="d.id"
          :pct="d.usedPct"
          :level="d.level"
          :label="t(`sys.res.disk.${d.id}`)"
          :sub="`${t('sys.res.free')} ${fmtBytes(d.freeBytes)} / ${fmtBytes(d.totalBytes)} · ${d.path}`"
          :state="t(`sys.res.state.${d.level}`)"
          data-testid="res-disk"
        />
      </div>
      <div class="card flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
        <span>
          {{ t('sys.res.database') }}:
          <strong>{{ fmtBytes(data.database.sizeBytes) }}</strong>
          · {{ t('sys.res.files') }}: {{ data.attachments.files }} ·
          {{ fmtBytes(data.attachments.bytes) }}
        </span>
      </div>
      <!-- что делать: только при предупреждении или ошибке -->
      <ul v-if="advice.length" class="space-y-1" data-testid="res-advice">
        <li
          v-for="a in advice"
          :key="a.id"
          class="notice"
          :class="a.level === 'fail' ? 'notice-error' : 'notice-warn'"
        >
          {{ a.text }}
          <RouterLink v-if="a.to" :to="a.to" class="ml-1 underline">{{
            t('sys.res.open')
          }}</RouterLink>
        </li>
      </ul>
      <div class="card space-y-3 p-4" data-testid="res-history">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm font-semibold">{{ t('sys.res.history') }}</h3>
          <div class="flex gap-1 rounded-lg bg-slate-100 p-0.5 text-xs dark:bg-slate-800">
            <button
              v-for="h in [6, 24, 168, 336]"
              :key="h"
              type="button"
              class="seg"
              :class="historyHours === h ? 'seg-on' : ''"
              :data-testid="`res-range-${h}`"
              @click="loadHistory(h)"
            >
              {{ t(`sys.res.range.${h}`) }}
            </button>
          </div>
        </div>
        <p v-if="history.length < 2" class="text-xs text-slate-500">
          {{ t('sys.res.historyEmpty') }}
        </p>
        <div v-else class="grid gap-4 sm:grid-cols-3">
          <TrendChart
            :title="'CPU'"
            :values="history.map((p) => p.cpu)"
            :from="historyFrom"
            :to="historyTo"
          />
          <TrendChart
            :title="t('sys.res.memory')"
            :values="history.map((p) => p.mem)"
            :from="historyFrom"
            :to="historyTo"
          />
          <TrendChart
            :title="t('sys.res.diskMax')"
            :values="history.map((p) => p.disk)"
            :from="historyFrom"
            :to="historyTo"
          />
        </div>
        <p class="text-xs text-slate-500">{{ t('sys.res.historyNote') }}</p>
      </div>
    </div>

    <!-- Службы -->
    <div v-else-if="section === 'containers'" class="space-y-3">
      <p v-if="!data.helperAlive" class="notice notice-warn">{{ t('updates.errHelper') }}</p>
      <section class="card overflow-x-auto" data-testid="services-arklock">
        <h3 class="px-3 pt-3 text-sm font-semibold">{{ t('sys.services.own') }}</h3>
        <table class="min-w-full text-sm" data-testid="containers-table">
          <thead class="text-left text-xs text-slate-500">
            <tr>
              <th class="px-3 py-2">{{ t('sys.containers.service') }}</th>
              <th>{{ t('sys.services.purpose') }}</th>
              <th>{{ t('sys.containers.state') }}</th>
              <th>{{ t('sys.containers.started') }}</th>
              <th>CPU</th>
              <th>{{ t('sys.res.memory') }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in data.items"
              :key="c.service"
              class="border-t border-slate-200 dark:border-slate-800"
              data-testid="container-row"
            >
              <td class="px-3 py-2 font-medium">{{ c.service }}</td>
              <td class="text-xs text-slate-500">
                {{
                  te(`sys.services.role.${c.service}`)
                    ? t(`sys.services.role.${c.service}`)
                    : c.image
                }}

                <div class="font-mono text-[11px]">{{ c.image }}</div>
              </td>
              <td
                :class="
                  c.state === 'running' && (c.health === 'healthy' || !c.health)
                    ? 'text-emerald-700'
                    : 'text-red-600'
                "
              >
                {{ c.state }}<span v-if="c.health"> · {{ c.health }}</span>
              </td>
              <td class="text-xs">
                {{ fmtDate(c.startedAt) }}<span v-if="c.restarts"> · ↻{{ c.restarts }}</span>
              </td>
              <td>{{ c.cpu }}</td>
              <td class="text-xs">{{ c.memory }}</td>
              <td class="px-2 text-right">
                <RouterLink to="/admin/diagnostics" class="btn">{{
                  t('sys.services.diagnose')
                }}</RouterLink>
              </td>
            </tr>
            <tr
              class="border-t border-slate-200 dark:border-slate-800"
              data-testid="service-helper"
            >
              <td class="px-3 py-2 font-medium">{{ t('sys.overview.helper') }}</td>
              <td class="text-xs text-slate-500">{{ t('sys.services.role.helper') }}</td>
              <td :class="data.helperAlive ? 'text-emerald-700' : 'text-amber-700'">
                {{ data.helperAlive ? t('sys.overview.helperOk') : t('sys.overview.helperOff') }}
              </td>
              <td colspan="3" class="text-xs text-slate-500">{{ t('sys.overview.helperHint') }}</td>
              <td class="px-2 text-right">
                <RouterLink to="/admin/updates" class="btn">{{
                  t('sys.services.open')
                }}</RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!data.items.length" class="p-3 text-sm text-slate-500">
          {{ t('sys.containers.empty') }}
        </p>
        <p class="px-3 pb-3 pt-1 text-xs text-slate-500">
          {{ t('sys.services.checked', { at: data.at ? fmtDate(data.at) : '—' }) }}
        </p>
      </section>
      <section class="card overflow-x-auto" data-testid="services-env">
        <h3 class="px-3 pt-3 text-sm font-semibold">{{ t('sys.services.env') }}</h3>
        <table class="min-w-full text-sm">
          <tbody>
            <tr
              v-for="e in envRows"
              :key="e.id"
              class="border-t border-slate-200 first:border-0 dark:border-slate-800"
            >
              <td class="px-3 py-2 font-medium">{{ e.name }}</td>
              <td class="text-xs text-slate-500">{{ e.why }}</td>
              <td :class="e.value ? 'text-emerald-700' : 'text-amber-700'">
                {{ e.value ?? t('sys.services.unknown') }}
              </td>
            </tr>
          </tbody>
        </table>
        <p class="px-3 pb-3 pt-1 text-xs text-slate-500">{{ t('sys.services.envNote') }}</p>
      </section>
    </div>

    <!-- Резервные копии -->
    <div v-else-if="section === 'backups'" class="space-y-4">
      <p v-if="!data.helperAlive" class="text-sm text-amber-700">{{ t('updates.errHelper') }}</p>
      <div class="card flex flex-wrap items-center gap-2 p-3 text-sm">
        <input
          v-model="label"
          maxlength="20"
          pattern="[a-z0-9]*"
          class="input w-40"
          :placeholder="t('sys.backups.label')"
          data-testid="backup-label"
        />
        <button
          type="button"
          class="btn-primary"
          :disabled="busy || !data.helperAlive"
          data-testid="backup-create"
          @click="backupNow"
        >
          {{ t('sys.backups.create') }}
        </button>
        <label
          class="btn cursor-pointer"
          :class="{ 'pointer-events-none opacity-50': busy || !data.helperAlive }"
          :title="t('sys.backups.uploadHint')"
        >
          {{ t('sys.backups.upload') }}
          <input
            type="file"
            accept=".gpg,application/octet-stream"
            class="sr-only"
            data-testid="backup-upload"
            :disabled="busy || !data.helperAlive"
            @change="uploadBackup"
          />
        </label>
        <span v-if="data.backups" class="text-xs text-slate-500"
          >{{ data.backups.dir }} · {{ t('sys.res.free') }} {{ data.backups.freeGiB }} GiB</span
        >
      </div>
      <div class="card overflow-x-auto">
        <table class="min-w-full text-sm" data-testid="backups-table">
          <thead class="text-left text-xs text-slate-500">
            <tr>
              <th class="px-3 py-2">{{ t('sys.backups.name') }}</th>
              <th>{{ t('sys.backups.created') }}</th>
              <th>{{ t('sys.backups.size') }}</th>
              <th>{{ t('sys.overview.version') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="b in data.backups?.items ?? []"
              :key="b.name"
              class="border-t border-slate-200 dark:border-slate-800"
              data-testid="backup-row"
            >
              <td class="px-3 py-2 font-mono text-xs">{{ b.name }}</td>
              <td class="text-xs">{{ fmtDate(b.createdAt) }}</td>
              <td>{{ fmtBytes(b.size) }}</td>
              <td>{{ b.version }}</td>
              <td class="space-x-1 whitespace-nowrap px-3 text-right">
                <button
                  type="button"
                  class="btn"
                  :disabled="busy"
                  data-testid="backup-verify"
                  @click="verifyBackup(b.name)"
                >
                  {{ t('sys.backups.verify') }}
                </button>
                <button type="button" class="btn" :disabled="busy" @click="downloadBackup(b.name)">
                  {{ t('sys.backups.download') }}
                </button>
                <button type="button" class="btn" :disabled="busy" @click="restoring = b.name">
                  {{ t('sys.backups.restore') }}
                </button>
                <button
                  type="button"
                  class="btn-danger"
                  :disabled="busy"
                  data-testid="backup-delete"
                  @click="deleteBackup(b.name)"
                >
                  {{ t('sys.backups.delete') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!(data.backups?.items ?? []).length" class="p-3 text-sm text-slate-500">
          {{ t('sys.backups.empty') }}
        </p>
      </div>
      <form
        v-if="restoring"
        class="card space-y-2 border-red-300 p-3 text-sm"
        @submit.prevent="restoreBackup"
      >
        <p class="text-red-700">{{ t('sys.backups.restoreWarn') }}</p>
        <p class="text-slate-600 dark:text-slate-300" data-testid="restore-key-note">
          {{ t('sys.backups.keyNote') }}
        </p>
        <p class="font-mono text-xs">{{ restoring }}</p>
        <input
          v-model="restoreConfirm"
          class="input font-mono"
          :placeholder="t('sys.backups.typeName')"
          data-testid="restore-confirm"
        />
        <div class="flex gap-2">
          <button
            type="submit"
            class="btn-danger"
            :disabled="busy || restoreConfirm !== restoring"
            data-testid="restore-go"
          >
            {{ t('sys.backups.restore') }}</button
          ><button type="button" class="btn" @click="restoring = ''">
            {{ t('common.cancel') }}
          </button>
        </div>
      </form>
      <form
        class="card flex flex-wrap items-center gap-3 p-3 text-sm"
        @submit.prevent="saveSchedule"
      >
        <label class="flex items-center gap-1"
          ><input v-model="sched.enabled" type="checkbox" data-testid="sched-enabled" />
          {{ t('sys.backups.scheduleOn') }}</label
        >
        <label
          >{{ t('sys.backups.hour') }}
          <input v-model.number="sched.hour" type="number" min="0" max="23" class="input w-20"
        /></label>
        <label
          >{{ t('sys.backups.keep') }}
          <input v-model.number="sched.keep" type="number" min="1" max="90" class="input w-20"
        /></label>
        <button type="submit" class="btn" :disabled="busy" data-testid="sched-save">
          {{ t('common.save') }}
        </button>
        <span v-if="data.schedule?.lastAt" class="text-xs text-slate-500"
          >{{ t('sys.backups.lastRun') }}: {{ fmtDate(data.schedule.lastAt) }} ({{
            data.schedule.lastResult
          }})</span
        >
      </form>
      <OffsiteBackups />
    </div>

    <!-- Журналы системы -->
    <div v-else-if="section === 'logs'" class="space-y-3">
      <form class="flex flex-wrap items-center gap-2 text-sm" @submit.prevent="fetchLogs">
        <select v-model="logForm.service" class="input w-auto" data-testid="log-service">
          <option value="app">app</option>
          <option value="db">db</option>
        </select>
        <input
          v-model.number="logForm.lines"
          type="number"
          min="10"
          max="2000"
          class="input w-24"
        />
        <button
          type="submit"
          class="btn-primary"
          :disabled="busy || !data.helperAlive"
          data-testid="log-fetch"
        >
          {{ t('sys.logs.fetch') }}
        </button>
        <RouterLink to="/admin/ledger" class="text-xs underline">{{
          t('admin.tab.ledger')
        }}</RouterLink>
      </form>
      <p class="text-xs text-slate-500">{{ t('sys.logs.hint') }}</p>
      <pre
        v-if="data.log"
        class="max-h-[60vh] overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-800 dark:bg-slate-900"
        data-testid="log-text"
        >{{ data.log.text }}</pre>
      <p v-else class="text-sm text-slate-500">{{ t('sys.logs.none') }}</p>
    </div>

    <!-- Хранилища -->
    <div v-else-if="section === 'storage'" class="space-y-3">
      <div
        v-for="c in data.categories"
        :key="c.id"
        class="card p-3 text-sm"
        :data-testid="`storage-${c.id}`"
      >
        <div class="flex justify-between">
          <span class="font-medium">{{ t(`sys.storage.${c.id}`) }}</span
          ><span :class="levelClass(c.status)">{{ levelText(c.status) }}</span>
        </div>
        <div class="text-slate-500">
          {{ fmtBytes(c.bytes)
          }}<span v-if="c.files !== undefined">
            · {{ t('sys.res.files') }}: {{ c.files }} / {{ t('sys.storage.registered') }}:
            {{ c.registered }} · {{ t('sys.storage.orphans') }}: {{ c.orphans }} ·
            {{ t('sys.storage.missing') }}: {{ c.missing }}</span
          >
        </div>
      </div>
      <div class="flex gap-2">
        <button
          type="button"
          class="btn"
          :disabled="busy"
          data-testid="storage-report"
          @click="reconcile(false)"
        >
          {{ t('sys.storage.check') }}</button
        ><button
          type="button"
          class="btn"
          :disabled="busy"
          data-testid="storage-apply"
          @click="reconcile(true)"
        >
          {{ t('sys.storage.clean') }}
        </button>
      </div>
      <p class="text-xs text-slate-500">{{ t('sys.storage.hint') }}</p>
    </div>

    <!-- Диагностика -->
    <div v-else-if="section === 'diagnostics'" class="space-y-3">
      <div class="flex items-center gap-3 text-sm">
        <span class="font-medium">{{ t('sys.diag.total') }}:</span
        ><span :class="levelClass(data.level)" data-testid="diag-level">{{
          levelText(data.level)
        }}</span
        ><button type="button" class="btn" @click="load">{{ t('sys.diag.again') }}</button>
      </div>
      <div class="card divide-y divide-slate-200 text-sm dark:divide-slate-800">
        <div v-for="c in data.checks" :key="c.id" class="px-3 py-2" data-testid="diag-row">
          <div class="flex justify-between gap-2">
            <span class="font-medium">{{ diagTitle(c) }}</span
            ><span :class="levelClass(c.level)">{{ levelText(c.level) }}</span>
          </div>
          <div class="text-slate-600 dark:text-slate-300">{{ diagText(c, 'detail') }}</div>
          <div v-if="diagText(c, 'cause')" class="text-xs text-slate-500">
            {{ t('sys.diag.cause') }}: {{ diagText(c, 'cause') }}
          </div>
          <div v-if="diagText(c, 'fix')" class="text-xs text-slate-500">
            {{ t('sys.diag.fix') }}: {{ diagText(c, 'fix') }}
          </div>
          <RouterLink
            v-if="c.level !== 'ok' && DIAG_LINK[c.id]"
            :to="DIAG_LINK[c.id]!"
            class="mt-1 inline-block text-xs font-medium text-brand-600 underline"
            :data-testid="`diag-go-${c.id}`"
            :aria-label="`${t('sys.diag.go')}: ${diagTitle(c)}`"
            >{{ t('sys.diag.go') }} →</RouterLink
          >
        </div>
      </div>
    </div>

    <!-- Сертификаты -->
    <div v-else-if="section === 'certificates'" class="space-y-3">
      <p v-if="!data.items.length" class="text-sm text-slate-500" data-testid="certs-empty">
        {{ t('sys.certs.empty') }}
      </p>
      <div v-for="i in data.items" :key="i.target" class="card p-3 text-sm" data-testid="cert-item">
        <div class="flex justify-between">
          <span class="font-medium">{{ i.label }} · {{ i.target }}</span
          ><span :class="levelClass(i.level)">{{ levelText(i.level) }}</span>
        </div>
        <p v-if="!i.ok" class="text-red-600">{{ i.error }}</p>
        <ul v-else class="mt-1 space-y-1">
          <li v-for="c in i.chain" :key="c.fingerprint256" class="text-xs">
            <b>{{ c.subject }}</b> ← {{ c.issuer }} · {{ fmtDate(c.validFrom) }} →
            {{ fmtDate(c.validTo) }} ·
            <span :class="c.daysLeft < 30 ? 'text-amber-600' : ''"
              >{{ c.daysLeft }} {{ t('sys.certs.days') }}</span
            >
          </li>
        </ul>
        <p v-if="i.ok && !i.trusted" class="text-xs text-amber-700">
          {{ t('sys.certs.untrusted') }}
        </p>
      </div>
    </div>

    <!-- Почта -->
    <div v-else-if="section === 'smtp'" class="space-y-3">
      <form class="card max-w-xl space-y-2 p-4 text-sm" @submit.prevent="saveSmtp">
        <label class="block"
          >{{ t('sys.smtp.host')
          }}<input v-model="smtp.host" required class="input" data-testid="smtp-host"
        /></label>
        <div class="flex gap-2">
          <label class="flex-1"
            >{{ t('sys.smtp.port')
            }}<input
              v-model.number="smtp.port"
              type="number"
              min="1"
              max="65535"
              required
              class="input"
              data-testid="smtp-port"
          /></label>
          <label class="flex-1"
            ><span class="inline-flex items-center gap-1"
              >{{ t('sys.smtp.security') }}<InfoHint :text="t('hint.smtpSecurity.text')" /></span
            ><select v-model="smtp.security" class="input" data-testid="smtp-security">
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS</option>
              <option value="none">{{ t('sys.smtp.none') }}</option>
            </select></label
          >
        </div>
        <p v-if="smtp.security === 'none'" class="text-xs text-amber-700">
          {{ t('sys.smtp.noneWarn') }}
        </p>
        <label class="block"
          >{{ t('sys.smtp.user')
          }}<input v-model="smtp.user" class="input" autocomplete="off" data-testid="smtp-user"
        /></label>
        <label class="block"
          >{{ t('sys.smtp.password')
          }}<input
            v-model="smtp.password"
            type="password"
            class="input"
            autocomplete="new-password"
            :placeholder="smtp.hasPassword ? t('sys.smtp.keepPassword') : ''"
            data-testid="smtp-password"
        /></label>
        <label class="block"
          >{{ t('sys.smtp.from')
          }}<input v-model="smtp.from" type="email" required class="input" data-testid="smtp-from"
        /></label>
        <button type="submit" class="btn-primary" :disabled="busy" data-testid="smtp-save">
          {{ t('common.save') }}
        </button>
      </form>
      <div v-if="data.configured" class="card max-w-xl space-y-2 p-4 text-sm">
        <button
          type="button"
          class="btn"
          :disabled="busy"
          data-testid="smtp-test"
          @click="smtpAction('/admin/smtp/test')"
        >
          {{ t('sys.smtp.test') }}
        </button>
        <form
          class="flex gap-2"
          @submit.prevent="smtpAction('/admin/smtp/send-test', { to: mailTo })"
        >
          <input
            v-model="mailTo"
            type="email"
            required
            class="input"
            :placeholder="t('sys.smtp.to')"
            data-testid="smtp-to"
          />
          <button type="submit" class="btn" :disabled="busy" data-testid="smtp-send">
            {{ t('sys.smtp.send') }}
          </button>
        </form>
        <p v-if="smtpResult" data-testid="smtp-result">{{ smtpResult }}</p>
      </div>
    </div>
  </div>
</template>
