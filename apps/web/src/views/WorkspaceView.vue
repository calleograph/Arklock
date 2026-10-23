<script setup lang="ts">
import { computed, nextTick, onMounted, ref, toRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import BranchNode from '../components/BranchNode.vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import ActionMenu, { type ActionItem } from '../components/ActionMenu.vue';
import EntryPanel from '../components/EntryPanel.vue';
import TransferDialog from '../components/TransferDialog.vue';
import VaultOverview from '../components/VaultOverview.vue';
import FolderPanel from '../components/FolderPanel.vue';
import SpacesPanel from '../components/SpacesPanel.vue';
import { useAuthStore } from '../stores/auth';
import { useWorkspaceStore } from '../stores/workspace';
import { errorMessage, spaceLabel, vaultLabel } from '../services/helpers';
import { searchText, type BranchItem, type EntryItem } from '../services/model';
import { api } from '../services/api';

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
const tagFilter = ref('');
const sort = ref<'title' | 'updated'>('title');
const selected = ref<Set<string>>(new Set());
const openId = ref<string | null>(null);
const creating = ref(false);
const showSpaces = ref(false);
async function refreshSpaces(): Promise<void> {
  await ws.loadVaults();
  await ws.loadTree();
}
const mobileView = ref<'folders' | 'list' | 'details'>('list');
const detailPanel = ref<HTMLElement | null>(null);
const error = ref('');
const collapsed = ref<Set<string>>(new Set());
const dialog = ref<null | { title: string; value: string; action: (v: string) => Promise<void> }>(
  null,
);
const moveTarget = ref<string>('');
const menuBranch = ref<BranchItem | null>(null);
const showTransfer = ref(false);
const creatorsPolicy = ref(false);

onMounted(async () => {
  try {
    await ws.loadVaults();
    await ws.loadTree();
    ready = true;
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
const canCreateVault = computed(
  () => !!ws.currentSpaceId && (auth.user?.role === 'admin' || creatorsPolicy.value),
);

const branchById = computed(() => new Map(ws.branches.map((b) => [b.id, b])));
const roots = computed(() =>
  ws.branches
    .filter((b) => !b.parentId || !branchById.value.has(b.parentId))
    .sort((a, b) => a.name.localeCompare(b.name)),
);
const counts = computed(() => {
  const m = new Map<string | null, number>();
  for (const e of ws.entries) m.set(e.branchId, (m.get(e.branchId) ?? 0) + 1);
  return m;
});
const allTags = computed(() => [...new Set(ws.entries.flatMap((e) => e.data.tags))].sort());

function pathOf(id: string | null): string {
  const out: string[] = [];
  let cur = id;
  const seen = new Set<string>();
  while (cur && branchById.value.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    out.unshift(branchById.value.get(cur)!.name);
    cur = branchById.value.get(cur)!.parentId;
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
    const ids = descendants(branchSel.value);
    base = ws.entries.filter((e) => !e.data.archived && e.branchId && ids.has(e.branchId));
  } else base = ws.entries.filter((e) => !e.data.archived);
  const q = query.value.trim().toLowerCase();
  const out = base.filter(
    (e) =>
      (!q || searchText(e.data).includes(q) || pathOf(e.branchId).toLowerCase().includes(q)) &&
      (!kindFilter.value || e.data.kind === kindFilter.value) &&
      (!tagFilter.value || e.data.tags.includes(tagFilter.value)),
  );
  return out.sort((a, b) =>
    sort.value === 'title'
      ? a.data.title.localeCompare(b.data.title)
      : b.updatedAt.localeCompare(a.updatedAt),
  );
});

const opened = computed(
  () => [...ws.entries, ...ws.trash.entries].find((e) => e.id === openId.value) ?? null,
);

function open(e: EntryItem): void {
  creating.value = false;
  openId.value = e.id;
  showDetails();
}
function newEntry(): void {
  openId.value = null;
  creating.value = true;
  showDetails();
}
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
  { id: 'trash', label: t('vault.toTrash'), icon: 'trash', danger: true, testid: 'btn-trash' },
]);
function onEntryAction(id: string): void {
  if (id === 'move') moving.value = true;
  else if (id === 'trash') void run(() => ws.trashEntry(opened.value!));
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
  { id: 'spaces', label: t('spaces.manage'), icon: 'folder', testid: 'spaces-open' },
  { id: 'transfer', label: t('transfer.title'), icon: 'sync', testid: 'btn-transfer' },
  { id: 'inspector', label: t('inspector.title'), icon: 'shield', testid: 'btn-inspector' },
]);
function onVaultAction(id: string): void {
  if (id === 'settings') void router.push(`/vault/${vault.value!.id}/settings`);
  else if (id === 'new') void newVault();
  else if (id === 'spaces') showSpaces.value = !showSpaces.value;
  else if (id === 'transfer') showTransfer.value = true;
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

const newFolder = () => ask(t('vault.newFolder'), '', (v) => ws.createBranch(v, branchSel.value));
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
  if (branchSel.value === b.id) branchSel.value = null;
  menuBranch.value = null;
}

