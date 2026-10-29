<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import ManagedVaultDialog from '../components/ManagedVaultDialog.vue';
import BranchNode from '../components/BranchNode.vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import ActionMenu, { type ActionItem } from '../components/ActionMenu.vue';
import EntryPanel from '../components/EntryPanel.vue';
import VaultOverview from '../components/VaultOverview.vue';
import FolderPanel from '../components/FolderPanel.vue';
import FolderCrumbs from '../components/FolderCrumbs.vue';
import FolderGrid from '../components/FolderGrid.vue';
import { childIndex, trailOf } from '../services/explorer';
import SpacesPanel from '../components/SpacesPanel.vue';
import { useAuthStore } from '../stores/auth';
import { useWorkspaceStore } from '../stores/workspace';
import { errorMessage, spaceLabel, vaultLabel } from '../services/helpers';
import { searchText, type BranchItem, type EntryItem } from '../services/model';
import { api } from '../services/api';
import ObjectIcon from '../components/ObjectIcon.vue';
import IconPicker from '../components/IconPicker.vue';
import type { ObjectIcon as ObjectIconData } from '../services/objectIcons';
import { useVaultIssues } from '../services/vaultIssues';
import ContextMenu from '../components/ContextMenu.vue';
import { copyWithAutoClear, reportEntryEvent } from '../services/clipboard';
import type { IssueType } from '../services/inspector';
import { naturalCompare } from '../services/helpers';

const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      spaces: {
        title: 'Пространство',
        manage: 'Управление пространствами',
        personal: 'Личное пространство',
      },
    },
    en: { spaces: { title: 'Space', manage: 'Manage spaces', personal: 'Personal space' } },
  },
});
const confirmBox = (m: string) => window.confirm(m);
const ws = useWorkspaceStore();
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
let ready = false;

type Scope = 'all' | 'favorites' | 'trash' | 'archive';
const scope = ref<Scope>('all');
const branchSel = ref<string | null>(null);
/** Строка поиска живёт в шапке; здесь читается из общего состояния. */
const query = toRef(ws, 'searchQuery');
const kindFilter = ref('');
// фильтр «проблемные записи» из сводки сейфа; хранится в адресе, переживает F5 и «Назад»
const vi = useVaultIssues();
const ISSUE_TYPES: IssueType[] = ['weak', 'reused', 'old', 'expired', 'compromised', 'policy'];
const issueFilter = computed<IssueType | null>(() => {
  const q = route.query.issue;
  return typeof q === 'string' && (ISSUE_TYPES as string[]).includes(q) ? (q as IssueType) : null;
});
function setIssueFilter(type: IssueType | null): void {
  const query = { ...route.query };
  if (type) query.issue = type;
  else delete query.issue;
  if (type) {
    scope.value = 'all';
    branchSel.value = null;
  }
  void router.replace({ query });
}
// проблемы по записям — метка в строке списка
const rowIssues = computed(() => {
  const m = new Map<string, IssueType[]>();
  for (const i of vi.issues.value) m.set(i.entryId, [...(m.get(i.entryId) ?? []), i.type]);
  return m;
});
const issueText = (id: string) =>
  (rowIssues.value.get(id) ?? []).map((x) => t(`issue.${x}`)).join(', ');
const pinnedFolders = computed(() => ws.branches.filter((b) => b.pinned && !b.deletedAt));
const tagFilter = ref('');
const sort = ref<'title' | 'updated'>('title');
const selected = ref<Set<string>>(new Set());
const openId = ref<string | null>(null);
const creating = ref(false);
// «Создать копию»: новая запись открывается заполненной данными этой записи
const cloneOf = ref<EntryItem | null>(null);
const showSpaces = ref(false);
async function refreshSpaces(): Promise<void> {
  await ws.loadVaults();
  await ws.loadTree();
}
const mobileView = ref<'folders' | 'list' | 'details'>('list');
const detailPanel = ref<HTMLElement | null>(null);
const error = ref('');
/** Свёрнутые папки — по сейфу, в браузере сотрудника (удобство, не данные): переживают F5 и смену раздела. */
const collapsed = ref<Set<string>>(new Set());
const treeKey = () => `arklock.tree.${ws.currentId}`;
watch(
  () => ws.currentId,
  () => {
    try {
      collapsed.value = new Set(JSON.parse(localStorage.getItem(treeKey()) ?? '[]') as string[]);
    } catch {
      collapsed.value = new Set();
    }
  },
  { immediate: true },
);
watch(collapsed, (c) => {
  try {
    localStorage.setItem(treeKey(), JSON.stringify([...c]));
  } catch {
    /* хранилище недоступно — дерево просто раскроется при следующей загрузке */
  }
});
const dialog = ref<null | { title: string; value: string; action: (v: string) => Promise<void> }>(
  null,
);
const moveTarget = ref<string>('');
const menuBranch = ref<BranchItem | null>(null);
// значок папки: черновик в окне выбора, сохраняется зашифрованным вместе с названием
const iconBranch = ref<BranchItem | null>(null);
const iconDraft = ref<ObjectIconData | undefined>(undefined);
function openFolderIcon(b: BranchItem): void {
  iconBranch.value = b;
  iconDraft.value = b.icon ? { ...b.icon } : undefined;
  menuBranch.value = null;
}
const iconSaving = ref(false);
async function saveFolderIcon(): Promise<void> {
  const b = iconBranch.value;
  if (!b) return;
  iconSaving.value = true;
  await run(() => ws.setBranchIcon(b, iconDraft.value));
  iconSaving.value = false;
  if (!error.value) iconBranch.value = null;
}
const creatorsPolicy = ref(false);

