<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../services/api';
import { confirmStepUp, stepUpHeaders } from '../services/stepup';
import { errorMessage, when } from '../services/helpers';
import { useAuthStore } from '../stores/auth';
import Icon from './Icon.vue';
import InfoHint from './InfoHint.vue';
import UnsavedHint from './UnsavedHint.vue';
import SwitchField from './SwitchField.vue';
import { useDirty } from '../services/dirty';

interface Stage {
  stage: string;
  ok: boolean;
  skipped?: boolean;
  warn?: boolean;
  code?: string;
  smtpStatus?: number;
  serverText?: string;
  info?: Record<string, string | number | boolean | string[]>;
}
interface Check {
  ok: boolean;
  code?: string;
  stage?: string | null;
  smtpStatus?: number | null;
  text?: string | null;
  stages: Stage[];
}
interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  security: 'none' | 'starttls' | 'tls';
  auth: 'none' | 'password' | 'ntlm';
  user: string;
  from: string;
  fromName: string;
  timeoutSec: number;
  verifyCert: boolean;
  caId: string | null;
  caName: string | null;
  purposes: string[];
  fallback: boolean;
  plainAuth?: boolean;
  hasPassword: boolean;
  status: {
    checkedAt: string | null;
    ok: boolean | null;
    stage: string | null;
    code: string | null;
    lastSuccessAt: string | null;
  };
}
interface Ca {
  id: string;
  name: string;
  subject: string;
  validTo: string;
  fingerprint256: string;
  usedBy: string[];
}
interface Row {
  id: string;
  profileId: string;
  profileName: string | null;
  to: string;
  type: string;
  category: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: string;
  lastCode: string | null;
  stage: string | null;
  text: string | null;
  smtpStatus: number | null;
  messageId: string | null;
  smtpRef: string | null;
  createdAt: string;
  deliveredAt: string | null;
  expiresAt: string;
}

const { t, te } = useI18n();
const auth = useAuthStore();
const TYPES = ['invitation', 'security', 'test'] as const;
const PORTS = { starttls: 587, tls: 465, none: 25 } as const;
const tab = ref<'profiles' | 'log'>('profiles');
const error = ref('');
const notice = ref('');
const profiles = ref<Profile[]>([]);
const activeId = ref<string | null>(null);
const cas = ref<Ca[]>([]);
const loaded = ref(false);

async function load(): Promise<void> {
  try {
    const [p, c] = await Promise.all([
      api<{ activeId: string | null; profiles: Profile[] }>('GET', '/admin/smtp/profiles'),
      api<Ca[]>('GET', '/admin/smtp/cas'),
    ]);
    profiles.value = p.profiles.sort((a, b) => a.name.localeCompare(b.name));
    activeId.value = p.activeId;
    cas.value = c;
  } catch (e) {
    error.value = errorMessage(e, t);
  }
  loaded.value = true;
}

