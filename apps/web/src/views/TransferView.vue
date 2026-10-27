<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import Icon from '../components/Icon.vue';
import InfoHint from '../components/InfoHint.vue';
import { copyWithAutoClear } from '../services/clipboard';
import { errorMessage, spaceLabel, vaultLabel } from '../services/helpers';
import {
  CSV_FIELDS,
  decryptExport,
  detectFormat,
  exportCsvParts,
  exportEncrypted,
  exportJsonV2,
  findDuplicates,
  generateArchivePassword,
  guessCsvMapping,
  importArklockJson,
  importBitwardenJson,
  importCsv,
  importKeepassXml,
  importPassworkJson,
  looksLikeHeader,
  parseCsv,
  positionalMapping,
  type CsvField,
  type ExportAttachment,
  type ImportFormat,
  type ImportItem,
  type ImportResult,
} from '../services/transfer';
import type { BranchItem, EntryItem } from '../services/model';
import { useWorkspaceStore } from '../stores/workspace';

/**
 * «Импорт и экспорт»: перенос паролей между сейфами и из других программ. Всё считается в браузере —
 * открытые данные и пароль архива на сервер не отправляются. Сервер отдаёт только то, что пользователю разрешено читать.
 */
const { t } = useI18n();
const ws = useWorkspaceStore();
const route = useRoute();
const router = useRouter();

const tab = computed<'import' | 'export'>({
  get: () => (route.query.tab === 'export' ? 'export' : 'import'),
  set: (v) => void router.replace({ query: { ...route.query, tab: v } }),
});
const error = ref('');
const busy = ref(false);

onMounted(async () => {
  try {
    if (!ws.vaults.length) await ws.loadVaults();
    pickDefaults();
  } catch (e) {
    error.value = errorMessage(e, t);
  }
});

// ---- где что лежит
interface Scope {
  id: string;
  label: string;
  vaults: { id: string; label: string; writable: boolean; readable: boolean; problem?: string }[];
}
const scopes = computed<Scope[]>(() => {
  const view = (v: (typeof ws.vaults)[number]) => ({
    id: v.id,
    label: v.kind === 'locker' ? t('transfer.personalVault') : vaultLabel(v, t),
    writable: v.unlocked && v.permissions.includes('entry.create'),
    readable: v.unlocked && v.permissions.includes('entry.read'),
    problem: v.unlocked ? undefined : t('transfer.noKey'),
  });
  const out: Scope[] = ws.spaces.map((s) => ({
    id: s.id,
    label: spaceLabel(s, t),
    vaults: ws.vaults.filter((v) => v.spaceId === s.id && v.kind !== 'locker').map(view),
  }));
  const locker = ws.vaults.find((v) => v.kind === 'locker');
  if (ws.personalAllowed && locker)
    out.push({ id: 'personal', label: t('transfer.personal'), vaults: [view(locker)] });
  return out.filter((s) => s.vaults.length);
});
const scopeOf = (id: string) => scopes.value.find((s) => s.id === id);

// ---- импорт: куда
const impScope = ref('');
const impVault = ref('');
const impVaults = computed(() => scopeOf(impScope.value)?.vaults.filter((v) => v.writable) ?? []);
const impScopes = computed(() => scopes.value.filter((s) => s.vaults.some((v) => v.writable)));
function pickDefaults(): void {
  const want = (route.query.vault as string | undefined) ?? ws.currentId ?? '';
  const home =
    scopes.value.find((s) => s.vaults.some((v) => v.id === want && v.writable)) ??
    impScopes.value[0];
  impScope.value = home?.id ?? '';
  impVault.value =
    home?.vaults.find((v) => v.id === want && v.writable)?.id ??
    home?.vaults.find((v) => v.writable)?.id ??
    '';
  const ex =
    scopes.value.find((s) => s.vaults.some((v) => v.id === want && v.readable)) ??
    scopes.value.find((s) => s.vaults.some((v) => v.readable));
  expScope.value = ex?.id ?? '';
  expVault.value =
    ex?.vaults.find((v) => v.id === want && v.readable)?.id ??
    ex?.vaults.find((v) => v.readable)?.id ??
    '';
}
watch(impScope, () => {
  if (!impVaults.value.some((v) => v.id === impVault.value))
    impVault.value = impVaults.value[0]?.id ?? '';
  void refreshExisting();
});
watch(impVault, () => void refreshExisting());

