<script setup lang="ts">
import SwitchField from './SwitchField.vue';
import UnsavedHint from './UnsavedHint.vue';
import { useDirty } from '../services/dirty';
import InfoHint from './InfoHint.vue';
import Icon from './Icon.vue';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { bindAccount, ldapTransportProblem, normalizeLdapUrl } from '@arklock/contracts';
import { api, ApiError } from '../services/api';
import { errorMessage, when } from '../services/helpers';
import { confirmStepUp, stepUpHeaders } from '../services/stepup';
import { useAuthStore } from '../stores/auth';

const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      directory: {
        profiles: 'Подключения каталогов',
        add: 'Добавить подключение',
        remove: 'Удалить подключение',
        name: 'Название подключения',
        confirm:
          'Удалить подключение к каталогу? Это возможно, только если от него не зависят зарегистрированные пользователи.',
        inUse:
          'В этом каталоге есть зарегистрированные пользователи. Отключите подключение вместо удаления.',
        scheduled: 'Плановая синхронизация (каждые 30 минут)',
        lastSync: 'Последняя синхронизация',
        browse: 'Просмотреть каталог',
        users: 'Пользователи',
        groups: 'Группы',
        ous: 'Подразделения (OU)',
        search: 'Имя или почта',
        base: 'DN подразделения для просмотра',
        map: 'Связать с группой Arklock',
        open: 'Открыть OU',
        useBase: 'Использовать как базовый DN пользователей',
        bounded: 'Показаны первые результаты. Уточните фильтр или подразделение.',
        savedOnly:
          'Просмотр, поиск и синхронизация используют сохранённые настройки. Ключи новых пользователей создаются в браузере при первом входе.',
        mappingHint:
          'Для привязанных групп членство пользователей этого каталога управляется каталогом. Изменение привязки сохраняйте перед синхронизацией.',
        errors: 'Ошибки синхронизации',
        connection: 'Подключение',
        account: 'Учётная запись и поиск',
        mapping: 'Пользователи и группы',
      },
    },
    en: {
      directory: {
        profiles: 'Directory connections',
        add: 'Add connection',
        remove: 'Delete connection',
        name: 'Connection name',
        confirm:
          'Delete this directory connection? This is possible only if no registered users depend on it.',
        inUse:
          'Enrolled users depend on this directory. Disable the connection instead of deleting it.',
        scheduled: 'Scheduled sync (every 30 minutes)',
        lastSync: 'Last sync',
        browse: 'Browse directory',
        users: 'Users',
        groups: 'Groups',
        ous: 'Organizational units (OU)',
        search: 'Name or email',
        base: 'Browse OU distinguished name',
        map: 'Map to an Arklock group',
        open: 'Open OU',
        useBase: 'Use as user Base DN',
        bounded: 'First results shown. Narrow the filter or OU.',
        savedOnly:
          'Browsing, lookup and sync use the saved settings. New users create their encryption keys in the browser on first sign-in.',
        mappingHint:
          'Directory membership manages mapped groups for users of this connection. Save mapping changes before syncing.',
        errors: 'Sync errors',
        connection: 'Connection',
        account: 'Account and search',
        mapping: 'Users and groups',
      },
    },
  },
});
const auth = useAuthStore();

interface Form {
  name: string;
  syncEnabled: boolean;
  enabled: boolean;
  url: string;
  startTls: boolean;
  allowPlaintext: boolean;
  insecureTls: boolean;
  caPem: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  userFilter: string;
  emailAttr: string;
  nameAttr: string;
  titleAttr: string;
  departmentAttr: string;
  phoneAttr: string;
  autoProvision: boolean;
  groups: { dn: string; circleId: string }[];
}
const blankForm = (): Form => ({
  name: 'LDAP',
  syncEnabled: false,
  enabled: false,
  url: 'ldaps://',
  startTls: false,
  allowPlaintext: false,
  insecureTls: false,
  caPem: '',
  bindDn: '',
  bindPassword: '',
  baseDn: '',
  userFilter:
    '(&(objectClass=person)(|(uid={u})(mail={u})(sAMAccountName={u})(userPrincipalName={u})))',
  emailAttr: 'mail',
  nameAttr: 'cn',
  titleAttr: 'title',
  departmentAttr: 'department',
  phoneAttr: 'telephoneNumber',
  autoProvision: true,
  groups: [],
});
const FORM_KEYS = Object.keys(blankForm()) as (keyof Form)[];
const form = ref<Form>(blankForm());
interface Profile extends Omit<Form, 'bindPassword'> {
  id: string;
  hasBindPassword: boolean;
  lastSync: {
    at: string;
    total: number;
    updated: number;
    disabled: number;
    errors: string[];
  } | null;
}
const profiles = ref<Profile[]>([]);
const selectedProfile = ref('default');
/** Форма показывается после первой загрузки профилей: поздний ответ не должен затирать уже введённое. */
const loaded = ref(false);
const clearPassword = ref(false);
const lastSync = ref<Profile['lastSync']>(null);
const hasBindPassword = ref(false);
const circles = ref<{ id: string; name: string }[]>([]);
const error = ref('');
const notice = ref('');
const result = ref('');
const lookupName = ref('');
const lookupOut = ref<{
  found: boolean;
  user?: { dn: string; email: string; name: string; groups: string[] };
} | null>(null);
const busy = ref(false);
const browseKind = ref<'users' | 'groups' | 'ous'>('users');
const browseQuery = ref('');
const browseBase = ref('');
const browseOut = ref<{ dn: string; name: string; email: string; disabled: boolean }[]>([]);
const truncated = ref(false);
const profileQuery = () => `?profileId=${encodeURIComponent(selectedProfile.value)}`;

