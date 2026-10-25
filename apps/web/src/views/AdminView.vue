<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../services/api';
import { errorMessage, vaultLabel, when } from '../services/helpers';
import { useAuthStore } from '../stores/auth';
import AdminSystem from '../components/AdminSystem.vue';
import SortTh from '../components/SortTh.vue';
import DepartmentsPanel from '../components/DepartmentsPanel.vue';
import SetupChecklist from '../components/SetupChecklist.vue';
import { generatorFrom } from '../services/policy';
import { useWorkspaceStore } from '../stores/workspace';
import LdapSettings from '../components/LdapSettings.vue';
import SsoSettings from '../components/SsoSettings.vue';
import SyslogSettings from '../components/SyslogSettings.vue';
import UpdatesView from './UpdatesView.vue';
import WebhookSettings from '../components/WebhookSettings.vue';
import InvitationsPanel from '../components/InvitationsPanel.vue';
import Icon, { type IconName } from '../components/Icon.vue';
import ActionMenu, { type ActionItem } from '../components/ActionMenu.vue';
import ContextMenu from '../components/ContextMenu.vue';
import AutomationPanel from '../components/AutomationPanel.vue';
import { ledgerAction, ledgerTarget, type LedgerItem } from '../services/ledger';
import PersonalLockerSettings from '../components/PersonalLockerSettings.vue';
import InfoHint from '../components/InfoHint.vue';
import OffboardingPanel from '../components/OffboardingPanel.vue';
import UserProfilePanel from '../components/UserProfilePanel.vue';
import NetworkSettings from '../components/NetworkSettings.vue';
import OrganizationPanel from '../components/OrganizationPanel.vue';
import AdminCorporateRecovery from '../components/AdminCorporateRecovery.vue';

/** Значки разделов админки: по смыслу раздела, подпись остаётся для доступности и подсказки. */
/** Вкладки настроек: карточки разложены по разделам, как в образце настроек. */
type SettingsTab = 'main' | 'security' | 'storage' | 'notify' | 'network';
// раздел настроек открывается по ссылке ?section=… (например, из диагностики)
const settingsTab = ref<SettingsTab>(
  (['main', 'security', 'storage', 'notify', 'network'] as const).find(
    (x) => x === useRoute().query.section,
  ) ?? 'main',
);
const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'main', label: 'admin.settingsTab.main' },
  { id: 'security', label: 'admin.settingsTab.security' },
  { id: 'storage', label: 'admin.settingsTab.storage' },
  { id: 'notify', label: 'admin.settingsTab.notify' },
  { id: 'network', label: 'admin.settingsTab.network' },
];
const TAB_ICON: Record<string, IconName> = {
  overview: 'chart',
  organization: 'building',
  vaults: 'database',
  wizards: 'check',
  departments: 'folder',
  users: 'user',
  circles: 'users',
  roles: 'shield',
  invitations: 'user-plus',
  resources: 'cpu',
  containers: 'server',
  backups: 'database',
  logs: 'log',
  storage: 'file',
  diagnostics: 'pulse',
  certificates: 'certificate',
  ldap: 'idcard',
  sso: 'key',
  saml: 'lock',
  smtp: 'mail',
  syslog: 'text',
  webhooks: 'plug',
  updates: 'sync',
  settings: 'settings',
  ledger: 'log',
  automation: 'bell',
};
import WizardsPanel from '../components/WizardsPanel.vue';
import VaultsInventory from '../components/VaultsInventory.vue';
import ManagedVaultSettings from '../components/ManagedVaultSettings.vue';
import PersonPicker, { type Person } from '../components/PersonPicker.vue';
import RolesPanel from '../components/RolesPanel.vue';
import SamlSettings from '../components/SamlSettings.vue';

const { t, te } = useI18n();
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
  | 'webhooks'
  | 'invitations'
  | 'roles'
  | 'saml'
  | 'updates'
  | 'organization'
  | 'departments'
  | 'automation'
  | 'vaults'
  | 'wizards'
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
  organization: 'admin.users',
  departments: 'admin.circles',
  vaults: 'admin.users',
  wizards: 'admin.users',
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
  webhooks: 'admin.integrations',
  invitations: 'admin.invitations',
  roles: 'admin.roles',
  updates: 'admin.updates',
  automation: 'admin.settings',
};
const adminPerms = ref<{ full: boolean; permissions: string[] } | null>(null);
const canTab = (x: Tab) =>
  !adminPerms.value || adminPerms.value.full || adminPerms.value.permissions.includes(TAB_PERM[x]);
const isFull = () => adminPerms.value?.full ?? auth.user?.role === 'admin';
/**
 * Раздел берётся из адреса: F5 оставляет в нём, «Назад» и «Вперёд» переключают разделы,
 * а переход пишется в историю браузера (а не заменяет её).
 */
const tab = computed<Tab>({
  get: () => ((route.params.tab as Tab) || 'overview') as Tab,
  set: (v) => void router.push(`/admin/${v}`),
});
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
  chief?: boolean;
  adminRoleId?: string | null;
  disabled: boolean;
  /** Почему отключён: вручную, каталогом, при увольнении (null — не записано) */
  disabledReason?: 'manual' | 'directory' | 'offboarding' | 'expired' | null;
  accessUntil?: string | null;
  disabledNote?: string | null;
  /** Секунд до конца временной блокировки входа после неудачных попыток (0 — не заблокирован) */
  lockedFor?: number;
  createdAt: string;
  lastSeenAt: string | null;
  authSource?: string;
}
const users = ref<U[]>([]);
const userSearch = ref('');
const userStatus = ref('');
// роль: администратор, сотрудник или административная роль (делегирование)
const userRole = ref('');
// сортировка на сервере; по умолчанию — по имени
const userSort = ref<{ by: 'name' | 'seen'; dir: 'asc' | 'desc' }>({
  by: 'name',
  dir: 'asc',
});
function sortUsers(by: 'name' | 'seen'): void {
  const s = userSort.value;
  userSort.value =
    s.by === by
      ? { by, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { by, dir: by === 'seen' ? 'desc' : 'asc' };
}
// список страницами с сервера: в организации на десятки тысяч сотрудников целиком он не загружается
const USER_PAGE = 50;
const userPage = ref(0);
const userTotal = ref(0);
const visibleUsers = computed(() => users.value);
let userTimer: ReturnType<typeof setTimeout> | undefined;
const loadUsers = async () => {
  const { by, dir } = userSort.value;
  const q = new URLSearchParams({
    limit: String(USER_PAGE),
    offset: String(userPage.value * USER_PAGE),
    q: userSearch.value.trim(),
    sort: by,
    dir,
  });
  if (userStatus.value) q.set('status', userStatus.value);
  if (userRole.value) q.set('role', userRole.value);
  const r = await api<{ items: U[]; total: number }>('GET', `/admin/users?${q}`);
  users.value = r.items;
  userTotal.value = r.total;
};
// смена отбора возвращает на первую страницу; ввод в поиск ждёт паузы, чтобы не нагружать сервер
watch([userSearch, userStatus, userRole, userSort], () => {
  userPage.value = 0;
  picked.value = new Set();
  clearTimeout(userTimer);
  userTimer = setTimeout(() => void run(loadUsers), 250);
});
function userPageBy(n: number): void {
  userPage.value += n;
  picked.value = new Set();
  void run(loadUsers);
}
onBeforeUnmount(() => clearTimeout(userTimer));
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
  run(async () => {
    try {
      await api('PATCH', `/admin/users/${u.id}`, body);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'corporate_access_at_risk')) throw e;
      const risks = (e.details as { vaults: { name: string | null; id: string }[] }).vaults;
      if (window.confirm(`${t('corporate.risk')}\n${risks.map((v) => v.name ?? v.id).join('\n')}`))
        await api('PATCH', `/admin/users/${u.id}`, { ...body, acknowledgeAccessRisk: true });
    }
  }, loadUsers);