const folderTargets = (b: BranchItem) => {
  const bad = descendants(b.id);
  return ws.branches.filter((x) => !bad.has(x.id));
};

function onSaved(item: EntryItem): void {
  creating.value = false;
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
    <SpacesPanel v-if="showSpaces" @changed="refreshSpaces" />

    <p
      v-if="!ws.keyLogOk"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      role="alert"
      data-testid="keylog-alert"
    >
      {{ t('vault.keyLogBroken') }}
    </p>
    <p
      v-if="ws.personalDataRestricted"
      class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
      role="status"
      data-testid="personal-restricted"
    >
      {{ t('corporate.personalRestricted') }}
    </p>
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
        class="flex rounded-[10px] bg-slate-100 p-0.5 text-sm lg:hidden dark:bg-slate-800"
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
              @click="((scope = 'all'), (branchSel = null), (mobileView = 'list'))"
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
            :label="t('vault.newFolder')"
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
            @select="(id) => ((scope = 'all'), (branchSel = id))"
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
            @click="newEntry"
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

        <div class="card">
          <div
            v-if="list.length"
            class="flex items-center gap-2 border-b border-slate-200 px-3 py-1.5 text-xs text-slate-500 dark:border-slate-800"
          >
            <input
              type="checkbox"
              :checked="allSelected"
              data-testid="select-all"
              @change="toggleAll"
            />
            {{ t('vault.selectAll') }} · {{ list.length }}
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
                  {{ query || tagFilter || kindFilter ? t('vault.noMatch') : t('vault.empty') }}
                </p>
                <button
                  v-if="
                    canWrite &&
                    scope !== 'trash' &&
                    scope !== 'archive' &&
                    !query &&
                    !tagFilter &&
                    !kindFilter
                  "
                  type="button"
                  class="btn-primary"
                  @click="newEntry"
                >
                  <Icon name="plus" /> {{ t('vault.add') }}
                </button>
              </div>
            </li>
            <li
              v-for="(e, i) in list"
              :key="e.id"
              class="entry-row rise group flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
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
              @click="open(e)"
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
              <span
                class="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-brand-50 text-sm font-semibold text-brand-700 ring-1 ring-inset ring-brand-500/10"
                aria-hidden="true"
                >{{ (e.data.title || '?').trim().charAt(0).toUpperCase() }}</span
              >
              <div class="min-w-0 flex-1">
                <button
                  type="button"
                  class="flex w-full min-w-0 items-center gap-1.5 text-left font-medium"
                  @click.stop="open(e)"
                >
                  <span class="truncate">{{ e.data.title }}</span>
                  <Icon
                    v-if="e.pinned"
                    name="star"
                    class="size-3.5 shrink-0 fill-amber-400 text-amber-500"
                    :aria-label="t('vault.favorites')"
                  />
                </button>
                <div class="truncate text-xs text-slate-500">
                  {{ e.data.username }}<span v-if="e.data.url"> · {{ e.data.url }}</span
                  ><span v-if="e.branchId"> · {{ pathOf(e.branchId) }}</span>
                </div>
              </div>
              <span class="badge shrink-0 max-sm:hidden">{{ t(`kind.${e.data.kind}`) }}</span>
            </li>
          </ul>
        </div>
      </div>

      <!-- Панель записи -->
      <div
        ref="detailPanel"
        tabindex="-1"
        class="min-w-0 scroll-mt-20 space-y-2 lg:sticky lg:top-20 lg:self-start"
        :class="mobileView === 'details' ? '' : 'hidden lg:block'"
      >
        <EntryPanel
          v-if="opened || creating"
          :key="(opened?.id ?? 'new') + (creating ? 'c' : '')"
          :item="creating ? null : opened"
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
          v-else-if="selectedBranch"
          :key="selectedBranch.id"
          :vault-id="vault.id"
          :branch="selectedBranch"
          @changed="run(() => ws.loadTree())"
        />
        <VaultOverview v-else />
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

    <!-- Меню папки -->
    <div
      v-if="menuBranch"
      class="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      @click.self="menuBranch = null"
    >
      <div class="card w-full max-w-sm space-y-3 p-4" data-testid="folder-menu">
        <h2 class="flex items-center gap-2 font-semibold">
          <Icon name="folder" /> {{ menuBranch.name }}
        </h2>
        <button
          type="button"
          class="btn w-full"
          data-testid="folder-rename"
          @click="(renameFolder(menuBranch!), (menuBranch = null))"
        >
          {{ t('vault.rename') }}
        </button>
        <label class="block text-sm"
          ><span class="mb-1 block">{{ t('vault.moveTo') }}</span>
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
        <button type="button" class="btn w-full" @click="menuBranch = null">
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>

    <!-- Диалог ввода названия -->
    <div
      v-if="dialog"
      class="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      <form
        class="card w-full max-w-sm space-y-3 p-4"
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

    <TransferDialog
      v-if="showTransfer && vault?.unlocked"
      :branches="ws.branches"
      :entries="ws.entries"
      :can-write="canWrite"
      @close="showTransfer = false"
      @done="ws.loadTree()"
    />
  </section>
</template>