// Признак «не сохранено» сравнивает только поля формы: служебные сведения профиля (id, отметки, синхронизация)
// в форму не попадают, иначе после сохранения форма снова считалась бы изменённой.
const { dirty, clean } = useDirty(() => [form.value, clearPassword.value]);

function choose(id: string): void {
  selectedProfile.value = id;
  const profile = profiles.value.find((p) => p.id === id);
  const next = blankForm();
  for (const k of FORM_KEYS)
    if (profile && k in profile && k !== 'bindPassword')
      (next as unknown as Record<string, unknown>)[k] = (
        profile as unknown as Record<string, unknown>
      )[k];
  next.groups = profile?.groups.map((g) => ({ ...g })) ?? [];
  form.value = next;
  hasBindPassword.value = !!profile?.hasBindPassword;
  lastSync.value = profile?.lastSync ?? null;
  clearPassword.value = false;
  lookupOut.value = null;
  browseOut.value = [];
  browseBase.value = '';
  serverErrors.value = {};
  urlFixed.value = '';
  check.value = null;
  void describeCa(next.caPem);
  clean();
}
function addProfile(): void {
  choose(crypto.randomUUID());
}

async function load(): Promise<void> {
  const r = await api<{ profiles: Profile[]; circles: { id: string; name: string }[] }>(
    'GET',
    '/admin/ldap/profiles',
  );
  circles.value = r.circles;
  profiles.value = r.profiles;
  choose(
    profiles.value.some((p) => p.id === selectedProfile.value)
      ? selectedProfile.value
      : (profiles.value[0]?.id ?? 'default'),
  );
  loaded.value = true;
}
onMounted(() => load().catch((e) => (error.value = errorMessage(e, t))));

// ——— проверка полей: те же правила, что на сервере, сразу под полем ———
const serverErrors = ref<Record<string, string>>({});
const urlFixed = ref('');
const parsedUrl = computed(() => normalizeLdapUrl(form.value.url));
const account = computed(() => bindAccount(form.value.bindDn, form.value.baseDn));
const fieldErrors = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  const u = parsedUrl.value;
  if (!u.ok) out.url = t(`dir.url.${u.problem}`);
  else {
    const tp = ldapTransportProblem(u.value, form.value.startTls, form.value.allowPlaintext);
    // о способе защиты — у флажков, а не под адресом: сообщение появляется при сохранении и не сдвигает форму при вводе
    if (tp === 'plaintext') out.allowPlaintext = t('dir.url.plaintext');
    if (tp === 'starttls_with_ldaps') out.startTls = t('dir.starttls_with_ldaps');
  }
  if (!account.value.ok) out.bindDn = t(`dir.bind.${account.value.problem}`);
  if (!form.value.baseDn.trim()) out.baseDn = t('dir.baseDn.required');
  if (!form.value.userFilter.includes('{u}')) out.userFilter = t('dir.filter.placeholder');
  return { ...out, ...serverErrors.value };
});
const touched = ref<Record<string, boolean>>({});
const showError = (f: string) => (touched.value[f] || submitted.value ? fieldErrors.value[f] : '');
const submitted = ref(false);
/** Однозначные отклонения адреса (пробелы, регистр, «/» в конце) исправляются сразу, и форма говорит об этом. */
function fixUrl(): void {
  touched.value.url = true;
  const u = parsedUrl.value;
  if (u.ok && u.changed) {
    form.value.url = u.value.url;
    urlFixed.value = t('dir.url.fixed', { url: u.value.url });
  } else urlFixed.value = '';
}
/** Ошибки сервера по полям (validation_error) — под соответствующими полями. */
const SERVER_CODE: Record<string, (code: string) => string> = {
  url: (c) => (c === 'plaintext' ? t('dir.url.plaintext') : t(`dir.url.${c.replace(/^url_/, '')}`)),
  startTls: () => t('dir.starttls_with_ldaps'),
  bindDn: (c) => t(`dir.bind.${c.replace(/^bind_/, '')}`),
  bindPassword: () => t('dir.password.reentry'),
  baseDn: () => t('dir.baseDn.required'),
  userFilter: (c) => t(c === 'filter_parens' ? 'dir.filter.parens' : 'dir.filter.placeholder'),
  caPem: (c) => t(`dir.cert.problem.${c.replace(/^cert_/, '')}`),
};
function applyServerErrors(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.code !== 'validation_error' || !Array.isArray(e.details))
    return false;
  const out: Record<string, string> = {};
  for (const d of e.details as { path: string; code: string }[]) {
    const f = d.code === 'plaintext' ? 'allowPlaintext' : d.path.split('.')[0]!;
    out[f] =
      d.code === 'plaintext'
        ? t('dir.url.plaintext')
        : (SERVER_CODE[f]?.(d.code) ?? t('error.validation'));
  }
  serverErrors.value = out;
  submitted.value = true;
  return true;
}

