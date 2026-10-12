<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import BranchNode from '../components/BranchNode.vue';
import EntryPanel from '../components/EntryPanel.vue';
import TransferDialog from '../components/TransferDialog.vue';
import { useAuthStore } from '../stores/auth';
import { useWorkspaceStore } from '../stores/workspace';
import { errorMessage } from '../services/helpers';
import { searchText, type BranchItem, type EntryItem } from '../services/model';
import { api } from '../services/api';

const { t } = useI18n();
const confirmBox = (m: string) => window.confirm(m);
const ws = useWorkspaceStore();
const auth = useAuthStore();
const router = useRouter();

type Scope = 'all' | 'favorites' | 'trash';
const scope = ref<Scope>('all');
const branchSel = ref<string | null>(null);
const query = ref('');
const kindFilter = ref('');
const tagFilter = ref('');
const sort = ref<'title' | 'updated'>('title');
const selected = ref<Set<string>>(new Set());
const openId = ref<string | null>(null);
const creating = ref(false);
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
  () => ws.currentId,
  () => {
    scope.value = 'all';
    branchSel.value = null;
    openId.value = null;
    selected.value = new Set();
    creating.value = false;
  },
);

const vault = computed(() => ws.current);
const canWrite = computed(
  () => !!vault.value && ['owner', 'admin', 'editor'].includes(vault.value.role),
);
const isVaultAdmin = computed(() => !!vault.value && ['owner', 'admin'].includes(vault.value.role));
const canCreateVault = computed(() => auth.user?.role === 'admin' || creatorsPolicy.value);

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
  else if (scope.value === 'favorites') base = ws.entries.filter((e) => e.pinned);
  else if (branchSel.value) {
    const ids = descendants(branchSel.value);
    base = ws.entries.filter((e) => e.branchId && ids.has(e.branchId));
  } else base = ws.entries;
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
}
function newEntry(): void {
  openId.value = null;
  creating.value = true;
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
}
void router;
</script>