// отключение спрашивает пояснение: оно остаётся в карточке и в списке (отмена — ничего не делать)
function setDisabled(u: U, disabled: boolean): void {
  if (!disabled) {
    void patchUser(u, { disabled: false });
    return;
  }
  const note = window.prompt(t('admin.disableNote', { name: u.name }), '');
  if (note === null) return;
  void patchUser(u, { disabled: true, disabledNote: note.trim() });
}
// массовое включение и отключение: по одному запросу на сотрудника, итог — общим сообщением
const picked = ref<Set<string>>(new Set());
const bulkBusy = ref(false);
const pickable = (u: U) => u.id !== auth.user?.id && !u.chief;
const pickedUsers = computed(() => visibleUsers.value.filter((u) => picked.value.has(u.id)));
function togglePick(u: U): void {
  const next = new Set(picked.value);
  if (next.has(u.id)) next.delete(u.id);
  else next.add(u.id);
  picked.value = next;
}
const allPicked = computed(
  () =>
    visibleUsers.value.filter(pickable).length > 0 &&
    visibleUsers.value.filter(pickable).every((u) => picked.value.has(u.id)),
);
function pickAll(): void {
  picked.value = allPicked.value
    ? new Set()
    : new Set(visibleUsers.value.filter(pickable).map((u) => u.id));
}
async function bulkStatus(disabled: boolean): Promise<void> {
  const list = pickedUsers.value.filter((u) => u.disabled !== disabled);
  if (!list.length) return;
  let note = '';
  if (disabled) {
    const answer = window.prompt(t('admin.bulkDisableNote', { n: list.length }), '');
    if (answer === null) return;
    note = answer.trim();
  }
  bulkBusy.value = true;
  error.value = '';
  const failed: string[] = [];
  for (const u of list) {
    try {
      await api('PATCH', `/admin/users/${u.id}`, {
        disabled,
        ...(disabled ? { disabledNote: note } : {}),
      });
    } catch (e) {
      failed.push(`${u.name}: ${errorMessage(e, t)}`);
    }
  }
  bulkBusy.value = false;
  picked.value = new Set();
  notice.value = t('admin.bulkDone', { n: list.length - failed.length });
  if (failed.length) error.value = failed.join('\n');
  await loadUsers();
}
const offboarding = ref<U | null>(null);
const profileOf = ref<U | null>(null);
const endSessions = (u: U) =>
  run(() => api('POST', `/admin/users/${u.id}/revoke-sessions`), loadUsers);

// ---- круги
interface C {
  id: string;
  name: string;
  description: string;
  adminRoleId?: string | null;
  members: number;
}
const circles = ref<C[]>([]);
const circleSearch = ref('');
const visibleCircles = computed(() =>
  circles.value.filter((c) =>
    `${c.name} ${c.description}`.toLowerCase().includes(circleSearch.value.toLowerCase()),
  ),
);
const editingCircle = ref<C | null>(null);
const groupPick = ref<Person[]>([]);
const selectedMembers = ref<string[]>([]);
const assignedVaults = ref<
  {
    id: string;
    name: string;
    role: string;
    customRoleId: string | null;
    expiresAt: string | null;
  }[]
>([]);
const newCircle = ref({ name: '', description: '' });
const openCircle = ref<string | null>(null);
const circleMembers = ref<{ id: string; name: string; email: string }[]>([]);
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
  selectedMembers.value = [];
  groupPick.value = [];
  if (openCircle.value)
    [circleMembers.value, assignedVaults.value] = await Promise.all([
      api<typeof circleMembers.value>('GET', `/admin/circles/${c.id}/members`),
      api<typeof assignedVaults.value>('GET', `/admin/circles/${c.id}/vaults`),
    ]);
}
const updateCircle = () =>
  run(async () => {
    if (!editingCircle.value) return;
    await api('PATCH', `/admin/circles/${editingCircle.value.id}`, {
      name: editingCircle.value.name,
      description: editingCircle.value.description,
    });
    editingCircle.value = null;
  }, loadCircles);
const updateGroupMembers = (action: 'add' | 'remove') =>
  run(async () => {
    await api('PATCH', `/admin/circles/${openCircle.value}/members`, {
      [action]: action === 'add' ? groupPick.value.map((p) => p.id) : selectedMembers.value,
    });
    circleMembers.value = await api('GET', `/admin/circles/${openCircle.value}/members`);
    groupPick.value = [];
    selectedMembers.value = [];
  }, loadCircles);
const removeFromCircle = (uid: string) =>
  run(async () => {
    await api('DELETE', `/admin/circles/${openCircle.value}/members/${uid}`);
    circleMembers.value = await api('GET', `/admin/circles/${openCircle.value}/members`);
  }, loadCircles);

// действия со строкой — в меню «⋯» и по правой кнопке: строка таблицы не растёт на ноутбуке
const userActions = (u: U): ActionItem[] => [
  {
    id: 'sessions',
    label: t('admin.endSessions'),
    icon: 'logout',
    testid: `end-sessions-${u.email}`,
  },
  { id: 'mfa', label: t('adminx.resetMfa'), icon: 'key', testid: `reset-mfa-${u.email}` },
  ...(u.lockedFor
    ? [
        {
          id: 'unlock',
          label: t('admin.unlock'),
          icon: 'lock' as const,
          testid: `unlock-${u.email}`,
        },
      ]
    : []),
  ...(u.id !== auth.user?.id && !u.chief
    ? [
        {
          id: 'toggle',
          label: u.disabled ? t('admin.enable') : t('admin.disable'),
          icon: 'lock' as const,
          danger: !u.disabled,
          testid: `toggle-${u.email}`,
        },
      ]
    : []),
  ...(!u.disabled && !u.chief && u.id !== auth.user?.id && (isFull() || u.role !== 'admin')
    ? [
        {
          id: 'offboard',
          label: t('admin.offboard'),
          icon: 'user' as const,
          danger: true,
          testid: `offboard-${u.email}`,
        },
      ]
    : []),
];
function onUserAction(u: U, id: string): void {
  if (id === 'sessions') void endSessions(u);
  else if (id === 'mfa') void resetMfa(u);
  else if (id === 'toggle') setDisabled(u, !u.disabled);
  else if (id === 'unlock') void run(() => api('POST', `/admin/users/${u.id}/unlock`), loadUsers);
  else if (id === 'offboard') offboarding.value = u;
}
const userMenu = ref<{ x: number; y: number; u: U } | null>(null);
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
const rangeList = () =>
  rangeUrl.value
    .split('\n')
    .map((u) => u.trim())
    .filter(Boolean);
