<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  estimateStrength,
  generatePassphrase,
  generatePassword,
  parseTotpInput,
  totp,
  totpRemaining,
} from '@arklock/crypto';
import {
  blankEntry,
  ENTRY_KINDS,
  normalizeEntry,
  type BranchItem,
  type EntryData,
  type EntryItem,
} from '../services/model';
import { useWorkspaceStore } from '../stores/workspace';
import PasswordGenerator from './PasswordGenerator.vue';
import EntryAccessPanel from './EntryAccessPanel.vue';
import EntryJournalPanel from './EntryJournalPanel.vue';
import EntrySettingsPanel from './EntrySettingsPanel.vue';
import IconButton from './IconButton.vue';
import SecretText from './SecretText.vue';
import Icon from './Icon.vue';
import ObjectIcon from './ObjectIcon.vue';
import IconPicker from './IconPicker.vue';
import { errorMessage, when } from '../services/helpers';
import { api } from '../services/api';
import { openSink } from '../services/download';
import { copyWithAutoClear, reportEntryEvent } from '../services/clipboard';
import { NO_POLICY, checkPolicy, type PasswordPolicy } from '../services/policy';
import type { VaultView } from '../stores/workspace';

const props = defineProps<{
  /** Выбранная запись; null — создание новой. */
  item: EntryItem | null;
  creating: boolean;
  branchId: string | null;
  vault: VaultView;
  branches: BranchItem[];
}>();
const emit = defineEmits<{
  (e: 'open', id: string): void;
  (e: 'saved', item: EntryItem): void;
  (e: 'cancel'): void;
  (e: 'changed'): void;
}>();

const { t } = useI18n();
const clone = <T,>(v: T): T => structuredClone(v);
const ws = useWorkspaceStore();

const editing = ref(props.creating);
const form = ref<EntryData>(props.item ? clone(normalizeEntry(props.item.data)) : blankEntry());
const tagsText = ref(form.value.tags.join(', '));
const showPw = ref(false);
const revealed = ref<Set<number>>(new Set());
const error = ref('');
const busy = ref(false);
const tab = ref<'details' | 'access' | 'journal' | 'settings'>('details');
/** Порядок типов — по частоте использования; значки — тот же набор, что и в интерфейсе. */
const KIND_ORDER = ['login', 'server', 'apikey', 'note', 'custom'] as const;
const KIND_ICON = {
  login: 'key',
  server: 'database',
  apikey: 'totp',
  note: 'text',
  custom: 'tag',
} as const;
const URL_HINT: Record<string, string> = {
  login: 'https://example.com/login',
  server: 'ssh://db.example.com:22',
  apikey: 'https://api.example.com/v1',
  note: '',
  custom: '',
};
const hasExtras = () =>
  !!(
    form.value.totp ||
    form.value.fields.length ||
    form.value.links?.length ||
    tagsText.value ||
    form.value.expiresAt
  );
const moreOpen = ref(false);
const iconOpen = ref(false);
moreOpen.value = hasExtras();
const subTab = ref<'files' | 'history' | 'share' | null>(null);
const tabs = ['details', 'files', 'access', 'journal', 'settings'] as const;
/** Вкладка «Файлы» — это данные записи с открытым списком вложений. */
const tabBar = ref<HTMLElement | null>(null);
/** Положение индикатора берётся у активной вкладки: подписи разной длины, ширина колонок не равная. */
const ink = ref<Record<string, string>>({});
function placeInk(): void {
  const el = tabBar.value?.querySelector<HTMLElement>('[aria-selected="true"]');
  if (el) ink.value = { '--tab-x': `${el.offsetLeft}px`, '--tab-w': `${el.offsetWidth}px` };
}
const shownTab = computed(() =>
  tab.value === 'details' && subTab.value === 'files' ? 'files' : tab.value,
);
function selectTab(value: (typeof tabs)[number]): void {
  error.value = '';
  if (value === 'files') {
    tab.value = 'details';
    void openFiles();
    return;
  }
  tab.value = value;
  subTab.value = null;
}
function tabKey(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = tabs.indexOf(shownTab.value);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  selectTab(tabs[next]!);
  (event.currentTarget as HTMLElement)
    .querySelector<HTMLButtonElement>(`[data-entry-tab="${shownTab.value}"]`)
    ?.focus();
}
const branchChoice = ref<string | null>(props.item?.branchId ?? props.branchId);

// Сброс вкладок и состояния только при смене записи или режима. Строковый ключ: массив в геттере
// считался бы изменённым при каждом обновлении объекта записи (фоновая перезагрузка) и сбрасывал бы вкладку.
watch(
  () => `${props.item?.id ?? ''}|${props.creating}`,
  () => {
    editing.value = props.creating;
    form.value = props.item ? clone(normalizeEntry(props.item.data)) : blankEntry();
    tagsText.value = form.value.tags.join(', ');
    moreOpen.value = hasExtras();
    iconOpen.value = false;
    showPw.value = false;
    revealed.value = new Set();
    error.value = '';
    tab.value = 'details';
    subTab.value = null;
    branchChoice.value = props.item?.branchId ?? props.branchId;
    history.value = null;
    files.value = null;
    confirmFile.value = '';
    link.value = '';
    share.value = { passphrase: '', minutes: 60, views: 1, notes: false };
    showGenerator.value = false;
  },
);
// Обновлённые данные той же записи подставляются в форму, если её не редактируют.
watch(
  () => props.item,
  (item) => {
    if (item && !editing.value) {
      form.value = clone(normalizeEntry(item.data));
      tagsText.value = form.value.tags.join(', ');
    }
  },
);

