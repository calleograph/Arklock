<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
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
import IconButton from './IconButton.vue';
import { errorMessage } from '../services/helpers';
import { api } from '../services/api';
import { openSink } from '../services/download';
import { NO_POLICY, checkPolicy, policyFrom, type PasswordPolicy } from '../services/policy';
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
const tab = ref<'details' | 'history' | 'files' | 'share'>('details');
const branchChoice = ref<string | null>(props.item?.branchId ?? props.branchId);

// Сброс вкладок и состояния только при смене записи или режима. Строковый ключ: массив в геттере
// считался бы изменённым при каждом обновлении объекта записи (фоновая перезагрузка) и сбрасывал бы вкладку.
watch(
  () => `${props.item?.id ?? ''}|${props.creating}`,
  () => {
    editing.value = props.creating;
    form.value = props.item ? clone(normalizeEntry(props.item.data)) : blankEntry();
    tagsText.value = form.value.tags.join(', ');
    showPw.value = false;
    revealed.value = new Set();
    error.value = '';
    tab.value = 'details';
    branchChoice.value = props.item?.branchId ?? props.branchId;
    history.value = null;
    files.value = null;
    confirmFile.value = '';
    link.value = '';
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

// ---- буфер обмена
const copied = ref('');
async function copy(label: string, value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = label;
    setTimeout(async () => {
      copied.value = '';
      try {
        if ((await navigator.clipboard.readText()) === value)
          await navigator.clipboard.writeText('');
      } catch {
        /* чтение буфера может быть запрещено */
      }
    }, 30_000);
  } catch {
    /* буфер недоступен */
  }
}

// ---- политика паролей организации
const policy = ref<PasswordPolicy>(NO_POLICY);
void api<Record<string, unknown>>('GET', '/auth/policy')
  .then((p) => (policy.value = policyFrom(p)))
  .catch(() => undefined);

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
  if (props.item) {
    editing.value = false;
    form.value = clone(normalizeEntry(props.item.data));
  } else {
    emit('cancel');
  }
}

