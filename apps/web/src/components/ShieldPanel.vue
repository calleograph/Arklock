<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../services/api';
import { confirmStepUp, stepUpHeaders } from '../services/stepup';
import { errorMessage, when } from '../services/helpers';
import { useAuthStore } from '../stores/auth';

/**
 * «Защита веб-приложения»: обзор, защита входа, разрешённые подсети, блокировки, события, дополнительные настройки.
 * Все числа приходят с сервера; если часть данных получить не удалось, она помечается «Не удалось проверить».
 */
const { t } = useI18n();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const TABS = ['overview', 'login', 'ips', 'blocks', 'requests', 'events', 'advanced'] as const;
type TabId = (typeof TABS)[number];
const tab = computed<TabId>(() => {
  const v = String(route.query.s ?? 'overview');
  return (TABS as readonly string[]).includes(v) ? (v as TabId) : 'overview';
});
function go(id: TabId, extra: Record<string, string> = {}): void {
  void router.push({ query: { ...(id === 'overview' ? {} : { s: id }), ...extra } });
}

const error = ref('');
const notice = ref('');

// ---- повторное подтверждение пароля для изменений защиты ----
const pending = ref<null | ((h: Record<string, string>) => Promise<unknown>)>(null);
const password = ref('');
async function guarded(action: (h: Record<string, string>) => Promise<unknown>): Promise<void> {
  error.value = '';
  notice.value = '';
  const h = stepUpHeaders();
  if (!h) {
    pending.value = action;
    return;
  }
  await attempt(action, h);
}
async function attempt(
  action: (h: Record<string, string>) => Promise<unknown>,
  h: Record<string, string>,
): Promise<void> {
  try {
    await action(h);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'reauth_required') pending.value = action;
    else if (e instanceof ApiError && e.code === 'would_lock_out')
      error.value = t('shield.ips.lockout', {
        ip: (e.details as { ip?: string } | undefined)?.ip ?? '',
      });
    else if (e instanceof ApiError && e.code === 'rules_required')
      error.value = t('shield.ips.rulesRequired');
    else error.value = errorMessage(e, t);
  }
}
async function submitPassword(): Promise<void> {
  const action = pending.value;
  if (!action || !auth.user) return;
  try {
    const h = await confirmStepUp(auth.user, password.value);
    password.value = '';
    pending.value = null;
    await attempt(action, h);
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}

// ---- данные ----
interface Overview {
  unknown: string[];
  captchaMode: string;
  accessRestriction: { enabled: boolean; rules: number; pendingConfirm: number | null };
  proxies: { cidrs: string[]; hops: number };
  mfaChiefsWithout: number;
  log: { ok: boolean; failures: number };
  last24h: {
    failedLogins: number;
    captchaShown: number;
    captchaFailed: number;
    rejected: number;
    suspicious: number;
    blocksCreated: number;
  };
  activeBlocks: number;
  topRules: { rule: string | null; count: number; last: string }[];
  hourly: { at: string; failed: number; rejected: number }[];
  lastChange: { at: string; what: string | null } | null;
}
interface Settings {
  windowMinutes: number;
  captchaAfter: number;
  blockIpAfter: number;
  blockPairAfter: number;
  blockMinutes: number;
  blockMaxMinutes: number;
  captchaBits: number;
  captchaMaxBits: number;
  retentionDays: number;
  alertMinutes: number;
  alertMail: boolean;
  defaults: Omit<Settings, 'defaults'>;
}
interface Who {
  ip: string;
  socket: string;
  forwardedFor: string | null;
  permitted: boolean;
  accessEnabled: boolean;
  hops: number;
}
interface Rule {
  id: string;
  cidr: string;
  comment: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}
interface Access {
  enabled: boolean;
  confirmBy: number | null;
  confirmSeconds: number;
  yourIp: string;
  yourIpAllowed: boolean;
  rules: Rule[];
}
interface Block {
  id: string;
  ip: string;
  scope: 'ip' | 'pair';
  source: 'auto' | 'manual';
  reason: string;
  rule: string;
  strikes: number;
  risk: 'warn' | 'critical';
  attempts24h: number;
  createdAt: string;
  expiresAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
}
interface EventRow {
  id: number;
  at: string;
  ip: string | null;
  user: string | null;
  account: string | null;
  kind: string;
  level: 'info' | 'warn' | 'critical' | 'ok';
  rule: string | null;
  result: string;
  seconds: number | null;
  source: string | null;
  requestId: string | null;
}

const overview = ref<Overview | null>(null);
const settings = ref<Settings | null>(null);
const draft = ref<Omit<Settings, 'defaults'> | null>(null);
const who = ref<Who | null>(null);
const access = ref<Access | null>(null);
const blocks = ref<{ active: Block[]; history: Block[] } | null>(null);
const events = ref<{ total: number; items: EventRow[] } | null>(null);
const proxiesText = ref('');

const unknownPart = (name: string) => overview.value?.unknown.includes(name);

async function loadOverview(): Promise<void> {
  try {
    overview.value = await api<Overview>('GET', '/admin/shield/overview');
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
async function loadSettings(): Promise<void> {
  settings.value = await api<Settings>('GET', '/admin/shield/settings');
  const { defaults: _d, ...rest } = settings.value;
  draft.value = { ...rest };
}
async function loadAccess(): Promise<void> {
  [who.value, access.value] = await Promise.all([
    api<Who>('GET', '/admin/shield/whoami'),
    api<Access>('GET', '/admin/shield/access'),
  ]);
  const p = await api<{ cidrs: string[] }>('GET', '/admin/shield/proxies');
  proxiesText.value = p.cidrs.join('\n');
  syncCountdown();
}
async function loadBlocks(): Promise<void> {
  blocks.value = await api('GET', '/admin/shield/blocks');
}

// фильтры событий хранятся в адресе: переход «Посмотреть активность» и F5 сохраняют выбор
const filter = ref({ period: 'day', level: '', ip: '', user: '', kind: '', rule: '', result: '' });
const page = ref(1);
const PAGE = 25;
function readFilter(): void {
  const q = route.query;
  filter.value = {
    period: String(q.period ?? 'day'),
    level: String(q.level ?? ''),
    ip: String(q.ip ?? ''),
    user: String(q.user ?? ''),
    kind: String(q.kind ?? ''),
    rule: String(q.rule ?? ''),
    result: String(q.result ?? ''),
  };
  page.value = Number(q.page ?? 1) || 1;
}
async function loadEvents(): Promise<void> {
  const q = new URLSearchParams({
    period: filter.value.period,
    page: String(page.value),
    pageSize: String(PAGE),
  });
  for (const k of ['level', 'ip', 'user', 'kind', 'rule', 'result'] as const)
    if (filter.value[k]) q.set(k, filter.value[k]);
  try {
    events.value = await api('GET', `/admin/shield/events?${q}`);
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
function applyFilter(): void {
  const extra: Record<string, string> = { page: '1' };
  for (const [k, v] of Object.entries(filter.value)) if (v) extra[k] = v;
  go('events', extra);
}
function openEvents(extra: Record<string, string>): void {
  go('events', { period: 'day', ...extra });
}
const pages = computed(() => Math.max(1, Math.ceil((events.value?.total ?? 0) / PAGE)));
function turn(d: number): void {
  const extra: Record<string, string> = {
    ...Object.fromEntries(Object.entries(filter.value).filter(([, v]) => v)),
    page: String(page.value + d),
  };
  go('events', extra);
}

async function loadTab(): Promise<void> {
  error.value = '';
  try {
    if (tab.value === 'overview') {
      await loadOverview();
      await loadSettings().catch(() => undefined);
    } else if (tab.value === 'login' || tab.value === 'advanced') await loadSettings();
    if (tab.value === 'advanced') await loadAccess();
    else if (tab.value === 'ips') await loadAccess();
    else if (tab.value === 'blocks') await loadBlocks();
    else if (tab.value === 'events') {
      readFilter();
      await loadEvents();
    }
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
onMounted(loadTab);
watch(() => route.fullPath, loadTab);

// ---- защита входа и дополнительные настройки ----
async function saveSettings(fields: (keyof Omit<Settings, 'defaults'>)[]): Promise<void> {
  const body = Object.fromEntries(fields.map((f) => [f, draft.value![f]]));
  await guarded(async (headers) => {
    await api('PUT', '/admin/shield/settings', body, { headers });
    notice.value = t('shield.saved');
    await loadSettings();
  });
}
async function restoreDefaults(): Promise<void> {
  if (!settings.value) return;
  const { defaults } = settings.value;
  await guarded(async (headers) => {
    await api('PUT', '/admin/shield/settings', defaults, { headers });
    notice.value = t('shield.saved');
    await loadSettings();
  });
}

// ---- подсети ----
const newRule = ref({ cidr: '', comment: '' });
async function addRule(): Promise<void> {
  const body = { ...newRule.value };
  await guarded(async (headers) => {
    await api('POST', '/admin/shield/access/rules', body, { headers });
    newRule.value = { cidr: '', comment: '' };
    await loadAccess();
  });
}
async function toggleRule(r: Rule): Promise<void> {
  await guarded(async (headers) => {
    await api('PATCH', `/admin/shield/access/rules/${r.id}`, { enabled: !r.enabled }, { headers });
    await loadAccess();
  });
}
async function deleteRule(r: Rule): Promise<void> {
  await guarded(async (headers) => {
    await api('DELETE', `/admin/shield/access/rules/${r.id}`, undefined, { headers });
    await loadAccess();
  });
}
const enabling = ref(false);
const ack = ref(false);
async function enableAccess(): Promise<void> {
  await guarded(async (headers) => {
    await api('POST', '/admin/shield/access/enable', { acknowledge: true }, { headers });
    enabling.value = false;
    ack.value = false;
    await loadAccess();
  });
}
async function disableAccess(): Promise<void> {
  await guarded(async (headers) => {
    await api('POST', '/admin/shield/access/disable', {}, { headers });
    await loadAccess();
  });
}
async function confirmAccess(): Promise<void> {
  try {
    await api('POST', '/admin/shield/access/confirm');
    notice.value = t('shield.ips.confirmed');
    await loadAccess();
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
// обратный отсчёт подтверждения: сервер сам откатит настройку по истечении срока
const left = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
function syncCountdown(): void {
  if (timer) clearInterval(timer);
  timer = null;
  const by = access.value?.confirmBy;
  if (!access.value?.enabled || !by) {
    left.value = 0;
    return;
  }
  const tick = () => {
    left.value = Math.max(0, Math.ceil((by - Date.now()) / 1000));
    if (left.value === 0 && timer) {
      clearInterval(timer);
      timer = null;
      setTimeout(() => void loadAccess().catch(() => undefined), 12_000);
    }
  };
  tick();
  timer = setInterval(tick, 1000);
}
onBeforeUnmount(() => timer && clearInterval(timer));
async function saveProxies(): Promise<void> {
  const cidrs = proxiesText.value
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  await guarded(async (headers) => {
    await api('PUT', '/admin/shield/proxies', { cidrs }, { headers });
    notice.value = t('shield.saved');
    await loadAccess();
  });
}

// ---- блокировки ----
const manual = ref({ ip: '', minutes: 60, reason: '' });
async function addBlock(): Promise<void> {
  const body = { ...manual.value };
  await guarded(async (headers) => {
    await api('POST', '/admin/shield/blocks', body, { headers });
    manual.value = { ip: '', minutes: 60, reason: '' };
    await loadBlocks();
  });
}
async function releaseBlock(b: Block): Promise<void> {
  if (!confirm(t('shield.blocks.releaseConfirm', { ip: b.ip }))) return;
  await guarded(async (headers) => {
    await api('POST', `/admin/shield/blocks/${b.id}/release`, {}, { headers });
    await loadBlocks();
  });
}
async function allowBlock(b: Block): Promise<void> {
  if (!confirm(t('shield.blocks.allowConfirm', { ip: b.ip }))) return;
  await guarded(async (headers) => {
    await api('POST', `/admin/shield/blocks/${b.id}/allow`, { acknowledge: true }, { headers });
    await loadBlocks();
  });
}

// ---- вид ----
const levelClass: Record<string, string> = {
  critical: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
  warn: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  info: 'bg-brand-50 text-brand-700',
  ok: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
};
const levelMark: Record<string, string> = { critical: '●', warn: '▲', info: 'ℹ', ok: '✔' };
const kindName = (k: string) => {
  const key = `shield.events.kinds.${k}`;
  const v = t(key);
  return v === key ? k : v;
};
const chartMax = computed(() =>
  Math.max(1, ...(overview.value?.hourly ?? []).map((h) => Math.max(h.failed, h.rejected))),
);
const KIND_OPTIONS = [
  'login_failed',
  'recovery_failed',
  'recovery_started',
  'directory_failed',
  'captcha_required',
  'captcha_invalid',
  'ip_blocked',
  'ip_unblocked',
  'request_rejected',
  'ip_not_allowed',
  'protection_changed',
  'access_restriction_rollback',
  'access_restriction_off',
];
</script>

<template>
  <section class="space-y-4" data-testid="shield-panel">
    <header>
      <h2 class="text-lg font-semibold">{{ t('shield.title') }}</h2>
      <p class="max-w-3xl text-xs text-slate-500">{{ t('shield.intro') }}</p>
    </header>

    <div
      role="tablist"
      class="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800"
      :aria-label="t('shield.title')"
    >
      <button
        v-for="id in TABS"
        :key="id"
        type="button"
        role="tab"
        :aria-selected="tab === id"
        class="-mb-px rounded-t-md border-b-2 px-3 py-1.5 text-sm font-medium"
        :class="
          tab === id
            ? 'border-brand-500 text-brand-700'
            : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100'
        "
        :data-testid="`shield-tab-${id}`"
        @click="go(id)"
      >
        {{ t(`shield.tabs.${id}`) }}
      </button>
    </div>

    <p v-if="error" class="notice notice-error" role="alert" data-testid="shield-error">
      {{ error }}
    </p>
    <p v-else-if="notice" class="notice notice-ok" role="status" data-testid="shield-notice">
      {{ notice }}
    </p>

    <form
      v-if="pending"
      class="card flex flex-wrap items-end gap-2 p-3 text-sm"
      data-testid="shield-reauth"
      @submit.prevent="submitPassword"
    >
      <label class="min-w-64 flex-1">
        <span class="field-label">{{ t('shield.confirmPassword') }}</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          class="input"
          data-testid="shield-password"
          required
        />
      </label>
      <button type="submit" class="btn-primary" data-testid="shield-reauth-ok">
        {{ t('shield.confirm') }}
      </button>
      <button type="button" class="btn" @click="pending = null">{{ t('shield.cancel') }}</button>
    </form>

    <!-- 1. Обзор -->
    <div v-if="tab === 'overview'" class="space-y-4" data-testid="shield-overview">
      <p v-if="!overview" class="text-slate-500">…</p>
      <template v-else>
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <div class="card p-3 text-sm">
            <div class="text-xs text-slate-500">{{ t('shield.overview.loginProtection') }}</div>
            <div class="mt-0.5 font-medium text-emerald-700 dark:text-emerald-300">
              ✔ {{ t('shield.overview.loginActive') }}
            </div>
          </div>
          <div class="card p-3 text-sm">
            <div class="text-xs text-slate-500">{{ t('shield.overview.captcha') }}</div>
            <div class="mt-0.5 font-medium">
              {{ t('shield.overview.captchaAdaptive', { n: settings?.captchaAfter ?? 5 }) }}
            </div>
          </div>
          <div class="card p-3 text-sm" data-testid="ov-access">
            <div class="text-xs text-slate-500">{{ t('shield.overview.access') }}</div>
            <div class="mt-0.5 font-medium">
              {{
                overview.accessRestriction.enabled
                  ? t('shield.overview.accessOn', { n: overview.accessRestriction.rules })
                  : t('shield.overview.accessOff')
              }}
            </div>
          </div>
          <div class="card p-3 text-sm">
            <div class="text-xs text-slate-500">{{ t('shield.overview.proxies') }}</div>
            <div class="mt-0.5 font-medium">
              {{
                overview.proxies.cidrs.length
                  ? t('shield.overview.proxiesList', { n: overview.proxies.cidrs.length })
                  : t('shield.overview.proxiesHops', { n: overview.proxies.hops })
              }}
            </div>
          </div>
          <div class="card p-3 text-sm">
            <div class="text-xs text-slate-500">{{ t('shield.overview.log') }}</div>
            <div
              class="mt-0.5 font-medium"
              :class="overview.log.ok ? '' : 'text-red-700 dark:text-red-300'"
            >
              {{
                overview.log.ok
                  ? '✔ ' + t('shield.overview.logOk')
                  : '● ' + t('shield.overview.logFail', { n: overview.log.failures })
              }}
            </div>
          </div>
          <div class="card p-3 text-sm">
            <div class="text-xs text-slate-500">{{ t('shield.overview.mfa') }}</div>
            <div
              class="mt-0.5 font-medium"
              :class="overview.mfaChiefsWithout > 0 ? 'text-amber-700 dark:text-amber-300' : ''"
            >
              <template v-if="overview.mfaChiefsWithout < 0">{{ t('shield.unknown') }}</template>
              <template v-else-if="overview.mfaChiefsWithout === 0"
                >✔ {{ t('shield.overview.mfaNone') }}</template
              >
              <template v-else>▲ {{ overview.mfaChiefsWithout }}</template>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <button
            type="button"
            class="card p-3 text-left hover:shadow-md"
            data-testid="ov-failed"
            @click="openEvents({ kind: 'login_failed' })"
          >
            <div class="text-xs text-slate-500">{{ t('shield.overview.failed') }}</div>
            <div class="text-2xl font-semibold">
              {{ unknownPart('events') ? t('shield.unknown') : overview.last24h.failedLogins }}
            </div>
          </button>
          <button
            type="button"
            class="card p-3 text-left hover:shadow-md"
            @click="openEvents({ kind: 'captcha_required' })"
          >
            <div class="text-xs text-slate-500">{{ t('shield.overview.captchaShown') }}</div>
            <div class="text-2xl font-semibold">
              {{ unknownPart('events') ? t('shield.unknown') : overview.last24h.captchaShown }}
            </div>
          </button>
          <button
            type="button"
            class="card p-3 text-left hover:shadow-md"
            @click="openEvents({ kind: 'request_rejected' })"
          >
            <div class="text-xs text-slate-500">{{ t('shield.overview.rejected') }}</div>
            <div class="text-2xl font-semibold">
              {{ unknownPart('events') ? t('shield.unknown') : overview.last24h.rejected }}
            </div>
          </button>
          <button
            type="button"
            class="card p-3 text-left hover:shadow-md"
            @click="openEvents({ level: 'critical' })"
          >
            <div class="text-xs text-slate-500">{{ t('shield.overview.suspicious') }}</div>
            <div class="text-2xl font-semibold">
              {{ unknownPart('events') ? t('shield.unknown') : overview.last24h.suspicious }}
            </div>
          </button>
          <button
            type="button"
            class="card p-3 text-left hover:shadow-md"
            data-testid="ov-blocks"
            @click="go('blocks')"
          >
            <div class="text-xs text-slate-500">{{ t('shield.overview.blocks') }}</div>
            <div class="text-2xl font-semibold">{{ overview.activeBlocks }}</div>
          </button>
        </div>

        <div class="card p-3">
          <h3 class="mb-2 text-sm">{{ t('shield.overview.chart') }}</h3>
          <p v-if="unknownPart('chart')" class="text-sm text-slate-500">
            {{ t('shield.unknown') }}
          </p>
          <svg
            v-else
            viewBox="0 0 240 50"
            class="h-24 w-full"
            role="img"
            :aria-label="t('shield.overview.chart')"
            preserveAspectRatio="none"
          >
            <g v-for="(h, i) in overview.hourly" :key="h.at">
              <rect
                :x="i * (240 / Math.max(24, overview.hourly.length))"
                :width="4"
                :y="50 - (h.failed / chartMax) * 48"
                :height="(h.failed / chartMax) * 48"
                fill="var(--color-brand-500)"
              />
              <rect
                :x="i * (240 / Math.max(24, overview.hourly.length)) + 4.5"
                :width="4"
                :y="50 - (h.rejected / chartMax) * 48"
                :height="(h.rejected / chartMax) * 48"
                fill="var(--color-red-600)"
              />
            </g>
          </svg>
          <p class="mt-1 text-xs text-slate-500">
            <span class="text-brand-700">■</span> {{ t('shield.overview.failed') }} ·
            <span class="text-red-600">■</span> {{ t('shield.overview.rejected') }}
          </p>
        </div>

        <div class="grid gap-3 md:grid-cols-2">
          <div class="card p-3">
            <h3 class="mb-2 text-sm">{{ t('shield.overview.topRules') }}</h3>
            <p v-if="!overview.topRules.length" class="text-sm text-slate-500">
              {{ t('shield.overview.noRules') }}
            </p>
            <ul v-else class="divide-y divide-slate-200 text-sm dark:divide-slate-800">
              <li
                v-for="r in overview.topRules"
                :key="r.rule ?? ''"
                class="flex justify-between gap-2 py-1.5"
              >
                <button
                  type="button"
                  class="text-left font-mono text-xs underline"
                  @click="openEvents({ rule: r.rule ?? '' })"
                >
                  {{ r.rule }}
                </button>
                <span>{{ r.count }}</span>
              </li>
            </ul>
          </div>
          <div class="card p-3 text-sm">
            <p>
              {{
                overview.lastChange
                  ? t('shield.overview.lastChange', { at: when(overview.lastChange.at) })
                  : t('shield.overview.neverChanged')
              }}
            </p>
          </div>
        </div>
      </template>
    </div>

    <!-- 2. Защита входа -->
    <div v-else-if="tab === 'login'" class="space-y-3" data-testid="shield-login">
      <p class="max-w-3xl text-sm">{{ t('shield.login.intro') }}</p>
      <form
        v-if="draft"
        class="card grid gap-3 p-4 text-sm sm:grid-cols-3"
        @submit.prevent="saveSettings(['captchaAfter', 'windowMinutes', 'blockMinutes'])"
      >
        <label
          ><span class="field-label">{{ t('shield.login.captchaAfter') }}</span>
          <input
            v-model.number="draft.captchaAfter"
            type="number"
            min="2"
            max="20"
            class="input"
            data-testid="set-captcha-after"
        /></label>
        <label
          ><span class="field-label">{{ t('shield.login.windowMinutes') }}</span>
          <input v-model.number="draft.windowMinutes" type="number" min="1" max="240" class="input"
        /></label>
        <label
          ><span class="field-label">{{ t('shield.login.blockMinutes') }}</span>
          <input v-model.number="draft.blockMinutes" type="number" min="1" max="1440" class="input"
        /></label>
        <p class="text-xs text-slate-500 sm:col-span-3">{{ t('shield.login.blockHint') }}</p>
        <div class="sm:col-span-3">
          <button type="submit" class="btn-primary" data-testid="shield-save-login">
            {{ t('shield.save') }}
          </button>
        </div>
      </form>
      <div class="card p-4 text-sm">
        <h3 class="mb-1">{{ t('shield.login.how') }}</h3>
        <ul class="list-disc space-y-1 pl-5 text-slate-600 dark:text-slate-300">
          <li>{{ t('shield.login.how1') }}</li>
          <li>{{ t('shield.login.how2') }}</li>
          <li>{{ t('shield.login.how3') }}</li>
        </ul>
      </div>
    </div>

    <!-- 3. IP-адреса и подсети -->
    <div v-else-if="tab === 'ips'" class="space-y-3" data-testid="shield-ips">
      <p class="max-w-3xl text-sm">{{ t('shield.ips.intro') }}</p>
      <div v-if="who && access" class="card space-y-1 p-3 text-sm">
        <div>
          {{ t('shield.ips.yourIp') }}:
          <strong class="font-mono" data-testid="your-ip">{{ who.ip }}</strong> —
          {{ access.yourIpAllowed ? t('shield.ips.allowed') : t('shield.ips.notAllowed') }}
        </div>
        <div class="text-xs text-slate-500">
          {{ t('shield.ips.socket') }}: <span class="font-mono">{{ who.socket }}</span> ·
          {{ t('shield.ips.forwarded') }}:
          <span class="font-mono">{{ who.forwardedFor ?? t('shield.ips.none') }}</span>
        </div>
      </div>

      <div v-if="access" class="card space-y-3 p-4 text-sm">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3>{{ t('shield.ips.rules') }}</h3>
            <p
              class="text-xs"
              :class="access.enabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500'"
              data-testid="access-state"
              :data-enabled="access.enabled"
            >
              {{ access.enabled ? '✔ ' + t('shield.ips.stateOn') : t('shield.ips.stateOff') }}
            </p>
          </div>
          <button
            v-if="!access.enabled"
            type="button"
            class="btn"
            data-testid="access-enable"
            @click="enabling = true"
          >
            {{ t('shield.ips.enable') }}
          </button>
          <button
            v-else
            type="button"
            class="btn"
            data-testid="access-disable"
            @click="disableAccess"
          >
            {{ t('shield.ips.disable') }}
          </button>
        </div>

        <div v-if="left > 0" class="notice notice-warn" role="alert" data-testid="access-pending">
          <span class="flex-1">{{ t('shield.ips.pending', { n: left }) }}</span>
          <button
            type="button"
            class="btn-primary"
            data-testid="access-confirm"
            @click="confirmAccess"
          >
            {{ t('shield.ips.confirmAccess') }}
          </button>
        </div>

        <div v-if="enabling" class="notice notice-warn flex-col" data-testid="access-warning">
          <strong>{{ t('shield.ips.warnTitle') }}</strong>
          <span>{{ t('shield.ips.warnText', { n: access.confirmSeconds }) }}</span>
          <label class="flex items-center gap-2"
            ><input v-model="ack" type="checkbox" data-testid="access-ack" />
            {{ t('shield.ips.ack') }}</label
          >
          <span class="flex gap-2">
            <button
              type="button"
              class="btn-primary"
              :disabled="!ack"
              data-testid="access-start"
              @click="enableAccess"
            >
              {{ t('shield.ips.start') }}
            </button>
            <button type="button" class="btn" @click="enabling = false">
              {{ t('shield.cancel') }}
            </button>
          </span>
        </div>

        <div class="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>{{ t('shield.ips.cidr') }}</th>
                <th>{{ t('shield.ips.comment') }}</th>
                <th>{{ t('shield.ips.state') }}</th>
                <th>{{ t('shield.ips.changed') }}</th>
                <th>{{ t('shield.ips.by') }}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-if="!access.rules.length">
                <td colspan="6" class="text-slate-500">{{ t('shield.ips.empty') }}</td>
              </tr>
              <tr v-for="r in access.rules" :key="r.id" :data-testid="`rule-${r.cidr}`">
                <td class="font-mono text-xs">{{ r.cidr }}</td>
                <td>{{ r.comment }}</td>
                <td>
                  <label class="flex items-center gap-2"
                    ><input
                      type="checkbox"
                      class="switch"
                      :checked="r.enabled"
                      :aria-label="r.cidr"
                      @change="toggleRule(r)"
                    />
                    {{ r.enabled ? t('shield.ips.enabled') : t('shield.ips.disabledRule') }}</label
                  >
                </td>
                <td class="text-xs text-slate-500">{{ when(r.updatedAt) }}</td>
                <td class="text-xs text-slate-500">{{ r.updatedBy ?? '' }}</td>
                <td>
                  <button type="button" class="btn-ghost" @click="deleteRule(r)">
                    {{ t('shield.ips.delete') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <form class="flex flex-wrap items-end gap-2" @submit.prevent="addRule">
          <label class="min-w-56 flex-1"
            ><span class="field-label">{{ t('shield.ips.cidr') }}</span>
            <input
              v-model="newRule.cidr"
              class="input font-mono"
              :placeholder="t('shield.ips.cidrPlaceholder')"
              required
              data-testid="rule-cidr"
          /></label>
          <label class="min-w-56 flex-1"
            ><span class="field-label">{{ t('shield.ips.comment') }}</span>
            <input v-model="newRule.comment" class="input" maxlength="200"
          /></label>
          <button type="submit" class="btn" data-testid="rule-add">
            {{ t('shield.ips.add') }}
          </button>
        </form>
      </div>

      <form v-if="access" class="card space-y-2 p-4 text-sm" @submit.prevent="saveProxies">
        <h3>{{ t('shield.ips.proxies') }}</h3>
        <p class="text-xs text-slate-500">
          {{ t('shield.ips.proxiesHint', { hops: who?.hops ?? '' }) }}
        </p>
        <textarea
          v-model="proxiesText"
          rows="3"
          class="input font-mono"
          aria-label="proxies"
          data-testid="proxies-text"
        />
        <button type="submit" class="btn" data-testid="proxies-save">
          {{ t('shield.ips.proxiesSave') }}
        </button>
      </form>
    </div>

    <!-- 4. Заблокированные адреса -->
    <div v-else-if="tab === 'blocks'" class="space-y-3" data-testid="shield-blocks">
      <div class="card space-y-2 p-4 text-sm">
        <h3>{{ t('shield.blocks.active') }}</h3>
        <p v-if="blocks && !blocks.active.length" class="text-slate-500" data-testid="blocks-none">
          {{ t('shield.blocks.none') }}
        </p>
        <div v-else-if="blocks" class="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>{{ t('shield.blocks.ip') }}</th>
                <th>{{ t('shield.blocks.reason') }}</th>
                <th>{{ t('shield.blocks.risk') }}</th>
                <th>{{ t('shield.blocks.attempts') }}</th>
                <th>{{ t('shield.blocks.from') }}</th>
                <th>{{ t('shield.blocks.until') }}</th>
                <th>{{ t('shield.blocks.rule') }}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in blocks.active" :key="b.id" :data-testid="`block-${b.ip}`">
                <td class="font-mono text-xs">
                  {{ b.ip }}
                  <div class="text-slate-500">
                    {{
                      b.scope === 'ip' ? t('shield.blocks.scopeIp') : t('shield.blocks.scopePair')
                    }}
                  </div>
                </td>
                <td>
                  {{ b.reason }}
                  <span class="text-xs text-slate-500"
                    >({{
                      b.source === 'auto'
                        ? t('shield.blocks.sourceAuto')
                        : t('shield.blocks.sourceManual')
                    }})</span
                  >
                </td>
                <td>
                  <span class="badge" :class="levelClass[b.risk]"
                    >{{ levelMark[b.risk] }} {{ t(`shield.level.${b.risk}`) }}</span
                  >
                </td>
                <td>{{ b.attempts24h }}</td>
                <td class="text-xs">{{ when(b.createdAt) }}</td>
                <td class="text-xs">{{ when(b.expiresAt) }}</td>
                <td class="font-mono text-xs">{{ b.rule }}</td>
                <td class="whitespace-nowrap">
                  <button type="button" class="btn-ghost" @click="openEvents({ ip: b.ip })">
                    {{ t('shield.blocks.activity') }}
                  </button>
                  <button
                    type="button"
                    class="btn-ghost"
                    data-testid="block-release"
                    @click="releaseBlock(b)"
                  >
                    {{ t('shield.blocks.release') }}
                  </button>
                  <button type="button" class="btn-ghost" @click="allowBlock(b)">
                    {{ t('shield.blocks.allow') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <form class="card space-y-2 p-4 text-sm" @submit.prevent="addBlock">
        <h3>{{ t('shield.blocks.manual') }}</h3>
        <p class="text-xs text-slate-500">{{ t('shield.blocks.nat') }}</p>
        <div class="flex flex-wrap items-end gap-2">
          <label
            ><span class="field-label">{{ t('shield.blocks.manualIp') }}</span
            ><input v-model="manual.ip" class="input font-mono" required data-testid="block-ip"
          /></label>
          <label
            ><span class="field-label">{{ t('shield.blocks.manualMinutes') }}</span
            ><input
              v-model.number="manual.minutes"
              type="number"
              min="1"
              max="10080"
              class="input w-28"
          /></label>
          <label class="min-w-56 flex-1"
            ><span class="field-label">{{ t('shield.blocks.manualReason') }}</span
            ><input
              v-model="manual.reason"
              class="input"
              maxlength="200"
              required
              data-testid="block-reason"
          /></label>
          <button type="submit" class="btn-primary" data-testid="block-add">
            {{ t('shield.blocks.manualGo') }}
          </button>
        </div>
      </form>
      <div v-if="blocks?.history.length" class="card space-y-2 p-4 text-sm">
        <h3>{{ t('shield.blocks.history') }}</h3>
        <ul class="divide-y divide-slate-200 dark:divide-slate-800">
          <li
            v-for="b in blocks.history"
            :key="b.id"
            class="flex flex-wrap justify-between gap-2 py-1.5 text-xs"
          >
            <span class="font-mono">{{ b.ip }}</span>
            <span>{{ b.reason }}</span>
            <span class="text-slate-500"
              >{{ when(b.createdAt)
              }}<template v-if="b.releasedBy">
                · {{ t('shield.blocks.releasedBy', { who: b.releasedBy }) }}</template
              ></span
            >
          </li>
        </ul>
      </div>
    </div>

    <!-- 5. API и веб-запросы -->
    <div v-else-if="tab === 'requests'" class="space-y-3" data-testid="shield-requests">
      <p class="max-w-3xl text-sm">{{ t('shield.requests.intro') }}</p>
      <ul class="card divide-y divide-slate-200 text-sm dark:divide-slate-800">
        <li
          v-for="k in ['authz', 'schema', 'sql', 'csrf', 'csp', 'limits', 'ssrf']"
          :key="k"
          class="flex items-start gap-3 px-4 py-2.5"
        >
          <span class="badge shrink-0" :class="levelClass.ok"
            >✔ {{ t('shield.requests.always') }}</span
          >
          <span>{{ t(`shield.requests.items.${k}`) }}</span>
        </li>
      </ul>
      <p class="text-xs text-slate-500">{{ t('shield.requests.later') }}</p>
    </div>

    <!-- 6. События -->
    <div v-else-if="tab === 'events'" class="space-y-3" data-testid="shield-events">
      <form class="card flex flex-wrap items-end gap-2 p-3 text-sm" @submit.prevent="applyFilter">
        <label
          ><span class="field-label">{{ t('shield.events.period') }}</span>
          <select v-model="filter.period" class="input" data-testid="ev-period">
            <option v-for="p in ['hour', 'day', 'week', 'month', 'all']" :key="p" :value="p">
              {{ t(`shield.events.${p}`) }}
            </option>
          </select></label
        >
        <label
          ><span class="field-label">{{ t('shield.events.level') }}</span>
          <select v-model="filter.level" class="input" data-testid="ev-level">
            <option value="">{{ t('shield.events.anyLevel') }}</option>
            <option v-for="l in ['critical', 'warn', 'info', 'ok']" :key="l" :value="l">
              {{ t(`shield.level.${l}`) }}
            </option>
          </select></label
        >
        <label
          ><span class="field-label">{{ t('shield.events.kind') }}</span>
          <select v-model="filter.kind" class="input">
            <option value="">{{ t('shield.events.anyLevel') }}</option>
            <option v-for="k in KIND_OPTIONS" :key="k" :value="k">{{ kindName(k) }}</option>
          </select></label
        >
        <label
          ><span class="field-label">{{ t('shield.events.ip') }}</span
          ><input v-model="filter.ip" class="input w-40 font-mono" data-testid="ev-ip"
        /></label>
        <label
          ><span class="field-label">{{ t('shield.events.user') }}</span
          ><input v-model="filter.user" class="input w-48"
        /></label>
        <label
          ><span class="field-label">{{ t('shield.events.rule') }}</span
          ><input v-model="filter.rule" class="input w-40 font-mono"
        /></label>
        <label
          ><span class="field-label">{{ t('shield.events.result') }}</span
          ><input v-model="filter.result" class="input w-32"
        /></label>
        <button type="submit" class="btn-primary" data-testid="ev-apply">
          {{ t('shield.events.apply') }}
        </button>
        <button type="button" class="btn" @click="go('events')">
          {{ t('shield.events.reset') }}
        </button>
      </form>
      <div class="card overflow-x-auto">
        <table data-testid="ev-table">
          <thead>
            <tr>
              <th>{{ t('shield.events.time') }}</th>
              <th>{{ t('shield.events.level') }}</th>
              <th>{{ t('shield.events.kind') }}</th>
              <th>{{ t('shield.events.ip') }}</th>
              <th>{{ t('shield.events.userCol') }}</th>
              <th>{{ t('shield.events.rule') }}</th>
              <th>{{ t('shield.events.result') }}</th>
              <th>{{ t('shield.events.seconds') }}</th>
              <th>{{ t('shield.events.source') }}</th>
              <th>{{ t('shield.events.corr') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="events && !events.items.length">
              <td colspan="10" class="text-slate-500">{{ t('shield.events.empty') }}</td>
            </tr>
            <tr v-for="e in events?.items ?? []" :key="e.id">
              <td class="whitespace-nowrap text-xs">{{ when(e.at) }}</td>
              <td>
                <span class="badge" :class="levelClass[e.level]"
                  >{{ levelMark[e.level] }} {{ t(`shield.level.${e.level}`) }}</span
                >
              </td>
              <td>{{ kindName(e.kind) }}</td>
              <td class="font-mono text-xs">{{ e.ip }}</td>
              <td class="text-xs">
                {{ e.user ?? (e.account ? '#' + e.account.slice(0, 6) : '') }}
              </td>
              <td class="font-mono text-xs">{{ e.rule }}</td>
              <td class="text-xs">{{ e.result }}</td>
              <td class="text-xs">{{ e.seconds ?? '' }}</td>
              <td class="text-xs">{{ e.source }}</td>
              <td class="font-mono text-xs">{{ e.requestId?.slice(0, 8) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="flex items-center justify-between text-sm">
        <span class="text-slate-500" data-testid="ev-total">{{
          t('shield.events.total', { n: events?.total ?? 0 })
        }}</span>
        <span class="flex items-center gap-2">
          <button type="button" class="btn" :disabled="page <= 1" @click="turn(-1)">
            {{ t('shield.events.prev') }}
          </button>
          {{ page }} / {{ pages }}
          <button type="button" class="btn" :disabled="page >= pages" @click="turn(1)">
            {{ t('shield.events.next') }}
          </button>
        </span>
      </div>
    </div>

    <!-- 7. Дополнительные настройки -->
    <div v-else-if="tab === 'advanced'" class="space-y-3" data-testid="shield-advanced">
      <form
        v-if="draft"
        class="card grid gap-3 p-4 text-sm sm:grid-cols-2"
        @submit.prevent="
          saveSettings([
            'blockIpAfter',
            'blockPairAfter',
            'blockMaxMinutes',
            'captchaBits',
            'captchaMaxBits',
            'retentionDays',
            'alertMinutes',
            'alertMail',
          ])
        "
      >
        <h3 class="sm:col-span-2">{{ t('shield.advanced.title') }}</h3>
        <label
          ><span class="field-label">{{ t('shield.advanced.blockIpAfter') }}</span
          ><input v-model.number="draft.blockIpAfter" type="number" min="5" max="200" class="input"
        /></label>
        <label
          ><span class="field-label">{{ t('shield.advanced.blockPairAfter') }}</span
          ><input
            v-model.number="draft.blockPairAfter"
            type="number"
            min="3"
            max="100"
            class="input"
        /></label>
        <label
          ><span class="field-label">{{ t('shield.advanced.blockMaxMinutes') }}</span
          ><input
            v-model.number="draft.blockMaxMinutes"
            type="number"
            min="5"
            max="10080"
            class="input"
        /></label>
        <label
          ><span class="field-label">{{ t('shield.advanced.captchaBits') }}</span
          ><input v-model.number="draft.captchaBits" type="number" min="12" max="22" class="input"
        /></label>
        <label
          ><span class="field-label">{{ t('shield.advanced.captchaMaxBits') }}</span
          ><input
            v-model.number="draft.captchaMaxBits"
            type="number"
            min="14"
            max="22"
            class="input"
        /></label>
        <label
          ><span class="field-label">{{ t('shield.advanced.retentionDays') }}</span
          ><input
            v-model.number="draft.retentionDays"
            type="number"
            min="7"
            max="365"
            class="input"
        /></label>
        <label
          ><span class="field-label">{{ t('shield.advanced.alertMinutes') }}</span
          ><input
            v-model.number="draft.alertMinutes"
            type="number"
            min="1"
            max="1440"
            class="input"
        /></label>
        <label class="flex items-center gap-2 self-end"
          ><input v-model="draft.alertMail" type="checkbox" class="switch" />
          {{ t('shield.advanced.alertMail') }}</label
        >
        <p class="text-xs text-slate-500 sm:col-span-2">
          {{ t('shield.advanced.limitsNote') }} {{ t('shield.advanced.alertsNote') }}
        </p>
        <div class="flex gap-2 sm:col-span-2">
          <button type="submit" class="btn-primary" data-testid="shield-save-advanced">
            {{ t('shield.save') }}
          </button>
          <button type="button" class="btn" @click="restoreDefaults">
            {{ t('shield.advanced.defaults') }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>