const canEdit = computed(() => !props.item || props.item.access !== 'reader');
const strength = computed(() => estimateStrength(form.value.password));
/** Папки деревом: вложенность показана отступом и значком ветки; порядок — по названию внутри уровня. */
const branchOptions = computed(() => {
  const byParent = new Map<string | null, BranchItem[]>();
  for (const b of props.branches) {
    const list = byParent.get(b.parentId) ?? [];
    list.push(b);
    byParent.set(b.parentId, list);
  }
  const out: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number): void => {
    for (const b of (byParent.get(parent) ?? []).sort((x, y) => x.name.localeCompare(y.name))) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push({ id: b.id, label: ' '.repeat(depth) + (depth ? '└ ' : '') + b.name });
      walk(b.id, depth + 1);
    }
  };
  walk(null, 0);
  // папки, чей родитель не загружен, показываем в корне, чтобы их нельзя было потерять
  for (const b of props.branches) if (!seen.has(b.id)) out.push({ id: b.id, label: b.name });
  return out;
});

// ---- TOTP
const code = ref('');
const remaining = ref(30);
let timer: ReturnType<typeof setInterval> | null = null;
async function refreshCode(): Promise<void> {
  const src = (editing.value ? form.value.totp : props.item?.data.totp) ?? '';
  if (!src) {
    code.value = '';
    return;
  }
  try {
    const p = parseTotpInput(src);
    code.value = await totp(p);
    remaining.value = totpRemaining(p.period ?? 30);
  } catch {
    code.value = '';
  }
}
watch(() => [props.item?.id, props.item?.data.totp, form.value.totp, editing.value], refreshCode, {
  immediate: true,
});
timer = setInterval(refreshCode, 1000);
onBeforeUnmount(() => timer && clearInterval(timer));

watch(shownTab, () => void nextTick(placeInk));
onMounted(() => {
  void nextTick(placeInk);
  window.addEventListener('resize', placeInk);
  // карточка монтируется заново для каждой записи: одно открытие — одна отметка в журнале
  if (props.item && !props.creating) void reportEvent('open');
});
onBeforeUnmount(() => window.removeEventListener('resize', placeInk));

// ---- буфер обмена
const copied = ref('');
async function copy(label: string, value: string): Promise<void> {
  const item = props.item;
  try {
    await copyWithAutoClear(value);
    copied.value = label;
    if (label !== 'link')
      void reportEvent(
        'copy',
        label === 'password' || label === 'username' || label === 'totp' ? label : 'custom',
        item,
      );
    setTimeout(() => (copied.value = ''), 30_000);
  } catch {
    error.value = t('entryPanel.clipboardFailed');
  }
}

async function reportEvent(
  action: 'copy' | 'reveal' | 'open',
  field?: 'password' | 'username' | 'totp' | 'custom',
  item = props.item,
): Promise<void> {
  if (!item) return;
  try {
    await reportEntryEvent(item, action, field);
  } catch {
    // неудачная отметка об открытии не мешает работе; о показе и копировании секрета — сообщаем
    if (action !== 'open') error.value = t('entryPanel.eventFailed');
  }
}
function toggleReveal(index: number): void {
  if (revealed.value.has(index)) revealed.value.delete(index);
  else {
    revealed.value.add(index);
    void reportEvent('reveal', index === -1 ? 'password' : 'custom');
  }
  revealed.value = new Set(revealed.value);
}

// ---- действующая политика записи и родителей
const policy = ref<PasswordPolicy>(NO_POLICY);
watch(
  () => `${props.vault.id}|${props.item?.id ?? ''}|${branchChoice.value ?? ''}`,
  async () => {
    const path = props.item
      ? `/vaults/${props.vault.id}/entries/${props.item.id}/policy`
      : branchChoice.value
        ? `/vaults/${props.vault.id}/branches/${branchChoice.value}/policy`
        : `/vaults/${props.vault.id}/policy`;
    try {
      policy.value = (await api<{ effective: PasswordPolicy }>('GET', path)).effective;
    } catch {
      /* Сохранение повторно проверяет политику в общем сторе. */
    }
  },
  { immediate: true },
);

function generate(kind: 'password' | 'phrase'): void {
  form.value.password =
    kind === 'password'
      ? generatePassword({ length: Math.max(20, policy.value.minLength) })
      : generatePassphrase({ words: Math.max(5, Math.ceil(policy.value.minLength / 8)) });
  showPw.value = true;
}

/** Отмена редактирования: та же логика, что у кнопки «Отмена»; Escape закрывает модальное окно. */
function cancelEditing(): void {
  if (!editing.value) return;
  if (busy.value) return;
  if (!confirmDiscard()) return;
  if (props.item) {
    editing.value = false;
    form.value = clone(normalizeEntry(props.item.data));
    tagsText.value = form.value.tags.join(', ');
    branchChoice.value = props.item.branchId;
    showPw.value = false;
    showGenerator.value = false;
  } else {
    emit('cancel');
  }
}
const hasChanges = computed(() => {
  const original = props.item ? normalizeEntry(props.item.data) : blankEntry();
  return (
    editing.value &&
    (JSON.stringify(form.value) !== JSON.stringify(original) ||
      tagsText.value !== original.tags.join(', ') ||
      branchChoice.value !== (props.item?.branchId ?? props.branchId))
  );
});
function confirmDiscard(): boolean {
  return !hasChanges.value || window.confirm(t('entryPanel.discardChanges'));
}
function beforeUnload(event: BeforeUnloadEvent): void {
  if (hasChanges.value || busy.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
window.addEventListener('beforeunload', beforeUnload);
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));
onBeforeRouteLeave(() => (busy.value ? false : confirmDiscard()));