onMounted(async () => {
  try {
    await ws.loadVaults();
    await ws.loadTree();
    ready = true;
    restoreFolder();
    await openFromRoute();
    if (auth.user?.role !== 'admin') {
      const s = await api<Record<string, unknown>>('GET', '/auth/policy').catch(
        () => ({}) as Record<string, unknown>,
      );
      creatorsPolicy.value = s['vaults.creators'] === 'members';
    }
  } catch (e) {
    error.value = errorMessage(e, t);
  }
});
watch(
  () => route.fullPath,
  () => {
    if (ready) void openFromRoute();
  },
);
async function openFromRoute(): Promise<void> {
  const vaultId = typeof route.query.vault === 'string' ? route.query.vault : ws.currentId;
  const entryId = typeof route.query.entry === 'string' ? route.query.entry : null;
  if (!entryId || !vaultId || !ws.vaults.some((v) => v.id === vaultId && v.unlocked)) return;
  try {
    if (ws.currentId !== vaultId) await ws.select(vaultId);
    branchSel.value = null;
    scope.value = 'all';
    kindFilter.value = '';
    tagFilter.value = '';
    await nextTick();
    const entry = ws.entries.find((e) => e.id === entryId);
    if (entry) open(entry);
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}

watch(
  () => ws.currentId,
  () => {
    scope.value = 'all';
    branchSel.value = null;
    openId.value = null;
    selected.value = new Set();
    creating.value = false;
  },
);
watch(branchSel, () => {
  openId.value = null;
  creating.value = false;
  mobileView.value = 'list';
});
// папка — единое состояние навигации: адрес (?folder=), левое дерево и центральная область читают одно значение
const folderParam = (): string | null => {
  const f = route.query.folder;
  return typeof f === 'string' && ws.branches.some((b) => b.id === f) ? f : null;
};
function restoreFolder(): void {
  const id = folderParam();
  if (id) {
    scope.value = 'all';
    branchSel.value = id;
  }
}
watch(branchSel, async (id) => {
  if (ready && (typeof route.query.folder === 'string' ? route.query.folder : null) !== id) {
    const q = { ...route.query };
    if (id) q.folder = id;
    else delete q.folder;
    delete q.entry; // иначе ссылка на запись снова откроет её и сбросит папку
    void router.push({ query: q });
  }
  // открытая в центре папка видна в дереве: родители раскрываются, строка прокручивается в поле зрения
  const parents = trailOf(ws.branches, id).slice(0, -1);
  if (parents.some((b) => collapsed.value.delete(b.id))) collapsed.value = new Set(collapsed.value);
  await nextTick();
  document
    .querySelector('[data-testid="tree"] .nav-link-active')
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
});
// «Назад» и «Вперёд» в браузере ходят по папкам
watch(
  () => route.query.folder,
  () => {
    if (!ready) return;
    const id = folderParam();
    if (id !== branchSel.value) {
      scope.value = 'all';
      branchSel.value = id;
    }
  },
);
// «Избранное», «Архив» и «Корзина» — не просмотр папки: выбранная папка сбрасывается
watch(scope, (s) => {
  if (s !== 'all') branchSel.value = null;
});
// папка удалена (здесь или на другом устройстве) вместе с родителем — остаёмся в корне
watch(
  () => ws.branches,
  (bs) => {
    if (branchSel.value && !bs.some((b) => b.id === branchSel.value)) branchSel.value = null;
  },
);

const vault = computed(() => ws.current);
const canWrite = computed(
  () =>
    !!vault.value &&
    (vault.value.permissions.includes('entry.create') ||
      (vault.value.role === 'limited' &&
        !!branchSel.value &&
        ws.branches.some((b) => b.id === branchSel.value && b.access !== 'reader'))),
);
const isVaultAdmin = computed(() => !!vault.value?.canManageMembers);
const selectedBranch = computed(() => ws.branches.find((b) => b.id === branchSel.value) ?? null);
const showManaged = ref(false);
// режим включён организацией, а такого сейфа у сотрудника ещё нет
const canCreateManaged = computed(
  () => ws.managedPolicy.enabled && !ws.vaults.some((v) => v.managed),
);
const canCreateVault = computed(
  () => !!ws.currentSpaceId && (auth.user?.role === 'admin' || creatorsPolicy.value),
);

const branchById = computed(() => new Map(ws.branches.map((b) => [b.id, b])));
// для пути — и удалённые папки: у записи в корзине виден прежний путь, даже если папка удалена вместе с ней
const pathIndex = computed(
  () => new Map([...ws.trash.branches, ...ws.branches].map((b) => [b.id, b])),
);
const roots = computed(() =>
  ws.branches
    .filter((b) => !b.parentId || !branchById.value.has(b.parentId))
    .sort((a, b) => naturalCompare(a.name, b.name)),
);
const counts = computed(() => {
  const m = new Map<string | null, number>();
  for (const e of ws.entries) m.set(e.branchId, (m.get(e.branchId) ?? 0) + 1);
  return m;
});
const allTags = computed(() => [...new Set(ws.entries.flatMap((e) => e.data.tags))].sort());
/** Поиск и фильтры работают поверх списка записей, а не проводника: папки в центре скрываются. */
const filtering = computed(
  () => !!(query.value.trim() || kindFilter.value || tagFilter.value || issueFilter.value),
);
const folderIndex = computed(() => childIndex(ws.branches));
const trail = computed(() => trailOf(ws.branches, branchSel.value));
const currentFolders = computed(() => folderIndex.value.get(branchSel.value) ?? []);

function pathOf(id: string | null): string {
  const out: string[] = [];
  let cur = id;
  const seen = new Set<string>();
  while (cur && pathIndex.value.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    out.unshift(pathIndex.value.get(cur)!.name);
    cur = pathIndex.value.get(cur)!.parentId;
  }
  return out.join(' / ');
}

/** Записи папки и всех вложенных папок с заданным признаком архива. */
function folderEntries(b: BranchItem, archived: boolean): EntryItem[] {
  const ids = descendants(b.id);
  return ws.entries.filter(
    (e) =>
      e.branchId && ids.has(e.branchId) && !!e.data.archived === archived && e.access !== 'reader',
  );
}
/** Архив папки — архив всех её записей: признак хранится в зашифрованных данных записи и меняется в браузере. */
const archiveFolder = (b: BranchItem, archived: boolean) =>
  run(async () => {
    for (const e of folderEntries(b, !archived)) await ws.saveEntry({ ...e.data, archived }, e);
    menuBranch.value = null;
  });
function descendants(id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of ws.branches)
      if (b.parentId && out.has(b.parentId) && !out.has(b.id)) (out.add(b.id), (grew = true));
  }
  return out;
}

const list = computed<EntryItem[]>(() => {
  let base: EntryItem[];
  if (scope.value === 'trash') base = ws.trash.entries;
  else if (scope.value === 'archive') base = ws.entries.filter((e) => e.data.archived);
  else if (scope.value === 'favorites')
    base = ws.entries.filter((e) => e.pinned && !e.data.archived);
  else if (branchSel.value) {
    // как в проводнике: без поиска и фильтров — записи самой папки, с ними — вместе с вложенными
    const ids = filtering.value ? descendants(branchSel.value) : new Set([branchSel.value]);
    base = ws.entries.filter((e) => !e.data.archived && e.branchId && ids.has(e.branchId));
  } else base = ws.entries.filter((e) => !e.data.archived);
  const q = query.value.trim().toLowerCase();
  const issueIds = issueFilter.value ? vi.idsOf(issueFilter.value) : null;
  const out = base.filter(
    (e) =>
      (!issueIds || issueIds.has(e.id)) &&
      (!q || searchText(e.data).includes(q) || pathOf(e.branchId).toLowerCase().includes(q)) &&
      (!kindFilter.value || e.data.kind === kindFilter.value) &&
      (!tagFilter.value || e.data.tags.includes(tagFilter.value)),
  );
  return out.sort((a, b) =>
    sort.value === 'title'
      ? naturalCompare(a.data.title, b.data.title)
      : b.updatedAt.localeCompare(a.updatedAt),
  );
});

const opened = computed(
  () => [...ws.entries, ...ws.trash.entries].find((e) => e.id === openId.value) ?? null,
);