// ---- импорт: файл
const fileName = ref('');
const fileText = ref('');
const format = ref<ImportFormat>('csv');
const rows = ref<string[][]>([]);
const mapping = ref<CsvField[]>([]);
const hasHeader = ref(true);
const passphrase = ref('');
const result = ref<ImportResult | null>(null);
const skipDuplicates = ref(true);
const progress = ref(0);
const report = ref<{ created: number; skipped: number; failed: number } | null>(null);
const existing = ref<EntryItem[]>([]);
const existingBranches = ref<BranchItem[]>([]);

async function refreshExisting(): Promise<void> {
  existing.value = [];
  existingBranches.value = [];
  if (!impVault.value) return;
  try {
    const tree = await ws.readVault(impVault.value);
    existing.value = tree.entries;
    existingBranches.value = tree.branches;
  } catch {
    /* дубликаты тогда ищутся только внутри файла */
  }
}

/** Предел записей в одном импорте: больше — разбить файл на части. */
const IMPORT_MAX_ITEMS = 50_000;

const FORMATS: ImportFormat[] = ['csv', 'bitwarden', 'passwork', 'keepass', 'arklock', 'encrypted'];

async function onFile(ev: Event): Promise<void> {
  error.value = '';
  result.value = null;
  report.value = null;
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (!f) return;
  if (f.size > 200 * 1024 * 1024) {
    error.value = t('transfer.tooBig');
    return;
  }
  fileName.value = f.name;
  fileText.value = await f.text();
  format.value = detectFormat(f.name, fileText.value);
  await prepare();
}

async function prepare(): Promise<void> {
  if (format.value === 'csv') {
    rows.value = parseCsv(fileText.value);
    hasHeader.value = looksLikeHeader(rows.value);
    remap();
  }
  await preview();
}
function remap(): void {
  mapping.value = hasHeader.value
    ? guessCsvMapping(rows.value[0] ?? [])
    : positionalMapping(rows.value[0]?.length ?? 0);
}
async function onHeaderToggle(): Promise<void> {
  remap();
  await preview();
}

async function preview(): Promise<void> {
  error.value = '';
  if (!fileText.value) return;
  try {
    let text = fileText.value;
    if (format.value === 'encrypted') {
      if (!passphrase.value) {
        result.value = null;
        return;
      }
      busy.value = true;
      text = await decryptExport(text, passphrase.value).finally(() => (busy.value = false));
      result.value = importArklockJson(text);
    } else if (format.value === 'csv')
      result.value = importCsv(rows.value, mapping.value, hasHeader.value);
    else if (format.value === 'bitwarden') result.value = importBitwardenJson(text);
    else if (format.value === 'passwork') result.value = importPassworkJson(text);
    else if (format.value === 'keepass') result.value = importKeepassXml(text);
    else result.value = importArklockJson(text);
    // защита от файла с миллионами записей: браузер и сервер не должны захлебнуться одним импортом
    if (result.value && result.value.items.length > IMPORT_MAX_ITEMS) {
      result.value = null;
      error.value = t('transfer.tooMany', { n: IMPORT_MAX_ITEMS });
    }
  } catch (e) {
    result.value = null;
    error.value =
      format.value === 'encrypted'
        ? t('transfer.badPassphrase')
        : e instanceof Error
          ? e.message
          : t('error.generic');
  }
}
async function onFormat(): Promise<void> {
  result.value = null;
  await prepare();
}

const dups = computed(() =>
  result.value ? findDuplicates(result.value.items, existing.value) : null,
);
const isDup = (i: number) =>
  !!dups.value && (dups.value.duplicateOfExisting.has(i) || dups.value.duplicateInFile.has(i));
const dupCount = computed(() =>
  dups.value ? new Set([...dups.value.duplicateOfExisting, ...dups.value.duplicateInFile]).size : 0,
);
const attachmentCount = computed(
  () => result.value?.items.reduce((n, i) => n + (i.attachments?.length ?? 0), 0) ?? 0,
);

