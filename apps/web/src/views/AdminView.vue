<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import { useAuthStore } from '../stores/auth';
import AdminSystem from '../components/AdminSystem.vue';
import LdapSettings from '../components/LdapSettings.vue';
import SsoSettings from '../components/SsoSettings.vue';
import SyslogSettings from '../components/SyslogSettings.vue';
import InvitationsPanel from '../components/InvitationsPanel.vue';
import Icon, { type IconName } from '../components/Icon.vue';

/** Значки разделов админки: по смыслу раздела, подпись остаётся для доступности и подсказки. */
const TAB_ICON: Record<string, IconName> = {
  overview: 'chart',
  users: 'user',
  circles: 'users',
  roles: 'shield',
  invitations: 'user',
  resources: 'chart',
  containers: 'database',
  backups: 'database',
  logs: 'log',
  storage: 'file',
  diagnostics: 'help',
  certificates: 'lock',
  ldap: 'users',
  sso: 'key',
  saml: 'key',
  smtp: 'text',
  syslog: 'log',
  settings: 'settings',
  ledger: 'log',
};
import RolesPanel from '../components/RolesPanel.vue';
import SamlSettings from '../components/SamlSettings.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

type SysTab =
  | 'overview'
  | 'resources'
  | 'containers'
  | 'backups'
  | 'logs'
  | 'storage'
  | 'diagnostics'
  | 'certificates'
  | 'smtp';
type Tab =
  | 'users'
  | 'circles'
  | 'settings'
  | 'ledger'
  | 'ldap'
  | 'sso'
  | 'syslog'
  | 'invitations'
  | 'roles'
  | 'saml'
  | SysTab;
const SYS_TABS: SysTab[] = [
  'overview',
  'resources',
  'containers',
  'backups',
  'logs',
  'storage',
  'diagnostics',
  'certificates',
  'smtp',
];
/** Полномочие, необходимое для раздела: делегированный администратор видит только разрешённые разделы. */
const TAB_PERM: Record<Tab, string> = {
  users: 'admin.users',
  circles: 'admin.circles',
  settings: 'admin.settings',
  ledger: 'admin.ledger',
  overview: 'admin.system',
  resources: 'admin.system',
  containers: 'admin.system',
  logs: 'admin.system',
  storage: 'admin.system',
  diagnostics: 'admin.system',
  certificates: 'admin.system',
  backups: 'admin.backups',
  smtp: 'admin.integrations',
  ldap: 'admin.integrations',
  sso: 'admin.integrations',
  saml: 'admin.integrations',
  syslog: 'admin.integrations',
  invitations: 'admin.invitations',
  roles: 'admin.roles',
};
const adminPerms = ref<{ full: boolean; permissions: string[] } | null>(null);
const canTab = (x: Tab) =>
  !adminPerms.value || adminPerms.value.full || adminPerms.value.permissions.includes(TAB_PERM[x]);
const isFull = () => adminPerms.value?.full ?? auth.user?.role === 'admin';
const tab = ref<Tab>((route.params.tab as Tab) || 'users');
watch(tab, (v) => router.replace(`/admin/${v}`));
const error = ref('');
const notice = ref('');