// «Изменить» из меню открывает карточку сразу в режиме изменения
const editNow = ref<string | null>(null);
function open(e: EntryItem, edit = false): void {
  creating.value = false;
  editNow.value = edit ? e.id : null;
  openId.value = e.id;
  showDetails();
}
// флаг одноразовый: переход к другой записи любым путём его снимает
watch(openId, (id) => id !== editNow.value && (editNow.value = null));
// долгое нажатие на телефоне открывает то же меню: iOS не присылает contextmenu
let pressTimer = 0;
let pressedLong = false;
function pressStart(ev: PointerEvent, e: EntryItem): void {
  if (ev.pointerType !== 'touch') return;
  pressedLong = false;
  const { clientX: x, clientY: y } = ev;
  pressTimer = window.setTimeout(() => {
    pressedLong = true;
    ctxMenu.value = { x, y, entry: e };
  }, 550);
}
function pressEnd(): void {
  clearTimeout(pressTimer);
}
function rowClick(e: EntryItem): void {
  // отпускание пальца после долгого нажатия — не открытие записи
  if (pressedLong) pressedLong = false;
  else open(e);
}
async function newEntryIn(b: BranchItem): Promise<void> {
  menuBranch.value = null;
  scope.value = 'all';
  branchSel.value = b.id;
  // смена папки закрывает открытую запись и форму (watch ниже) — форму открываем после неё
  await nextTick();
  newEntry();
}
function newEntry(from: EntryItem | null = null): void {
  openId.value = null;
  cloneOf.value = from;
  creating.value = true;
  showDetails();
}
/**
 * Горячие клавиши списка (не срабатывают при вводе текста и с Ctrl/Alt/Meta): «/» — поиск, «n» — новая запись,
 * «e» — изменить открытую, «c» — копировать пароль, «u» — копировать логин.
 */
function onHotkey(ev: KeyboardEvent): void {
  if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.isComposing) return;
  const el = ev.target as HTMLElement | null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
  if (document.querySelector('[role="dialog"]')) return;
  const e = opened.value;
  if (ev.key === '/') {
    ev.preventDefault();
    document.querySelector<HTMLInputElement>('[data-testid="search"]')?.focus();
  } else if (ev.key === 'n' && canWrite.value && scope.value !== 'trash') {
    ev.preventDefault();
    newEntry();
  } else if (ev.key === 'e' && e && e.access !== 'reader' && scope.value !== 'trash') {
    ev.preventDefault();
    open(e, true);
  } else if (ev.key === 'c' && e?.data.password) {
    ev.preventDefault();
    void run(() => copyFromMenu(e, e.data.password, 'password'));
  } else if (ev.key === 'u' && e?.data.username) {
    ev.preventDefault();
    void run(() => copyFromMenu(e, e.data.username, 'username'));
  }
}
onMounted(() => window.addEventListener('keydown', onHotkey));
onBeforeUnmount(() => window.removeEventListener('keydown', onHotkey));
function showDetails(): void {
  mobileView.value = 'details';
  if (window.matchMedia('(max-width: 1023px)').matches)
    void nextTick(() => {
      detailPanel.value?.focus({ preventScroll: true });
      detailPanel.value?.scrollIntoView({ block: 'start' });
    });
}
function toggle(id: string): void {
  selected.value.has(id) ? selected.value.delete(id) : selected.value.add(id);
  selected.value = new Set(selected.value);
}
const allSelected = computed(
  () => list.value.length > 0 && list.value.every((e) => selected.value.has(e.id)),
);
function toggleAll(): void {
  selected.value = allSelected.value ? new Set() : new Set(list.value.map((e) => e.id));
}

async function run(fn: () => Promise<unknown>): Promise<void> {
  error.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}

/** Сейф, в который переносится открытая запись (только открытые ключом и не текущий). */
const moveTo = ref('');
const moving = ref(false);
watch(openId, () => (moving.value = false));
const entryActions = computed<ActionItem[]>(() => [
  ...(moveTargets.value.length
    ? [{ id: 'move', label: t('ws.moveEntry'), icon: 'sync' as const, testid: 'entry-move' }]
    : []),
  ...(canWrite.value
    ? [{ id: 'clone', label: t('ctx.clone'), icon: 'copy' as const, testid: 'entry-clone' }]
    : []),
  { id: 'trash', label: t('vault.toTrash'), icon: 'trash', danger: true, testid: 'btn-trash' },
]);
// меню записи по правой кнопке: частые действия без открытия карточки
const ctxMenu = ref<{ x: number; y: number; entry: EntryItem } | null>(null);
const flash = ref('');
function openEntryMenu(ev: MouseEvent, e: EntryItem): void {
  ctxMenu.value = { x: ev.clientX, y: ev.clientY, entry: e };
}
const ctxItems = computed<ActionItem[]>(() => {
  const e = ctxMenu.value?.entry;
  if (!e) return [];
  if (scope.value === 'trash')
    return e.access === 'reader'
      ? [{ id: 'open', label: t('ctx.open'), icon: 'external', testid: 'ctx-open' }]
      : [
          { id: 'open', label: t('ctx.open'), icon: 'external', testid: 'ctx-open' },
          { id: 'restore', label: t('vault.restore'), icon: 'sync', testid: 'ctx-restore' },
          {
            id: 'purge',
            label: t('vault.purge'),
            icon: 'trash',
            danger: true,
            testid: 'ctx-purge',
          },
        ];
  const edit = e.access !== 'reader';
  return [
    { id: 'open', label: t('ctx.open'), icon: 'external', testid: 'ctx-open' },
    ...(edit
      ? [{ id: 'edit', label: t('ctx.edit'), icon: 'edit' as const, testid: 'ctx-edit' }]
      : []),
    ...(e.data.username
      ? [
          {
            id: 'copy-username',
            label: t('ctx.copyUsername'),
            icon: 'copy' as const,
            testid: 'ctx-copy-username',
          },
        ]
      : []),
    ...(e.data.password && e.data.kind !== 'note'
      ? [
          {
            id: 'copy-password',
            label: t('ctx.copyPassword'),
            icon: 'key' as const,
            testid: 'ctx-copy-password',
          },
        ]
      : []),
    ...(e.data.url
      ? [{ id: 'copy-url', label: t('ctx.copyUrl'), icon: 'copy' as const, testid: 'ctx-copy-url' }]
      : []),
    {
      id: 'pin',
      label: e.pinned ? t('ctx.unpin') : t('ctx.pin'),
      icon: 'star' as const,
      testid: 'ctx-pin',
    },
    ...(canWrite.value
      ? [{ id: 'clone', label: t('ctx.clone'), icon: 'copy' as const, testid: 'ctx-clone' }]
      : []),
    ...(edit
      ? [
          {
            id: 'archive',
            label: e.data.archived ? t('ctx.unarchive') : t('ctx.archive'),
            icon: 'archive' as const,
            testid: 'ctx-archive',
          },
          {
            id: 'trash',
            label: t('vault.toTrash'),
            icon: 'trash' as const,
            danger: true,
            testid: 'ctx-trash',
          },
        ]
      : []),
  ];
});
async function copyFromMenu(
  e: EntryItem,
  value: string,
  field: 'username' | 'password' | 'custom',
) {
  await copyWithAutoClear(value);
  flash.value = t('common.copied');
  setTimeout(() => (flash.value = ''), 2000);
  // отметка в журнале; её сбой не мешает пользоваться скопированным
  void reportEntryEvent(e, 'copy', field).catch(() => undefined);
}
// удаление обратимо одним нажатием: «Вернуть» в течение нескольких секунд, дальше — через корзину
const undo = ref<EntryItem | null>(null);
let undoTimer: ReturnType<typeof setTimeout> | undefined;
async function trashWithUndo(e: EntryItem): Promise<void> {
  await ws.trashEntry(e);
  undo.value = e;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => (undo.value = null), 8000);
}
async function undoTrash(): Promise<void> {
  const e = undo.value;
  undo.value = null;
  if (e) await ws.restoreEntry(e);
}
onBeforeUnmount(() => clearTimeout(undoTimer));
function onCtx(id: string): void {
  const e = ctxMenu.value?.entry;
  if (!e) return;
  if (id === 'open') open(e);
  else if (id === 'edit') open(e, true);
  else if (id === 'copy-username') void run(() => copyFromMenu(e, e.data.username, 'username'));
  else if (id === 'copy-password') void run(() => copyFromMenu(e, e.data.password, 'password'));
  else if (id === 'copy-url') void run(() => copyFromMenu(e, e.data.url, 'custom'));
  else if (id === 'pin') void run(() => ws.setPinned(e, !e.pinned));
  else if (id === 'clone') newEntry(e);
  else if (id === 'restore') void run(() => ws.restoreEntry(e));
  else if (id === 'purge') confirmBox(t('vault.confirmPurge')) && void run(() => ws.purgeEntry(e));
  else if (id === 'archive')
    void run(() => ws.saveEntry({ ...e.data, archived: !e.data.archived }, e));
  else if (id === 'trash') void run(() => trashWithUndo(e));
}

