<script setup lang="ts">
import SwitchField from './SwitchField.vue';
import InfoHint from './InfoHint.vue';
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../services/api';
import { errorMessage, when } from '../services/helpers';

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
          'Проверка, просмотр и синхронизация используют сохранённые настройки. Ключи новых пользователей создаются в браузере при первом входе.',
        mappingHint:
          'Для привязанных групп членство пользователей этого каталога управляется каталогом. Изменение привязки сохраняйте перед синхронизацией.',
        clearPassword: 'Удалить сохранённый служебный пароль',
        errors: 'Ошибки синхронизации',
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
          'Diagnostics, browsing and sync use saved settings. New users create their encryption keys in the browser on first sign-in.',
        mappingHint:
          'Directory membership manages mapped groups for users of this connection. Save mapping changes before syncing.',
        clearPassword: 'Clear saved service password',
        errors: 'Sync errors',
      },
    },
  },
});

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

function choose(id: string): void {
  selectedProfile.value = id;
  const profile = profiles.value.find((p) => p.id === id);
  form.value = {
    ...blankForm(),
    ...profile,
    groups: profile?.groups.map((g) => ({ ...g })) ?? [],
    bindPassword: '',
  };
  hasBindPassword.value = !!profile?.hasBindPassword;
  lastSync.value = profile?.lastSync ?? null;
  clearPassword.value = false;
  lookupOut.value = null;
  browseOut.value = [];
  browseBase.value = '';
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

function fail(e: unknown): void {
  error.value =
    e instanceof ApiError && e.code === 'ldap_profile_in_use'
      ? t('directory.inUse')
      : e instanceof ApiError && e.code === 'insecure_ldap'
        ? t('ldap.allowPlaintext')
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

const save = () =>
  wrap(async () => {
    await api('PUT', `/admin/ldap/profiles/${selectedProfile.value}`, {
      ...form.value,
      bindPassword: clearPassword.value
        ? ''
        : form.value.bindPassword === ''
          ? undefined
          : form.value.bindPassword,
    });
    notice.value = t('admin.saved');
    await load();
  });

const test = () =>
  wrap(async () => {
    const r = await api<{ ok: boolean; message?: string }>(
      'POST',
      '/admin/ldap/test' + profileQuery(),
    );
    result.value = r.ok ? t('ldap.ok') : `${t('ldap.fail')}: ${r.message ?? ''}`;
  });

const lookup = () =>
  wrap(async () => {
    const r = await api<{ ok: boolean; found?: boolean; message?: string; user?: never }>(
      'POST',
      '/admin/ldap/lookup' + profileQuery(),
      { username: lookupName.value },
    );
    if (!r.ok) result.value = `${t('ldap.fail')}: ${r.message ?? ''}`;
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
      message?: string;
      entries?: typeof browseOut.value;
      truncated?: boolean;
    }>('POST', '/admin/ldap/browse' + profileQuery(), {
      kind: browseKind.value,
      q: browseQuery.value,
      baseDn: browseBase.value || undefined,
    });
    if (!r.ok) result.value = `${t('ldap.fail')}: ${r.message ?? ''}`;
    browseOut.value = r.entries ?? [];
    truncated.value = !!r.truncated;
  });
</script>

<template>
  <div class="space-y-4" data-testid="ldap-settings">
    <p class="text-sm text-slate-500">{{ t('ldap.hint') }}</p>
    <div class="flex max-w-2xl flex-wrap items-end gap-2">
      <label class="min-w-48 flex-1 text-sm"
        >{{ t('directory.profiles') }}
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
    <p
      v-if="error"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
      role="alert"
      data-testid="ldap-error"
    >
      {{ error }}
    </p>
    <p
      v-if="notice"
      class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
      role="status"
    >
      {{ notice }}
    </p>

    <form v-if="loaded" class="card max-w-2xl space-y-3 p-4 text-sm" @submit.prevent="save">
      <label class="block"
        >{{ t('directory.name')
        }}<input
          v-model="form.name"
          required
          maxlength="100"
          class="input"
          data-testid="ldap-profile-name"
      /></label>
      <SwitchField v-model="form.enabled" data-testid="ldap-enabled" :label="t('ldap.enabled')" />
      <label class="block"
        >{{ t('ldap.url')
        }}<input v-model="form.url" required class="input font-mono" data-testid="ldap-url"
      /></label>
      <SwitchField
        v-if="hasBindPassword"
        v-model="clearPassword"
        :label="t('directory.clearPassword')"
      />
      <div class="flex flex-wrap gap-4">
        <SwitchField v-model="form.startTls" :label="t('ldap.startTls')" />
        <label class="flex items-center gap-2"
          ><input v-model="form.allowPlaintext" type="checkbox" data-testid="ldap-plaintext" />
          {{ t('ldap.allowPlaintext') }}<InfoHint :text="t('hint.ldapPlaintext.text')"
        /></label>
        <SwitchField v-model="form.insecureTls" :label="t('ldap.insecureTls')" />
      </div>
      <label class="block"
        >{{ t('ldap.ca')
        }}<textarea v-model="form.caPem" rows="3" class="input font-mono text-xs" />
      </label>
      <label class="block"
        ><span class="inline-flex items-center gap-1"
          >{{ t('ldap.bindDn') }}<InfoHint :text="t('hint.ldapBindDn.text')" /></span
        ><input v-model="form.bindDn" class="input font-mono" data-testid="ldap-binddn"
      /></label>
      <label class="block"
        >{{ t('ldap.bindPassword')
        }}<input
          v-model="form.bindPassword"
          type="password"
          autocomplete="new-password"
          class="input"
          :placeholder="hasBindPassword ? t('sys.smtp.keepPassword') : ''"
          data-testid="ldap-bindpw"
      /></label>
      <label class="block"
        ><span class="inline-flex items-center gap-1"
          >{{ t('ldap.baseDn')
          }}<InfoHint
            :text="t('hint.ldapBaseDn.text')"
            :details="t('hint.ldapBaseDn.details')" /></span
        ><input v-model="form.baseDn" required class="input font-mono" data-testid="ldap-basedn"
      /></label>
      <label class="block"
        ><span class="inline-flex items-center gap-1"
          >{{ t('ldap.userFilter') }}<InfoHint :text="t('hint.ldapUserFilter.text')" /></span
        ><input v-model="form.userFilter" required class="input font-mono text-xs"
      /></label>
      <div class="flex gap-3">
        <label class="flex-1"
          >{{ t('ldap.emailAttr') }}<input v-model="form.emailAttr" class="input"
        /></label>
        <label class="flex-1"
          >{{ t('ldap.nameAttr') }}<input v-model="form.nameAttr" class="input"
        /></label>
      </div>
      <fieldset class="space-y-1">
        <legend class="text-sm">{{ t('ldap.cardAttrs') }}</legend>
        <div class="flex flex-wrap gap-3">
          <label
            v-for="k in ['titleAttr', 'departmentAttr', 'phoneAttr'] as const"
            :key="k"
            class="flex-1"
            >{{ t(`ldap.${k}`) }}<input v-model="form[k]" class="input" :data-testid="`ldap-${k}`"
          /></label>
        </div>
        <p class="text-xs text-slate-500">{{ t('ldap.cardAttrsHint') }}</p>
      </fieldset>
      <SwitchField v-model="form.autoProvision" :label="t('ldap.autoProvision')" />
      <SwitchField
        v-model="form.syncEnabled"
        data-testid="ldap-scheduled-sync"
        :label="t('directory.scheduled')"
      />

      <div class="space-y-2">
        <div class="font-medium">{{ t('ldap.groups') }}</div>
        <p class="text-xs text-slate-500">{{ t('directory.mappingHint') }}</p>
        <div v-for="(g, i) in form.groups" :key="i" class="flex gap-2">
          <input
            v-model="g.dn"
            class="input flex-1 font-mono text-xs"
            :placeholder="t('ldap.groupDn')"
          />
          <select v-model="g.circleId" class="input w-48">
            <option v-for="c in circles" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <button type="button" class="btn" @click="form.groups.splice(i, 1)">✕</button>
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
      <button type="submit" class="btn-primary" :disabled="busy" data-testid="ldap-save">
        {{ t('common.save') }}
      </button>
    </form>

    <div class="card max-w-2xl space-y-3 p-4 text-sm">
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
        <button type="button" class="btn" :disabled="busy" data-testid="ldap-test" @click="test">
          {{ t('ldap.test') }}
        </button>
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
      <p v-if="result" data-testid="ldap-result">{{ result }}</p>
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