// ——— сертификат центра: файл .cer/.crt/.pem (PEM или DER) или текст ———
interface CertInfo {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  daysLeft: number;
  fingerprint256: string;
  kind: 'root' | 'intermediate' | 'leaf';
  expired: boolean;
  notYetValid: boolean;
  chainToRoot: boolean;
}
const caInfo = ref<CertInfo[]>([]);
const caProblem = ref('');
const caPaste = ref('');
async function describeCa(pem: string): Promise<void> {
  caProblem.value = '';
  if (!pem.trim()) {
    caInfo.value = [];
    return;
  }
  const r = await api<{ ok: boolean; certs?: CertInfo[]; problem?: string }>(
    'POST',
    '/admin/ldap/ca-info',
    { pem },
  ).catch(() => null);
  caInfo.value = r?.certs ?? [];
}
async function uploadCa(body: { data?: string; pem?: string }): Promise<void> {
  delete serverErrors.value.caPem;
  const r = await api<{ ok: boolean; certs?: CertInfo[]; pem?: string; problem?: string }>(
    'POST',
    '/admin/ldap/ca-info',
    body,
  ).catch((e) => ({ ok: false, problem: '', error: errorMessage(e, t) }) as const);
  if (r.ok && r.pem) {
    form.value.caPem = r.pem;
    caInfo.value = r.certs ?? [];
    caProblem.value = '';
    caPaste.value = '';
  } else
    caProblem.value = r.problem
      ? t(`dir.cert.problem.${r.problem}`)
      : ('error' in r && r.error) || t('error.generic');
}
async function onCaFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  if (f.size > 256 * 1024) {
    caProblem.value = t('dir.cert.problem.too_large');
    return;
  }
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  await uploadCa({ data: btoa(bin) });
}
function clearCa(): void {
  form.value.caPem = '';
  caInfo.value = [];
  caProblem.value = '';
}
const issuerName = (c: CertInfo) =>
  c.issuer
    .split(', ')
    .find((x) => x.startsWith('CN='))
    ?.slice(3) ?? c.issuer;

function fail(e: unknown): void {
  if (applyServerErrors(e)) {
    error.value = errorMessage(e, t);
    return;
  }
  error.value =
    e instanceof ApiError && e.code === 'ldap_profile_in_use'
      ? t('directory.inUse')
      : errorMessage(e, t);
}