/** Панель генератора открывается по кнопке под полем пароля; выбранный пароль подставляется в форму. */
const showGenerator = ref(false);
function useGenerated(value: string): void {
  form.value.password = value;
  showPw.value = true;
  showGenerator.value = false;
}

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
  tab.value = 'history';
  if (props.item) history.value = await ws.revisions(props.item);
}
async function revert(id: string): Promise<void> {
  if (!props.item) return;
  busy.value = true;
  try {
    await ws.restoreRevision(props.item, id);
    emit('changed');
    history.value = null;
    tab.value = 'details';
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
  tab.value = 'files';
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
  if (!props.item || !picked.length) return;
  busy.value = true;
  error.value = '';
  try {
    for (const f of picked) {
      if (f.size > storage.value.maxMiB * 1024 * 1024) {
        error.value = t('files.tooLarge');
        continue;
      }
      progress.value = { label: f.name, done: 0, total: f.size || 1 };
      await ws.attachmentAdd(props.item, f, (done, total) => {
        progress.value = { label: f.name, done, total };
      });
    }
    files.value = await ws.attachmentList(props.item);
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
  if (!props.item) return;
  busy.value = true;
  error.value = '';
  try {
    link.value = await ws.createLink(props.item, {
      passphrase: share.value.passphrase,
      expiresInMinutes: Number(share.value.minutes),
      maxViews: Number(share.value.views),
      includeNotes: share.value.notes,
    });
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

const fmt = (iso: string) => new Date(iso).toLocaleString();
void api;
</script>

<template>
  <!-- В режиме создания и редактирования форма открывается модальным окном поверх страницы -->
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
    @keydown.esc="cancelEditing"
  >
    <div :class="editing ? 'card w-full max-w-2xl p-4 shadow-xl' : 'contents'">
      <!-- Просмотр -->
      <template v-if="item && !editing">
        <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0">
            <h2 class="truncate text-lg font-semibold" data-testid="view-title">
              {{ item.data.title }}
            </h2>
            <div class="mt-1 flex flex-wrap gap-1">
              <span class="badge">{{ t(`kind.${item.data.kind}`) }}</span>
              <span v-for="tag in item.data.tags" :key="tag" class="badge">#{{ tag }}</span>
            </div>
          </div>
          <div class="flex gap-1">
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
          </div>
        </div>

        <div class="mb-3 flex gap-1 border-b border-slate-200 text-sm dark:border-slate-800">
          <button
            type="button"
            class="px-3 py-1"
            :class="tab === 'details' ? 'border-b-2 border-brand-500 font-medium' : ''"
            @click="tab = 'details'"
          >
            {{ t('vault.details') }}
          </button>
          <button
            type="button"
            class="px-3 py-1"
            :class="tab === 'history' ? 'border-b-2 border-brand-500 font-medium' : ''"
            data-testid="tab-history"
            @click="loadHistory"
          >
            {{ t('vault.history') }}
          </button>
          <button
            type="button"
            class="px-3 py-1"
            :class="tab === 'files' ? 'border-b-2 border-brand-500 font-medium' : ''"
            data-testid="tab-files"
            @click="openFiles"
          >
            {{ t('files.tab') }}
          </button>
          <button
            type="button"
            class="px-3 py-1"
            :class="tab === 'share' ? 'border-b-2 border-brand-500 font-medium' : ''"
            data-testid="tab-share"
            @click="tab = 'share'"
          >
            {{ t('vault.share') }}
          </button>
        </div>

        <dl v-if="tab === 'details'" class="space-y-3 text-sm">
          <div v-if="item.data.username">
            <dt class="text-xs text-slate-500">{{ t('vault.username') }}</dt>
            <dd class="flex items-center justify-between gap-2">
              <span class="break-all" data-testid="view-username">{{ item.data.username }}</span>
              <button type="button" class="btn" @click="copy('username', item.data.username)">
                {{ copied === 'username' ? t('common.copied') : t('common.copy') }}
              </button>
            </dd>
          </div>
          <div v-if="item.data.password">
            <dt class="text-xs text-slate-500">
              {{ item.data.kind === 'apikey' ? t('vault.secret') : t('vault.password') }}
            </dt>
            <dd class="flex items-center justify-between gap-2">
              <span class="break-all font-mono" data-testid="view-password">{{
                revealed.has(-1) ? item.data.password : '••••••••••'
              }}</span>
              <span class="flex shrink-0 gap-1">
                <button
                  type="button"
                  class="btn"
                  data-testid="btn-reveal"
                  @click="
                    revealed.has(-1) ? revealed.delete(-1) : revealed.add(-1);
                    revealed = new Set(revealed);
                  "
                >
                  {{ revealed.has(-1) ? t('common.hide') : t('common.show') }}
                </button>
                <button
                  type="button"
                  class="btn"
                  data-testid="btn-copy-password"
                  @click="copy('password', item.data.password)"
                >
                  {{ copied === 'password' ? t('common.copied') : t('common.copy') }}
                </button>
              </span>
            </dd>
          </div>
          <div v-if="linkedEntries.length" data-testid="links-view">
            <dt class="text-xs text-slate-500">{{ t('vault.links') }}</dt>
            <dd class="flex flex-wrap gap-1">
              <button
                v-for="l in linkedEntries"
                :key="l.id"
                type="button"
                class="btn"
                data-testid="link-open"
                @click="emit('open', l.id)"
              >
                🔗 {{ l.title }}
              </button>
            </dd>
          </div>
          <div v-if="item.data.url">
            <dt class="text-xs text-slate-500">{{ t('vault.url') }}</dt>
            <dd class="break-all">
              <a
                v-if="/^https?:\/\//i.test(item.data.url)"
                :href="item.data.url"
                target="_blank"
                rel="noopener noreferrer"
                class="text-brand-600 underline"
                >{{ item.data.url }}</a
              >
              <span v-else>{{ item.data.url }}</span>
            </dd>
          </div>
          <div v-if="code">
            <dt class="text-xs text-slate-500">{{ t('vault.totp') }}</dt>
            <dd class="flex items-center justify-between gap-2">
              <span class="font-mono text-lg tracking-widest" data-testid="view-totp">{{
                code
              }}</span>
              <span class="text-xs text-slate-500">{{ remaining }} {{ t('vault.sec') }}</span>
              <button type="button" class="btn" @click="copy('totp', code)">
                {{ copied === 'totp' ? t('common.copied') : t('common.copy') }}
              </button>
            </dd>
          </div>
          <div v-for="(f, i) in item.data.fields" :key="i">
            <dt class="text-xs text-slate-500">{{ f.name }}</dt>
            <dd class="flex items-center justify-between gap-2">
              <span class="break-all" :class="f.secret ? 'font-mono' : ''">{{
                f.secret && !revealed.has(i) ? '••••••••' : f.value
              }}</span>
              <span class="flex gap-1">
                <button
                  v-if="f.secret"
                  type="button"
                  class="btn"
                  @click="
                    revealed.has(i) ? revealed.delete(i) : revealed.add(i);
                    revealed = new Set(revealed);
                  "
                >
                  {{ revealed.has(i) ? t('common.hide') : t('common.show') }}
                </button>
                <button type="button" class="btn" @click="copy('f' + i, f.value)">
                  {{ copied === 'f' + i ? t('common.copied') : t('common.copy') }}
                </button>
              </span>
            </dd>
          </div>
          <div v-if="item.data.notes">
            <dt class="text-xs text-slate-500">{{ t('vault.notes') }}</dt>
            <dd class="whitespace-pre-wrap break-words" data-testid="view-notes">
              {{ item.data.notes }}
            </dd>
          </div>
          <div class="text-xs text-slate-500">
            {{ t('vault.updated') }}: {{ fmt(item.updatedAt) }}
            <span v-if="item.data.expiresAt">
              · {{ t('vault.expires') }}: {{ item.data.expiresAt }}</span
            >
          </div>
        </dl>

        <div v-else-if="tab === 'files'" class="space-y-3 text-sm" data-testid="files-panel">
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

        <div v-else-if="tab === 'history'" data-testid="history-list">
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
                  {{ h.data ? `${h.data.title} · ${h.data.username}` : t('vault.undecryptable') }}
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

        <div v-else class="space-y-3 text-sm">
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
        <p v-if="error" class="mt-2 text-sm text-red-600" role="alert">{{ error }}</p>
      </template>

      <!-- Редактор -->
      <form v-else-if="editing" class="space-y-3" data-testid="entry-form" @submit.prevent="save">
        <h2 class="font-semibold">{{ item ? t('vault.edit') : t('vault.add') }}</h2>
        <div class="grid grid-cols-2 gap-2">
          <label class="block text-sm"
            ><span class="mb-1 block">{{ t('vault.kind') }}</span>
            <select v-model="form.kind" class="input" data-testid="f-kind">
              <option v-for="k in ENTRY_KINDS" :key="k" :value="k">{{ t(`kind.${k}`) }}</option>
            </select></label
          >
          <label class="block text-sm"
            ><span class="mb-1 block">{{ t('vault.folder') }}</span>
            <select v-model="branchChoice" class="input" data-testid="f-folder">
              <option :value="null">{{ t('vault.root') }}</option>
              <option v-for="b in branchOptions" :key="b.id" :value="b.id">{{ b.label }}</option>
            </select></label
          >
        </div>
        <label class="block text-sm"
          ><span class="mb-1 block">{{ t('vault.entryTitle') }}</span>
          <input v-model="form.title" required maxlength="200" class="input" data-testid="f-title"
        /></label>
        <template v-if="form.kind !== 'note'">
          <label class="block text-sm"
            ><span class="mb-1 block">{{
              form.kind === 'apikey' ? t('vault.keyId') : t('vault.username')
            }}</span>
            <input
              v-model="form.username"
              maxlength="300"
              autocomplete="off"
              class="input"
              data-testid="f-username"
          /></label>
          <div class="text-sm">
            <span class="mb-1 block">{{
              form.kind === 'apikey' ? t('vault.secret') : t('vault.password')
            }}</span>
            <div class="flex gap-1">
              <input
                v-model="form.password"
                :type="showPw ? 'text' : 'password'"
                autocomplete="new-password"
                class="input font-mono"
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
            ><span class="mb-1 block">{{ t('vault.url') }}</span>
            <input v-model="form.url" maxlength="500" class="input" data-testid="f-url"
          /></label>
          <label class="block text-sm"
            ><span class="mb-1 block">{{ t('vault.totpSecret') }}</span>
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
        <label class="block text-sm"
          ><span class="mb-1 block">{{ t('vault.notes') }}</span>
          <textarea
            v-model="form.notes"
            rows="form.kind === 'note' ? 8 : 3"
            maxlength="20000"
            class="input"
            data-testid="f-notes"
          />
        </label>

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
            <label class="flex items-center gap-1 text-xs"
              ><input v-model="f.secret" type="checkbox" />{{ t('vault.secretField') }}</label
            >
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
            <select v-model="linkChoice" class="input" data-testid="f-link-select">
              <option value="">—</option>
              <option v-for="e in siblings" :key="e.id" :value="e.id">{{ e.data.title }}</option>
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
            ><span class="mb-1 block">{{ t('vault.tags') }}</span>
            <input v-model="tagsText" class="input" data-testid="f-tags" placeholder="work, prod"
          /></label>
          <label class="block text-sm"
            ><span class="mb-1 block">{{ t('vault.expires') }}</span>
            <input v-model="form.expiresAt" type="date" class="input"
          /></label>
        </div>

        <p v-if="error" class="text-sm text-red-600" role="alert" data-testid="form-error">
          {{ error }}
        </p>
        <div class="flex gap-2">
          <button type="submit" class="btn-primary" :disabled="busy" data-testid="f-save">
            {{ t('common.save') }}
          </button>
          <button
            type="button"
            class="btn"
            @click="
              item ? ((editing = false), (form = clone(normalizeEntry(item.data)))) : emit('cancel')
            "
          >
            {{ t('common.cancel') }}
          </button>
        </div>
      </form>
      <p v-else class="text-sm text-slate-500">{{ t('vault.selectEntry') }}</p>
      <span class="hidden">{{ vault.id }}</span>
    </div>
  </section>
</template>