const b64ToBytes = (b64: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function runImport(): Promise<void> {
  if (!result.value || !impVault.value) return;
  busy.value = true;
  error.value = '';
  progress.value = 0;
  let created = 0,
    skipped = 0,
    failed = 0;
  try {
    await ws.audit('import', 'begin');
    // импорт идёт в выбранный сейф: он становится открытым, существующие записи не меняются
    if (ws.currentId !== impVault.value) await ws.select(impVault.value);
    const folderIds = new Map<string, string>();
    const branches = ws.branches;
    for (const b of branches) {
      const parts: string[] = [];
      let cur: BranchItem | undefined = b;
      const seen = new Set<string>();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        parts.unshift(cur.name);
        cur = branches.find((x) => x.id === cur!.parentId);
      }
      folderIds.set(parts.join('\u0000'), b.id);
    }
    const ensure = async (path: string[]): Promise<string | null> => {
      let parent: string | null = null;
      for (let i = 1; i <= path.length; i++) {
        const key = path.slice(0, i).join('\u0000');
        let id = folderIds.get(key);
        if (!id) {
          id = crypto.randomUUID();
          await ws.createBranchWithId(id, path[i - 1]!, parent, result.value?.folderIcons?.[key]);
          folderIds.set(key, id);
        }
        parent = id;
      }
      return parent;
    };
    const items: ImportItem[] = result.value.items;
    for (let i = 0; i < items.length; i++) {
      if (skipDuplicates.value && isDup(i)) {
        skipped++;
        progress.value = i + 1;
        continue;
      }
      try {
        const branchId = await ensure(items[i]!.path);
        const saved = await ws.saveEntry(items[i]!.data, undefined, branchId);
        for (const a of items[i]!.attachments ?? [])
          await ws.attachmentAdd(saved, new File([b64ToBytes(a.data)], a.name, { type: a.type }));
        created++;
      } catch {
        failed++;
      }
      progress.value = i + 1;
    }
    report.value = { created, skipped, failed };
    await ws.audit('import', 'done', undefined, created).catch(() => undefined);
    await refreshExisting();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}

// ---- экспорт
const expMode = ref<'one' | 'space' | 'all'>('one');
const expScope = ref('');
const expVault = ref('');
const expFormat = ref<'encrypted' | 'json' | 'csv'>('encrypted');
const withFiles = ref(true);
const confirmPlain = ref(false);
const archivePass = ref(generateArchivePassword());
const copied = ref(false);
const expVaults = computed(() => scopeOf(expScope.value)?.vaults.filter((v) => v.readable) ?? []);
const blocked = computed(() => scopes.value.flatMap((s) => s.vaults).filter((v) => !v.readable));
watch(expScope, () => {
  if (!expVaults.value.some((v) => v.id === expVault.value))
    expVault.value = expVaults.value[0]?.id ?? '';
});
const targets = computed(() => {
  if (expMode.value === 'one') return expVaults.value.filter((v) => v.id === expVault.value);
  if (expMode.value === 'space') return expVaults.value;
  return scopes.value.flatMap((s) => s.vaults).filter((v) => v.readable);
});
const expProgress = ref('');
const exported = ref<{ vaults: number; entries: number; files: number; skipped: number } | null>(
  null,
);

function regenerate(): void {
  archivePass.value = generateArchivePassword();
  copied.value = false;
}
async function copyPass(): Promise<void> {
  await copyWithAutoClear(archivePass.value).catch(() => undefined);
  copied.value = true;
  setTimeout(() => (copied.value = false), 3000);
}

// вложения кладутся внутрь выгрузки в Base64: предел защищает память вкладки
const FILE_MAX = 20 * 1024 * 1024;
const FILES_TOTAL_MAX = 128 * 1024 * 1024;
const toB64 = (chunks: Uint8Array[]): string => {
  let bin = '';
  for (const c of chunks)
    for (let i = 0; i < c.length; i += 0x8000)
      bin += String.fromCharCode(...c.subarray(i, i + 0x8000));
  return btoa(bin);
};

async function runExport(): Promise<void> {
  if (!targets.value.length || busy.value) return;
  busy.value = true;
  error.value = '';
  exported.value = null;
  let files = 0;
  let skippedFiles = 0;
  let bytes = 0;
  try {
    await ws.audit('export', 'begin');
    const parts: {
      name: string | null;
      branches: BranchItem[];
      entries: (EntryItem & { attachments?: ExportAttachment[] })[];
    }[] = [];
    let n = 0;
    for (const v of targets.value) {
      expProgress.value = t('transfer.reading', { name: v.label });
      const tree = await ws.readVault(v.id);
      const canFiles =
        withFiles.value &&
        expFormat.value !== 'csv' &&
        ws.vaults.find((x) => x.id === v.id)?.permissions.includes('attachment.read');
      const entries: (EntryItem & { attachments?: ExportAttachment[] })[] = tree.entries;
      if (canFiles) {
        for (const e of entries) {
          n++;
          expProgress.value = t('transfer.readingFiles', { name: v.label, n });
          const list = await ws.attachmentList(e).catch(() => []);
          for (const a of list) {
            if (a.problem || a.size > FILE_MAX || bytes + a.size > FILES_TOTAL_MAX) {
              skippedFiles++;
              continue;
            }
            const chunks: Uint8Array[] = [];
            await ws.attachmentDownload(e, a.id, {
              write: async (c) => void chunks.push(c.slice()),
            });
            bytes += a.size;
            files++;
            (e.attachments ??= []).push({ name: a.name, type: a.type, data: toB64(chunks) });
          }
        }
      }
      parts.push({ name: v.label, branches: tree.branches, entries });
    }
    expProgress.value = t('transfer.packing');
    const count = parts.reduce((s, p) => s + p.entries.length, 0);
    let body: string, name: string, type: string;
    if (expFormat.value === 'csv') {
      body = exportCsvParts(parts);
      name = 'arklock-export.csv';
      type = 'text/csv';
    } else if (expFormat.value === 'json') {
      body = exportJsonV2(parts);
      name = 'arklock-export.json';
      type = 'application/json';
    } else {
      body = await exportEncrypted(exportJsonV2(parts), archivePass.value);
      name = 'arklock-export.encrypted.json';
      type = 'application/json';
    }
    const url = URL.createObjectURL(new Blob([body], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    // в журнал попадают формат и число записей, но не пароль архива и не содержимое
    await ws.audit('export', 'done', expFormat.value, count);
    exported.value = { vaults: parts.length, entries: count, files, skipped: skippedFiles };
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    expProgress.value = '';
    busy.value = false;
  }
}
const canExport = computed(
  () =>
    targets.value.length > 0 &&
    !busy.value &&
    (expFormat.value === 'encrypted' || confirmPlain.value),
);
</script>

<template>
  <section class="max-w-3xl space-y-3" data-testid="transfer-page">
    <header class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="flex items-center gap-2">
        <Icon name="transfer" class="size-5" />{{ t('transfer.title') }}
      </h2>
      <div
        class="flex gap-1 rounded-lg bg-slate-100 p-0.5 text-sm dark:bg-slate-800"
        role="tablist"
      >
        <button
          v-for="m in ['import', 'export'] as const"
          :key="m"
          type="button"
          role="tab"
          class="seg"
          :class="tab === m ? 'seg-on' : ''"
          :aria-selected="tab === m"
          :data-testid="`tab-${m}`"
          @click="tab = m"
        >
          {{ t(`transfer.${m}`) }}
        </button>
      </div>
    </header>

    <p
      v-if="error"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      role="alert"
      data-testid="transfer-error"
    >
      {{ error }}
    </p>

    <!-- ИМПОРТ -->
    <div v-if="tab === 'import'" class="card space-y-3 p-4 text-sm" data-testid="import-panel">
      <p class="text-slate-500">{{ t('transfer.formats') }}</p>
      <div class="grid gap-x-3 gap-y-2 sm:grid-cols-2">
        <label class="block"
          ><span class="field-label">{{ t('transfer.targetSpace') }}</span>
          <select v-model="impScope" class="input" data-testid="import-space">
            <option v-for="s in impScopes" :key="s.id" :value="s.id">{{ s.label }}</option>
          </select></label
        >
        <label class="block"
          ><span class="field-label">{{ t('transfer.targetVault') }}</span>
          <select v-model="impVault" class="input" data-testid="import-vault">
            <option v-for="v in impVaults" :key="v.id" :value="v.id">{{ v.label }}</option>
          </select></label
        >
      </div>
      <p v-if="!impScopes.length" class="text-amber-700 dark:text-amber-300">
        {{ t('transfer.readOnly') }}
      </p>
      <div class="grid items-end gap-x-3 gap-y-2 sm:grid-cols-[1fr_auto]">
        <label class="block"
          ><span class="field-label">{{ t('transfer.file') }}</span>
          <input
            type="file"
            accept=".csv,.json,.xml,.txt"
            class="input"
            data-testid="import-file"
            @change="onFile"
        /></label>
        <label v-if="fileText" class="block"
          ><span class="field-label">{{ t('transfer.format') }}</span>
          <select v-model="format" class="input" data-testid="import-format" @change="onFormat">
            <option v-for="f in FORMATS" :key="f" :value="f">{{ t(`transfer.fmt.${f}`) }}</option>
          </select></label
        >
      </div>

      <div v-if="format === 'encrypted' && fileText" class="flex flex-wrap gap-2">
        <input
          v-model="passphrase"
          type="password"
          autocomplete="off"
          class="input max-w-xs"
          :placeholder="t('transfer.archivePassword')"
          data-testid="import-pass"
          @keydown.enter.prevent="preview"
        />
        <button
          type="button"
          class="btn"
          :disabled="busy || !passphrase"
          data-testid="import-decrypt"
          @click="preview"
        >
          {{ t('transfer.decrypt') }}
        </button>
      </div>

      <div v-if="format === 'csv' && rows.length" class="space-y-1">
        <label class="flex items-center gap-2"
          ><input
            v-model="hasHeader"
            type="checkbox"
            data-testid="import-header"
            @change="onHeaderToggle" />
          {{ t('transfer.skipHeader') }}
          <InfoHint :text="t('transfer.skipHeaderHint')"
        /></label>
        <div class="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-700">
          <table class="min-w-full text-xs" data-testid="import-mapping">
            <thead>
              <tr>
                <th v-for="(h, i) in rows[0]" :key="i" class="px-1.5 py-1 text-left align-top">
                  <div class="max-w-40 truncate text-slate-500" :title="h">
                    {{ hasHeader ? h : `#${i + 1}` }}
                  </div>
                  <select
                    v-model="mapping[i]"
                    class="input !py-0.5 text-xs"
                    :aria-label="t('transfer.mapping')"
                    :data-testid="`map-${i}`"
                    @change="preview"
                  >
                    <option v-for="f in CSV_FIELDS" :key="f" :value="f">
                      {{ t(`transfer.field.${f}`) }}
                    </option>
                  </select>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(r, ri) in rows.slice(hasHeader ? 1 : 0, hasHeader ? 4 : 3)"
                :key="ri"
                class="border-t border-slate-100 dark:border-slate-800"
              >
                <td
                  v-for="(c, ci) in r"
                  :key="ci"
                  class="max-w-40 truncate px-1.5 py-0.5 text-slate-600 dark:text-slate-400"
                >
                  {{ mapping[ci] === 'password' ? '••••••' : c }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="result" class="space-y-2" data-testid="import-preview">
        <p>
          {{ t('transfer.found', { n: result.items.length }) }}
          <span v-if="dupCount">, {{ t('transfer.duplicates', { n: dupCount }) }}</span>
          <span v-if="attachmentCount">, {{ t('transfer.files', { n: attachmentCount }) }}</span>
        </p>
        <ul
          class="max-h-36 overflow-auto rounded border border-slate-200 text-xs dark:border-slate-800"
        >
          <li
            v-for="(it, i) in result.items.slice(0, 100)"
            :key="i"
            class="flex justify-between gap-2 border-b border-slate-100 px-2 py-0.5 last:border-0 dark:border-slate-800"
          >
            <span class="truncate"
              >{{ it.path.length ? it.path.join(' / ') + ' / ' : '' }}{{ it.data.title }}</span
            >
            <span v-if="isDup(i)" class="badge shrink-0">{{ t('transfer.dup') }}</span>
          </li>
        </ul>
        <ul
          v-if="result.errors.length"
          class="text-xs text-amber-700 dark:text-amber-300"
          data-testid="import-errors"
        >
          <li v-for="(er, i) in result.errors.slice(0, 10)" :key="i">{{ er }}</li>
          <li v-if="result.errors.length > 10">
            {{ t('transfer.moreErrors', { n: result.errors.length - 10 }) }}
          </li>
        </ul>
        <label class="flex items-center gap-2"
          ><input v-model="skipDuplicates" type="checkbox" data-testid="import-skipdup" />
          {{ t('transfer.skipDuplicates') }}</label
        >
        <p class="text-xs text-slate-500">{{ t('transfer.noOverwrite') }}</p>
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="btn-primary"
            :disabled="busy || !impVault || !result.items.length"
            data-testid="import-run"
            @click="runImport"
          >
            {{ t('transfer.run') }}
          </button>
          <progress
            v-if="busy"
            class="h-2 w-40"
            :max="result.items.length"
            :value="progress"
            data-testid="import-progress"
          ></progress>
          <span v-if="busy" class="text-xs text-slate-500"
            >{{ progress }} / {{ result.items.length }}</span
          >
        </div>
      </div>
      <p
        v-if="report"
        class="rounded-md bg-emerald-50 p-2 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
        data-testid="import-report"
      >
        {{ t('transfer.report', report) }}
      </p>
    </div>

    <!-- ЭКСПОРТ -->
    <div v-else class="card space-y-3 p-4 text-sm" data-testid="export-panel">
      <p class="text-slate-500">{{ t('transfer.exportHint') }}</p>
      <fieldset class="flex flex-wrap gap-x-4 gap-y-1">
        <legend class="sr-only">{{ t('transfer.scope') }}</legend>
        <label
          v-for="m in ['one', 'space', 'all'] as const"
          :key="m"
          class="flex items-center gap-1.5"
        >
          <input v-model="expMode" type="radio" :value="m" :data-testid="`export-mode-${m}`" />
          {{ t(`transfer.mode.${m}`) }}
        </label>
      </fieldset>
      <div v-if="expMode !== 'all'" class="grid gap-x-3 gap-y-2 sm:grid-cols-2">
        <label class="block"
          ><span class="field-label">{{ t('transfer.space') }}</span>
          <select v-model="expScope" class="input" data-testid="export-space">
            <option
              v-for="s in scopes.filter((x) => x.vaults.some((v) => v.readable))"
              :key="s.id"
              :value="s.id"
            >
              {{ s.label }}
            </option>
          </select></label
        >
        <label v-if="expMode === 'one'" class="block"
          ><span class="field-label">{{ t('transfer.vault') }}</span>
          <select v-model="expVault" class="input" data-testid="export-vault">
            <option v-for="v in expVaults" :key="v.id" :value="v.id">{{ v.label }}</option>
          </select></label
        >
      </div>
      <p class="text-xs text-slate-500" data-testid="export-scope-note">
        {{ t('transfer.willExport', { n: targets.length }) }}
        <span v-if="blocked.length"> {{ t('transfer.blocked', { n: blocked.length }) }}</span>
      </p>

      <label class="block max-w-sm"
        ><span class="field-label">{{ t('transfer.format') }}</span>
        <select v-model="expFormat" class="input" data-testid="export-format">
          <option value="encrypted">{{ t('transfer.fmtEncrypted') }}</option>
          <option value="json">{{ t('transfer.fmtJson') }}</option>
          <option value="csv">{{ t('transfer.fmtCsv') }}</option>
        </select></label
      >

      <div
        v-if="expFormat === 'encrypted'"
        class="space-y-1.5 rounded-md border border-slate-200 p-3 dark:border-slate-700"
        data-testid="export-secure"
      >
        <span class="field-label flex items-center gap-1">
          {{ t('transfer.archivePassword') }}
          <InfoHint
            :text="t('transfer.archivePasswordHint')"
            :details="t('transfer.archiveFormat')"
          />
        </span>
        <div class="flex flex-wrap items-center gap-2">
          <input
            :value="archivePass"
            readonly
            spellcheck="false"
            class="input w-auto min-w-0 flex-1 font-mono tracking-wide"
            :aria-label="t('transfer.archivePassword')"
            data-testid="export-pass"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <button type="button" class="btn" data-testid="export-copy" @click="copyPass">
            <Icon name="copy" />{{ copied ? t('transfer.copied') : t('common.copy') }}
          </button>
          <button type="button" class="btn" data-testid="export-regenerate" @click="regenerate">
            <Icon name="dice" />{{ t('transfer.regenerate') }}
          </button>
        </div>
        <p class="text-xs text-slate-500">{{ t('transfer.passwordNote') }}</p>
      </div>
      <label
        v-else
        class="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-100"
      >
        <input v-model="confirmPlain" type="checkbox" class="mt-1" data-testid="export-confirm" />
        <span>{{ t('transfer.plainWarning') }}</span></label
      >
      <label v-if="expFormat !== 'csv'" class="flex items-center gap-2"
        ><input v-model="withFiles" type="checkbox" data-testid="export-files" />
        {{ t('transfer.withFiles') }}</label
      >
      <p v-else class="text-xs text-slate-500">{{ t('transfer.csvLimits') }}</p>

      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="btn-primary"
          :disabled="!canExport"
          data-testid="export-run"
          @click="runExport"
        >
          <Icon name="transfer" />{{ t('transfer.download') }}
        </button>
        <span
          v-if="busy"
          class="text-xs text-slate-500"
          role="status"
          data-testid="export-progress"
          >{{ expProgress }}</span
        >
      </div>
      <p
        v-if="exported"
        class="rounded-md bg-emerald-50 p-2 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
        data-testid="export-report"
      >
        {{ t('transfer.exported', exported) }}
        <span v-if="exported.skipped">
          {{ t('transfer.filesSkipped', { n: exported.skipped }) }}</span
        >
      </p>
    </div>
  </section>
</template>