function onEntryAction(id: string): void {
  if (id === 'move') moving.value = true;
  else if (id === 'clone') newEntry(opened.value);
  else if (id === 'trash') void run(() => trashWithUndo(opened.value!));
}
const vaultActions = computed<ActionItem[]>(() => [
  ...(isVaultAdmin.value && vault.value?.kind === 'shared'
    ? [
        {
          id: 'settings',
          label: t('vault.settings'),
          icon: 'settings' as const,
          testid: 'btn-vault-settings',
        },
      ]
    : []),
  ...(canCreateVault.value
    ? [{ id: 'new', label: t('vault.newVault'), icon: 'plus' as const, testid: 'btn-new-vault' }]
    : []),
  ...(canCreateManaged.value
    ? [
        {
          id: 'managed',
          label: t('managed.title'),
          icon: 'users' as const,
          testid: 'btn-new-managed',
        },
      ]
    : []),
  { id: 'spaces', label: t('spaces.manage'), icon: 'folder', testid: 'spaces-open' },
  { id: 'inspector', label: t('inspector.title'), icon: 'shield', testid: 'btn-inspector' },
]);
function onVaultAction(id: string): void {
  if (id === 'settings') void router.push(`/vault/${vault.value!.id}/settings`);
  else if (id === 'new') void newVault();
  else if (id === 'managed') showManaged.value = true;
  else if (id === 'spaces') showSpaces.value = !showSpaces.value;
  else if (id === 'inspector') void router.push('/inspector');
}
const moveTargets = computed(() =>
  ws.vaults.filter((v) => v.unlocked && !v.problem && v.id !== ws.currentId),
);
async function moveNow(): Promise<void> {
  error.value = '';
  try {
    await ws.moveEntry(opened.value!, moveTo.value);
    moveTo.value = '';
    moving.value = false;
  } catch (e) {
    const code = e instanceof Error ? e.message : '';
    error.value =
      code === 'target vault is locked' ? t('vault.entryMoveLocked') : errorMessage(e, t);
  }
}

const bulk = (action: 'move' | 'trash' | 'restore' | 'purge', branchId?: string | null) =>
  run(async () => {
    await ws.bulk([...selected.value], action, branchId);
    selected.value = new Set();
    if (openId.value && !ws.entries.concat(ws.trash.entries).some((e) => e.id === openId.value))
      openId.value = null;
  });

const dropOn = (branchId: string | null, entryId: string) =>
  run(() =>
    ws.bulk(selected.value.has(entryId) ? [...selected.value] : [entryId], 'move', branchId),
  );
let dragId = '';

function ask(title: string, value: string, action: (v: string) => Promise<void>): void {
  dialog.value = { title, value, action };
}
async function submitDialog(): Promise<void> {
  const d = dialog.value;
  if (!d || !d.value.trim()) return;
  await run(() => d.action(d.value));
  dialog.value = null;
}

/** Новая папка создаётся в выбранной папке (или в корне); подпись кнопки называет место. */
const newFolderLabel = computed(() =>
  selectedBranch.value
    ? t('ws.newFolderIn', { name: selectedBranch.value.name })
    : t('ws.newFolderRoot'),
);
/** Родитель запоминается при открытии окна: папка создаётся там, где пользователь нажал, даже если вид успел смениться. */
function newFolder(): void {
  const parent = selectedBranch.value;
  ask(newFolderLabel.value, '', async (v) => {
    await ws.createBranch(v, parent?.id ?? null);
    if (parent && collapsed.value.delete(parent.id)) collapsed.value = new Set(collapsed.value);
  });
}
const canCreateFolder = computed(
  () => canWrite.value && (!selectedBranch.value || selectedBranch.value.access !== 'reader'),
);
function openFolder(id: string | null): void {
  scope.value = 'all';
  branchSel.value = id;
  openId.value = null;
}
async function openFolderAccess(b: BranchItem): Promise<void> {
  menuBranch.value = null;
  openFolder(b.id);
  await nextTick();
  showDetails();
}
const newSubfolder = (parent: BranchItem) => {
  menuBranch.value = null;
  ask(t('ws.newFolderIn', { name: parent.name }), '', async (v) => {
    await ws.createBranch(v, parent.id);
    if (collapsed.value.delete(parent.id)) collapsed.value = new Set(collapsed.value);
  });
};
const renameFolder = (b: BranchItem) =>
  ask(t('vault.rename'), b.name, (v) => ws.renameBranch(b, v));
const newVault = () =>
  ask(t('vault.newVault'), '', async (v) => {
    await ws.createVault(v);
  });
async function moveFolder(b: BranchItem, to: string): Promise<void> {
  await run(() => ws.moveBranch(b, to || null));
  menuBranch.value = null;
}
async function removeFolder(b: BranchItem): Promise<void> {
  if (!confirmBox(t('vault.confirmFolderDelete'))) return;
  await run(() => ws.deleteBranch(b));
  if (branchSel.value === b.id)
    branchSel.value = b.parentId && branchById.value.has(b.parentId) ? b.parentId : null;
  menuBranch.value = null;
}

const folderTargets = (b: BranchItem) => {
  const bad = descendants(b.id);
  return ws.branches.filter((x) => !bad.has(x.id));
};