const loadSettings = async () => {
  settings.value = await api('GET', '/admin/settings');
  rangeUrl.value = (await api<{ urls: string[] }>('GET', '/admin/security/range')).urls.join('\n');
};
const saveSetting = (key: string, value: unknown) =>
  run(async () => {
    await api('PUT', '/admin/settings', { [key]: value });
    // свой генератор администратор видит сразу, остальные — при следующей загрузке сейфов
    if (key.startsWith('generator.'))
      useWorkspaceStore().generator = generatorFrom({ ...settings.value, [key]: value });
    notice.value = t('admin.saved');
  }, loadSettings);
const testRange = () =>
  run(async () => {
    const out: string[] = [];
    for (const url of rangeList()) {
      const r = await api<{ ok: boolean; reason?: string; lines?: number }>(
        'POST',
        '/admin/security/range/test',
        { url },
      );
      out.push(
        `${url}: ${r.ok ? t('admin.rangeOk', { n: r.lines ?? 0 }) : t('admin.rangeFail', { r: r.reason ?? '' })}`,
      );
    }
    rangeResult.value = out.join('\n');
  });
const saveRange = () =>
  run(async () => {
    await api('PUT', '/admin/security/range', { urls: rangeList() });
    notice.value = t('admin.saved');
  }, loadSettings);

// ---- журнал
type L = LedgerItem;
// категории журнала — начала кодов действий (сервер фильтрует по началу)
const LEDGER_KINDS = [
  '',
  'auth.',
  'entry.',
  'entry.client.',
  'vault.',
  'grant.',
  'space.',
  'admin.',
] as const;
const targetText = (l: L) => ledgerTarget(l, t, te);
const actionText = (a: string) => ledgerAction(a, t, te);
// генератор организации: последний включённый класс символов выключить нельзя — генератору не из чего строить пароль
const GEN_CLASSES = ['lower', 'upper', 'digits', 'symbols'] as const;
const genClassesOn = computed(
  () => GEN_CLASSES.filter((c) => settings.value[`generator.${c}`] !== false).length,
);
// срок хранения журнала: готовые значения и текущее, если его задали через API (например, 30 дней)
const ledgerKeepOptions = computed(() => {
  const cur = Number(settings.value['ledger.retentionDays'] ?? 0);
  return [...new Set([0, 90, 180, 365, 730, 1825, cur])].sort(
    (a, b) => (a || Infinity) - (b || Infinity),
  );
});
const ledger = ref<L[]>([]);
const next = ref<number | string | null>(null);
// сортировка — на сервере: страницы «показать ещё» продолжают тот же порядок
const ledgerSort = ref<{ by: 'at' | 'action'; dir: 'desc' | 'asc' }>({ by: 'at', dir: 'desc' });
function sortLedger(by: 'at' | 'action'): void {
  const s = ledgerSort.value;
  ledgerSort.value =
    s.by === by
      ? { by, dir: s.dir === 'desc' ? 'asc' : 'desc' }
      : { by, dir: by === 'at' ? 'desc' : 'asc' };
  void loadLedger();
}

const filter = ref({ action: '', q: '', from: '', to: '' });
// журнал одного сотрудника открывается из его карточки: /admin/ledger?user=…&name=…
const ledgerUser = computed(() =>
  typeof route.query.user === 'string'
    ? { id: route.query.user, name: typeof route.query.name === 'string' ? route.query.name : '' }
    : null,
);
// переход из карточки сотрудника начинает с чистого отбора: прежний поиск сузил бы его журнал
watch(ledgerUser, (u) => {
  if (u) filter.value = { action: '', q: '', from: '', to: '' };
  if (tab.value === 'ledger') void loadLedger();
});
// одни и те же условия для списка и выгрузки: CSV должен содержать то, что видно на экране
function ledgerParams(extra: Record<string, string>): URLSearchParams {
  const p = new URLSearchParams(extra);
  if (filter.value.action) p.set('action', filter.value.action);
  if (filter.value.q) p.set('q', filter.value.q);
  if (filter.value.from) p.set('from', new Date(filter.value.from).toISOString());
  if (filter.value.to) p.set('to', new Date(filter.value.to + 'T23:59:59').toISOString());
  if (ledgerUser.value) p.set('user', ledgerUser.value.id);
  if (ledgerSort.value.by !== 'at') p.set('sort', ledgerSort.value.by);
  if (ledgerSort.value.dir !== 'desc') p.set('dir', ledgerSort.value.dir);
  return p;
}
async function loadLedger(more = false): Promise<void> {
  const p = ledgerParams({ limit: '50' });
  if (more && next.value) p.set('before', String(next.value));
  const r = await api<{ items: L[]; next: number | string | null }>('GET', `/admin/ledger?${p}`);
  ledger.value = more ? [...ledger.value, ...r.items] : r.items;
  next.value = r.next;
}
async function exportLedger(): Promise<void> {
  const r = await api<{ csv: string }>(
    'GET',
    `/admin/ledger?${ledgerParams({ limit: '500', format: 'csv' })}`,
  );
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
    } else if (tab.value === 'settings') await loadSettings();
    else if (tab.value === 'ledger') await loadLedger();
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
/**
 * Меню в два уровня: крупные разделы по задаче администратора и пункты внутри. Пункт настроек может вести
 * в конкретный раздел страницы настроек (section), поэтому адрес сети, почта и политики безопасности найдутся
 * там, где их ищут, а не среди пользователей.
 */