/** Небезопасные режимы просят мастер-пароль: подтверждение действует 15 минут на все такие действия сеанса. */
const pending = ref<((h: Record<string, string>) => Promise<unknown>) | null>(null);
const password = ref('');
async function withStep(action: (h: Record<string, string>) => Promise<unknown>): Promise<boolean> {
  error.value = '';
  try {
    await action(stepUpHeaders() ?? {});
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'reauth_required') pending.value = action;
    else error.value = errorMessage(e, t);
    return false;
  }
}
async function submitPassword(): Promise<void> {
  const action = pending.value;
  if (!action || !auth.user) return;
  try {
    const h = await confirmStepUp(auth.user, password.value);
    password.value = '';
    pending.value = null;
    await action(h);
    await afterSave();
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}

// ——— форма профиля ———
interface Form {
  id: string | null;
  name: string;
  host: string;
  port: number;
  security: 'none' | 'starttls' | 'tls';
  auth: 'none' | 'password' | 'ntlm';
  user: string;
  password: string;
  hasPassword: boolean;
  from: string;
  fromName: string;
  timeoutSec: number;
  verifyCert: boolean;
  caId: string | null;
  purposes: string[];
  fallback: boolean;
  plainAuth: boolean;
}
const form = ref<Form | null>(null);
const blank = (): Form => ({
  id: null,
  name: '',
  host: '',
  port: 587,
  security: 'starttls',
  auth: 'none',
  user: '',
  password: '',
  hasPassword: false,
  from: '',
  fromName: 'Arklock',
  timeoutSec: 15,
  verifyCert: true,
  caId: null,
  purposes: [],
  fallback: false,
  plainAuth: false,
});
const { dirty, clean, reset } = useDirty(() => form.value);
function edit(p: Profile | null): void {
  notice.value = '';
  error.value = '';
  form.value = p
    ? {
        ...p,
        id: p.id,
        password: '',
        purposes: [...p.purposes],
        plainAuth: p.plainAuth ?? (p.security === 'none' && p.auth === 'password'),
      }
    : blank();
  clean();
}
/** NTLM сервер принимает только по шифрованному соединению: без него форма не даёт сохранить и объясняет почему. */
const ntlmNeedsTls = computed(() => form.value?.auth === 'ntlm' && form.value.security === 'none');
/** Пароль по соединению без шифрования отправляется только с явным согласием (флажок под предупреждением). */
const plainAuthAsked = computed(
  () => form.value?.auth === 'password' && form.value.security === 'none',
);
function setSecurity(v: Form['security']): void {
  if (!form.value) return;
  form.value.security = v;
  form.value.port = PORTS[v];
}
const body = (f: Form) => ({
  name: f.name.trim(),
  host: f.host.trim(),
  port: Number(f.port),
  security: f.security,
  auth: f.auth,
  user: f.auth === 'none' ? '' : f.user.trim(),
  ...(f.auth !== 'none' && f.password !== '' ? { password: f.password } : {}),
  from: f.from.trim(),
  fromName: f.fromName.trim(),
  timeoutSec: Number(f.timeoutSec),
  verifyCert: f.verifyCert,
  caId: f.caId,
  purposes: f.purposes,
  fallback: f.fallback,
  plainAuth: f.security === 'none' && f.auth === 'password' ? f.plainAuth : false,
});
const saving = ref(false);
async function afterSave(): Promise<void> {
  form.value = null;
  reset();
  notice.value = t('mail.form.saved');
  await load();
}
async function save(): Promise<void> {
  const f = form.value;
  if (!f || saving.value) return;
  saving.value = true;
  const ok = await withStep((h) =>
    f.id
      ? api('PUT', `/admin/smtp/profiles/${f.id}`, body(f), { headers: h })
      : api('POST', `/admin/smtp/profiles`, body(f), { headers: h }),
  );
  saving.value = false;
  if (ok) await afterSave();
}
async function activate(p: Profile): Promise<void> {
  try {
    await api('PUT', '/admin/smtp/active', { id: p.id });
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
async function remove(p: Profile): Promise<void> {
  if (!window.confirm(t('mail.actions.removeConfirm', { name: p.name }))) return;
  try {
    await api('DELETE', `/admin/smtp/profiles/${p.id}`);
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}

// ——— проверка соединения и тестовое письмо ———
const checks = ref<Record<string, Check | 'run'>>({});
const to = ref<Record<string, string>>({});
const sent = ref<
  Record<string, { kind: 'run' | 'ok' | 'queued' | 'fail'; data?: Record<string, unknown> }>
>({});
async function check(p: Profile): Promise<void> {
  if (checks.value[p.id] === 'run') return;
  checks.value = { ...checks.value, [p.id]: 'run' };
  try {
    const r = await api<Check>('POST', `/admin/smtp/profiles/${p.id}/check`);
    checks.value = { ...checks.value, [p.id]: r };
  } catch (e) {
    const { [p.id]: _, ...rest } = checks.value;
    checks.value = rest;
    error.value =
      e instanceof ApiError && e.code === 'smtp_rate_limited'
        ? t('mail.sent.rate')
        : e instanceof ApiError && e.code === 'smtp_busy'
          ? t('mail.sent.busy')
          : errorMessage(e, t);
  }
  await load();
}
async function sendTest(p: Profile): Promise<void> {
  if (sent.value[p.id]?.kind === 'run') return;
  sent.value = { ...sent.value, [p.id]: { kind: 'run' } };
  try {
    const r = await api<Record<string, unknown>>('POST', `/admin/smtp/profiles/${p.id}/send-test`, {
      to: (to.value[p.id] ?? '').trim(),
    });
    sent.value = {
      ...sent.value,
      [p.id]: { kind: r.ok ? 'ok' : r.queued ? 'queued' : 'fail', data: r },
    };
  } catch (e) {
    const rate = e instanceof ApiError && e.code === 'smtp_rate_limited';
    sent.value = {
      ...sent.value,
      [p.id]: {
        kind: 'fail',
        data: { code: rate ? 'rate' : 'error', message: errorMessage(e, t) },
      },
    };
  }
  await load();
}

/** Заголовок и подсказка по коду причины. */
function errInfo(
  code: string | null | undefined,
  reason?: unknown,
): { title: string; hint: string } {
  const key = te(`mail.err.${code ?? ''}.title`) ? `mail.err.${code}` : 'mail.err.error';
  const extra =
    typeof reason === 'string' && te(`mail.reason.${reason}`) ? t(`mail.reason.${reason}`) : '';
  return { title: t(`${key}.title`), hint: [extra, t(`${key}.hint`)].filter(Boolean).join('. ') };
}
const text = (s: unknown) => (typeof s === 'string' ? s : s == null ? '' : String(s));
function stageLine(s: Stage): string {
  const i = s.info ?? {};
  if (s.skipped) return t(s.stage === 'auth' ? 'mail.detail.authSkipped' : 'mail.detail.skipped');
  switch (s.stage) {
    case 'dns':
      return t('mail.detail.dns', { addresses: text(i.addresses) });
    case 'tcp':
      return t('mail.detail.tcp', { address: text(i.address) });
    case 'greeting':
      return text(i.banner);
    case 'ehlo':
      return text(i.features);
    case 'tls':
      return t('mail.detail.tlsOk', { protocol: text(i.protocol) });
    case 'certificate':
      return s.ok
        ? t(s.warn ? 'mail.detail.certUnverified' : 'mail.detail.certTrusted', {
            subject: text(i.subject),
            issuer: text(i.issuer),
            validTo: i.validTo ? when(text(i.validTo)).slice(0, 10) : '',
          })
        : '';
    case 'methods': {
      const list = (v: unknown) =>
        Array.isArray(v) && v.length ? v.join(', ') : t('mail.detail.methodsNone');
      return t('mail.detail.methods', { before: list(i.before), after: list(i.after) });
    }
    case 'auth':
      return s.ok ? t('mail.detail.authOk') : '';
    default:
      return '';
  }
}
const STAGE_ORDER = ['dns', 'tcp', 'greeting', 'ehlo', 'tls', 'certificate', 'methods', 'auth'];
/** Этапы по порядку; последний результат этапа (при отказе он идёт вторым), не дошедшие — «не выполнялось». */
function stageRows(c: Check): { stage: string; s: Stage | null }[] {
  const last = new Map<string, Stage>();
  for (const s of c.stages) last.set(s.stage, s);
  return STAGE_ORDER.map((stage) => ({ stage, s: last.get(stage) ?? null }));
}
function certProbe(c: Check): string {
  const s = c.stages.find((x) => x.stage === 'certificate' && !x.ok);
  const i = s?.info;
  if (!i?.subject) return '';
  return t('mail.detail.cert', {
    subject: text(i.subject),
    issuer: text(i.issuer),
    validTo: i.validTo ? when(text(i.validTo)).slice(0, 10) : '',
    fingerprint: text(i.fingerprint256),
  });
}
function failReason(c: Check): unknown {
  return c.stages.find((x) => !x.ok && x.info?.reason)?.info?.reason;
}

// ——— доверенные сертификаты ———
const caOpen = ref(false);
const caForm = ref({ name: '', pem: '', data: '', file: '' });
async function addCa(): Promise<void> {
  error.value = '';
  try {
    const f = caForm.value;
    await api('POST', '/admin/smtp/cas', {
      name: f.name.trim(),
      ...(f.data ? { data: f.data } : { pem: f.pem }),
    });
    caForm.value = { name: '', pem: '', data: '', file: '' };
    await load();
  } catch (e) {
    const problem =
      (e instanceof ApiError && (e.details as { problem?: string } | undefined)?.problem) || '';
    error.value =
      e instanceof ApiError && e.code === 'ca_invalid'
        ? problem
          ? t(`dir.cert.problem.${problem}`)
          : t('mail.ca.invalid')
        : errorMessage(e, t);
  }
}
async function removeCa(c: Ca): Promise<void> {
  try {
    await api('DELETE', `/admin/smtp/cas/${c.id}`);
    await load();
  } catch (e) {
    error.value =
      e instanceof ApiError && e.code === 'ca_in_use' ? t('mail.ca.inUse') : errorMessage(e, t);
  }
}
async function pickFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  // файл передаётся как есть (base64): сервер сам определяет PEM или DER
  let bin = '';
  for (const b of new Uint8Array(await file.arrayBuffer())) bin += String.fromCharCode(b);
  caForm.value.data = btoa(bin);
  caForm.value.file = file.name;
  caForm.value.pem = '';
  if (!caForm.value.name) caForm.value.name = file.name.replace(/\.[^.]+$/, '');
}

// ——— журнал отправки ———
const LIMIT = 25;
const rows = ref<Row[]>([]);
const total = ref(0);
const offset = ref(0);
const logLoading = ref(false);
const filter = ref({ status: '', type: '', profile: '', q: '', from: '', to: '', errors: false });
async function loadLog(): Promise<void> {
  const f = filter.value;
  const qs = new URLSearchParams({ limit: String(LIMIT), offset: String(offset.value) });
  if (f.status) qs.set('status', f.status);
  if (f.type) qs.set('type', f.type);
  if (f.profile) qs.set('profile', f.profile);
  if (f.q.trim()) qs.set('q', f.q.trim());
  if (f.from) qs.set('from', new Date(f.from).toISOString());
  if (f.to) qs.set('to', new Date(`${f.to}T23:59:59`).toISOString());
  if (f.errors) qs.set('errors', '1');
  logLoading.value = true;
  try {
    const r = await api<{ items: Row[]; total: number }>('GET', `/admin/smtp/queue?${qs}`);
    rows.value = r.items;
    total.value = r.total;
  } catch (e) {
    error.value = errorMessage(e, t);
  }
  logLoading.value = false;
}
let debounce = 0;
watch(
  filter,
  () => {
    clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      offset.value = 0;
      void loadLog();
    }, 250);
  },
  { deep: true },
);
async function rowAction(r: Row, action: 'retry' | 'cancel'): Promise<void> {
  try {
    await api('POST', `/admin/smtp/queue/${r.id}/${action}`);
    await loadLog();
  } catch (e) {
    error.value =
      e instanceof ApiError && e.code === 'mail_not_retryable'
        ? t('mail.log.notRetryable')
        : errorMessage(e, t);
  }
}
const canRetry = (r: Row) => r.status === 'failed' && new Date(r.expiresAt) > new Date();
const canCancel = (r: Row) => r.status === 'queued' || r.status === 'retry';
const statusClass = (s: string) =>
  s === 'accepted'
    ? 'badge-brand'
    : s === 'failed'
      ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-200'
      : s === 'cancelled'
        ? ''
        : 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200';
const pageFrom = computed(() => (total.value ? offset.value + 1 : 0));
const pageTo = computed(() => Math.min(offset.value + LIMIT, total.value));

let timer = 0;
watch(tab, (v) => {
  if (v === 'log') void loadLog();
});
onMounted(() => {
  void load();
  // журнал обновляется сам, пока открыт: письма уходят и повторяются в фоне
  timer = window.setInterval(() => {
    if (tab.value === 'log' && !document.hidden) void loadLog();
  }, 15_000);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  clearTimeout(debounce);
});
const typeLabel = (r: Row) =>
  te(`mail.type.${r.type}`) ? t(`mail.type.${r.type}`) : r.category || r.type;
</script>

<template>
  <section class="space-y-4" data-testid="mail-settings">
    <header>
      <h2 class="text-lg font-semibold">{{ t('mail.title') }}</h2>
      <p class="max-w-3xl text-xs text-slate-500">{{ t('mail.intro') }}</p>
    </header>

    <div
      role="tablist"
      class="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800"
      :aria-label="t('mail.title')"
    >
      <button
        v-for="id in ['profiles', 'log'] as const"
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
        :data-testid="`mail-tab-${id}`"
        @click="tab = id"
      >
        {{ t(`mail.tabs.${id}`) }}
      </button>
    </div>

    <p v-if="error" class="notice notice-error" role="alert" data-testid="mail-error">
      {{ error }}
    </p>
    <p v-else-if="notice" class="notice notice-ok" role="status" data-testid="mail-notice">
      {{ notice }}
    </p>

    <form
      v-if="pending"
      class="card flex flex-wrap items-end gap-2 p-3 text-sm"
      data-testid="mail-reauth"
      @submit.prevent="submitPassword"
    >
      <div class="w-full text-xs text-slate-500">
        <strong class="text-slate-700 dark:text-slate-200">{{ t('mail.reauth.title') }}.</strong>
        {{ t('mail.reauth.hint') }}
      </div>
      <input
        v-model="password"
        type="password"
        autocomplete="current-password"
        class="input min-w-64 flex-1"
        :aria-label="t('mail.reauth.title')"
        data-testid="mail-reauth-password"
        required
      />
      <button type="submit" class="btn-primary" data-testid="mail-reauth-ok">
        {{ t('mail.reauth.confirm') }}
      </button>
      <button type="button" class="btn" @click="pending = null">{{ t('mail.form.cancel') }}</button>
    </form>

    <!-- Профили -->
    <div v-if="tab === 'profiles'" class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-semibold">{{ t('mail.tabs.profiles') }}</h3>
        <button
          v-if="!form"
          type="button"
          class="btn-primary"
          data-testid="smtp-add"
          @click="edit(null)"
        >
          <Icon name="plus" /> {{ t('mail.add') }}
        </button>
      </div>

      <p
        v-if="loaded && !profiles.length && !form"
        class="notice notice-warn"
        data-testid="mail-empty"
      >
        {{ t('mail.empty') }}
      </p>

      <form
        v-if="form"
        class="card space-y-3 p-4 text-sm"
        data-testid="smtp-form"
        @submit.prevent="save"
      >
        <h3 class="font-semibold">
          {{ form.id ? t('mail.form.editTitle', { name: form.name }) : t('mail.form.newTitle') }}
        </h3>
        <div class="form-grid">
          <label class="block sm:col-span-2">
            <span class="field-label">{{ t('mail.form.name') }}</span>
            <input
              v-model="form.name"
              required
              maxlength="100"
              class="input"
              :placeholder="t('mail.form.namePh')"
              data-testid="smtp-name"
            />
          </label>
          <label class="block">
            <span class="field-label">{{ t('mail.form.host') }}</span>
            <input
              v-model="form.host"
              required
              class="input"
              autocomplete="off"
              spellcheck="false"
              :placeholder="t('mail.form.hostPh')"
              data-testid="smtp-host"
            />
          </label>
          <label class="block">
            <span class="field-label"
              >{{ t('mail.form.security') }}<InfoHint :text="t('mail.form.securityHint')"
            /></span>
            <select
              :value="form.security"
              class="input"
              data-testid="smtp-security"
              @change="setSecurity(($event.target as HTMLSelectElement).value as Form['security'])"
            >
              <option value="starttls">{{ t('mail.form.secStarttls') }}</option>
              <option value="tls">{{ t('mail.form.secTls') }}</option>
              <option value="none">{{ t('mail.form.secNone') }}</option>
            </select>
          </label>
          <label class="block">
            <span class="field-label">{{ t('mail.form.port') }}</span>
            <input
              v-model.number="form.port"
              type="number"
              min="1"
              max="65535"
              required
              class="input"
              data-testid="smtp-port"
            />
          </label>
          <label class="block">
            <span class="field-label">{{ t('mail.form.timeout') }}</span>
            <input
              v-model.number="form.timeoutSec"
              type="number"
              min="3"
              max="120"
              required
              class="input"
              data-testid="smtp-timeout"
            />
          </label>
        </div>
        <p v-if="form.security === 'none'" class="notice notice-warn" data-testid="smtp-none-warn">
          {{ t('mail.form.noneWarn') }}
        </p>
        <SwitchField
          v-if="plainAuthAsked"
          v-model="form.plainAuth"
          :label="t('mail.form.plainAuth')"
          data-testid="smtp-plain-auth"
        />

        <div class="form-grid">
          <label class="block sm:col-span-2">
            <span class="field-label"
              >{{ t('mail.form.auth')
              }}<InfoHint v-if="form.auth === 'ntlm'" :text="t('mail.form.ntlmHint')"
            /></span>
            <select v-model="form.auth" class="input" data-testid="smtp-auth">
              <option value="none">{{ t('mail.form.authNone') }}</option>
              <option value="password">{{ t('mail.form.authPassword') }}</option>
              <option value="ntlm">{{ t('mail.form.authNtlm') }}</option>
            </select>
            <p v-if="ntlmNeedsTls" class="field-error" role="alert" data-testid="smtp-ntlm-tls">
              {{ t('mail.form.ntlmNeedsTls') }}
            </p>
          </label>
          <template v-if="form.auth !== 'none'">
            <label class="block">
              <span class="field-label">{{ t('mail.form.user') }}</span>
              <input
                v-model="form.user"
                required
                class="input"
                autocomplete="off"
                :placeholder="form.auth === 'ntlm' ? t('mail.form.userNtlm') : ''"
                data-testid="smtp-user"
              />
            </label>
            <label class="block">
              <span class="field-label"
                >{{ t('mail.form.password') }}<InfoHint :text="t('mail.form.passwordHint')"
              /></span>
              <input
                v-model="form.password"
                type="password"
                class="input"
                autocomplete="new-password"
                :placeholder="form.hasPassword ? t('mail.form.passwordSet') : ''"
                data-testid="smtp-password"
              />
            </label>
          </template>
          <label class="block">
            <span class="field-label"
              >{{ t('mail.form.from') }}<InfoHint :text="t('mail.form.fromHint')"
            /></span>
            <input
              v-model="form.from"
              type="email"
              required
              class="input"
              data-testid="smtp-from"
            />
          </label>
          <label class="block">
            <span class="field-label">{{ t('mail.form.fromName') }}</span>
            <input
              v-model="form.fromName"
              maxlength="200"
              class="input"
              data-testid="smtp-from-name"
            />
          </label>
        </div>

        <div class="space-y-2">
          <label class="check-row">
            <input v-model="form.verifyCert" type="checkbox" data-testid="smtp-verify" />
            <span class="check-text">
              {{ t('mail.form.verify') }}
              <span class="check-hint">{{ t('mail.form.verifyHint') }}</span>
            </span>
          </label>
          <p v-if="!form.verifyCert" class="notice notice-warn" data-testid="smtp-verify-warn">
            {{ t('mail.form.verifyOff') }}
          </p>
          <label v-if="form.verifyCert && form.security !== 'none'" class="block sm:max-w-md">
            <span class="field-label">{{ t('mail.form.ca') }}</span>
            <select v-model="form.caId" class="input" data-testid="smtp-ca">
              <option :value="null">{{ t('mail.form.caNone') }}</option>
              <option v-for="c in cas" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
        </div>

        <fieldset class="space-y-1">
          <legend class="field-label">
            {{ t('mail.form.routing') }}<InfoHint :text="t('mail.form.routingHint')" />
          </legend>
          <div class="flex flex-wrap gap-x-4 gap-y-0.5">
            <label v-for="ty in TYPES" :key="ty" class="check-row">
              <input
                v-model="form.purposes"
                type="checkbox"
                :value="ty"
                :data-testid="`smtp-purpose-${ty}`"
              />
              <span class="check-text">{{ t(`mail.type.${ty}`) }}</span>
            </label>
          </div>
          <label class="check-row">
            <input v-model="form.fallback" type="checkbox" data-testid="smtp-fallback" />
            <span class="check-text">{{ t('mail.form.fallback') }}</span>
          </label>
        </fieldset>

        <div class="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            class="btn-primary"
            :disabled="saving || ntlmNeedsTls || (plainAuthAsked && !form.plainAuth)"
            data-testid="smtp-save"
          >
            {{ t('mail.form.save') }}
          </button>
          <button
            type="button"
            class="btn"
            @click="
              form = null;
              reset();
            "
          >
            {{ t('mail.form.cancel') }}
          </button>
          <UnsavedHint :dirty="dirty" />
        </div>
      </form>

      <article
        v-for="p in profiles"
        :key="p.id"
        class="card space-y-2 p-3 text-sm"
        :data-testid="`smtp-profile-${p.id}`"
        data-profile
      >
        <div class="flex flex-wrap items-center gap-1.5">
          <h4 class="font-semibold">{{ p.name }}</h4>
          <span v-if="p.id === activeId" class="badge-brand" data-testid="badge-active">{{
            t('mail.badge.active')
          }}</span>
          <span v-if="p.fallback" class="badge">{{ t('mail.badge.fallback') }}</span>
          <span v-if="p.purposes.length" class="badge">{{
            t('mail.badge.purposes', {
              types: p.purposes.map((x) => t(`mail.type.${x}`)).join(', '),
            })
          }}</span>
          <span
            v-if="!p.verifyCert && p.security !== 'none'"
            class="badge bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
            >{{ t('mail.badge.unverified') }}</span
          >
          <span
            v-if="p.security === 'none'"
            class="badge bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
            >{{ t('mail.badge.plaintext') }}</span
          >
        </div>
        <p class="text-xs text-slate-500">
          <code>{{ p.host }}:{{ p.port }}</code> · {{ t(`mail.sec.${p.security}`) }} ·
          {{ t(`mail.auth.${p.auth}`)
          }}<template v-if="p.auth !== 'none'"> ({{ p.user }})</template> · {{ p.from
          }}<template v-if="p.caName"> · {{ p.caName }}</template>
        </p>
        <p class="text-xs" data-testid="smtp-status">
          <template v-if="p.status.ok === null">{{ t('mail.status.never') }}</template>
          <template v-else-if="p.status.ok"
            ><span class="text-emerald-700 dark:text-emerald-300">{{
              t('mail.status.ok', { at: when(p.status.checkedAt!) })
            }}</span></template
          >
          <template v-else
            ><span class="text-red-700 dark:text-red-300">{{
              t('mail.status.fail', {
                title: errInfo(p.status.code).title,
                at: when(p.status.checkedAt!),
              })
            }}</span
            ><template v-if="p.status.lastSuccessAt">
              · {{ t('mail.status.lastOk', { at: when(p.status.lastSuccessAt) }) }}</template
            ></template
          >
        </p>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="btn"
            :disabled="checks[p.id] === 'run'"
            :aria-busy="checks[p.id] === 'run'"
            :data-testid="`smtp-test-${p.id}`"
            data-action="check"
            @click="check(p)"
          >
            {{ checks[p.id] === 'run' ? t('mail.actions.checking') : t('mail.actions.check') }}
          </button>
          <button type="button" class="btn" data-action="edit" @click="edit(p)">
            {{ t('mail.actions.edit') }}
          </button>
          <button
            v-if="p.id !== activeId"
            type="button"
            class="btn"
            data-action="activate"
            @click="activate(p)"
          >
            {{ t('mail.actions.activate') }}
          </button>
          <button type="button" class="btn-danger" data-action="remove" @click="remove(p)">
            {{ t('mail.actions.remove') }}
          </button>
        </div>

        <!-- результат проверки по этапам -->
        <div
          v-if="checks[p.id] && checks[p.id] !== 'run'"
          class="space-y-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50"
          :data-testid="`smtp-result-${p.id}`"
          data-result
        >
          <ol class="space-y-1">
            <li
              v-for="r in stageRows(checks[p.id] as Check)"
              :key="r.stage"
              class="flex items-start gap-2"
              :data-stage="r.stage"
            >
              <span class="mt-0.5 w-4 shrink-0 text-center" aria-hidden="true">{{
                !r.s ? '·' : r.s.skipped ? '–' : r.s.ok ? (r.s.warn ? '!' : '✓') : '✗'
              }}</span>
              <span class="w-36 shrink-0 font-medium">{{ t(`mail.stage.${r.stage}`) }}</span>
              <span class="min-w-0 break-words text-slate-600 dark:text-slate-300">
                <template v-if="!r.s">{{ t('mail.detail.notReached') }}</template>
                <template v-else-if="r.s.ok">{{ stageLine(r.s) }}</template>
                <strong v-else class="text-red-700 dark:text-red-300">{{
                  errInfo(r.s.code, r.s.info?.reason).title
                }}</strong>
              </span>
            </li>
          </ol>
          <p
            v-if="(checks[p.id] as Check).ok"
            class="text-emerald-700 dark:text-emerald-300"
            data-testid="smtp-result"
          >
            {{ p.auth === 'none' ? t('mail.result.okNoAuth') : t('mail.result.ok') }}
          </p>
          <div v-else class="space-y-1" data-testid="smtp-result">
            <p class="font-medium text-red-700 dark:text-red-300">
              {{ errInfo((checks[p.id] as Check).code, failReason(checks[p.id] as Check)).title }}
            </p>
            <p>
              {{ errInfo((checks[p.id] as Check).code, failReason(checks[p.id] as Check)).hint }}
            </p>
            <p v-if="(checks[p.id] as Check).text" class="text-xs text-slate-500">
              {{ t('mail.result.server', { text: (checks[p.id] as Check).text }) }}
            </p>
            <p v-if="certProbe(checks[p.id] as Check)" class="break-all text-xs text-slate-500">
              {{ certProbe(checks[p.id] as Check) }}
            </p>
          </div>
        </div>

        <form class="flex flex-wrap items-center gap-2" @submit.prevent="sendTest(p)">
          <input
            v-model="to[p.id]"
            type="email"
            required
            class="input min-w-56 flex-1"
            :aria-label="t('mail.actions.testTo')"
            :placeholder="t('mail.actions.testTo')"
            :data-testid="`smtp-to-${p.id}`"
          />
          <button
            type="submit"
            class="btn"
            :disabled="sent[p.id]?.kind === 'run'"
            :data-testid="`smtp-send-${p.id}`"
          >
            {{
              sent[p.id]?.kind === 'run' ? t('mail.actions.sending') : t('mail.actions.sendTest')
            }}
          </button>
        </form>
        <div
          v-if="sent[p.id] && sent[p.id]!.kind !== 'run'"
          class="text-xs"
          :data-testid="`smtp-sent-${p.id}`"
          role="status"
        >
          <template v-if="sent[p.id]!.kind === 'ok'">
            <p class="text-emerald-700 dark:text-emerald-300">{{ t('mail.sent.accepted') }}</p>
            <p v-if="sent[p.id]!.data?.smtpRef" class="text-slate-500">
              {{ t('mail.sent.ref', { ref: text(sent[p.id]!.data?.smtpRef) }) }}
            </p>
            <p class="break-all text-slate-500">
              {{ t('mail.sent.msg', { id: text(sent[p.id]!.data?.messageId) }) }}
            </p>
          </template>
          <template v-else-if="sent[p.id]!.kind === 'queued'">
            <p class="text-amber-700 dark:text-amber-300">{{ t('mail.sent.queued') }}</p>
            <p v-if="sent[p.id]!.data?.text" class="text-slate-500">
              {{ t('mail.result.server', { text: text(sent[p.id]!.data?.text) }) }}
            </p>
          </template>
          <template v-else>
            <p class="text-red-700 dark:text-red-300">
              {{
                sent[p.id]!.data?.code === 'rate'
                  ? t('mail.sent.rate')
                  : t('mail.sent.failed', { title: errInfo(text(sent[p.id]!.data?.code)).title })
              }}
            </p>
            <p v-if="sent[p.id]!.data?.code !== 'rate'">
              {{ errInfo(text(sent[p.id]!.data?.code)).hint }}
            </p>
            <p v-if="sent[p.id]!.data?.text" class="text-slate-500">
              {{ t('mail.result.server', { text: text(sent[p.id]!.data?.text) }) }}
            </p>
          </template>
        </div>
      </article>

      <!-- доверенные сертификаты -->
      <section class="card p-3 text-sm" data-testid="mail-cas">
        <button
          type="button"
          class="flex w-full items-center justify-between text-left font-semibold"
          :aria-expanded="caOpen"
          data-testid="mail-ca-toggle"
          @click="caOpen = !caOpen"
        >
          {{ t('mail.ca.title') }}
          <span class="text-xs font-normal text-slate-500">{{ cas.length }}</span>
        </button>
        <div v-if="caOpen" class="mt-2 space-y-3">
          <p class="text-xs text-slate-500">{{ t('mail.ca.hint') }}</p>
          <p v-if="!cas.length" class="text-xs text-slate-500">{{ t('mail.ca.none') }}</p>
          <ul v-else class="divide-y divide-slate-200 dark:divide-slate-800">
            <li
              v-for="c in cas"
              :key="c.id"
              class="flex flex-wrap items-center justify-between gap-2 py-1.5"
              data-testid="mail-ca"
            >
              <span class="min-w-0">
                <span class="font-medium">{{ c.name }}</span>
                <span class="block break-all text-xs text-slate-500"
                  >{{ c.subject }} · {{ t('mail.ca.until', { date: when(c.validTo).slice(0, 10) })
                  }}<template v-if="c.usedBy.length">
                    · {{ t('mail.ca.usedBy', { names: c.usedBy.join(', ') }) }}</template
                  ></span
                >
              </span>
              <button type="button" class="btn" @click="removeCa(c)">
                {{ t('mail.ca.remove') }}
              </button>
            </li>
          </ul>
          <form class="space-y-2" @submit.prevent="addCa">
            <input
              v-model="caForm.name"
              required
              maxlength="100"
              class="input"
              :placeholder="t('mail.ca.name')"
              :aria-label="t('mail.ca.name')"
              data-testid="mail-ca-name"
            />
            <p v-if="caForm.file" class="field-hint" data-testid="mail-ca-chosen">
              {{ caForm.file }}
            </p>
            <textarea
              v-if="!caForm.file"
              v-model="caForm.pem"
              :required="!caForm.data"
              rows="4"
              class="input font-mono text-xs"
              spellcheck="false"
              :placeholder="t('mail.ca.pem')"
              :aria-label="t('mail.ca.pem')"
              data-testid="mail-ca-pem"
            />
            <div class="flex flex-wrap items-center gap-2">
              <label class="btn cursor-pointer">
                {{ t('mail.ca.file') }}
                <input
                  type="file"
                  accept=".cer,.crt,.pem,.der,application/x-x509-ca-cert,application/pkix-cert"
                  class="sr-only"
                  data-testid="mail-ca-file"
                  @change="pickFile"
                />
              </label>
              <button type="submit" class="btn-primary" data-testid="mail-ca-add">
                {{ t('mail.ca.add') }}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>

    <!-- Журнал отправки -->
    <div v-else class="space-y-3" data-testid="mail-log">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-semibold">{{ t('mail.log.title') }}</h3>
        <button type="button" class="btn" data-testid="mail-log-refresh" @click="loadLog">
          {{ t('mail.log.refresh') }}
        </button>
      </div>
      <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <input
          v-model="filter.q"
          type="search"
          class="input sm:col-span-2"
          :placeholder="t('mail.log.search')"
          :aria-label="t('mail.log.search')"
          data-testid="mail-log-q"
        />
        <select
          v-model="filter.status"
          class="input"
          :aria-label="t('mail.log.status')"
          data-testid="mail-log-status"
        >
          <option value="">{{ t('mail.log.allStatuses') }}</option>
          <option
            v-for="s in ['queued', 'retry', 'sending', 'accepted', 'failed', 'cancelled']"
            :key="s"
            :value="s"
          >
            {{ t(`mail.log.st.${s}`) }}
          </option>
        </select>
        <select
          v-model="filter.type"
          class="input"
          :aria-label="t('mail.log.kind')"
          data-testid="mail-log-type"
        >
          <option value="">{{ t('mail.log.allTypes') }}</option>
          <option v-for="ty in TYPES" :key="ty" :value="ty">{{ t(`mail.type.${ty}`) }}</option>
        </select>
        <select
          v-model="filter.profile"
          class="input"
          :aria-label="t('mail.log.profile')"
          data-testid="mail-log-profile"
        >
          <option value="">{{ t('mail.log.allProfiles') }}</option>
          <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <label class="flex items-center gap-1.5 text-xs"
          >{{ t('mail.log.from')
          }}<input v-model="filter.from" type="date" class="input" data-testid="mail-log-from"
        /></label>
        <label class="flex items-center gap-1.5 text-xs"
          >{{ t('mail.log.to')
          }}<input v-model="filter.to" type="date" class="input" data-testid="mail-log-to"
        /></label>
        <label class="flex items-center gap-1.5 text-sm"
          ><input v-model="filter.errors" type="checkbox" data-testid="mail-log-errors" />{{
            t('mail.log.errors')
          }}</label
        >
      </div>
      <p class="text-xs text-slate-500" data-testid="mail-log-total">
        {{ t('mail.log.total', { n: total }) }} · {{ t('mail.log.acceptedNote') }}
      </p>

      <p v-if="!rows.length && !logLoading" class="empty" data-testid="mail-log-empty">
        {{ t('mail.log.none') }}
      </p>
      <ul v-else class="card divide-y divide-slate-200 text-sm dark:divide-slate-800">
        <li
          v-for="r in rows"
          :key="r.id"
          class="grid gap-x-3 gap-y-1 px-3 py-2 md:grid-cols-[9rem_minmax(0,1fr)_12rem]"
          data-testid="mail-log-row"
          :data-status="r.status"
        >
          <div class="text-xs text-slate-500">
            <div>{{ when(r.createdAt) }}</div>
            <div>{{ typeLabel(r) }}</div>
          </div>
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="break-all font-medium">{{ r.to }}</span>
              <span
                class="badge"
                :class="statusClass(r.status)"
                :data-testid="`mail-st-${r.status}`"
                >{{ t(`mail.log.st.${r.status}`) }}</span
              >
              <span class="text-xs text-slate-500"
                >{{ t('mail.log.attempts') }}: {{ r.attempts }}</span
              >
            </div>
            <div class="text-xs text-slate-500">
              {{ r.profileName ?? r.profileId }}
              <template v-if="r.status === 'retry'">
                · {{ t('mail.log.retryAt', { at: when(r.nextAttemptAt) }) }}</template
              >
              <template
                v-if="r.status === 'queued' || r.status === 'retry' || r.status === 'failed'"
              >
                · {{ t('mail.log.expires', { at: when(r.expiresAt) }) }}</template
              >
            </div>
            <div v-if="r.lastCode" class="text-xs text-red-700 dark:text-red-300">
              {{ errInfo(r.lastCode).title
              }}<template v-if="r.stage"> · {{ t(`mail.stage.${r.stage}`) }}</template
              ><template v-if="r.smtpStatus"> · SMTP {{ r.smtpStatus }}</template>
              <span v-if="r.text" class="block break-words text-slate-500">{{ r.text }}</span>
            </div>
            <div class="break-all font-mono text-[11px] text-slate-500">
              {{ t('mail.log.event', { id: r.id })
              }}<template v-if="r.messageId"> · {{ r.messageId }}</template
              ><template v-if="r.smtpRef"> · {{ r.smtpRef }}</template>
            </div>
          </div>
          <div class="flex flex-wrap items-start gap-1.5 md:justify-end">
            <button
              v-if="canRetry(r)"
              type="button"
              class="btn"
              data-testid="mail-log-retry"
              @click="rowAction(r, 'retry')"
            >
              {{ t('mail.log.retry') }}
            </button>
            <button
              v-if="canCancel(r)"
              type="button"
              class="btn"
              data-testid="mail-log-cancel"
              @click="rowAction(r, 'cancel')"
            >
              {{ t('mail.log.cancel') }}
            </button>
          </div>
        </li>
      </ul>
      <div v-if="total > LIMIT" class="flex items-center justify-between text-sm">
        <span class="text-xs text-slate-500">{{
          t('mail.log.page', { from: pageFrom, to: pageTo, n: total })
        }}</span>
        <span class="flex gap-2">
          <button
            type="button"
            class="btn"
            :disabled="offset === 0"
            data-testid="mail-log-prev"
            @click="((offset = Math.max(0, offset - LIMIT)), loadLog())"
          >
            {{ t('mail.log.prev') }}
          </button>
          <button
            type="button"
            class="btn"
            :disabled="offset + LIMIT >= total"
            data-testid="mail-log-next"
            @click="((offset += LIMIT), loadLog())"
          >
            {{ t('mail.log.next') }}
          </button>
        </span>
      </div>
    </div>
  </section>
</template>