async function run(fn: () => Promise<unknown>, reload?: () => Promise<void>): Promise<void> {
  error.value = '';
  notice.value = '';
  try {
    await fn();
    if (reload) await reload();
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}

// ---- пользователи
interface U {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  adminRoleId?: string | null;
  disabled: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}
const users = ref<U[]>([]);
const loadUsers = async () => {
  users.value = await api('GET', '/admin/users');
};
const adminRoles = ref<{ id: string; name: string }[]>([]);
async function loadAdminRoles(): Promise<void> {
  if (!isFull()) return;
  const r = await api<{ roles: { id: string; name: string; scope: string }[] }>(
    'GET',
    '/admin/roles',
  );
  adminRoles.value = r.roles.filter((x) => x.scope === 'admin');
}
const patchUser = (u: U, body: object) =>
  run(() => api('PATCH', `/admin/users/${u.id}`, body), loadUsers);
const endSessions = (u: U) =>
  run(() => api('POST', `/admin/users/${u.id}/revoke-sessions`), loadUsers);

// ---- круги
interface C {
  id: string;
  name: string;
  description: string;
  members: number;
}
const circles = ref<C[]>([]);
const newCircle = ref({ name: '', description: '' });
const openCircle = ref<string | null>(null);
const circleMembers = ref<{ id: string; name: string; email: string }[]>([]);
const addUserId = ref('');
const loadCircles = async () => {
  circles.value = await api('GET', '/admin/circles');
};
const createCircle = () =>
  run(async () => {
    await api('POST', '/admin/circles', newCircle.value);
    newCircle.value = { name: '', description: '' };
  }, loadCircles);
const deleteCircle = (c: C) =>
  window.confirm(t('admin.confirmDelete')) &&
  run(() => api('DELETE', `/admin/circles/${c.id}`), loadCircles);
async function showCircle(c: C): Promise<void> {
  openCircle.value = openCircle.value === c.id ? null : c.id;
  if (openCircle.value) circleMembers.value = await api('GET', `/admin/circles/${c.id}/members`);
}
const addToCircle = () =>
  run(async () => {
    await api('PUT', `/admin/circles/${openCircle.value}/members/${addUserId.value}`);
    circleMembers.value = await api('GET', `/admin/circles/${openCircle.value}/members`);
    addUserId.value = '';
  }, loadCircles);
const removeFromCircle = (uid: string) =>
  run(async () => {
    await api('DELETE', `/admin/circles/${openCircle.value}/members/${uid}`);
    circleMembers.value = await api('GET', `/admin/circles/${openCircle.value}/members`);
  }, loadCircles);

const resetMfa = (u: { id: string }) =>
  window.confirm(t('admin.confirmDelete')) &&
  run(async () => {
    await api('POST', `/admin/users/${u.id}/mfa-reset`);
    notice.value = t('adminx.mfaReset');
  });

// ---- настройки
const settings = ref<Record<string, unknown>>({});
const rangeUrl = ref('');
const rangeResult = ref('');
const loadSettings = async () => {
  settings.value = await api('GET', '/admin/settings');
  rangeUrl.value = (await api<{ url: string }>('GET', '/admin/security/range')).url;
};
const saveSetting = (key: string, value: unknown) =>
  run(async () => {
    await api('PUT', '/admin/settings', { [key]: value });
    notice.value = t('admin.saved');
  }, loadSettings);
const testRange = () =>
  run(async () => {
    const r = await api<{ ok: boolean; reason?: string; lines?: number }>(
      'POST',
      '/admin/security/range/test',
      { url: rangeUrl.value },
    );
    rangeResult.value = r.ok
      ? t('admin.rangeOk', { n: r.lines ?? 0 })
      : t('admin.rangeFail', { r: r.reason ?? '' });
  });
const saveRange = () =>
  run(async () => {
    await api('PUT', '/admin/security/range', { url: rangeUrl.value });
    notice.value = t('admin.saved');
  }, loadSettings);

// ---- журнал
interface L {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
}
const ledger = ref<L[]>([]);
const next = ref<number | null>(null);
const filter = ref({ action: '', q: '', from: '', to: '' });
async function loadLedger(more = false): Promise<void> {
  const p = new URLSearchParams({ limit: '50' });
  if (filter.value.action) p.set('action', filter.value.action);
  if (filter.value.q) p.set('q', filter.value.q);
  if (filter.value.from) p.set('from', new Date(filter.value.from).toISOString());
  if (filter.value.to) p.set('to', new Date(filter.value.to + 'T23:59:59').toISOString());
  if (more && next.value) p.set('before', String(next.value));
  const r = await api<{ items: L[]; next: number | null }>('GET', `/admin/ledger?${p}`);
  ledger.value = more ? [...ledger.value, ...r.items] : r.items;
  next.value = r.next;
}
async function exportLedger(): Promise<void> {
  const p = new URLSearchParams({ limit: '500', format: 'csv' });
  if (filter.value.action) p.set('action', filter.value.action);
  const r = await api<{ csv: string }>('GET', `/admin/ledger?${p}`);
  const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'arklock-ledger.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function loadTab(): Promise<void> {
  error.value = '';
  try {
    if (tab.value === 'users') {
      await loadUsers();
      await loadAdminRoles();
    } else if (tab.value === 'circles') {
      await loadCircles();
      if (!users.value.length) await loadUsers();
    } else if (tab.value === 'settings') await loadSettings();
    else if (tab.value === 'ledger') await loadLedger();
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
/** Разделы панели по смыслу: люди, система, интеграции, безопасность. */
const GROUPS: { id: string; tabs: Tab[] }[] = [
  { id: 'people', tabs: ['users', 'circles', 'roles', 'invitations'] },
  {
    id: 'system',
    tabs: [
      'overview',
      'resources',
      'containers',
      'backups',
      'logs',
      'storage',
      'diagnostics',
      'certificates',
    ],
  },
  { id: 'integrations', tabs: ['ldap', 'sso', 'saml', 'smtp', 'syslog'] },
  { id: 'security', tabs: ['settings', 'ledger'] },
];
const ALL_TABS: Tab[] = [
  'users',
  'circles',
  'settings',
  'ledger',
  ...SYS_TABS,
  'ldap',
  'sso',
  'saml',
  'syslog',
  'invitations',
  'roles',
];
onMounted(async () => {
  try {
    adminPerms.value = await api('GET', '/auth/admin-perms');
  } catch {
    /* сервер всё равно проверяет каждый запрос */
  }
  if (!canTab(tab.value)) tab.value = ALL_TABS.find(canTab) ?? tab.value;
  else await loadTab();
});
watch(tab, loadTab);
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
</script>

<template>
  <section class="space-y-4">
    <h1>{{ t('admin.title') }}</h1>
    <div class="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[13.5rem_minmax(0,1fr)]">
      <nav class="md:sticky md:top-20 md:self-start" :aria-label="t('admin.title')">
        <div
          class="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:mx-0 md:block md:space-y-5 md:overflow-visible md:px-0 md:pb-0"
        >
          <div
            v-for="g in GROUPS"
            :key="g.id"
            class="flex shrink-0 items-center gap-1 md:block md:space-y-0.5"
          >
            <div
              class="hidden px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 md:block"
            >
              {{ t(`admin.group.${g.id}`) }}
            </div>
            <template v-for="x in g.tabs.filter(canTab)" :key="x">
              <button
                type="button"
                class="nav-link w-full whitespace-nowrap"
                :class="tab === x ? 'nav-link-active' : ''"
                :aria-current="tab === x ? 'page' : undefined"
                :data-testid="`admin-tab-${x}`"
                @click="tab = x"
              >
                <Icon :name="TAB_ICON[x] ?? 'settings'" class="size-4 opacity-80" />
                {{ t(`admin.tab.${x}`) }}
              </button>
            </template>
            <RouterLink
              v-if="g.id === 'system' && auth.user?.role === 'admin'"
              to="/admin/updates"
              class="nav-link w-full whitespace-nowrap"
              >{{ t('nav.updates') }}</RouterLink
            >
          </div>
        </div>
      </nav>
      <div class="min-w-0 space-y-4">
        <p
          v-if="error"
          class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          role="alert"
          data-testid="admin-error"
        >
          {{ error }}
        </p>
        <p
          v-if="notice"
          class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
          role="status"
        >
          {{ notice }}
        </p>

        <RolesPanel v-if="tab === 'roles'" />
        <InvitationsPanel v-else-if="tab === 'invitations'" />
        <SyslogSettings v-else-if="tab === 'syslog'" />
        <SsoSettings v-else-if="tab === 'sso'" />
        <SamlSettings v-else-if="tab === 'saml'" />
        <LdapSettings v-else-if="tab === 'ldap'" />
        <AdminSystem v-else-if="(SYS_TABS as string[]).includes(tab)" :section="tab as SysTab" />

        <div v-else-if="tab === 'users'" class="card overflow-x-auto">
          <table class="min-w-full text-sm" data-testid="users-table">
            <thead class="text-left text-xs text-slate-500">
              <tr>
                <th class="px-3 py-2">{{ t('common.name') }}</th>
                <th>{{ t('admin.role') }}</th>
                <th v-if="isFull() && adminRoles.length">{{ t('admin.adminRole') }}</th>
                <th>{{ t('admin.lastSeen') }}</th>
                <th>{{ t('admin.status') }}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="u in users"
                :key="u.id"
                class="border-t border-slate-200 dark:border-slate-800"
                data-testid="user-row"
              >
                <td class="px-3 py-2">
                  <div>{{ u.name }}</div>
                  <div class="text-xs text-slate-500">{{ u.email }}</div>
                </td>
                <td>
                  <select
                    :value="u.role"
                    class="input w-auto"
                    :disabled="u.id === auth.user?.id"
                    @change="patchUser(u, { role: ($event.target as HTMLSelectElement).value })"
                  >
                    <option value="admin">{{ t('admin.roleAdmin') }}</option>
                    <option value="member">{{ t('admin.roleMember') }}</option>
                  </select>
                </td>
                <td v-if="isFull() && adminRoles.length">
                  <select
                    :value="u.adminRoleId ?? ''"
                    class="input w-auto"
                    :disabled="u.role === 'admin'"
                    :data-testid="`admin-role-${u.email}`"
                    @change="
                      patchUser(u, {
                        adminRoleId: ($event.target as HTMLSelectElement).value || null,
                      })
                    "
                  >
                    <option value="">{{ t('admin.noAdminRole') }}</option>
                    <option v-for="r in adminRoles" :key="r.id" :value="r.id">{{ r.name }}</option>
                  </select>
                </td>
                <td class="text-xs">{{ fmt(u.lastSeenAt) }}</td>
                <td>
                  <span :class="u.disabled ? 'text-red-600' : 'text-emerald-600'">{{
                    u.disabled ? t('admin.disabled') : t('admin.active')
                  }}</span>
                </td>
                <td class="space-x-1 whitespace-nowrap px-3 text-right">
                  <button type="button" class="btn" @click="endSessions(u)">
                    {{ t('admin.endSessions') }}
                  </button>
                  <button
                    type="button"
                    class="btn"
                    :data-testid="`reset-mfa-${u.email}`"
                    @click="resetMfa(u)"
                  >
                    {{ t('adminx.resetMfa') }}
                  </button>
                  <button
                    type="button"
                    :class="u.disabled ? 'btn' : 'btn-danger'"
                    :disabled="u.id === auth.user?.id"
                    :data-testid="`toggle-${u.email}`"
                    @click="patchUser(u, { disabled: !u.disabled })"
                  >
                    {{ u.disabled ? t('admin.enable') : t('admin.disable') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else-if="tab === 'circles'" class="space-y-3">
          <form class="flex flex-wrap gap-2" @submit.prevent="createCircle">
            <input
              v-model="newCircle.name"
              required
              maxlength="100"
              class="input max-w-xs"
              :placeholder="t('common.name')"
              data-testid="circle-name"
            />
            <input
              v-model="newCircle.description"
              maxlength="500"
              class="input max-w-sm"
              :placeholder="t('admin.description')"
            />
            <button type="submit" class="btn-primary" data-testid="circle-create">
              {{ t('admin.create') }}
            </button>
          </form>
          <ul
            class="card divide-y divide-slate-200 text-sm dark:divide-slate-800"
            data-testid="circles-list"
          >
            <li v-for="c in circles" :key="c.id" class="px-3 py-2">
              <div class="flex items-center justify-between gap-2">
                <button
                  type="button"
                  class="min-w-0 truncate text-left font-medium"
                  :data-testid="`circle-${c.name}`"
                  @click="showCircle(c)"
                >
                  ◎ {{ c.name }}
                  <span class="text-xs text-slate-500"
                    >· {{ c.members }} {{ t('admin.membersN') }}</span
                  >
                </button>
                <button type="button" class="btn-danger" @click="deleteCircle(c)">
                  {{ t('common.delete') }}
                </button>
              </div>
              <div v-if="openCircle === c.id" class="mt-2 space-y-2">
                <ul class="text-xs">
                  <li v-for="m in circleMembers" :key="m.id" class="flex justify-between py-0.5">
                    {{ m.name }} ({{ m.email }})
                    <button type="button" class="text-red-600" @click="removeFromCircle(m.id)">
                      ×
                    </button>
                  </li>
                </ul>
                <div class="flex gap-2">
                  <select v-model="addUserId" class="input" data-testid="circle-add-user">
                    <option value="" disabled>…</option>
                    <option v-for="u in users" :key="u.id" :value="u.id">
                      {{ u.name }} ({{ u.email }})
                    </option></select
                  ><button
                    type="button"
                    class="btn"
                    :disabled="!addUserId"
                    data-testid="circle-add"
                    @click="addToCircle"
                  >
                    {{ t('settings.add') }}
                  </button>
                </div>
              </div>
            </li>
          </ul>
        </div>

        <div v-else-if="tab === 'settings'" class="space-y-6">
          <div class="card space-y-3 p-4 text-sm">
            <label class="flex items-center justify-between gap-3"
              >{{ t('admin.registration')
              }}<select
                :value="settings['registration.mode']"
                class="input w-auto"
                data-testid="set-registration"
                @change="
                  saveSetting('registration.mode', ($event.target as HTMLSelectElement).value)
                "
              >
                <option value="closed">{{ t('admin.closed') }}</option>
                <option value="open">{{ t('admin.open') }}</option>
              </select></label
            >
            <label class="flex items-center justify-between gap-3"
              >{{ t('admin.vaultCreators')
              }}<select
                :value="settings['vaults.creators']"
                class="input w-auto"
                data-testid="set-creators"
                @change="saveSetting('vaults.creators', ($event.target as HTMLSelectElement).value)"
              >
                <option value="admins">{{ t('admin.onlyAdmins') }}</option>
                <option value="members">{{ t('admin.allMembers') }}</option>
              </select></label
            >
            <label class="flex items-center justify-between gap-3"
              >{{ t('admin.trashDays')
              }}<input
                :value="settings['trash.retentionDays']"
                type="number"
                min="1"
                max="3650"
                class="input w-24"
                data-testid="set-trash"
                @change="
                  saveSetting(
                    'trash.retentionDays',
                    Number(($event.target as HTMLInputElement).value),
                  )
                "
            /></label>
            <label class="flex items-center justify-between gap-3"
              >{{ t('adminx.mfaRequired')
              }}<select
                :value="settings['security.mfaRequired']"
                class="input w-auto"
                data-testid="set-mfa"
                @change="
                  saveSetting('security.mfaRequired', ($event.target as HTMLSelectElement).value)
                "
              >
                <option value="off">{{ t('adminx.mfaOff') }}</option>
                <option value="admins">{{ t('adminx.mfaAdmins') }}</option>
                <option value="all">{{ t('adminx.mfaAll') }}</option>
              </select></label
            >
            <label class="flex items-center justify-between gap-3"
              >{{ t('admin.sessionIdle')
              }}<input
                :value="settings['session.idleHours']"
                type="number"
                min="0.25"
                max="720"
                step="0.25"
                class="input w-24"
                data-testid="set-session-idle"
                @change="
                  saveSetting(
                    'session.idleHours',
                    Number(($event.target as HTMLInputElement).value),
                  )
                "
            /></label>
            <label class="flex items-center justify-between gap-3"
              >{{ t('admin.sessionMax')
              }}<input
                :value="settings['session.maxHours']"
                type="number"
                min="0"
                max="8760"
                step="1"
                class="input w-24"
                data-testid="set-session-max"
                @change="
                  saveSetting('session.maxHours', Number(($event.target as HTMLInputElement).value))
                "
            /></label>

            <label class="flex items-center justify-between gap-3"
              >{{ t('policy.minLength')
              }}<input
                :value="settings['policy.password.minLength']"
                type="number"
                min="0"
                max="128"
                class="input w-24"
                data-testid="set-minlen"
                @change="
                  saveSetting(
                    'policy.password.minLength',
                    Number(($event.target as HTMLInputElement).value),
                  )
                "
            /></label>
            <label class="flex items-center justify-between gap-3"
              >{{ t('policy.classesLabel')
              }}<input
                :value="settings['policy.password.classes']"
                type="number"
                min="0"
                max="4"
                class="input w-24"
                data-testid="set-classes"
                @change="
                  saveSetting(
                    'policy.password.classes',
                    Number(($event.target as HTMLInputElement).value),
                  )
                "
            /></label>
            <label class="flex items-center justify-between gap-3"
              >{{ t('invite.notify')
              }}<input
                type="checkbox"
                :checked="settings['notifications.security'] !== false"
                data-testid="set-notify"
                @change="
                  saveSetting('notifications.security', ($event.target as HTMLInputElement).checked)
                "
            /></label>
            <label class="flex items-center justify-between gap-3"
              >{{ t('adminx.attachMax')
              }}<input
                :value="settings['storage.attachmentMaxMiB']"
                type="number"
                min="0"
                max="512"
                class="input w-24"
                data-testid="set-attach-max"
                @change="
                  saveSetting(
                    'storage.attachmentMaxMiB',
                    Number(($event.target as HTMLInputElement).value),
                  )
                "
            /></label>
            <label class="flex items-center justify-between gap-3"
              >{{ t('adminx.vaultQuota')
              }}<input
                :value="settings['storage.vaultQuotaMiB']"
                type="number"
                min="0"
                class="input w-24"
                data-testid="set-vault-quota"
                @change="
                  saveSetting(
                    'storage.vaultQuotaMiB',
                    Number(($event.target as HTMLInputElement).value),
                  )
                "
            /></label>
            <label class="flex items-center justify-between gap-3"
              >{{ t('admin.passwordMaxAge')
              }}<input
                :value="settings['security.passwordMaxAgeDays']"
                type="number"
                min="0"
                max="3650"
                class="input w-24"
                @change="
                  saveSetting(
                    'security.passwordMaxAgeDays',
                    Number(($event.target as HTMLInputElement).value),
                  )
                "
            /></label>
          </div>
          <div class="card space-y-2 p-4 text-sm">
            <h2 class="font-medium">{{ t('admin.rangeTitle') }}</h2>
            <p class="text-slate-500">{{ t('admin.rangeHint') }}</p>
            <input v-model="rangeUrl" class="input font-mono" data-testid="range-url" />
            <div class="flex gap-2">
              <button type="button" class="btn" data-testid="range-test" @click="testRange">
                {{ t('admin.test') }}</button
              ><button
                type="button"
                class="btn-primary"
                data-testid="range-save"
                @click="saveRange"
              >
                {{ t('common.save') }}
              </button>
            </div>
            <p v-if="rangeResult" data-testid="range-result">{{ rangeResult }}</p>
          </div>
        </div>

        <div v-else class="space-y-3">
          <form class="flex flex-wrap gap-2" @submit.prevent="loadLedger()">
            <input
              v-model="filter.action"
              class="input w-44"
              :placeholder="t('admin.actionPrefix')"
              data-testid="ledger-action"
            />
            <input v-model="filter.q" class="input w-44" :placeholder="t('vault.search')" />
            <input v-model="filter.from" type="date" class="input w-auto" /><input
              v-model="filter.to"
              type="date"
              class="input w-auto"
            />
            <button type="submit" class="btn" data-testid="ledger-apply">
              {{ t('admin.apply') }}
            </button>
            <button type="button" class="btn" data-testid="ledger-export" @click="exportLedger">
              CSV
            </button>
          </form>
          <div class="card overflow-x-auto">
            <table class="min-w-full text-xs" data-testid="ledger-table">
              <thead class="text-left text-slate-500">
                <tr>
                  <th class="px-3 py-2">{{ t('admin.time') }}</th>
                  <th>{{ t('admin.actor') }}</th>
                  <th>{{ t('admin.action') }}</th>
                  <th>{{ t('admin.target') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="l in ledger"
                  :key="l.id"
                  class="border-t border-slate-200 dark:border-slate-800"
                  data-testid="ledger-row"
                >
                  <td class="whitespace-nowrap px-3 py-1.5">{{ fmt(l.at) }}</td>
                  <td class="font-mono">{{ l.actor.slice(0, 13) }}</td>
                  <td>{{ l.action }}</td>
                  <td class="font-mono">{{ l.target }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <button v-if="next" type="button" class="btn" @click="loadLedger(true)">
            {{ t('admin.more') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