<template>
  <section class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <select
        class="input max-w-xs"
        :value="ws.currentId"
        data-testid="vault-select"
        @change="ws.select(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="v in ws.vaults" :key="v.id" :value="v.id">
          {{ v.kind === 'locker' ? t('vault.locker') : v.name
          }}{{ v.problem === 'pending' ? ' ⏳' : v.problem ? ' ⚠' : '' }}
        </option>
      </select>
      <button
        v-if="canCreateVault"
        type="button"
        class="btn"
        data-testid="btn-new-vault"
        @click="newVault"
      >
        {{ t('vault.newVault') }}
      </button>
      <button
        v-if="isVaultAdmin && vault?.kind === 'shared'"
        type="button"
        class="btn"
        data-testid="btn-vault-settings"
        @click="router.push(`/vault/${vault.id}/settings`)"
      >
        {{ t('vault.settings') }}
      </button>
      <div class="ml-auto flex gap-2">
        <button type="button" class="btn" data-testid="btn-transfer" @click="showTransfer = true">
          {{ t('transfer.title') }}
        </button>
        <button type="button" class="btn" @click="router.push('/inspector')">
          {{ t('inspector.title') }}
        </button>
      </div>
    </div>

    <p
      v-if="!ws.keyLogOk"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      role="alert"
      data-testid="keylog-alert"
    >
      {{ t('vault.keyLogBroken') }}
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
      class="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-[15rem_minmax(0,1fr)_24rem]"
    >
      <!-- Боковая панель -->
      <aside class="card p-2 text-sm" data-testid="sidebar">
        <ul class="mb-2 space-y-0.5">
          <li>
            <button
              type="button"
              class="w-full rounded px-2 py-1 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
              :class="
                scope === 'all' && !branchSel ? 'bg-slate-100 font-medium dark:bg-slate-800' : ''
              "
              data-testid="scope-all"
              @click="((scope = 'all'), (branchSel = null))"
              @dragover.prevent
              @drop.prevent="dropOn(null, dragId)"
            >
              📚 {{ t('vault.all') }}
              <span class="float-right text-xs text-slate-400">{{ ws.entries.length }}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              class="w-full rounded px-2 py-1 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
              :class="scope === 'favorites' ? 'bg-slate-100 font-medium dark:bg-slate-800' : ''"
              data-testid="scope-favorites"
              @click="scope = 'favorites'"
            >
              ★ {{ t('vault.favorites') }}
            </button>
          </li>
          <li>
            <button
              type="button"
              class="w-full rounded px-2 py-1 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
              :class="scope === 'trash' ? 'bg-slate-100 font-medium dark:bg-slate-800' : ''"
              data-testid="scope-trash"
              @click="scope = 'trash'"
            >
              🗑 {{ t('vault.trash') }}
              <span class="float-right text-xs text-slate-400">{{
                ws.trash.entries.length + ws.trash.branches.length || ''
              }}</span>
            </button>
          </li>
        </ul>
        <div class="mb-1 flex items-center justify-between px-1 text-xs uppercase text-slate-500">
          <span>{{ t('vault.folders') }}</span>
          <button
            v-if="canWrite || branchSel"
            type="button"
            class="text-brand-600"
            data-testid="btn-new-folder"
            @click="newFolder"
          >
            ＋
          </button>
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
              :class="tagFilter === tg ? '!bg-brand-500 !text-white' : ''"
              @click="tagFilter = tagFilter === tg ? '' : tg"
            >
              #{{ tg }}
            </button>
          </div>
        </div>
      </aside>

      <!-- Список -->
      <div class="min-w-0 space-y-2">
        <div class="flex flex-wrap gap-2">
          <input
            v-model="query"
            type="search"
            :placeholder="t('vault.search')"
            class="input min-w-40 flex-1"
            data-testid="search"
          />
          <select v-model="kindFilter" class="input w-auto" data-testid="kind-filter">
            <option value="">{{ t('vault.allKinds') }}</option>
            <option
              v-for="k in ['login', 'note', 'server', 'apikey', 'custom']"
              :key="k"
              :value="k"
            >
              {{ t(`kind.${k}`) }}
            </option>
          </select>
          <select v-model="sort" class="input w-auto">
            <option value="title">{{ t('vault.sortTitle') }}</option>
            <option value="updated">{{ t('vault.sortUpdated') }}</option>
          </select>
          <button
            v-if="canWrite && scope !== 'trash'"
            type="button"
            class="btn-primary"
            data-testid="add-entry"
            @click="newEntry"
          >
            {{ t('vault.add') }}
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
            <span>📁 {{ b.name }}</span>
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
            <li v-if="ws.loading" class="px-4 py-6 text-center text-sm text-slate-500">
              {{ t('common.working') }}
            </li>
            <li
              v-else-if="!list.length"
              class="px-4 py-6 text-center text-sm text-slate-500"
              data-testid="empty"
            >
              {{ query || tagFilter || kindFilter ? t('vault.noMatch') : t('vault.empty') }}
            </li>
            <li
              v-for="e in list"
              :key="e.id"
              class="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50"
              :class="openId === e.id ? 'bg-slate-50 dark:bg-slate-800/50' : ''"
              data-testid="entry-row"
              draggable="true"
              @dragstart="dragId = e.id"
              @click="open(e)"
            >
              <input
                type="checkbox"
                :checked="selected.has(e.id)"
                :aria-label="e.data.title"
                data-testid="row-check"
                @click.stop
                @change="toggle(e.id)"
              />
              <div class="min-w-0 flex-1">
                <div class="truncate font-medium">{{ e.pinned ? '★ ' : '' }}{{ e.data.title }}</div>
                <div class="truncate text-xs text-slate-500">
                  {{ e.data.username }}<span v-if="e.data.url"> · {{ e.data.url }}</span
                  ><span v-if="e.branchId"> · 📁 {{ pathOf(e.branchId) }}</span>
                </div>
              </div>
              <span class="badge shrink-0">{{ t(`kind.${e.data.kind}`) }}</span>
            </li>
          </ul>
        </div>
      </div>

      <!-- Панель записи -->
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
      />
      <section v-else class="card hidden p-4 text-sm text-slate-500 lg:block">
        {{ t('vault.selectEntry') }}
      </section>
      <div v-if="opened && scope === 'trash'" class="lg:col-start-3 flex gap-2">
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
      <div v-else-if="opened && canWrite && opened.access !== 'reader'" class="lg:col-start-3">
        <button
          type="button"
          class="btn-danger"
          data-testid="btn-trash"
          @click="run(() => ws.trashEntry(opened!))"
        >
          {{ t('vault.toTrash') }}
        </button>
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
        <h2 class="font-semibold">📁 {{ menuBranch.name }}</h2>
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