interface NavItem {
  id: string;
  tab: Tab;
  section?: SettingsTab;
  icon: IconName;
  label: string;
}
const nav = (tab: Tab, section?: SettingsTab, icon?: IconName): NavItem => ({
  id: section && section !== 'main' ? `settings-${section}` : tab,
  tab,
  section,
  icon: icon ?? TAB_ICON[tab] ?? 'settings',
  label: section ? `admin.settingsTab.${section}` : `admin.tab.${tab}`,
});
const GROUPS: { id: string; items: NavItem[] }[] = [
  { id: 'overview', items: [nav('overview'), nav('organization')] },
  {
    id: 'people',
    items: [nav('wizards'), nav('users'), nav('invitations'), nav('departments'), nav('circles')],
  },
  { id: 'vaultsGroup', items: [nav('vaults')] },
  {
    id: 'security',
    items: [nav('settings', 'security', 'shield'), nav('roles'), nav('automation'), nav('ledger')],
  },
  {
    id: 'system',
    items: [
      nav('resources'),
      nav('containers'),
      nav('diagnostics'),
      nav('certificates'),
      nav('logs'),
      nav('updates'),
    ],
  },
  {
    id: 'storage',
    items: [nav('backups'), nav('storage'), nav('settings', 'storage', 'file')],
  },
  {
    id: 'integrations',
    items: [nav('ldap'), nav('sso'), nav('saml'), nav('smtp'), nav('syslog'), nav('webhooks')],
  },
  {
    id: 'server',
    items: [
      nav('settings', 'main', 'settings'),
      nav('settings', 'network', 'globe'),
      nav('settings', 'notify', 'bell'),
    ],
  },
];
const isActive = (i: NavItem) =>
  tab.value === i.tab && (i.tab !== 'settings' || (i.section ?? 'main') === settingsTab.value);