async function wrap(fn: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  result.value = '';
  try {
    await fn();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

/** Тело запроса из формы: пустой пароль — «оставить сохранённый», флажок «удалить» — пустая строка. */
const payload = () => ({
  ...form.value,
  bindPassword: clearPassword.value
    ? ''
    : form.value.bindPassword === ''
      ? undefined
      : form.value.bindPassword,
});

// ——— подтверждение снижения защиты (сервер требует его, когда включается небезопасный режим) ———
const reauthFor = ref<null | ((h: Record<string, string>) => Promise<void>)>(null);
const reauthPassword = ref('');
async function withConfirm(action: (h: Record<string, string>) => Promise<void>): Promise<void> {
  try {
    await action(stepUpHeaders() ?? {});
  } catch (e) {
    if (e instanceof ApiError && e.code === 'reauth_required') reauthFor.value = action;
    else throw e;
  }
}
const confirmReauth = () =>
  wrap(async () => {
    const action = reauthFor.value;
    if (!action || !auth.user) return;
    const h = await confirmStepUp(auth.user, reauthPassword.value);
    reauthPassword.value = '';
    reauthFor.value = null;
    await action(h);
  });

const save = () => {
  submitted.value = true;
  serverErrors.value = {};
  fixUrl();
  if (Object.keys(fieldErrors.value).length) {
    error.value = t('error.validationFields', {
      fields: Object.keys(fieldErrors.value)
        .map((f) => t(`error.field.${f}`))
        .join(', '),
    });
    return;
  }
  return wrap(() =>
    withConfirm(async (headers) => {
      await api('PUT', `/admin/ldap/profiles/${selectedProfile.value}`, payload(), { headers });
      await load();
      notice.value = t('dir.saved');
      submitted.value = false;
    }),
  );
};

// ——— пошаговая проверка того, что сейчас в форме ———
interface Stage {
  stage: string;
  ok: boolean;
  skipped?: boolean;
  warn?: boolean;
  code: string;
  params?: Record<string, string | number | boolean>;
  detail?: string;
}
const check = ref<{ ok: boolean; stages: Stage[] } | null>(null);
const stageText = (s: Stage) => {
  const key = `dir.result.${s.stage}.${s.code}`;
  const fallback = `dir.result.${s.stage}.ldap_error`;
  const p = { ...(s.params ?? {}) };
  if (s.stage === 'config' && s.code !== 'ok')
    return SERVER_CODE[s.code.startsWith('bind_') ? 'bindDn' : 'url']!(s.code);
  return t(te(key) ? key : te(fallback) ? fallback : 'error.generic', p);
};
const { te } = useI18n();
const test = () => {
  submitted.value = true;
  fixUrl();
  if (fieldErrors.value.url || fieldErrors.value.bindDn) return;
  return wrap(() =>
    withConfirm(async (headers) => {
      check.value = await api<{ ok: boolean; stages: Stage[] }>(
        'POST',
        '/admin/ldap/test' + profileQuery(),
        payload(),
        { headers },
      );
      const last = check.value.stages.at(-1);
      result.value = check.value.ok
        ? t('dir.check.ok')
        : t('dir.check.fail', { stage: last ? t(`dir.stage.${last.stage}`) : '' });
    }),
  );
};

const lookupFailure = (r: { reason?: string }) =>
  `${t('ldap.fail')}: ${te(`dir.result.bind.${r.reason}`) ? t(`dir.result.bind.${r.reason}`) : te(`dir.result.tls.${r.reason}`) ? t(`dir.result.tls.${r.reason}`) : t('error.generic')}`;
const lookup = () =>
  wrap(async () => {
    const r = await api<{ ok: boolean; found?: boolean; reason?: string; user?: never }>(
      'POST',
      '/admin/ldap/lookup' + profileQuery(),
      { username: lookupName.value },
    );
    if (!r.ok) result.value = lookupFailure(r);
    else lookupOut.value = { found: !!r.found, user: r.user };
  });

// предпросмотр сверки: те же правила без записи — кого отключат, что изменится, кто ещё не входил
interface Preview {
  linked: number;
  disable: { email: string; name: string; reason: 'missing' | 'disabled' | 'moved' }[];
  update: { email: string; name: string; join: string[]; leave: string[]; fields: string[] }[];
  unchanged: number;
  notYet: { count: number; sample: { email: string; name: string }[]; truncated: boolean };
  sample: { email: string; name: string; profile: Record<string, string>; groups: string[] } | null;
  errors: string[];
}
const preview = ref<Preview | null>(null);
const previewSync = () =>
  wrap(async () => {
    preview.value = await api<Preview>('POST', '/admin/ldap/sync/preview' + profileQuery());
  });
const sync = () =>
  wrap(async () => {
    preview.value = null;
    const r = await api<{ total: number; disabled: number; updated: number; errors: string[] }>(
      'POST',
      '/admin/ldap/sync' + profileQuery(),
    );
    result.value = t('ldap.syncResult', r);
    await load();
  });
const remove = () =>
  window.confirm(t('directory.confirm')) &&
  wrap(async () => {
    await api('DELETE', `/admin/ldap/profiles/${selectedProfile.value}`);
    await load();
  });
const browse = () =>
  wrap(async () => {
    const r = await api<{
      ok: boolean;
      reason?: string;
      entries?: typeof browseOut.value;
      truncated?: boolean;
    }>('POST', '/admin/ldap/browse' + profileQuery(), {
      kind: browseKind.value,
      q: browseQuery.value,
      baseDn: browseBase.value || undefined,
    });
    if (!r.ok) result.value = lookupFailure(r);
    browseOut.value = r.entries ?? [];
    truncated.value = !!r.truncated;
  });
</script>

<template>
  <div class="space-y-4" data-testid="ldap-settings">
    <p class="text-sm text-slate-500">{{ t('ldap.hint') }}</p>
    <div class="flex max-w-3xl flex-wrap items-end gap-2">
      <label class="min-w-48 flex-1 text-sm">
        <span class="field-label">{{ t('directory.profiles') }}</span>
        <select
          :value="selectedProfile"
          class="input"
          :disabled="busy"
          data-testid="ldap-profile"
          @change="choose(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
          <option v-if="!profiles.some((p) => p.id === selectedProfile)" :value="selectedProfile">
            {{ t('directory.add') }}
          </option>
        </select>
      </label>
      <button
        type="button"
        class="btn"
        :disabled="busy"
        data-testid="ldap-add-profile"
        @click="addProfile"
      >
        {{ t('directory.add') }}
      </button>
      <button
        type="button"
        class="btn"
        :disabled="busy || !profiles.some((p) => p.id === selectedProfile)"
        data-testid="ldap-delete-profile"
        @click="remove"
      >
        {{ t('directory.remove') }}
      </button>
    </div>
    <p v-if="error" class="notice notice-error max-w-3xl" role="alert" data-testid="ldap-error">
      {{ error }}
    </p>
    <p v-if="notice" class="notice notice-ok max-w-3xl" role="status" data-testid="ldap-notice">
      {{ notice }}
    </p>

    <form
      v-if="reauthFor"
      class="card flex max-w-3xl flex-wrap items-end gap-2 p-3 text-sm"
      data-testid="ldap-reauth"
      @submit.prevent="confirmReauth"
    >
      <div class="w-full text-xs text-slate-500">
        <strong class="text-slate-700 dark:text-slate-200">{{ t('dir.reauth.title') }}.</strong>
        {{ t('dir.reauth.text') }}
      </div>
      <input
        v-model="reauthPassword"
        type="password"
        autocomplete="current-password"
        class="input min-w-64 flex-1"
        :aria-label="t('dir.reauth.password')"
        data-testid="ldap-reauth-password"
        required
      />
      <button type="submit" class="btn-primary" :disabled="busy" data-testid="ldap-reauth-ok">
        {{ t('dir.reauth.ok') }}
      </button>
      <button type="button" class="btn" @click="reauthFor = null">{{ t('common.cancel') }}</button>
    </form>

    <form
      v-if="loaded"
      class="card max-w-3xl space-y-4 p-4 text-sm"
      novalidate
      @submit.prevent="save"
    >
      <!-- подключение -->
      <fieldset class="space-y-3">
        <legend class="mb-1 font-semibold">{{ t('directory.connection') }}</legend>
        <div class="form-grid">
          <label class="block">
            <span class="field-label">{{ t('directory.name') }}</span>
            <input
              v-model="form.name"
              required
              maxlength="100"
              class="input"
              data-testid="ldap-profile-name"
            />
          </label>
          <div class="sm:pt-6">
            <SwitchField
              v-model="form.enabled"
              data-testid="ldap-enabled"
              :label="t('ldap.enabled')"
            />
          </div>
          <label class="block sm:col-span-2">
            <span class="field-label">{{ t('dir.url.label') }}</span>
            <input
              v-model="form.url"
              class="input font-mono"
              spellcheck="false"
              autocomplete="off"
              :aria-invalid="!!showError('url')"
              data-testid="ldap-url"
              @blur="fixUrl"
            />
            <p v-if="showError('url')" class="field-error" data-testid="ldap-url-error">
              {{ showError('url') }}
            </p>
            <p v-else-if="urlFixed" class="field-hint" data-testid="ldap-url-fixed">
              {{ urlFixed }}
            </p>
            <p v-else class="field-hint">{{ t('dir.url.hint') }}</p>
          </label>
        </div>
        <div class="space-y-1.5">
          <SwitchField
            v-model="form.startTls"
            :label="t('ldap.startTls')"
            data-testid="ldap-starttls"
          />
          <p v-if="showError('startTls')" class="field-error pl-7">{{ showError('startTls') }}</p>
          <SwitchField
            v-model="form.allowPlaintext"
            :label="t('ldap.allowPlaintext')"
            :hint="t('hint.ldapPlaintext.text')"
            data-testid="ldap-plaintext"
          />
          <p
            v-if="showError('allowPlaintext')"
            class="field-error pl-7"
            data-testid="ldap-transport-error"
          >
            {{ showError('allowPlaintext') }}
          </p>
          <p
            v-if="form.allowPlaintext"
            class="notice notice-warn"
            data-testid="ldap-plaintext-warn"
          >
            {{ t('dir.insecure.plaintext') }}
          </p>
          <SwitchField
            v-model="form.insecureTls"
            :label="t('ldap.insecureTls')"
            data-testid="ldap-insecure"
          />
          <p v-if="form.insecureTls" class="notice notice-warn" data-testid="ldap-insecure-warn">
            {{ t('dir.insecure.tls') }}
          </p>
        </div>

        <!-- сертификат центра сертификации -->
        <div class="space-y-1.5" data-testid="ldap-ca">
          <span class="field-label"
            >{{ t('dir.cert.label') }}<InfoHint :text="t('dir.cert.hint')"
          /></span>
          <div class="flex flex-wrap items-center gap-2">
            <label class="btn cursor-pointer">
              <Icon name="file" class="size-4" />{{ t('dir.cert.upload') }}
              <input
                type="file"
                accept=".cer,.crt,.pem,.der,application/x-x509-ca-cert,application/pkix-cert"
                class="sr-only"
                data-testid="ldap-ca-file"
                @change="onCaFile"
              />
            </label>
            <button
              v-if="form.caPem"
              type="button"
              class="btn-ghost"
              data-testid="ldap-ca-clear"
              @click="clearCa"
            >
              {{ t('dir.cert.clear') }}
            </button>
          </div>
          <p
            v-if="caProblem || showError('caPem')"
            class="field-error"
            role="alert"
            data-testid="ldap-ca-problem"
          >
            {{ caProblem || showError('caPem') }}
          </p>
          <p v-else-if="!form.caPem" class="field-hint">{{ t('dir.cert.none') }}</p>
          <ul v-if="caInfo.length" class="space-y-1.5 text-xs" data-testid="ldap-ca-info">
            <li
              v-for="c in caInfo"
              :key="c.fingerprint256"
              class="space-y-0.5 rounded-md border border-slate-200 p-2 dark:border-slate-700"
            >
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="font-medium">{{ c.subject }}</span>
                <span
                  :class="
                    c.kind === 'leaf'
                      ? 'badge bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
                      : 'badge'
                  "
                  >{{ t(`dir.cert.kind.${c.kind}`) }}</span
                >
              </div>
              <div class="text-slate-500">{{ t('dir.cert.issuer') }}: {{ c.issuer }}</div>
              <div
                :class="
                  c.expired || c.notYetValid
                    ? 'text-red-700 dark:text-red-300'
                    : c.daysLeft < 30
                      ? 'text-amber-700'
                      : 'text-slate-500'
                "
              >
                {{ t('dir.cert.valid') }}: {{ c.validFrom.slice(0, 10) }} —
                {{ c.validTo.slice(0, 10) }} ({{
                  c.expired
                    ? t('dir.cert.expired')
                    : c.notYetValid
                      ? t('dir.cert.notYet')
                      : t('dir.cert.days', { n: c.daysLeft })
                }})
              </div>
              <div class="break-all font-mono text-slate-500">SHA-256: {{ c.fingerprint256 }}</div>
              <div v-if="c.kind === 'leaf'" class="text-amber-800 dark:text-amber-200">
                {{ t('dir.cert.leafWarn') }}
              </div>
              <div
                v-else-if="c.chainToRoot"
                class="text-emerald-700 dark:text-emerald-300"
                data-testid="ldap-ca-chain-ok"
              >
                {{ t('dir.cert.chainOk') }}
              </div>
              <div
                v-else
                class="text-amber-800 dark:text-amber-200"
                data-testid="ldap-ca-chain-missing"
              >
                {{ t('dir.cert.chainMissing', { issuer: issuerName(c) }) }}
              </div>
            </li>
          </ul>
          <details class="text-xs">
            <summary class="cursor-pointer text-slate-500">{{ t('dir.cert.paste') }}</summary>
            <div class="mt-1 space-y-1">
              <textarea
                v-model="caPaste"
                rows="4"
                class="input font-mono text-xs"
                data-testid="ldap-ca-paste"
              />
              <button
                type="button"
                class="btn"
                :disabled="!caPaste.trim()"
                @click="uploadCa({ pem: caPaste })"
              >
                {{ t('dir.cert.upload') }}
              </button>
            </div>
          </details>
        </div>
      </fieldset>

      <!-- учётная запись и поиск -->
      <fieldset class="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800">
        <legend class="sr-only">{{ t('directory.account') }}</legend>
        <p class="font-semibold">{{ t('directory.account') }}</p>
        <div class="form-grid">
          <label class="block">
            <span class="field-label"
              >{{ t('dir.bind.label') }}<InfoHint :text="t('dir.bind.hint')"
            /></span>
            <input
              v-model="form.bindDn"
              class="input font-mono"
              spellcheck="false"
              autocomplete="off"
              :aria-invalid="!!showError('bindDn')"
              data-testid="ldap-binddn"
              @blur="touched.bindDn = true"
            />
            <p v-if="showError('bindDn')" class="field-error" data-testid="ldap-binddn-error">
              {{ showError('bindDn') }}
            </p>
            <p
              v-else-if="account.ok && account.kind !== 'none'"
              class="field-hint"
              data-testid="ldap-binddn-hint"
            >
              {{ t(`dir.bind.kind.${account.kind}`) }}
              <template v-if="account.derived">
                {{ t('dir.bind.uses', { value: account.value }) }}</template
              >
            </p>
          </label>
          <label class="block">
            <span class="field-label">{{ t('ldap.bindPassword') }}</span>
            <input
              v-model="form.bindPassword"
              type="password"
              autocomplete="new-password"
              class="input"
              :placeholder="hasBindPassword && !clearPassword ? t('dir.password.keep') : ''"
              :disabled="clearPassword"
              :aria-invalid="!!showError('bindPassword')"
              data-testid="ldap-bindpw"
            />
            <p v-if="showError('bindPassword')" class="field-error" data-testid="ldap-bindpw-error">
              {{ showError('bindPassword') }}
            </p>
            <SwitchField
              v-if="hasBindPassword"
              v-model="clearPassword"
              class="mt-1"
              :label="t('dir.password.clear')"
              data-testid="ldap-clear-password"
            />
          </label>
          <label class="block sm:col-span-2">
            <span class="field-label"
              >{{ t('ldap.baseDn')
              }}<InfoHint :text="t('hint.ldapBaseDn.text')" :details="t('hint.ldapBaseDn.details')"
            /></span>
            <input
              v-model="form.baseDn"
              class="input font-mono"
              spellcheck="false"
              :aria-invalid="!!showError('baseDn')"
              data-testid="ldap-basedn"
              @blur="touched.baseDn = true"
            />
            <p v-if="showError('baseDn')" class="field-error">{{ showError('baseDn') }}</p>
          </label>
          <label class="block sm:col-span-2">
            <span class="field-label"
              >{{ t('ldap.userFilter') }}<InfoHint :text="t('hint.ldapUserFilter.text')"
            /></span>
            <input
              v-model="form.userFilter"
              class="input font-mono text-xs"
              spellcheck="false"
              :aria-invalid="!!showError('userFilter')"
              data-testid="ldap-filter"
              @blur="touched.userFilter = true"
            />
            <p v-if="showError('userFilter')" class="field-error">{{ showError('userFilter') }}</p>
          </label>
          <label class="block">
            <span class="field-label">{{ t('ldap.emailAttr') }}</span>
            <input v-model="form.emailAttr" class="input" />
          </label>
          <label class="block">
            <span class="field-label">{{ t('ldap.nameAttr') }}</span>
            <input v-model="form.nameAttr" class="input" />
          </label>
        </div>
      </fieldset>

      <!-- пользователи и группы -->
      <fieldset class="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800">
        <legend class="sr-only">{{ t('directory.mapping') }}</legend>
        <p class="font-semibold">{{ t('directory.mapping') }}</p>
        <div>
          <span class="field-label">{{ t('ldap.cardAttrs') }}</span>
          <div class="grid gap-3 sm:grid-cols-3">
            <label
              v-for="k in ['titleAttr', 'departmentAttr', 'phoneAttr'] as const"
              :key="k"
              class="block"
            >
              <span class="field-label">{{ t(`ldap.${k}`) }}</span>
              <input v-model="form[k]" class="input" :data-testid="`ldap-${k}`" />
            </label>
          </div>
          <p class="field-hint">{{ t('ldap.cardAttrsHint') }}</p>
        </div>
        <div class="space-y-1.5">
          <SwitchField v-model="form.autoProvision" :label="t('ldap.autoProvision')" />
          <SwitchField
            v-model="form.syncEnabled"
            data-testid="ldap-scheduled-sync"
            :label="t('directory.scheduled')"
          />
        </div>
        <div class="space-y-2">
          <div class="font-medium">{{ t('ldap.groups') }}</div>
          <p class="field-hint">{{ t('directory.mappingHint') }}</p>
          <div v-for="(g, i) in form.groups" :key="i" class="flex flex-wrap gap-2">
            <input
              v-model="g.dn"
              class="input min-w-0 flex-1 font-mono text-xs"
              :placeholder="t('ldap.groupDn')"
            />
            <select v-model="g.circleId" class="input w-48">
              <option v-for="c in circles" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
            <button
              type="button"
              class="btn"
              :aria-label="t('common.delete')"
              @click="form.groups.splice(i, 1)"
            >
              ✕
            </button>
          </div>
          <button
            type="button"
            class="btn"
            :disabled="!circles.length"
            data-testid="ldap-add-group"
            @click="form.groups.push({ dn: '', circleId: circles[0]!.id })"
          >
            {{ t('ldap.addGroup') }}
          </button>
        </div>
      </fieldset>

      <div
        class="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3 dark:border-slate-800"
      >
        <button type="submit" class="btn-primary" :disabled="busy" data-testid="ldap-save">
          {{ t('common.save') }}
        </button>
        <button type="button" class="btn" :disabled="busy" data-testid="ldap-test" @click="test">
          {{ t('dir.check.run') }}
        </button>
        <UnsavedHint :dirty="dirty" />
      </div>
      <p class="field-hint">{{ t('dir.check.note') }}</p>

      <section v-if="check" class="space-y-1" data-testid="ldap-check">
        <p
          :class="check.ok ? 'notice notice-ok' : 'notice notice-error'"
          role="status"
          data-testid="ldap-result"
        >
          {{ result }}
        </p>
        <ol class="space-y-1">
          <li
            v-for="s in check.stages"
            :key="s.stage"
            class="flex items-start gap-2 text-xs"
            :data-stage="s.stage"
            :data-ok="s.ok"
          >
            <span
              aria-hidden="true"
              class="mt-0.5 w-4 shrink-0 text-center font-bold"
              :class="
                !s.ok ? 'text-red-600' : s.warn || s.skipped ? 'text-amber-600' : 'text-emerald-600'
              "
              >{{ !s.ok ? '✕' : s.warn || s.skipped ? '!' : '✓' }}</span
            >
            <div class="min-w-0 flex-1">
              <span class="font-medium">{{ t(`dir.stage.${s.stage}`) }}.</span>
              {{ stageText(s) }}
              <details v-if="s.detail" class="mt-0.5">
                <summary class="cursor-pointer text-slate-500">
                  {{ t('dir.check.details') }}
                </summary>
                <pre class="whitespace-pre-wrap break-all text-slate-500">{{ s.detail }}</pre>
              </details>
            </div>
          </li>
        </ol>
      </section>
    </form>

    <div class="card max-w-3xl space-y-3 p-4 text-sm">
      <p class="text-xs text-slate-500">{{ t('directory.savedOnly') }}</p>
      <div v-if="lastSync" data-testid="ldap-last-sync">
        {{ t('directory.lastSync') }}: {{ when(lastSync.at) }} ·
        {{ t('ldap.syncResult', lastSync) }}
        <ul
          v-if="lastSync.errors.length"
          class="text-xs text-red-600"
          :aria-label="t('directory.errors')"
        >
          <li v-for="(message, i) in lastSync.errors" :key="i">{{ message }}</li>
        </ul>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="btn"
          :disabled="busy"
          data-testid="ldap-sync-preview"
          @click="previewSync"
        >
          {{ t('ldap.preview') }}
        </button>
        <button type="button" class="btn" :disabled="busy" data-testid="ldap-sync" @click="sync">
          {{ t('ldap.sync') }}
        </button>
      </div>
      <p v-if="result && !check" class="text-sm" data-testid="ldap-op-result">{{ result }}</p>
      <section
        v-if="preview"
        class="space-y-2 rounded-md border border-slate-200 p-3 text-xs dark:border-slate-700"
        data-testid="ldap-preview"
      >
        <p class="font-medium">
          {{
            t('ldap.previewSummary', {
              linked: preview.linked,
              disable: preview.disable.length,
              update: preview.update.length,
              unchanged: preview.unchanged,
            })
          }}
        </p>
        <div v-if="preview.disable.length">
          <p class="font-medium text-red-700 dark:text-red-300">{{ t('ldap.willDisable') }}</p>
          <ul>
            <li v-for="u in preview.disable" :key="u.email">
              {{ u.name }} &lt;{{ u.email }}&gt; — {{ t(`ldap.reason.${u.reason}`) }}
            </li>
          </ul>
        </div>
        <div v-if="preview.update.length">
          <p class="font-medium">{{ t('ldap.willUpdate') }}</p>
          <ul>
            <li v-for="u in preview.update" :key="u.email">
              {{ u.name }}:
              <span v-if="u.join.length">+ {{ u.join.join(', ') }} </span>
              <span v-if="u.leave.length">− {{ u.leave.join(', ') }} </span>
              <span v-if="u.fields.length"
                >· {{ t('ldap.fieldsChanged', { n: u.fields.length }) }}</span
              >
            </li>
          </ul>
        </div>
        <div v-if="preview.notYet.count">
          <p class="font-medium">
            {{ t('ldap.notYet', { n: preview.notYet.count })
            }}{{ preview.notYet.truncated ? '+' : '' }}
          </p>
          <p class="text-slate-500">{{ t('ldap.notYetHint') }}</p>
          <ul>
            <li v-for="u in preview.notYet.sample" :key="u.email">
              {{ u.name }} &lt;{{ u.email }}&gt;
            </li>
          </ul>
        </div>
        <div v-if="preview.sample">
          <p class="font-medium">{{ t('ldap.sampleData') }}</p>
          <p>
            {{ preview.sample.name }} · {{ preview.sample.email }}
            <template v-for="(v, k) in preview.sample.profile" :key="k"
              ><span v-if="v"> · {{ v }}</span></template
            >
            <span v-if="preview.sample.groups.length">
              · {{ preview.sample.groups.length }} {{ t('ldap.groupsShort') }}</span
            >
          </p>
        </div>
        <ul v-if="preview.errors.length" class="text-red-600">
          <li v-for="(m, i) in preview.errors" :key="i">{{ m }}</li>
        </ul>
      </section>
      <form class="flex gap-2" @submit.prevent="lookup">
        <input
          v-model="lookupName"
          required
          class="input"
          :placeholder="t('ldap.lookupName')"
          data-testid="ldap-lookup-name"
        />
        <button type="submit" class="btn" :disabled="busy" data-testid="ldap-lookup">
          {{ t('ldap.lookup') }}
        </button>
      </form>
      <div v-if="lookupOut" data-testid="ldap-lookup-result">
        <p v-if="!lookupOut.found">{{ t('ldap.notFound') }}</p>
        <div v-else>
          <p>
            {{ t('ldap.found') }}: {{ lookupOut.user?.name }} &lt;{{ lookupOut.user?.email }}&gt;
          </p>
          <p class="break-all font-mono text-xs text-slate-500">{{ lookupOut.user?.dn }}</p>
          <ul class="font-mono text-xs">
            <li v-for="g in lookupOut.user?.groups" :key="g">{{ g }}</li>
          </ul>
        </div>
      </div>
      <form class="space-y-2 border-t border-slate-200 pt-3" @submit.prevent="browse">
        <div class="flex gap-2">
          <select
            v-model="browseKind"
            class="input w-48"
            :aria-label="t('directory.browse')"
            data-testid="ldap-browse-kind"
          >
            <option value="users">{{ t('directory.users') }}</option>
            <option value="groups">{{ t('directory.groups') }}</option>
            <option value="ous">{{ t('directory.ous') }}</option>
          </select>
          <input
            v-model="browseQuery"
            class="input"
            :placeholder="t('directory.search')"
            :aria-label="t('directory.search')"
            data-testid="ldap-browse-query"
          />
        </div>
        <input
          v-model="browseBase"
          class="input font-mono text-xs"
          :placeholder="form.baseDn"
          :aria-label="t('directory.base')"
          data-testid="ldap-browse-base"
        />
        <button type="submit" class="btn" :disabled="busy" data-testid="ldap-browse">
          {{ t('directory.browse') }}
        </button>
      </form>
      <p v-if="truncated" class="text-xs text-amber-700">{{ t('directory.bounded') }}</p>
      <ul class="max-h-80 divide-y divide-slate-200 overflow-auto" data-testid="ldap-browse-result">
        <li v-for="entry in browseOut" :key="entry.dn" class="space-y-1 py-2">
          <p>
            {{ entry.name }} <span class="text-slate-500">{{ entry.email }}</span>
          </p>
          <p class="break-all font-mono text-xs text-slate-500">{{ entry.dn }}</p>
          <button
            v-if="browseKind === 'groups'"
            type="button"
            class="btn text-xs"
            :disabled="!circles.length || form.groups.some((g) => g.dn === entry.dn)"
            @click="form.groups.push({ dn: entry.dn, circleId: circles[0]!.id })"
          >
            {{ t('directory.map') }}
          </button>
          <div v-if="browseKind === 'ous'" class="flex flex-wrap gap-2">
            <button
              type="button"
              class="btn text-xs"
              @click="
                browseBase = entry.dn;
                browse();
              "
            >
              {{ t('directory.open') }}
            </button>
            <button type="button" class="btn text-xs" @click="form.baseDn = entry.dn">
              {{ t('directory.useBase') }}
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