function onSaved(item: EntryItem): void {
  creating.value = false;
  const folder = ws.branches.find((b) => b.id === item.branchId);
  if (folder?.access === 'structure') {
    // сданную запись читать нельзя: она не открывается и не попадает в список
    flash.value = t('ws.handedIn', { folder: folder.name });
    setTimeout(() => (flash.value = ''), 6000);
    return;
  }
  openId.value = item.id;
  showDetails();
}
void router;
</script>

<template>
  <section class="space-y-3">
    <div
      class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2 sm:flex sm:flex-wrap"
      data-testid="workspace-toolbar"
    >
      <label
        class="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-slate-500 sm:flex-none"
        >{{ t('spaces.title')
        }}<select
          class="input text-slate-900 sm:w-56 dark:text-slate-100"
          :value="ws.currentSpaceId ?? ''"
          data-testid="space-select"
          @change="ws.selectSpace(($event.target as HTMLSelectElement).value || null)"
        >
          <option v-for="s in ws.spaces" :key="s.id" :value="s.id">{{ spaceLabel(s, t) }}</option>
          <option v-if="ws.personalAllowed" value="">{{ t('spaces.personal') }}</option>
        </select></label
      >
      <label
        class="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-slate-500 sm:flex-none"
        >{{ t('ws.vault')
        }}<select
          class="input text-slate-900 sm:w-64 dark:text-slate-100"
          :value="ws.currentId"
          data-testid="vault-select"
          @change="ws.select(($event.target as HTMLSelectElement).value)"
        >
          <optgroup
            v-if="!ws.currentSpaceId && ws.personalAllowed"
            :label="t('vault.groupPersonal')"
          >
            <option
              v-for="v in ws.spaceVaults.filter((x) => x.kind === 'locker')"
              :key="v.id"
              :value="v.id"
            >
              {{ t('vault.locker') }}{{ v.problem === 'pending' ? ' ⏳' : v.problem ? ' ⚠' : '' }}
            </option>
          </optgroup>
          <optgroup v-if="ws.currentSpaceId" :label="t('vault.groupShared')">
            <option
              v-for="v in ws.spaceVaults.filter((x) => x.kind !== 'locker')"
              :key="v.id"
              :value="v.id"
            >
              {{ vaultLabel(v, t) }}{{ v.problem === 'pending' ? ' ⏳' : v.problem ? ' ⚠' : '' }}
            </option>
          </optgroup>
        </select></label
      >
      <div>
        <ActionMenu
          :label="t('ws.actions')"
          :title="t('ws.actionsTitle')"
          align="left"
          :items="vaultActions"
          data-testid="vault-actions"
          @select="onVaultAction"
        />
      </div>
    </div>
    <SpacesPanel v-if="showSpaces" @changed="refreshSpaces" @close="showSpaces = false" />

    <p
      v-if="!ws.keyLogOk"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      role="alert"
      data-testid="keylog-alert"
    >
      {{ t('vault.keyLogBroken') }}
    </p>
    <div
      v-if="ws.personalDataRestricted && !ws.dismissedNotices.includes('personal-restricted')"
      class="notice notice-warn items-center justify-between"
      role="status"
      data-testid="personal-restricted"
    >
      <span>{{ t('corporate.personalRestricted', { n: ws.personalEntries }) }}</span>
      <span class="flex shrink-0 gap-2">
        <RouterLink to="/settings#personal" class="btn">{{ t('ws.more') }}</RouterLink>
        <IconButton
          icon="check"
          :label="t('ws.dismiss')"
          data-testid="personal-dismiss"
          @click="ws.dismissNotice('personal-restricted')"
        />
      </span>
    </div>
    <p
      v-if="vault?.problem === 'pending'"
      class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200"
      data-testid="pending-banner"
    >
      {{ t('vault.pendingKey') }}
    </p>
    <p
      v-else-if="vault?.problem"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      role="alert"
    >
      {{ t(`vault.problem.${vault.problem}`) }}
    </p>
    <p
      v-if="ws.skipped"
      class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200"
      role="alert"
    >
      {{ t('vault.skipped', { n: ws.skipped }) }}
    </p>
    <p
      v-if="error"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      role="alert"
      data-testid="ws-error"
    >
      {{ error }}
    </p>

    <div
      v-if="vault?.unlocked"
      class="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-[14rem_minmax(0,1fr)_25rem]"
    >
      <nav
        class="flex rounded-lg bg-slate-100 p-0.5 text-sm lg:hidden dark:bg-slate-800"
        :aria-label="t('corporate.mobileNavigation')"
      >
        <button
          v-for="view in ['folders', 'list', 'details'] as const"
          :key="view"
          type="button"
          class="seg flex-1 py-1.5"
          :class="{ 'seg-on': mobileView === view }"
          :aria-pressed="mobileView === view"
          :data-testid="`mobile-view-${view}`"
          @click="mobileView = view"
        >
          {{ t(`corporate.mobile.${view}`) }}
        </button>
      </nav>
      <!-- Боковая панель -->
      <aside
        class="card p-2 text-sm"
        :class="mobileView === 'folders' ? '' : 'hidden lg:block'"
        data-testid="sidebar"
      >
        <ul class="mb-2 space-y-0.5">
          <li>
            <button
              type="button"
              class="nav-link w-full"
              :class="scope === 'all' && !branchSel ? 'nav-link-active' : ''"
              data-testid="scope-all"
              @click="
                ((scope = 'all'), (branchSel = null), (mobileView = 'list'), setIssueFilter(null))
              "
              @dragover.prevent
              @drop.prevent="dropOn(null, dragId)"
            >
              <Icon name="all" />
              <span class="flex-1 text-left">{{ t('vault.all') }}</span>
              <span class="text-xs text-slate-500">{{
                ws.entries.filter((e) => !e.data.archived).length
              }}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              class="nav-link w-full"
              :class="scope === 'favorites' ? 'nav-link-active' : ''"
              data-testid="scope-favorites"
              @click="((scope = 'favorites'), (mobileView = 'list'))"
            >
              <Icon name="star" /> <span class="flex-1 text-left">{{ t('vault.favorites') }}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              class="nav-link w-full"
              :class="scope === 'archive' ? 'nav-link-active' : ''"
              data-testid="scope-archive"
              @click="((scope = 'archive'), (mobileView = 'list'))"
            >
              <Icon name="archive" /> <span class="flex-1 text-left">{{ t('vault.archive') }}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              class="nav-link w-full"
              :class="scope === 'trash' ? 'nav-link-active' : ''"
              data-testid="scope-trash"
              @click="((scope = 'trash'), (mobileView = 'list'))"
            >
              <Icon name="trash" /> <span class="flex-1 text-left">{{ t('vault.trash') }}</span>
              <span class="text-xs text-slate-500">{{
                ws.trash.entries.length + ws.trash.branches.length || ''
              }}</span>
            </button>
          </li>
        </ul>
        <div class="mb-1 flex items-center justify-between px-1 text-xs uppercase text-slate-500">
          <span>{{ t('vault.folders') }}</span>
          <IconButton
            v-if="canWrite || branchSel"
            icon="folder-plus"
            :label="newFolderLabel"
            data-testid="btn-new-folder"
            @click="newFolder"
          />
        </div>
        <ul data-testid="tree">
          <BranchNode
            v-for="b in roots"
            :key="b.id"
            :node="b"
            :all="ws.branches"
            :selected="scope === 'all' ? branchSel : null"
            :depth="0"
            :counts="counts"
            :collapsed="collapsed"
            @select="openFolder"
            @toggle="
              (id) => (
                collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id),
                (collapsed = new Set(collapsed))
              )
            "
            @menu="(b2) => (menuBranch = b2)"
            @drop="(p) => dropOn(p.branchId, dragId)"
          />
        </ul>
        <div
          v-if="allTags.length"
          class="mt-3 border-t border-slate-200 pt-2 dark:border-slate-800"
        >
          <div class="mb-1 px-1 text-xs uppercase text-slate-500">{{ t('vault.tags') }}</div>
          <div class="flex flex-wrap gap-1">
            <button
              v-for="tg in allTags"
              :key="tg"
              type="button"
              class="badge"
              :class="tagFilter === tg ? 'badge-brand ring-1 ring-brand-500' : ''"
              @click="tagFilter = tagFilter === tg ? '' : tg"
            >
              #{{ tg }}
            </button>
          </div>
        </div>
      </aside>

      <!-- Список -->
      <div class="min-w-0 space-y-2" :class="mobileView === 'list' ? '' : 'hidden lg:block'">
        <FolderCrumbs
          v-if="scope === 'all'"
          :root-label="vaultLabel(vault, t)"
          :trail="trail"
          @open="openFolder"
        />
        <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 sm:flex sm:flex-wrap">
          <select
            v-model="kindFilter"
            class="input sm:w-auto"
            :aria-label="t('ws.kindFilter')"
            data-testid="kind-filter"
          >
            <option value="">{{ t('vault.allKinds') }}</option>
            <option
              v-for="k in ['login', 'note', 'server', 'apikey', 'custom']"
              :key="k"
              :value="k"
            >
              {{ t(`kind.${k}`) }}
            </option>
          </select>
          <select v-model="sort" class="input sm:w-auto" :aria-label="t('ws.sort')">
            <option value="title">{{ t('vault.sortTitle') }}</option>
            <option value="updated">{{ t('vault.sortUpdated') }}</option>
          </select>
          <button
            v-if="canWrite && scope !== 'trash'"
            type="button"
            class="btn-primary sm:ml-auto"
            :aria-label="t('vault.add')"
            data-testid="add-entry"
            @click="newEntry()"
          >
            <Icon name="plus" /> <span class="max-sm:hidden">{{ t('vault.add') }}</span>
          </button>
        </div>

        <div
          v-if="selected.size"
          class="flex flex-wrap items-center gap-2 rounded-md bg-slate-100 px-3 py-2 text-sm dark:bg-slate-800"
          data-testid="bulk-bar"
        >
          <span>{{ t('vault.selected', { n: selected.size }) }}</span>
          <template v-if="scope !== 'trash'">
            <select v-model="moveTarget" class="input w-auto" data-testid="bulk-target">
              <option value="">{{ t('vault.root') }}</option>
              <option v-for="b in ws.branches" :key="b.id" :value="b.id">{{ pathOf(b.id) }}</option>
            </select>
            <button
              type="button"
              class="btn"
              data-testid="bulk-move"
              @click="bulk('move', moveTarget || null)"
            >
              {{ t('vault.move') }}
            </button>
            <button
              type="button"
              class="btn-danger"
              data-testid="bulk-trash"
              @click="bulk('trash')"
            >
              {{ t('vault.toTrash') }}
            </button>
          </template>
          <template v-else>
            <button type="button" class="btn" data-testid="bulk-restore" @click="bulk('restore')">
              {{ t('vault.restore') }}
            </button>
            <button
              type="button"
              class="btn-danger"
              data-testid="bulk-purge"
              @click="confirmBox(t('vault.confirmPurge')) && bulk('purge')"
            >
              {{ t('vault.purge') }}
            </button>
          </template>
        </div>

        <ul
          v-if="scope === 'trash' && ws.trash.branches.length"
          class="card divide-y divide-slate-200 text-sm dark:divide-slate-800"
        >
          <li
            v-for="b in ws.trash.branches"
            :key="b.id"
            class="flex items-center justify-between px-3 py-2"
          >
            <span class="flex items-center gap-2"><Icon name="folder" /> {{ b.name }}</span>
            <span class="flex gap-1"
              ><button
                type="button"
                class="btn"
                data-testid="restore-branch"
                @click="run(() => ws.restoreBranch(b))"
              >
                {{ t('vault.restore') }}</button
              ><button
                type="button"
                class="btn-danger"
                @click="confirmBox(t('vault.confirmPurge')) && run(() => ws.deleteBranch(b, true))"
              >
                {{ t('vault.purge') }}
              </button></span
            >
          </li>
        </ul>

        <div
          v-if="scope === 'favorites' && pinnedFolders.length"
          class="flex flex-wrap items-center gap-1.5 text-sm"
          data-testid="favorite-folders"
        >
          <span class="text-xs text-slate-500">{{ t('vault.folders') }}:</span>
          <button
            v-for="b in pinnedFolders"
            :key="b.id"
            type="button"
            class="badge gap-1 !py-1 hover:bg-slate-200 dark:hover:bg-slate-700"
            :data-testid="`favorite-folder-${b.name}`"
            @click="((scope = 'all'), (branchSel = b.id), (openId = null))"
          >
            <ObjectIcon :icon="b.icon" kind="folder" variant="inline" />{{ pathOf(b.id) }}
          </button>
        </div>

        <div
          v-if="issueFilter"
          class="notice notice-warn flex items-center justify-between gap-2 !py-1.5 text-sm"
          role="status"
          data-testid="issue-filter"
        >
          <span>{{ t('overview.filter', { what: t(`issue.${issueFilter}`) }) }}</span>
          <button
            type="button"
            class="text-xs font-medium underline"
            data-testid="issue-filter-clear"
            @click="setIssueFilter(null)"
          >
            {{ t('overview.clear') }}
          </button>
        </div>

        <FolderGrid
          v-if="scope === 'all' && !filtering"
          :folders="currentFolders"
          :counts="counts"
          :kids="folderIndex"
          :can-create="canCreateFolder"
          :create-label="newFolderLabel"
          :where="branchSel"
          @open="openFolder"
          @create="newFolder"
          @menu="(b) => (menuBranch = b)"
          @drop="(id) => dropOn(id, dragId)"
        />

        <div class="card">
          <div
            v-if="list.length"
            class="flex items-center gap-2 border-b border-slate-200 px-3 py-1.5 text-xs text-slate-500 dark:border-slate-800"
          >
            <input
              type="checkbox"
              :checked="allSelected"
              :aria-label="t('vault.selectAll')"
              data-testid="select-all"
              @change="toggleAll"
            />
            {{ t('vault.selectAll') }}
            <span class="ml-auto font-medium uppercase" data-testid="entries-title"
              >{{ scope === 'all' && branchSel ? t('ws.entries') : t('vault.all') }} ·
              {{ list.length }}</span
            >
          </div>
          <ul class="divide-y divide-slate-200 dark:divide-slate-800" data-testid="entry-list">
            <li v-if="ws.loading" class="space-y-2 px-4 py-4" aria-busy="true">
              <div class="skeleton h-9" />
              <div class="skeleton h-9" />
              <div class="skeleton h-9" />
            </li>
            <li v-else-if="!list.length" class="p-4" data-testid="empty">
              <div class="empty border-0">
                <Icon
                  :name="query || tagFilter || kindFilter ? 'search' : 'inbox'"
                  class="!size-8 opacity-60"
                />
                <p>
                  {{
                    query || tagFilter || kindFilter
                      ? t('vault.noMatch')
                      : scope === 'favorites'
                        ? t('vault.emptyFavorites')
                        : scope === 'archive'
                          ? t('vault.emptyArchive')
                          : scope === 'trash'
                            ? t('vault.emptyTrash')
                            : t('vault.empty')
                  }}
                </p>
                <button
                  v-if="canWrite && scope === 'all' && !query && !tagFilter && !kindFilter"
                  type="button"
                  class="btn-primary"
                  @click="newEntry()"
                >
                  <Icon name="plus" /> {{ t('vault.add') }}
                </button>
              </div>
            </li>
            <li
              v-for="(e, i) in list"
              :key="e.id"
              class="entry-row rise group flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors [-webkit-touch-callout:none] hover:bg-slate-50 max-lg:select-none dark:hover:bg-slate-800/50"
              :class="[
                openId === e.id
                  ? 'bg-brand-50 hover:bg-brand-50 shadow-[inset_3px_0_0_var(--color-brand-500)] dark:hover:bg-brand-50'
                  : '',
                selected.size ? 'selecting' : '',
              ]"
              :style="{ '--i': i }"
              data-testid="entry-row"
              draggable="true"
              @dragstart="dragId = e.id"
              @click="rowClick(e)"
              @contextmenu.prevent="openEntryMenu($event, e)"
              @pointerdown="pressStart($event, e)"
              @pointerup="pressEnd"
              @pointercancel="pressEnd"
              @pointerleave="pressEnd"
            >
              <input
                type="checkbox"
                :checked="selected.has(e.id)"
                :aria-label="e.data.title"
                class="row-check"
                data-testid="row-check"
                @click.stop
                @change="toggle(e.id)"
              />
              <ObjectIcon :icon="e.data.icon" kind="entry" :label="e.data.title" />
              <div class="min-w-0 flex-1">
                <button
                  type="button"
                  class="flex w-full min-w-0 items-center gap-1.5 text-left font-medium"
                  @click.stop="rowClick(e)"
                >
                  <span class="truncate">{{ e.data.title }}</span>
                  <Icon
                    v-if="e.pinned"
                    name="star"
                    class="size-3.5 shrink-0 fill-amber-400 text-amber-500"
                    :aria-label="t('vault.favorites')"
                  />
                  <span
                    v-if="rowIssues.has(e.id)"
                    class="size-2 shrink-0 rounded-full"
                    :class="
                      rowIssues.get(e.id)!.includes('compromised') ? 'bg-red-500' : 'bg-amber-500'
                    "
                    role="img"
                    :aria-label="issueText(e.id)"
                    :title="issueText(e.id)"
                    data-testid="row-issue"
                  />
                </button>
                <div class="truncate text-xs text-slate-500">
                  {{
                    [e.data.username, e.data.url, e.branchId && pathOf(e.branchId)]
                      .filter(Boolean)
                      .join(' · ')
                  }}
                </div>
              </div>
              <!-- быстрое копирование без открытия записи; на устройствах без наведения кнопки видны всегда -->
              <span
                v-if="e.data.username || e.data.password"
                class="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-sm:hidden [@media(hover:none)]:opacity-100"
                @click.stop
              >
                <IconButton
                  v-if="e.data.username"
                  icon="user"
                  :label="t('ws.copyLogin')"
                  data-testid="row-copy-login"
                  @click.stop="run(() => copyFromMenu(e, e.data.username, 'username'))"
                />
                <IconButton
                  v-if="e.data.password"
                  icon="copy"
                  :label="t('ws.copyPassword')"
                  data-testid="row-copy-password"
                  @click.stop="run(() => copyFromMenu(e, e.data.password, 'password'))"
                />
              </span>
              <!-- тип показывается, когда он отличается от обычного «логин и пароль»: иначе это шум в каждой строке -->
              <span v-if="e.data.kind !== 'login'" class="badge shrink-0 max-sm:hidden">{{
                t(`kind.${e.data.kind}`)
              }}</span>
            </li>
          </ul>
        </div>
      </div>

      <!-- Панель записи -->
      <div
        ref="detailPanel"
        tabindex="-1"
        class="min-w-0 scroll-mt-16 space-y-2 lg:sticky lg:top-16 lg:max-h-[calc(100dvh-4.5rem)] lg:self-start lg:overflow-y-auto"
        :class="mobileView === 'details' ? '' : 'hidden lg:block'"
      >
        <EntryPanel
          v-if="opened || creating"
          :key="(opened?.id ?? 'new') + (creating ? 'c' + (cloneOf?.id ?? '') : '')"
          :item="creating ? null : opened"
          :template="creating ? cloneOf : null"
          :edit="!creating && !!opened && editNow === opened.id"
          :creating="creating"
          :branch-id="branchSel"
          :vault="vault"
          :branches="ws.branches"
          @open="(id) => (openId = id)"
          @saved="onSaved"
          @cancel="creating = false"
          @changed="() => (openId = openId)"
        >
          <template #actions>
            <ActionMenu
              v-if="opened && scope !== 'trash' && opened.access !== 'reader'"
              :title="t('ws.entryActions')"
              :items="entryActions"
              data-testid="entry-actions"
              @select="onEntryAction"
            />
          </template>
        </EntryPanel>
        <FolderPanel
          v-else-if="selectedBranch && selectedBranch.access !== 'structure'"
          :key="selectedBranch.id"
          :vault-id="vault.id"
          :branch="selectedBranch"
          @changed="run(() => ws.loadTree())"
        />
        <VaultOverview v-else :vi="vi" @filter="setIssueFilter" />
        <div v-if="opened && scope === 'trash'" class="flex gap-2">
          <button
            type="button"
            class="btn"
            data-testid="restore-entry"
            @click="run(() => ws.restoreEntry(opened!))"
          >
            {{ t('vault.restore') }}
          </button>
          <button
            type="button"
            class="btn-danger"
            @click="confirmBox(t('vault.confirmPurge')) && run(() => ws.purgeEntry(opened!))"
          >
            {{ t('vault.purge') }}
          </button>
        </div>
        <div
          v-if="moving && opened && opened.access !== 'reader' && moveTargets.length"
          class="card flex flex-wrap items-center gap-2 p-3"
          data-testid="move-entry"
        >
          <select
            v-model="moveTo"
            class="input min-w-0 flex-1"
            data-testid="move-target"
            :aria-label="t('vault.entryMoveTarget')"
          >
            <option value="">{{ t('vault.entryMoveChoose') }}</option>
            <option v-for="v in moveTargets" :key="v.id" :value="v.id">
              {{ v.kind === 'locker' ? t('vault.locker') : vaultLabel(v, t) }}
            </option>
          </select>
          <button
            type="button"
            class="btn"
            :disabled="!moveTo"
            data-testid="btn-move"
            @click="moveNow"
          >
            {{ t('vault.entryMoveAction') }}
          </button>
          <button type="button" class="btn" @click="moving = false">
            {{ t('common.cancel') }}
          </button>
        </div>
      </div>
    </div>

    <ContextMenu
      v-if="ctxMenu"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxItems"
      :label="ctxMenu.entry.data.title"
      @select="onCtx"
      @close="ctxMenu = null"
    />
    <div
      v-if="undo"
      class="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white shadow-lg dark:bg-slate-100 dark:text-slate-900"
      role="status"
      data-testid="undo-toast"
    >
      {{ t('ws.trashed') }}
      <button
        type="button"
        class="font-semibold underline"
        data-testid="undo-trash"
        @click="run(undoTrash)"
      >
        {{ t('ws.undo') }}
      </button>
    </div>
    <p
      v-if="flash"
      class="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white shadow-lg dark:bg-slate-100 dark:text-slate-900"
      role="status"
      data-testid="flash"
    >
      {{ flash }}
    </p>

    <!-- Значок папки -->
    <div
      v-if="iconBranch"
      class="modal-scrim flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      :aria-label="t('icons.folderTitle', { name: iconBranch.name })"
      @click.self="iconBranch = null"
      @keydown.esc="iconBranch = null"
    >
      <div class="modal w-full max-w-sm space-y-3 p-4" data-testid="folder-icon-dialog">
        <h2 class="font-semibold">{{ t('icons.folderTitle', { name: iconBranch.name }) }}</h2>
        <IconPicker v-model="iconDraft" kind="folder" :label="iconBranch.name" />
        <div class="flex gap-2">
          <button
            type="button"
            class="btn-primary"
            :disabled="iconSaving"
            data-testid="folder-icon-save"
            @click="saveFolderIcon"
          >
            {{ t('common.save') }}
          </button>
          <button type="button" class="btn" @click="iconBranch = null">
            {{ t('common.cancel') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Меню папки -->
    <div
      v-if="menuBranch"
      class="modal-scrim flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      @click.self="menuBranch = null"
    >
      <div class="modal w-full max-w-sm space-y-3 p-4" data-testid="folder-menu">
        <h2 class="flex items-center gap-2 font-semibold">
          <ObjectIcon :icon="menuBranch.icon" kind="folder" variant="inline" />
          {{ menuBranch.name }}
        </h2>
        <template v-if="menuBranch.access !== 'reader'">
          <button
            v-if="canWrite"
            type="button"
            class="btn w-full"
            data-testid="folder-subfolder"
            @click="newSubfolder(menuBranch!)"
          >
            <Icon name="folder-plus" /> {{ t('ws.newSubfolder') }}
          </button>
          <button
            v-if="canWrite"
            type="button"
            class="btn w-full"
            data-testid="folder-add-entry"
            @click="newEntryIn(menuBranch!)"
          >
            <Icon name="plus" /> {{ t('ctx.addHere') }}
          </button>
        </template>
        <template v-if="menuBranch.access === 'editor' || menuBranch.access === 'manager'">
          <button
            type="button"
            class="btn w-full"
            data-testid="folder-rename"
            @click="(renameFolder(menuBranch!), (menuBranch = null))"
          >
            {{ t('vault.rename') }}
          </button>
          <button
            type="button"
            class="btn w-full"
            data-testid="folder-icon"
            @click="openFolderIcon(menuBranch!)"
          >
            {{ t('icons.change') }}
          </button>
        </template>
        <button
          v-if="menuBranch.access === 'manager'"
          type="button"
          class="btn w-full"
          data-testid="folder-access"
          @click="openFolderAccess(menuBranch!)"
        >
          <Icon name="users" /> {{ t('ws.folderAccess') }}
        </button>
        <button
          type="button"
          class="btn w-full"
          data-testid="folder-pin"
          @click="
            (run(() => ws.setBranchPinned(menuBranch!, !menuBranch!.pinned)), (menuBranch = null))
          "
        >
          <Icon name="star" /> {{ menuBranch.pinned ? t('ctx.unpin') : t('ctx.pin') }}
        </button>
        <template v-if="menuBranch.access === 'editor' || menuBranch.access === 'manager'">
          <label class="block text-sm"
            ><span class="field-label">{{ t('vault.moveTo') }}</span>
            <select
              class="input"
              data-testid="folder-move"
              @change="moveFolder(menuBranch!, ($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled selected>…</option>
              <option value="">{{ t('vault.root') }}</option>
              <option v-for="b in folderTargets(menuBranch)" :key="b.id" :value="b.id">
                {{ pathOf(b.id) }}
              </option>
            </select></label
          >
          <button
            v-if="folderEntries(menuBranch, false).length"
            type="button"
            class="btn w-full"
            data-testid="folder-archive"
            @click="archiveFolder(menuBranch!, true)"
          >
            <Icon name="archive" />
            {{ t('ws.archiveFolder', { n: folderEntries(menuBranch, false).length }) }}
          </button>
          <button
            v-if="folderEntries(menuBranch, true).length"
            type="button"
            class="btn w-full"
            data-testid="folder-unarchive"
            @click="archiveFolder(menuBranch!, false)"
          >
            <Icon name="inbox" />
            {{ t('ws.unarchiveFolder', { n: folderEntries(menuBranch, true).length }) }}
          </button>
          <button
            type="button"
            class="btn-danger w-full"
            data-testid="folder-delete"
            @click="removeFolder(menuBranch!)"
          >
            {{ t('vault.deleteFolder') }}
          </button>
        </template>
        <button type="button" class="btn w-full" @click="menuBranch = null">
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>

    <!-- Диалог ввода названия -->
    <div
      v-if="dialog"
      class="modal-scrim flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <form
        class="modal w-full max-w-sm space-y-3 p-4"
        data-testid="name-dialog"
        @submit.prevent="submitDialog"
      >
        <h2 class="font-semibold">{{ dialog.title }}</h2>
        <input
          v-model="dialog.value"
          required
          maxlength="100"
          class="input"
          data-testid="name-input"
          autofocus
        />
        <div class="flex justify-end gap-2">
          <button type="button" class="btn" @click="dialog = null">{{ t('common.cancel') }}</button
          ><button type="submit" class="btn-primary" data-testid="name-ok">
            {{ t('common.save') }}
          </button>
        </div>
      </form>
    </div>
    <ManagedVaultDialog
      v-if="showManaged"
      @close="showManaged = false"
      @done="showManaged = false"
    />
  </section>
</template>