const visibleItems = (g: { items: NavItem[] }) => g.items.filter((i) => canTab(i.tab));
// группы раскрыты; свёрнутые администратором запоминаются
const NAV_KEY = 'arklock.admin.nav';
const readNav = (): { open: Record<string, boolean>; rail: boolean } => {
  try {
    return JSON.parse(localStorage.getItem(NAV_KEY) ?? '') as {
      open: Record<string, boolean>;
      rail: boolean;
    };
  } catch {
    return { open: {}, rail: false };
  }
};
const navState = ref(readNav());
const saveNav = () => {
  try {
    localStorage.setItem(NAV_KEY, JSON.stringify(navState.value));
  } catch {
    /* без хранилища меню просто не запоминает выбор */
  }
};
const groupOpen = (g: { id: string; items: NavItem[] }) => navState.value.open[g.id] ?? true;
function toggleGroup(g: { id: string; items: NavItem[] }): void {
  navState.value = { ...navState.value, open: { ...navState.value.open, [g.id]: !groupOpen(g) } };
  saveNav();
}
function toggleRail(): void {
  navState.value = { ...navState.value, rail: !navState.value.rail };
  saveNav();
}
function go(i: NavItem): void {
  void router.push(
    i.section ? { path: `/admin/${i.tab}`, query: { section: i.section } } : `/admin/${i.tab}`,
  );
}
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
  'webhooks',
  'invitations',
  'roles',
  'updates',
  'organization',
  'departments',
  'automation',
  'vaults',
  'wizards',
];
onMounted(async () => {
  try {
    adminPerms.value = await api('GET', '/auth/admin-perms');
  } catch {
    /* сервер всё равно проверяет каждый запрос */
  }
  if (!canTab(tab.value)) void router.replace(`/admin/${ALL_TABS.find(canTab) ?? 'users'}`);
  else await loadTab();
  showActiveTab();
});
// на телефоне меню — горизонтальная полоса: активный раздел не должен оставаться за краем
const showActiveTab = () =>
  void nextTick(() =>
    document
      .querySelector('[data-nav-active="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
  );
watch(tab, () => {
  void loadTab();
  showActiveTab();
});
watch(
  () => [route.params.tab, route.query.section] as const,
  ([, sec]) => {
    settingsTab.value = SETTINGS_TABS.find((x) => x.id === sec)?.id ?? 'main';
  },
);
const fmt = (iso: string | null) => (iso ? when(iso) : '—');
</script>

<template>
  <section class="space-y-4">
    <h1>{{ t('admin.title') }}</h1>
    <div
      class="grid grid-cols-[minmax(0,1fr)] gap-4"
      :class="
        navState.rail ? 'md:grid-cols-[3rem_minmax(0,1fr)]' : 'md:grid-cols-[13.5rem_minmax(0,1fr)]'
      "
    >
      <!-- меню не выше видимой части экрана: иначе прокрутка к активному разделу сдвигает всю страницу -->
      <nav
        class="md:sticky md:top-16 md:max-h-[calc(100dvh-8.25rem)] md:self-start md:overflow-y-auto md:pr-1"
        :aria-label="t('admin.title')"
        data-testid="admin-nav"
      >
        <button
          type="button"
          class="nav-link mb-1 hidden w-full text-slate-500 md:inline-flex"
          :aria-expanded="!navState.rail"
          :title="navState.rail ? t('admin.navExpand') : t('admin.navCollapse')"
          :aria-label="navState.rail ? t('admin.navExpand') : t('admin.navCollapse')"
          data-testid="admin-nav-rail"
          @click="toggleRail"
        >
          <Icon name="all" class="size-4 opacity-80" />
          <span v-if="!navState.rail">{{ t('admin.navCollapse') }}</span>
        </button>
        <div
          class="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:mx-0 md:block md:space-y-1 md:overflow-visible md:px-0 md:pb-0"
        >
          <div
            v-for="g in GROUPS.filter((x) => visibleItems(x).length)"
            :key="g.id"
            class="flex shrink-0 items-center gap-1 md:block md:space-y-0.5"
            :data-testid="`admin-group-${g.id}`"
          >
            <button
              type="button"
              class="hidden w-full items-start justify-between gap-1 rounded-md px-2.5 pb-0.5 pt-1 text-left text-[11px] font-semibold uppercase leading-tight tracking-wider text-slate-500 hover:text-slate-800 md:flex dark:hover:text-slate-200"
              :class="
                navState.rail ? 'md:border-t md:border-slate-200 md:dark:border-slate-800' : ''
              "
              :aria-expanded="groupOpen(g)"
              :data-testid="`admin-group-toggle-${g.id}`"
              @click="toggleGroup(g)"
            >
              <span :class="navState.rail ? 'sr-only' : ''">{{ t(`admin.group.${g.id}`) }}</span>
              <span v-if="!navState.rail" aria-hidden="true">{{ groupOpen(g) ? '▾' : '▸' }}</span>
            </button>
            <template v-for="x in visibleItems(g)" :key="x.id">
              <button
                type="button"
                class="nav-link w-full whitespace-nowrap md:whitespace-normal md:text-left"
                :class="[isActive(x) ? 'nav-link-active' : '', groupOpen(g) ? '' : 'md:hidden']"
                :aria-current="isActive(x) ? 'page' : undefined"
                :data-nav-active="isActive(x)"
                :title="t(x.label)"
                :data-testid="`admin-tab-${x.id}`"
                @click="go(x)"
              >
                <Icon :name="x.icon" class="size-4 shrink-0 opacity-80" />
                <span :class="navState.rail ? 'md:sr-only' : ''">{{ t(x.label) }}</span>
              </button>
            </template>
          </div>
          <div class="flex shrink-0 items-center gap-1 md:block md:space-y-0.5">
            <div
              class="hidden px-2.5 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 md:block"
              :class="navState.rail ? 'md:sr-only' : ''"
            >
              {{ t('admin.group.data') }}
            </div>
            <RouterLink
              to="/transfer?tab=export"
              class="nav-link w-full whitespace-nowrap md:whitespace-normal md:text-left"
              :title="t('transfer.title')"
              data-testid="admin-tab-transfer"
            >
              <Icon name="transfer" class="size-4 shrink-0 opacity-80" />
              <span :class="navState.rail ? 'md:sr-only' : ''">{{ t('transfer.title') }}</span>
            </RouterLink>
          </div>
        </div>
      </nav>
      <div class="min-w-0 space-y-4">
        <SetupChecklist v-if="tab === 'overview' && isFull()" />
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

        <AutomationPanel v-if="tab === 'automation'" />
        <RolesPanel v-else-if="tab === 'roles'" />
        <InvitationsPanel v-else-if="tab === 'invitations'" />
        <SyslogSettings v-else-if="tab === 'syslog'" />
        <UpdatesView v-else-if="tab === 'updates'" />
        <OrganizationPanel v-else-if="tab === 'organization'" />
        <VaultsInventory v-else-if="tab === 'vaults'" />
        <WizardsPanel v-else-if="tab === 'wizards'" />
        <DepartmentsPanel v-else-if="tab === 'departments'" />
        <WebhookSettings v-else-if="tab === 'webhooks'" />
        <SsoSettings v-else-if="tab === 'sso'" />
        <SamlSettings v-else-if="tab === 'saml'" />
        <LdapSettings v-else-if="tab === 'ldap'" />
        <AdminSystem v-else-if="(SYS_TABS as string[]).includes(tab)" :section="tab as SysTab" />

        <div v-else-if="tab === 'users'" class="card overflow-x-auto">
          <div class="flex flex-wrap gap-2 p-3">
            <input
              v-model="userSearch"
              type="search"
              class="input max-w-sm"
              :aria-label="t('corporate.findUsers')"
              :placeholder="t('corporate.findUsers')"
              data-testid="admin-user-search"
            />
            <select v-model="userStatus" class="input w-auto" :aria-label="t('admin.status')">
              <option value="">{{ t('corporate.allStatuses') }}</option>
              <option value="active">{{ t('admin.active') }}</option>
              <option value="disabled">{{ t('admin.disabled') }}</option>
            </select>
            <select
              v-model="userRole"
              class="input w-auto max-w-full"
              :aria-label="t('admin.role')"
              data-testid="users-role-filter"
            >
              <option value="">{{ t('admin.allRoles') }}</option>
              <option value="admin">{{ t('admin.roleAdmin') }}</option>
              <option value="member">{{ t('admin.roleMember') }}</option>
              <option v-for="r in adminRoles" :key="r.id" :value="`role:${r.id}`">
                {{ r.name }}
              </option>
            </select>
          </div>
          <UserProfilePanel
            v-if="profileOf && !offboarding"
            :key="profileOf.id"
            :user-id="profileOf.id"
            :admin-roles="adminRoles"
            :can-ledger="canTab('ledger')"
            @close="profileOf = null"
            @offboard="((offboarding = profileOf), (profileOf = null))"
            @changed="loadUsers"
          />
          <OffboardingPanel
            v-if="offboarding"
            :key="offboarding.id"
            :user="{ id: offboarding.id, name: offboarding.name }"
            :is-full="isFull()"
            @close="offboarding = null"
            @done="loadUsers"
          />
          <div
            v-if="pickedUsers.length"
            class="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
            data-testid="users-bulk"
          >
            <span>{{ t('admin.picked', { n: pickedUsers.length }) }}</span>
            <button
              type="button"
              class="btn-danger"
              :disabled="bulkBusy"
              data-testid="users-bulk-disable"
              @click="bulkStatus(true)"
            >
              {{ t('admin.disable') }}
            </button>
            <button
              type="button"
              class="btn"
              :disabled="bulkBusy"
              data-testid="users-bulk-enable"
              @click="bulkStatus(false)"
            >
              {{ t('admin.enable') }}
            </button>
            <button type="button" class="btn-ghost" @click="picked = new Set()">
              {{ t('common.cancel') }}
            </button>
          </div>
          <table class="min-w-full text-sm" data-testid="users-table">
            <thead class="text-left text-xs text-slate-500">
              <tr>
                <th class="w-8 pl-3">
                  <input
                    type="checkbox"
                    :checked="allPicked"
                    :aria-label="t('admin.pickAll')"
                    data-testid="users-pick-all"
                    @change="pickAll"
                  />
                </th>
                <SortTh
                  class="px-3 py-2"
                  :label="t('common.name')"
                  :dir="userSort.by === 'name' ? userSort.dir : null"
                  testid="users-sort-name"
                  @sort="sortUsers('name')"
                />
                <th>{{ t('admin.role') }}</th>
                <th v-if="isFull() && adminRoles.length">{{ t('admin.adminRole') }}</th>
                <SortTh
                  :label="t('admin.lastSeen')"
                  :dir="userSort.by === 'seen' ? userSort.dir : null"
                  testid="users-sort-seen"
                  @sort="sortUsers('seen')"
                />
                <th>{{ t('admin.status') }}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="u in visibleUsers"
                :key="u.id"
                class="border-t border-slate-200 dark:border-slate-800"
                data-testid="user-row"
                @contextmenu.prevent="userMenu = { x: $event.clientX, y: $event.clientY, u }"
              >
                <td class="w-8 pl-3">
                  <input
                    v-if="pickable(u)"
                    type="checkbox"
                    :checked="picked.has(u.id)"
                    :aria-label="u.name"
                    :data-testid="`user-pick-${u.email}`"
                    @change="togglePick(u)"
                  />
                </td>
                <td class="px-3 py-2">
                  <button
                    type="button"
                    class="text-left font-medium hover:text-brand-600 hover:underline"
                    :data-testid="`profile-open-${u.email}`"
                    @click="((offboarding = null), (profileOf = u))"
                  >
                    {{ u.name }}
                  </button>
                  <span v-if="u.chief" class="badge ml-1" data-testid="chief-badge">{{
                    t('chief.badge')
                  }}</span>
                  <div class="text-xs text-slate-500">{{ u.email }}</div>
                  <div class="text-xs text-slate-500">{{ u.authSource ?? 'local' }}</div>
                </td>
                <td>
                  <select
                    :value="u.role"
                    class="input w-auto"
                    :disabled="u.id === auth.user?.id || u.chief || !auth.user?.chief"
                    :title="auth.user?.chief ? undefined : t('chief.onlyChief')"
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
                  <span
                    v-if="!u.disabled && u.lockedFor"
                    class="block text-xs text-amber-700 dark:text-amber-300"
                    data-testid="user-locked"
                    >{{ t('admin.lockedFor', { m: Math.ceil(u.lockedFor / 60) }) }}</span
                  >
                  <span
                    v-if="!u.disabled && u.accessUntil"
                    class="block text-xs text-amber-700 dark:text-amber-300"
                    data-testid="user-access-until"
                    >{{ t('admin.accessUntilShort', { at: when(u.accessUntil) }) }}</span
                  >
                  <span
                    v-if="u.disabled && u.disabledReason"
                    class="block text-xs text-slate-500"
                    :title="u.disabledNote ?? ''"
                    data-testid="user-disabled-reason"
                    >{{ t(`admin.disabledBy.${u.disabledReason}`)
                    }}<template v-if="u.disabledNote">: {{ u.disabledNote }}</template></span
                  >
                </td>
                <td class="px-3 text-right">
                  <ActionMenu
                    :title="`${t('admin.userActions')}: ${u.name}`"
                    :items="userActions(u)"
                    :data-testid="`user-actions-${u.email}`"
                    @select="(id) => onUserAction(u, id)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
          <div
            class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-800"
            data-testid="users-pager"
          >
            <span data-testid="users-range">{{
              t('admin.pageRange', {
                from: userTotal ? userPage * USER_PAGE + 1 : 0,
                to: Math.min(userTotal, (userPage + 1) * USER_PAGE),
                total: userTotal,
              })
            }}</span>
            <span class="flex gap-1">
              <button
                type="button"
                class="btn"
                :disabled="userPage === 0"
                data-testid="users-prev"
                @click="userPageBy(-1)"
              >
                {{ t('admin.pagePrev') }}
              </button>
              <button
                type="button"
                class="btn"
                :disabled="(userPage + 1) * USER_PAGE >= userTotal"
                data-testid="users-next"
                @click="userPageBy(1)"
              >
                {{ t('admin.pageNext') }}
              </button>
            </span>
          </div>
        </div>

        <div v-else-if="tab === 'circles'" class="space-y-3">
          <input
            v-model="circleSearch"
            type="search"
            class="input max-w-sm"
            :aria-label="t('corporate.findGroups')"
            :placeholder="t('corporate.findGroups')"
            data-testid="admin-group-search"
          />
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
            <li v-for="c in visibleCircles" :key="c.id" class="px-3 py-2">
              <div class="flex items-center justify-between gap-2">
                <button
                  type="button"
                  class="min-w-0 truncate text-left font-medium"
                  :data-testid="`circle-${c.name}`"
                  @click="run(() => showCircle(c))"
                >
                  ◎ {{ c.name }}
                  <span class="text-xs text-slate-500"
                    >· {{ c.members }} {{ t('admin.membersN') }}</span
                  >
                </button>
                <span v-if="isFull() && adminRoles.length" class="inline-flex items-center gap-1">
                  <select
                    :value="c.adminRoleId ?? ''"
                    class="input w-auto"
                    :aria-label="`${t('admin.adminRole')}: ${c.name}`"
                    :data-testid="`circle-admin-role-${c.name}`"
                    @change="
                      run(async () => {
                        await api('PATCH', `/admin/circles/${c.id}`, {
                          adminRoleId: ($event.target as HTMLSelectElement).value || null,
                        });
                        await loadCircles();
                      })
                    "
                  >
                    <option value="">{{ t('admin.noAdminRole') }}</option>
                    <option v-for="r in adminRoles" :key="r.id" :value="r.id">{{ r.name }}</option>
                  </select>
                  <InfoHint
                    :text="t('hint.groupAdminRole.text')"
                    :details="t('hint.groupAdminRole.details')"
                  />
                </span>
                <button
                  type="button"
                  class="btn"
                  :aria-label="`${t('vault.rename')}: ${c.name}`"
                  @click="editingCircle = { ...c }"
                >
                  {{ t('vault.rename') }}
                </button>
                <button type="button" class="btn-danger" @click="deleteCircle(c)">
                  {{ t('common.delete') }}
                </button>
              </div>
              <form
                v-if="editingCircle?.id === c.id"
                class="my-2 flex flex-wrap gap-2"
                @submit.prevent="updateCircle"
              >
                <input
                  v-model="editingCircle.name"
                  required
                  maxlength="100"
                  class="input"
                  :aria-label="t('common.name')"
                />
                <input
                  v-model="editingCircle.description"
                  maxlength="500"
                  class="input"
                  :aria-label="t('admin.description')"
                />
                <button type="submit" class="btn-primary">{{ t('common.save') }}</button
                ><button type="button" class="btn" @click="editingCircle = null">
                  {{ t('common.cancel') }}
                </button>
              </form>
              <div v-if="openCircle === c.id" class="mt-2 space-y-2">
                <ul class="text-xs">
                  <li v-for="m in circleMembers" :key="m.id" class="flex justify-between py-0.5">
                    <label class="flex items-center gap-2"
                      ><input v-model="selectedMembers" :value="m.id" type="checkbox" />{{
                        m.name
                      }}
                      ({{ m.email }})</label
                    >
                    <button
                      type="button"
                      class="text-red-600"
                      :aria-label="`${t('common.delete')}: ${m.name}`"
                      @click="removeFromCircle(m.id)"
                    >
                      ×
                    </button>
                  </li>
                </ul>
                <button
                  v-if="selectedMembers.length"
                  type="button"
                  class="btn-danger"
                  @click="updateGroupMembers('remove')"
                >
                  {{ t('corporate.removeSelected') }} ({{ selectedMembers.length }})
                </button>
                <div class="space-y-1">
                  <PersonPicker
                    v-model="groupPick"
                    multiple
                    :exclude="circleMembers.map((m) => m.id)"
                    :placeholder="t('corporate.addSeveral')"
                    testid="circle-add-user"
                  />
                  <button
                    type="button"
                    class="btn"
                    :disabled="!groupPick.length"
                    data-testid="circle-add"
                    @click="updateGroupMembers('add')"
                  >
                    {{ t('settings.add')
                    }}<span v-if="groupPick.length"> ({{ groupPick.length }})</span>
                  </button>
                </div>
                <div class="space-y-1 text-xs">
                  <h3 class="font-medium">{{ t('corporate.groupVaults') }}</h3>
                  <p v-if="!assignedVaults.length" class="text-slate-500">
                    {{ t('corporate.noGroupVaults') }}
                  </p>
                  <p v-for="v in assignedVaults" :key="v.id">
                    {{ vaultLabel(v, t) }} ·
                    {{ v.customRoleId ? t('corporate.customRole') : t(`role.${v.role}`)
                    }}<span v-if="v.expiresAt"> · {{ fmt(v.expiresAt) }}</span>
                  </p>
                </div>
              </div>
            </li>
          </ul>
        </div>

        <div v-else-if="tab === 'settings'" class="space-y-6">
          <h2 class="text-base font-semibold" data-testid="settings-title">
            {{ t(`admin.settingsTab.${settingsTab}`) }}
          </h2>
          <AdminCorporateRecovery v-if="isFull() && settingsTab === 'security'" />
          <NetworkSettings v-if="settingsTab === 'network'" />
          <section
            class="card space-y-3 p-4 text-sm"
            data-testid="settings-group-access"
            v-show="settingsTab === 'main'"
          >
            <div>
              <h2 class="font-medium">{{ t('admin.settingsGroup.access') }}</h2>
              <p class="text-xs text-slate-500">{{ t('admin.settingsGroup.accessHint') }}</p>
            </div>
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('admin.registration') }}<InfoHint :text="t('hint.registration.text')" /></span
              ><select
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
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('admin.vaultCreators')
                }}<InfoHint :text="t('hint.vaultCreators.text')" /></span
              ><select
                :value="settings['vaults.creators']"
                class="input w-auto"
                data-testid="set-creators"
                @change="saveSetting('vaults.creators', ($event.target as HTMLSelectElement).value)"
              >
                <option value="admins">{{ t('admin.onlyAdmins') }}</option>
                <option value="members">{{ t('admin.allMembers') }}</option>
              </select></label
            >
          </section>
          <section
            class="card space-y-3 p-4 text-sm"
            data-testid="settings-group-sessions"
            v-show="settingsTab === 'security'"
          >
            <div>
              <h2 class="font-medium">{{ t('admin.settingsGroup.sessions') }}</h2>
              <p class="text-xs text-slate-500">{{ t('admin.settingsGroup.sessionsHint') }}</p>
            </div>
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('adminx.mfaRequired')
                }}<InfoHint
                  :text="t('hint.mfaRequired.text')"
                  :details="t('hint.mfaRequired.details')" /></span
              ><select
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
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('pin.reloadPolicy')
                }}<InfoHint
                  :text="t('hint.reloadUnlock.text')"
                  :details="t('hint.reloadUnlock.details')" /></span
              ><input
                type="checkbox"
                class="switch"
                :checked="settings['security.reloadUnlock'] !== false"
                data-testid="set-reload"
                @change="
                  saveSetting('security.reloadUnlock', ($event.target as HTMLInputElement).checked)
                "
            /></label>
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('pin.policy')
                }}<InfoHint
                  :text="t('hint.pinUnlock.text')"
                  :details="t('hint.pinUnlock.details')" /></span
              ><input
                type="checkbox"
                class="switch"
                :checked="settings['security.pinUnlock'] === true"
                data-testid="set-pin"
                @change="
                  saveSetting('security.pinUnlock', ($event.target as HTMLInputElement).checked)
                "
            /></label>
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('admin.sessionIdle')
                }}<InfoHint
                  :text="t('hint.sessionIdle.text')"
                  :details="t('hint.sessionIdle.details')" /></span
              ><input
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
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('admin.sessionMax') }}<InfoHint :text="t('hint.sessionMax.text')" /></span
              ><input
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
          </section>
          <section
            class="card space-y-3 p-4 text-sm"
            data-testid="settings-group-passwords"
            v-show="settingsTab === 'security'"
          >
            <div>
              <h2 class="font-medium">{{ t('admin.settingsGroup.passwords') }}</h2>
              <p class="text-xs text-slate-500">{{ t('admin.settingsGroup.passwordsHint') }}</p>
            </div>
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('policy.minLength')
                }}<InfoHint
                  :text="t('hint.minLength.text')"
                  :details="t('hint.minLength.details')" /></span
              ><input
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
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('policy.classesLabel') }}<InfoHint :text="t('hint.classes.text')" /></span
              ><input
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
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span>{{ t('policy.maxRepeatLabel') }}</span
              ><input
                :value="settings['policy.password.maxRepeat'] ?? 0"
                type="number"
                min="0"
                max="20"
                class="input w-24"
                data-testid="set-max-repeat"
                @change="
                  saveSetting(
                    'policy.password.maxRepeat',
                    Number(($event.target as HTMLInputElement).value),
                  )
                "
            /></label>
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span>{{ t('admin.revealSeconds') }}</span
              ><input
                :value="settings['security.revealSeconds'] ?? 0"
                type="number"
                min="0"
                max="3600"
                class="input w-24"
                data-testid="set-reveal-seconds"
                @change="
                  saveSetting(
                    'security.revealSeconds',
                    Number(($event.target as HTMLInputElement).value),
                  )
                "
            /></label>
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('admin.passwordMaxAge')
                }}<InfoHint :text="t('hint.passwordMaxAge.text')" /></span
              ><input
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
          </section>
          <section
            class="card space-y-3 p-4 text-sm"
            data-testid="settings-group-generator"
            v-show="settingsTab === 'security'"
          >
            <div>
              <h2 class="font-medium">{{ t('admin.settingsGroup.generator') }}</h2>
              <p class="text-xs text-slate-500">{{ t('admin.settingsGroup.generatorHint') }}</p>
            </div>
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span>{{ t('generator.length') }}</span
              ><input
                :value="settings['generator.length'] ?? 20"
                type="number"
                min="8"
                max="128"
                class="input w-24"
                data-testid="set-gen-length"
                @change="
                  saveSetting('generator.length', Number(($event.target as HTMLInputElement).value))
                "
            /></label>
            <fieldset class="flex flex-wrap gap-x-4 gap-y-1">
              <legend class="mb-1">{{ t('admin.genClasses') }}</legend>
              <label v-for="c in GEN_CLASSES" :key="c" class="flex items-center gap-2"
                ><input
                  type="checkbox"
                  :checked="settings[`generator.${c}`] !== false"
                  :disabled="settings[`generator.${c}`] !== false && genClassesOn <= 1"
                  :data-testid="`set-gen-${c}`"
                  @change="
                    saveSetting(`generator.${c}`, ($event.target as HTMLInputElement).checked)
                  "
                />{{ t(`generator.${c}`) }}</label
              >
            </fieldset>
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('admin.genExclude') }}<InfoHint :text="t('admin.genExcludeHint')" /></span
              ><input
                :value="settings['generator.exclude'] ?? ''"
                maxlength="64"
                spellcheck="false"
                autocomplete="off"
                class="input w-48 font-mono"
                data-testid="set-gen-exclude"
                @change="
                  saveSetting(
                    'generator.exclude',
                    ($event.target as HTMLInputElement).value.replace(/[^\x21-\x7e]/g, ''),
                  )
                "
            /></label>
          </section>
          <section
            class="card space-y-3 p-4 text-sm"
            data-testid="settings-group-links"
            v-show="settingsTab === 'security'"
          >
            <div>
              <h2 class="font-medium">{{ t('admin.settingsGroup.links') }}</h2>
              <p class="text-xs text-slate-500">{{ t('admin.settingsGroup.linksHint') }}</p>
            </div>
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span>{{ t('admin.linksMaxMinutes') }}</span
              ><input
                :value="settings['links.maxMinutes'] ?? 0"
                type="number"
                min="0"
                max="43200"
                class="input w-28"
                data-testid="set-links-minutes"
                @change="
                  saveSetting('links.maxMinutes', Number(($event.target as HTMLInputElement).value))
                "
            /></label>
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span>{{ t('admin.linksMaxViews') }}</span
              ><input
                :value="settings['links.maxViews'] ?? 100"
                type="number"
                min="1"
                max="100"
                class="input w-28"
                data-testid="set-links-views"
                @change="
                  saveSetting('links.maxViews', Number(($event.target as HTMLInputElement).value))
                "
            /></label>
            <label class="block"
              ><span class="field-label">{{ t('admin.linksNotice') }}</span
              ><textarea
                :value="String(settings['links.notice'] ?? '')"
                rows="2"
                maxlength="500"
                class="input"
                data-testid="set-links-notice"
                @change="saveSetting('links.notice', ($event.target as HTMLTextAreaElement).value)"
              />
            </label>
          </section>
          <section
            class="card space-y-3 p-4 text-sm"
            data-testid="settings-group-storage"
            v-show="settingsTab === 'storage'"
          >
            <div>
              <h2 class="font-medium">{{ t('admin.settingsGroup.storage') }}</h2>
              <p class="text-xs text-slate-500">{{ t('admin.settingsGroup.storageHint') }}</p>
            </div>
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('admin.trashDays') }}<InfoHint :text="t('hint.trashDays.text')" /></span
              ><input
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
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('admin.ledgerDays') }}<InfoHint :text="t('hint.ledgerDays.text')" /></span
              ><select
                :value="settings['ledger.retentionDays'] ?? 0"
                class="input w-auto"
                data-testid="set-ledger-days"
                @change="
                  saveSetting(
                    'ledger.retentionDays',
                    Number(($event.target as HTMLSelectElement).value),
                  )
                "
              >
                <option v-for="d in ledgerKeepOptions" :key="d" :value="d">
                  {{
                    te(`admin.ledgerKeep.${d}`)
                      ? t(`admin.ledgerKeep.${d}`)
                      : t('admin.ledgerKeepDays', { n: d })
                  }}
                </option>
              </select></label
            >
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('adminx.attachMax') }}<InfoHint :text="t('hint.attachMax.text')" /></span
              ><input
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
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('adminx.vaultQuota') }}<InfoHint :text="t('hint.vaultQuota.text')" /></span
              ><input
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
            <PersonalLockerSettings />
          </section>
          <ManagedVaultSettings v-show="settingsTab === 'storage'" />
          <section
            class="card space-y-3 p-4 text-sm"
            data-testid="settings-group-notify"
            v-show="settingsTab === 'notify'"
          >
            <div>
              <h2 class="font-medium">{{ t('admin.settingsGroup.notify') }}</h2>
              <p class="text-xs text-slate-500">{{ t('admin.settingsGroup.notifyHint') }}</p>
            </div>
            <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              ><span class="inline-flex items-center gap-1"
                >{{ t('invite.notify') }}<InfoHint :text="t('hint.notify.text')" /></span
              ><input
                type="checkbox"
                class="switch"
                :checked="settings['notifications.security'] !== false"
                data-testid="set-notify"
                @change="
                  saveSetting('notifications.security', ($event.target as HTMLInputElement).checked)
                "
            /></label>
          </section>
          <div class="card space-y-2 p-4 text-sm">
            <h2 class="font-medium">{{ t('admin.rangeTitle') }}</h2>
            <p class="text-slate-500">{{ t('admin.rangeHint') }}</p>
            <textarea
              v-model="rangeUrl"
              rows="2"
              class="input font-mono"
              data-testid="range-url"
            ></textarea>
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
            <p v-if="rangeResult" class="whitespace-pre-line break-all" data-testid="range-result">
              {{ rangeResult }}
            </p>
          </div>
        </div>

        <div v-else class="space-y-3">
          <form class="flex flex-wrap gap-2" @submit.prevent="loadLedger()">
            <select
              v-model="filter.action"
              class="input w-auto"
              :aria-label="t('admin.actionPrefix')"
              data-testid="ledger-action"
            >
              <option v-for="k in LEDGER_KINDS" :key="k" :value="k">
                {{ t(`admin.ledgerKind.${k.replaceAll('.', '') || 'all'}`) }}
              </option>
            </select>
            <input
              v-model="filter.q"
              type="search"
              class="input w-72"
              :placeholder="t('admin.ledgerSearch')"
              :aria-label="t('admin.ledgerSearch')"
              data-testid="ledger-search"
            />
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
          <p v-if="ledgerUser" class="flex items-center gap-2 text-sm" data-testid="ledger-user">
            <span class="badge-brand">{{
              t('admin.ledgerOnlyUser', { name: ledgerUser.name || ledgerUser.id.slice(0, 8) })
            }}</span>
            <button
              type="button"
              class="text-xs underline"
              data-testid="ledger-user-clear"
              @click="router.replace('/admin/ledger')"
            >
              {{ t('admin.ledgerAllUsers') }}
            </button>
          </p>
          <div class="card overflow-x-auto">
            <table class="min-w-full text-xs" data-testid="ledger-table">
              <thead class="text-left text-slate-500">
                <tr>
                  <SortTh
                    class="px-3 py-2"
                    :label="t('admin.time')"
                    :dir="ledgerSort.by === 'at' ? ledgerSort.dir : null"
                    testid="ledger-sort-at"
                    @sort="sortLedger('at')"
                  />
                  <th>{{ t('admin.actor') }}</th>
                  <SortTh
                    :label="t('admin.action')"
                    :dir="ledgerSort.by === 'action' ? ledgerSort.dir : null"
                    testid="ledger-sort-action"
                    @sort="sortLedger('action')"
                  />
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
                  <td class="max-w-56 truncate" :title="l.actor">{{ l.actorName ?? l.actor }}</td>
                  <td class="whitespace-nowrap pr-3">
                    <span :title="l.action">{{ actionText(l.action) }}</span>
                    <span v-if="l.detail?.clientReported" class="badge ml-1">{{
                      t('entryPanel.clientReported')
                    }}</span>
                  </td>
                  <td
                    class="max-w-56 truncate"
                    :class="l.targetName ? '' : 'font-mono'"
                    :title="l.target ?? ''"
                  >
                    {{ targetText(l) }}
                  </td>
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
    <ContextMenu
      v-if="userMenu"
      :x="userMenu.x"
      :y="userMenu.y"
      :items="userActions(userMenu.u)"
      :label="`${t('admin.userActions')}: ${userMenu.u.name}`"
      @select="(id) => onUserAction(userMenu!.u, id)"
      @close="userMenu = null"
    />
  </section>
</template>