/** Панель генератора открывается по кнопке под полем пароля; выбранный пароль подставляется в форму. */
const showGenerator = ref(false);
function useGenerated(value: string): void {
  form.value.password = value;
  showPw.value = true;
  showGenerator.value = false;
}

/** Тип поля выбирается из двух вариантов; тип хранится в том же флаге `secret`, что и раньше. */
const FIELD_TYPES = [
  { key: 'text', secret: false, icon: 'text', label: 'vault.fieldTypeText' },
  { key: 'password', secret: true, icon: 'lock', label: 'vault.fieldTypePassword' },
] as const;

function addField(): void {
  form.value.fields.push({ name: '', value: '', secret: false });
}

async function save(): Promise<void> {
  error.value = '';
  if (!form.value.title.trim()) {
    error.value = t('vault.titleRequired');
    return;
  }
  if (form.value.password && form.value.kind !== 'note') {
    const bad = checkPolicy(form.value.password, policy.value);
    if (bad.length) {
      error.value = bad
        .map((b) =>
          t(`policy.${b}`, { n: b === 'length' ? policy.value.minLength : policy.value.classes }),
        )
        .join(' ');
      return;
    }
  }
  if (form.value.totp) {
    try {
      parseTotpInput(form.value.totp);
    } catch {
      error.value = t('vault.totpInvalid');
      return;
    }
  }
  busy.value = true;
  try {
    form.value.tags = tagsText.value
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    form.value.fields = form.value.fields.filter((f) => f.name.trim());
    const saved = await ws.saveEntry(form.value, props.item ?? undefined, branchChoice.value);
    editing.value = false;
    emit('saved', saved);
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}

// ---- история
const history = ref<
  { rev: { id: string; version: number; savedAt: string }; data: EntryData | null }[] | null
>(null);
async function loadHistory(): Promise<void> {
  subTab.value = 'history';
  error.value = '';
  const item = props.item;
  try {
    if (item) {
      const rows = await ws.revisions(item);
      if (props.item?.id === item.id) history.value = rows;
    }
  } catch (e) {
    error.value = errorMessage(e, t);
    history.value = [];
  }
}
async function revert(id: string): Promise<void> {
  if (!props.item) return;
  busy.value = true;
  try {
    await ws.restoreRevision(props.item, id);
    emit('changed');
    history.value = null;
    tab.value = 'details';
    subTab.value = null;
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}

// ---- файлы
interface FileRow {
  id: string;
  name: string;
  type: string;
  size: number;
  problem?: boolean;
}
const files = ref<FileRow[] | null>(null);
const storage = ref<{ enabled: boolean; maxMiB: number }>({ enabled: true, maxMiB: 25 });
const confirmFile = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
async function openFiles(): Promise<void> {
  subTab.value = 'files';
  error.value = '';
  if (!props.item) return;
  try {
    const policy = await api<Record<string, unknown>>('GET', '/auth/policy');
    storage.value = {
      enabled: policy['storage.enabled'] !== false,
      maxMiB: Number(policy['storage.attachmentMaxMiB'] ?? 25),
    };
    files.value = storage.value.enabled ? await ws.attachmentList(props.item) : [];
  } catch (e) {
    error.value = errorMessage(e, t);
    files.value = [];
  }
}
const progress = ref<{ label: string; done: number; total: number } | null>(null);

async function addFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const picked = Array.from(input.files ?? []);
  input.value = '';
  const item = props.item;
  if (!item || !picked.length) return;
  busy.value = true;
  error.value = '';
  try {
    for (const f of picked) {
      if (f.size > storage.value.maxMiB * 1024 * 1024) {
        error.value = t('files.tooLarge');
        continue;
      }
      progress.value = { label: f.name, done: 0, total: f.size || 1 };
      await ws.attachmentAdd(item, f, (done, total) => {
        progress.value = { label: f.name, done, total };
      });
    }
    const rows = await ws.attachmentList(item);
    if (props.item?.id === item.id) files.value = rows;
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    progress.value = null;
    busy.value = false;
  }
}

async function downloadFile(f: FileRow): Promise<void> {
  if (!props.item) return;
  busy.value = true;
  error.value = '';
  let sink: Awaited<ReturnType<typeof openSink>> | null = null;
  try {
    sink = await openSink(f.name, f.size);
    progress.value = { label: f.name, done: 0, total: f.size || 1 };
    await ws.attachmentDownload(props.item, f.id, sink, (done, total) => {
      progress.value = { label: f.name, done, total };
    });
    await sink.close();
  } catch (e) {
    await sink?.abort().catch(() => undefined);
    // отмена выбора файла пользователем — не ошибка
    if (!(e instanceof DOMException && e.name === 'AbortError')) error.value = t('files.broken');
  } finally {
    progress.value = null;
    busy.value = false;
  }
}
async function removeFile(f: FileRow): Promise<void> {
  if (!props.item) return;
  if (confirmFile.value !== f.id) {
    confirmFile.value = f.id;
    return;
  }
  confirmFile.value = '';
  busy.value = true;
  try {
    await ws.attachmentRemove(props.item, f.id);
    files.value = await ws.attachmentList(props.item);
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
const fmtSize = (n: number) =>
  n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024
      ? `${Math.round(n / 1024)} KB`
      : `${n} B`;

// ---- ссылка передачи
const link = ref('');
const share = ref({ passphrase: '', minutes: 60, views: 1, notes: false });
async function createLink(): Promise<void> {
  const item = props.item;
  if (!item) return;
  busy.value = true;
  error.value = '';
  try {
    const created = await ws.createLink(item, {
      passphrase: share.value.passphrase,
      expiresInMinutes: Number(share.value.minutes),
      maxViews: Number(share.value.views),
      includeNotes: share.value.notes,
    });
    if (props.item?.id === item.id) link.value = created;
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}

/** Связи записей: выбор среди других записей этого хранилища; названия берутся из расшифрованного списка. */
const linkChoice = ref('');
const siblings = computed(() =>
  ws.entries.filter((e) => e.vaultId === props.vault.id && e.id !== props.item?.id && !e.deletedAt),
);
const titleOf = (id: string) => ws.entries.find((e) => e.id === id)?.data.title ?? '';
const linkedEntries = computed(() =>
  (props.item?.data.links ?? [])
    .map((id) => ({ id, title: titleOf(id) }))
    .filter((l) => l.title !== ''),
);
function addLink(): void {
  if (!linkChoice.value) return;
  const links = new Set(form.value.links ?? []);
  links.add(linkChoice.value);
  form.value.links = [...links];
  linkChoice.value = '';
}
const removeLink = (id: string) =>
  (form.value.links = (form.value.links ?? []).filter((x) => x !== id));

async function toggleArchive(): Promise<void> {
  if (!props.item) return;
  busy.value = true;
  error.value = '';
  try {
    await ws.saveEntry({ ...props.item.data, archived: !props.item.data.archived }, props.item);
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}

const fmt = (iso: string) => when(iso);
</script>

<template>
  <!-- В режиме создания и редактирования форма открывается модальным окном поверх страницы;
       в body, чтобы липкая колонка карточки не опускала окно под шапку -->
  <Teleport to="body" :disabled="!editing">
    <section
      :class="
        editing
          ? 'modal-fade fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-950/60 p-3 sm:p-8'
          : 'card p-4'
      "
      :role="editing ? 'dialog' : undefined"
      :aria-modal="editing ? 'true' : undefined"
      :aria-label="editing ? item?.data.title || t('vault.add') : undefined"
      data-testid="entry-panel"
      @keydown.esc.stop.prevent="cancelEditing"
    >
      <div :class="editing ? 'card w-full max-w-2xl p-4 shadow-xl' : 'contents'">
        <!-- Просмотр -->
        <template v-if="item && !editing">
          <div class="mb-4 flex items-start gap-2">
            <ObjectIcon :icon="item.data.icon" kind="entry" :label="item.data.title" />
            <div class="min-w-0 flex-1">
              <h2 class="truncate text-xl font-semibold tracking-tight" data-testid="view-title">
                {{ item.data.title }}
              </h2>
              <div class="mt-1 flex flex-wrap gap-1">
                <span class="badge">{{ t(`kind.${item.data.kind}`) }}</span>
                <span v-for="tag in item.data.tags" :key="tag" class="badge">#{{ tag }}</span>
              </div>
            </div>
            <div class="-mr-1.5 -mt-1 flex shrink-0">
              <IconButton
                v-if="canEdit"
                icon="edit"
                :label="t('vault.edit')"
                data-testid="btn-edit"
                @click="editing = true"
              />
              <IconButton
                v-if="canEdit"
                :icon="item.data.archived ? 'inbox' : 'archive'"
                :label="item.data.archived ? t('vault.unarchive') : t('vault.archiveEntry')"
                data-testid="btn-archive"
                @click="toggleArchive"
              />
              <IconButton
                icon="star"
                :label="item.pinned ? t('vault.unpin') : t('vault.pin')"
                :active="item.pinned"
                data-testid="btn-pin"
                @click="ws.setPinned(item, !item.pinned)"
              />
              <slot name="actions" />
            </div>
          </div>

          <div
            ref="tabBar"
            class="tabs mb-3 flex justify-between gap-3 overflow-x-auto"
            role="tablist"
            :aria-label="t('entryPanel.tabsLabel')"
            @keydown="tabKey"
          >
            <button
              v-for="value in tabs"
              :id="`entry-tab-${value}`"
              :key="value"
              type="button"
              role="tab"
              class="tab"
              :aria-selected="shownTab === value"
              :aria-controls="`entry-panel-${value === 'files' ? 'details' : value}`"
              :tabindex="shownTab === value ? 0 : -1"
              :data-entry-tab="value"
              :data-testid="`tab-${value}`"
              @click="selectTab(value)"
            >
              {{ t(`entryPanel.tabs.${value}`) }}
            </button>
            <span class="tabs-ink" aria-hidden="true" :style="ink" />
          </div>
          <!-- Второй уровень — переключатель вида внутри вкладки, а не ещё одна кнопка-действие -->
          <div
            v-if="tab === 'access' || tab === 'journal'"
            class="mb-3 inline-flex rounded-lg bg-slate-100 p-0.5 text-xs dark:bg-slate-800"
            role="group"
          >
            <template v-if="tab === 'access'">
              <button
                type="button"
                class="seg"
                :class="{ 'seg-on': !subTab }"
                :aria-pressed="!subTab"
                @click="subTab = null"
              >
                {{ t('entryPanel.actualAccess') }}
              </button>
              <button
                type="button"
                class="seg"
                :class="{ 'seg-on': subTab === 'share' }"
                :aria-pressed="subTab === 'share'"
                data-testid="tab-share"
                @click="subTab = 'share'"
              >
                {{ t('vault.share') }}
              </button>
            </template>
            <template v-else>
              <button
                type="button"
                class="seg"
                :class="{ 'seg-on': !subTab }"
                :aria-pressed="!subTab"
                @click="subTab = null"
              >
                {{ t('entryPanel.events') }}
              </button>
              <button
                type="button"
                class="seg"
                :class="{ 'seg-on': subTab === 'history' }"
                :aria-pressed="subTab === 'history'"
                data-testid="tab-history"
                @click="loadHistory"
              >
                {{ t('vault.history') }}
              </button>
            </template>
          </div>
          <div
            v-show="tab === 'details'"
            id="entry-panel-details"
            role="tabpanel"
            aria-labelledby="entry-tab-details"
          >
            <dl
              v-if="subTab !== 'files'"
              class="divide-y divide-slate-200 text-sm dark:divide-slate-800"
            >
              <div v-if="item.data.username" class="field-row">
                <dt>{{ t('vault.username') }}</dt>
                <dd>
                  <span class="min-w-0 flex-1 break-all" data-testid="view-username">{{
                    item.data.username
                  }}</span>
                  <IconButton
                    :icon="copied === 'username' ? 'check' : 'copy'"
                    :label="copied === 'username' ? t('common.copied') : t('common.copy')"
                    @click="copy('username', item.data.username)"
                  />
                </dd>
              </div>
              <div v-if="item.data.password" class="field-row">
                <dt>
                  {{ item.data.kind === 'apikey' ? t('vault.secret') : t('vault.password') }}
                </dt>
                <dd>
                  <SecretText
                    class="min-w-0 flex-1"
                    :value="item.data.password"
                    :shown="revealed.has(-1)"
                    data-testid="view-password"
                  />
                  <IconButton
                    :icon="revealed.has(-1) ? 'eye-off' : 'eye'"
                    :label="revealed.has(-1) ? t('common.hide') : t('common.show')"
                    :active="revealed.has(-1)"
                    data-testid="btn-reveal"
                    @click="toggleReveal(-1)"
                  />
                  <IconButton
                    :icon="copied === 'password' ? 'check' : 'copy'"
                    :label="copied === 'password' ? t('common.copied') : t('common.copy')"
                    data-testid="btn-copy-password"
                    @click="copy('password', item.data.password)"
                  />
                </dd>
              </div>
              <div v-if="linkedEntries.length" class="field-row" data-testid="links-view">
                <dt>{{ t('vault.links') }}</dt>
                <dd class="flex-wrap">
                  <button
                    v-for="l in linkedEntries"
                    :key="l.id"
                    type="button"
                    class="btn"
                    data-testid="link-open"
                    @click="emit('open', l.id)"
                  >
                    <Icon name="external" /> {{ l.title }}
                  </button>
                </dd>
              </div>
              <div v-if="item.data.url" class="field-row">
                <dt>{{ t('vault.url') }}</dt>
                <dd>
                  <a
                    v-if="/^https?:\/\//i.test(item.data.url)"
                    :href="item.data.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="min-w-0 flex-1 break-all text-brand-600 underline decoration-brand-500/30 underline-offset-2 hover:decoration-brand-500"
                    >{{ item.data.url }}</a
                  >
                  <span v-else class="min-w-0 flex-1 break-all">{{ item.data.url }}</span>
                </dd>
              </div>
              <div v-if="code" class="field-row">
                <dt>{{ t('vault.totp') }}</dt>
                <dd>
                  <span class="flex-1 font-mono text-lg tracking-[0.2em]" data-testid="view-totp">{{
                    code
                  }}</span>
                  <!-- кольцо оставшегося времени кода: убывает линейно, как сам срок -->
                  <span
                    class="totp-ring num text-[11px] text-slate-500"
                    :style="{ '--left': remaining / 30 }"
                    :aria-label="`${remaining} ${t('vault.sec')}`"
                    >{{ remaining }}</span
                  >
                  <IconButton
                    :icon="copied === 'totp' ? 'check' : 'copy'"
                    :label="copied === 'totp' ? t('common.copied') : t('common.copy')"
                    @click="copy('totp', code)"
                  />
                </dd>
              </div>
              <div v-for="(f, i) in item.data.fields" :key="i" class="field-row">
                <dt>{{ f.name }}</dt>
                <dd>
                  <SecretText
                    v-if="f.secret"
                    class="min-w-0 flex-1"
                    :value="f.value"
                    :shown="revealed.has(i)"
                    mask="••••••••"
                  />
                  <span v-else class="min-w-0 flex-1 break-all">{{ f.value }}</span>
                  <IconButton
                    v-if="f.secret"
                    :icon="revealed.has(i) ? 'eye-off' : 'eye'"
                    :label="revealed.has(i) ? t('common.hide') : t('common.show')"
                    :active="revealed.has(i)"
                    @click="toggleReveal(i)"
                  />
                  <IconButton
                    :icon="copied === 'f' + i ? 'check' : 'copy'"
                    :label="copied === 'f' + i ? t('common.copied') : t('common.copy')"
                    @click="copy('f' + i, f.value)"
                  />
                </dd>
              </div>
              <div v-if="item.data.notes" class="field-row">
                <dt>{{ t('vault.notes') }}</dt>
                <dd class="whitespace-pre-wrap break-words" data-testid="view-notes">
                  {{ item.data.notes }}
                </dd>
              </div>
              <div class="num pt-3 text-xs text-slate-500">
                {{ t('vault.updated') }}: {{ fmt(item.updatedAt) }}
                <span v-if="item.data.expiresAt">
                  · {{ t('vault.expires') }}: {{ item.data.expiresAt }}</span
                >
              </div>
            </dl>

            <div v-else class="space-y-3 text-sm" data-testid="files-panel">
              <p class="text-xs text-slate-500">
                {{ t('files.encryptedNote') }} {{ t('files.max', { n: storage.maxMiB }) }}
              </p>
              <p v-if="!storage.enabled" class="text-amber-700" role="alert">
                {{ t('files.disabled') }}
              </p>
              <p v-else-if="!files" class="text-slate-500">{{ t('common.working') }}</p>
              <p v-else-if="!files.length" class="text-slate-500" data-testid="files-empty">
                {{ t('files.empty') }}
              </p>
              <ul v-else class="divide-y divide-slate-200 dark:divide-slate-800">
                <li
                  v-for="f in files"
                  :key="f.id"
                  class="flex flex-wrap items-center justify-between gap-2 py-2"
                  data-testid="file-row"
                >
                  <span class="min-w-0 break-all"
                    >{{ f.name }}
                    <span class="text-xs text-slate-500">· {{ fmtSize(f.size) }}</span></span
                  >
                  <span class="flex gap-1">
                    <button
                      type="button"
                      class="btn"
                      :disabled="busy || f.problem"
                      data-testid="file-download"
                      @click="downloadFile(f)"
                    >
                      {{ t('files.download') }}
                    </button>
                    <button
                      v-if="canEdit"
                      type="button"
                      class="btn"
                      :disabled="busy"
                      data-testid="file-remove"
                      @click="removeFile(f)"
                    >
                      {{ confirmFile === f.id ? t('files.confirmRemove') : t('files.remove') }}
                    </button>
                  </span>
                </li>
              </ul>
              <div v-if="progress" class="space-y-1" data-testid="file-progress">
                <div class="truncate text-xs text-slate-500">{{ progress.label }}</div>
                <progress class="w-full" :max="progress.total" :value="progress.done"></progress>
              </div>
              <div v-if="canEdit && storage.enabled">
                <input
                  ref="fileInput"
                  type="file"
                  multiple
                  class="hidden"
                  data-testid="file-input"
                  @change="addFile"
                />
                <button
                  type="button"
                  class="btn"
                  :disabled="busy"
                  data-testid="file-add"
                  @click="fileInput?.click()"
                >
                  {{ t('files.add') }}
                </button>
              </div>
              <p v-if="error" class="text-red-600" role="alert" data-testid="files-error">
                {{ error }}
              </p>
            </div>
          </div>
          <div
            v-show="tab === 'journal'"
            id="entry-panel-journal"
            role="tabpanel"
            aria-labelledby="entry-tab-journal"
          >
            <EntryJournalPanel
              :key="item.id"
              v-show="subTab !== 'history'"
              :vault-id="vault.id"
              :entry-id="item.id"
              :active="tab === 'journal' && subTab !== 'history'"
            />
            <div v-if="subTab === 'history'" data-testid="history-list">
              <p v-if="!history" class="text-sm text-slate-500">{{ t('common.working') }}</p>
              <p v-else-if="!history.length" class="text-sm text-slate-500">
                {{ t('vault.noHistory') }}
              </p>
              <ul v-else class="divide-y divide-slate-200 text-sm dark:divide-slate-800">
                <li
                  v-for="h in history"
                  :key="h.rev.id"
                  class="flex items-center justify-between gap-2 py-2"
                  data-testid="history-row"
                >
                  <div class="min-w-0">
                    <div class="font-medium">v{{ h.rev.version }} · {{ fmt(h.rev.savedAt) }}</div>
                    <div class="truncate text-xs text-slate-500">
                      {{
                        h.data ? `${h.data.title} · ${h.data.username}` : t('vault.undecryptable')
                      }}
                    </div>
                  </div>
                  <button
                    v-if="canEdit && h.data"
                    type="button"
                    class="btn shrink-0"
                    :disabled="busy"
                    data-testid="btn-revert"
                    @click="revert(h.rev.id)"
                  >
                    {{ t('vault.revert') }}
                  </button>
                </li>
              </ul>
            </div>
          </div>
          <div
            v-show="tab === 'access'"
            id="entry-panel-access"
            role="tabpanel"
            aria-labelledby="entry-tab-access"
          >
            <EntryAccessPanel
              :key="item.id"
              v-show="subTab !== 'share'"
              :vault-id="vault.id"
              :entry-id="item.id"
              :active="tab === 'access' && subTab !== 'share'"
              @changed="emit('changed')"
            />
            <div v-if="subTab === 'share'" class="space-y-3 text-sm">
              <p class="text-slate-500">{{ t('vault.shareHint') }}</p>
              <div class="grid grid-cols-2 gap-2">
                <label class="block"
                  ><span class="mb-1 block text-xs">{{ t('vault.linkLifetime') }}</span>
                  <select v-model="share.minutes" class="input" data-testid="share-minutes">
                    <option :value="15">15 {{ t('vault.min') }}</option>
                    <option :value="60">1 {{ t('vault.hour') }}</option>
                    <option :value="1440">24 {{ t('vault.hour') }}</option>
                    <option :value="10080">7 {{ t('vault.days') }}</option>
                  </select></label
                >
                <label class="block"
                  ><span class="mb-1 block text-xs">{{ t('vault.linkViews') }}</span>
                  <select v-model="share.views" class="input" data-testid="share-views">
                    <option :value="1">1</option>
                    <option :value="3">3</option>
                    <option :value="10">10</option>
                  </select></label
                >
              </div>
              <label class="block"
                ><span class="mb-1 block text-xs">{{ t('vault.linkPassphrase') }}</span>
                <input
                  v-model="share.passphrase"
                  type="password"
                  autocomplete="off"
                  class="input"
                  data-testid="share-passphrase"
              /></label>
              <label class="flex items-center gap-2"
                ><input v-model="share.notes" type="checkbox" /> {{ t('vault.linkNotes') }}</label
              >
              <button
                type="button"
                class="btn-primary"
                :disabled="busy"
                data-testid="btn-create-link"
                @click="createLink"
              >
                {{ t('vault.createLink') }}
              </button>
              <div v-if="link" class="rounded-md bg-emerald-50 p-2 dark:bg-emerald-950">
                <p class="break-all font-mono text-xs" data-testid="share-link">{{ link }}</p>
                <button type="button" class="btn mt-2" @click="copy('link', link)">
                  {{ copied === 'link' ? t('common.copied') : t('common.copy') }}
                </button>
              </div>
            </div>
          </div>
          <div
            v-show="tab === 'settings'"
            id="entry-panel-settings"
            role="tabpanel"
            aria-labelledby="entry-tab-settings"
          >
            <EntrySettingsPanel
              :key="item.id"
              :vault-id="vault.id"
              :entry-id="item.id"
              :active="tab === 'settings'"
              :password="item.data.password"
              :password-changed-at="item.data.passwordChangedAt"
              @policy="policy = $event"
            />
          </div>
          <p v-if="error" class="mt-2 text-sm text-red-600" role="alert">{{ error }}</p>
        </template>

        <!-- Редактор -->
        <form v-else-if="editing" class="space-y-3" data-testid="entry-form" @submit.prevent="save">
          <h2 class="font-semibold">{{ item ? t('vault.edit') : t('vault.add') }}</h2>
          <!-- тип записи: компактный ряд со значками, а не выпадающий список -->
          <div
            class="flex flex-wrap gap-1"
            role="radiogroup"
            :aria-label="t('vault.kind')"
            data-testid="f-kind"
          >
            <button
              v-for="k in KIND_ORDER"
              :key="k"
              type="button"
              role="radio"
              class="inline-flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1 text-xs font-medium transition-colors"
              :class="
                form.kind === k
                  ? 'border-brand-500 bg-brand-50 text-brand-700'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300'
              "
              :aria-checked="form.kind === k"
              :data-testid="`f-kind-${k}`"
              @click="form.kind = k"
            >
              <Icon :name="KIND_ICON[k]" class="size-3.5" />{{ t(`kind.${k}`) }}
            </button>
          </div>
          <div>
            <label class="block text-sm"
              ><span class="field-label">{{ t('vault.folder') }}</span>
              <select v-model="branchChoice" class="input" data-testid="f-folder">
                <option :value="null">{{ t('vault.root') }}</option>
                <option v-for="b in branchOptions" :key="b.id" :value="b.id">{{ b.label }}</option>
              </select></label
            >
          </div>
          <div class="text-sm">
            <label for="f-title" class="field-label">{{ t('vault.entryTitle') }}</label>
            <div class="flex gap-1.5">
              <!-- значок рядом с названием: нажатие раскрывает компактный выбор под полем -->
              <button
                type="button"
                class="shrink-0 rounded-[10px] focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
                :aria-label="t('icons.title')"
                :aria-expanded="iconOpen"
                data-testid="f-icon"
                @click="iconOpen = !iconOpen"
              >
                <ObjectIcon :icon="form.icon" kind="entry" :label="form.title" />
              </button>
              <input
                id="f-title"
                v-model="form.title"
                required
                maxlength="200"
                class="input"
                data-testid="f-title"
              />
            </div>
            <IconPicker
              v-if="iconOpen"
              v-model="form.icon"
              kind="entry"
              :label="form.title"
              class="mt-2 rounded-[10px] border border-slate-200 p-2 dark:border-slate-700"
            />
          </div>
          <template v-if="form.kind !== 'note'">
            <label class="block text-sm"
              ><span class="field-label">{{
                form.kind === 'apikey' ? t('kindFields.service') : t('vault.username')
              }}</span>
              <input
                v-model="form.username"
                maxlength="300"
                autocomplete="off"
                class="input"
                data-testid="f-username"
            /></label>
            <div class="text-sm">
              <span class="field-label">{{
                form.kind === 'apikey' ? t('vault.secret') : t('vault.password')
              }}</span>
              <div class="flex gap-1">
                <input
                  v-model="form.password"
                  :type="showPw ? 'text' : 'password'"
                  autocomplete="new-password"
                  class="input font-mono"
                  :aria-label="form.kind === 'apikey' ? t('vault.secret') : t('vault.password')"
                  data-testid="f-password"
                />
                <button type="button" class="btn" @click="showPw = !showPw">
                  {{ showPw ? t('common.hide') : t('common.show') }}
                </button>
              </div>
              <PasswordGenerator
                v-if="showGenerator"
                class="mt-2"
                :min-length="policy.minLength"
                @use="useGenerated"
              />
              <div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <button
                  type="button"
                  class="text-brand-600 underline"
                  data-testid="btn-generator"
                  :aria-expanded="showGenerator"
                  @click="showGenerator = !showGenerator"
                >
                  {{ showGenerator ? t('generator.close') : t('generator.open') }}
                </button>
                <button
                  type="button"
                  class="text-brand-600 underline"
                  data-testid="btn-generate"
                  @click="generate('password')"
                >
                  {{ t('vault.generate') }}
                </button>
                <button
                  type="button"
                  class="text-brand-600 underline"
                  data-testid="btn-phrase"
                  @click="generate('phrase')"
                >
                  {{ t('vault.generatePhrase') }}
                </button>
                <span
                  v-if="form.password"
                  :class="
                    strength.score >= 3
                      ? 'text-emerald-600'
                      : strength.score === 2
                        ? 'text-amber-600'
                        : 'text-red-600'
                  "
                  data-testid="strength"
                  >{{ t(`strength.${strength.score}`) }} · {{ strength.bits }}
                  {{ t('vault.bits') }}</span
                >
              </div>
            </div>
            <label class="block text-sm"
              ><span class="field-label">{{ t(`kindFields.url.${form.kind}`) }}</span>
              <input
                v-model="form.url"
                maxlength="500"
                class="input"
                :placeholder="URL_HINT[form.kind]"
                data-testid="f-url"
            /></label>
          </template>
          <label class="block text-sm"
            ><span class="field-label">{{
              form.kind === 'note' ? t('kindFields.noteText') : t('vault.notes')
            }}</span>
            <textarea
              v-model="form.notes"
              :rows="form.kind === 'note' ? 8 : 2"
              maxlength="20000"
              class="input"
              data-testid="f-notes"
            />
          </label>

          <!-- необязательное — под раскрытием; открыто, если что-то из этого уже заполнено -->
          <details
            class="rounded-[10px] border border-slate-200 dark:border-slate-800"
            :open="moreOpen"
            data-testid="f-more"
            @toggle="moreOpen = ($event.target as HTMLDetailsElement).open"
          >
            <summary
              class="cursor-pointer select-none px-3 py-2 text-sm font-medium text-slate-600 dark:text-slate-300"
            >
              {{ t('kindFields.more') }}
            </summary>
            <div class="space-y-3 border-t border-slate-200 p-3 dark:border-slate-800">
              <template v-if="form.kind !== 'note'">
                <label class="block text-sm"
                  ><span class="field-label">{{ t('vault.totpSecret') }}</span>
                  <input
                    v-model="form.totp"
                    autocomplete="off"
                    spellcheck="false"
                    class="input font-mono"
                    data-testid="f-totp"
                    placeholder="otpauth://… / JBSWY3DPEHPK3PXP"
                  />
                  <span v-if="code" class="mt-1 block font-mono text-xs text-slate-500"
                    >{{ t('vault.totpPreview') }}: {{ code }}</span
                  ></label
                >
              </template>
              <fieldset class="space-y-2">
                <legend class="text-sm">{{ t('vault.fields') }}</legend>
                <div v-for="(f, i) in form.fields" :key="i" class="flex gap-1">
                  <input
                    v-model="f.name"
                    :placeholder="t('vault.fieldName')"
                    class="input"
                    :data-testid="`field-name-${i}`"
                  />
                  <input
                    v-model="f.value"
                    :type="f.secret ? 'password' : 'text'"
                    :placeholder="t('vault.fieldValue')"
                    class="input"
                    :data-testid="`field-value-${i}`"
                  />
                  <div
                    class="flex shrink-0 gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800"
                    role="radiogroup"
                    :aria-label="t('vault.fieldType')"
                  >
                    <button
                      v-for="opt in FIELD_TYPES"
                      :key="opt.key"
                      type="button"
                      role="radio"
                      class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors"
                      :class="
                        f.secret === opt.secret
                          ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-50'
                          : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                      "
                      :aria-checked="f.secret === opt.secret"
                      :data-testid="`field-type-${opt.key}-${i}`"
                      @click="f.secret = opt.secret"
                    >
                      <Icon :name="opt.icon" class="size-3.5" />
                      {{ t(opt.label) }}
                    </button>
                  </div>
                  <button type="button" class="btn" @click="form.fields.splice(i, 1)">×</button>
                </div>
                <button type="button" class="btn" data-testid="btn-add-field" @click="addField">
                  {{ t('vault.addField') }}
                </button>
              </fieldset>

              <fieldset class="space-y-1 text-sm" data-testid="links-editor">
                <legend class="text-xs text-slate-500">{{ t('vault.links') }}</legend>
                <div class="flex flex-wrap gap-1">
                  <span v-for="id in form.links ?? []" :key="id" class="badge">
                    {{ titleOf(id) || '…' }}
                    <button
                      type="button"
                      class="ml-1"
                      :aria-label="t('vault.links')"
                      @click="removeLink(id)"
                    >
                      ×
                    </button>
                  </span>
                </div>
                <div class="flex gap-2">
                  <select
                    v-model="linkChoice"
                    class="input"
                    :aria-label="t('vault.links')"
                    data-testid="f-link-select"
                  >
                    <option value="">—</option>
                    <option v-for="e in siblings" :key="e.id" :value="e.id">
                      {{ e.data.title }}
                    </option>
                  </select>
                  <button
                    type="button"
                    class="btn"
                    :disabled="!linkChoice"
                    data-testid="btn-add-link"
                    @click="addLink"
                  >
                    {{ t('vault.addLink') }}
                  </button>
                </div>
              </fieldset>

              <div class="grid grid-cols-2 gap-2">
                <label class="block text-sm"
                  ><span class="field-label">{{ t('vault.tags') }}</span>
                  <input
                    v-model="tagsText"
                    class="input"
                    data-testid="f-tags"
                    placeholder="work, prod"
                /></label>
                <label class="block text-sm"
                  ><span class="field-label">{{ t('vault.expires') }}</span>
                  <input v-model="form.expiresAt" type="date" class="input"
                /></label>
              </div>
            </div>
          </details>

          <p v-if="error" class="text-sm text-red-600" role="alert" data-testid="form-error">
            {{ error }}
          </p>
          <div
            class="sticky bottom-0 -mx-1 flex gap-2 bg-white/95 px-1 py-2 backdrop-blur dark:bg-slate-900/95"
          >
            <button type="submit" class="btn-primary" :disabled="busy" data-testid="f-save">
              {{ t('common.save') }}
            </button>
            <button type="button" class="btn" @click="cancelEditing">
              {{ t('common.cancel') }}
            </button>
          </div>
        </form>
        <p v-else class="text-sm text-slate-500">{{ t('vault.selectEntry') }}</p>
      </div>
    </section>
  </Teleport>
</template>
