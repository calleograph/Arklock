<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  CSV_FIELDS,
  decryptExport,
  detectFormat,
  exportCsv,
  exportEncrypted,
  exportJson,
  findDuplicates,
  guessCsvMapping,
  importArklockJson,
  importBitwardenJson,
  importPassworkJson,
  importCsv,
  importKeepassXml,
  parseCsv,
  type CsvField,
  type ImportFormat,
  type ImportItem,
  type ImportResult,
} from '../services/transfer';
import type { BranchItem, EntryItem } from '../services/model';
import { useWorkspaceStore } from '../stores/workspace';

const props = defineProps<{ branches: BranchItem[]; entries: EntryItem[]; canWrite: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>();
const { t } = useI18n();
const ws = useWorkspaceStore();

const mode = ref<'import' | 'export'>('import');
const error = ref('');
const busy = ref(false);

// ---- импорт
const fileText = ref('');
const format = ref<ImportFormat>('csv');
const rows = ref<string[][]>([]);
const mapping = ref<CsvField[]>([]);
const passphrase = ref('');
const result = ref<ImportResult | null>(null);
const skipDuplicates = ref(true);
const progress = ref(0);
const report = ref<{ created: number; skipped: number; failed: number } | null>(null);

async function onFile(ev: Event): Promise<void> {
  error.value = '';
  result.value = null;
  report.value = null;
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (!f) return;
  if (f.size > 20 * 1024 * 1024) {
    error.value = t('transfer.tooBig');
    return;
  }
  fileText.value = await f.text();
  format.value = detectFormat(f.name, fileText.value);
  if (format.value === 'csv') {
    rows.value = parseCsv(fileText.value);
    mapping.value = guessCsvMapping(rows.value[0] ?? []);
  }
  await preview();
}

async function preview(): Promise<void> {
  error.value = '';
  try {
    let text = fileText.value;
    if (format.value === 'encrypted') {
      if (!passphrase.value) return;
      busy.value = true;
      text = await decryptExport(text, passphrase.value).finally(() => (busy.value = false));
      result.value = importArklockJson(text);
    } else if (format.value === 'csv') result.value = importCsv(rows.value, mapping.value, true);
    else if (format.value === 'bitwarden') result.value = importBitwardenJson(text);
    else if (format.value === 'passwork') result.value = importPassworkJson(text);
    else if (format.value === 'keepass') result.value = importKeepassXml(text);
    else result.value = importArklockJson(text);
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

const dups = computed(() =>
  result.value ? findDuplicates(result.value.items, props.entries) : null,
);
const isDup = (i: number) =>
  !!dups.value && (dups.value.duplicateOfExisting.has(i) || dups.value.duplicateInFile.has(i));

async function runImport(): Promise<void> {
  if (!result.value) return;
  busy.value = true;
  error.value = '';
  progress.value = 0;
  let created = 0,
    skipped = 0,
    failed = 0;
  const folderIds = new Map<string, string>(); // путь → id
  for (const b of props.branches) {
    const parts: string[] = [];
    let cur: BranchItem | undefined = b;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.name);
      cur = props.branches.find((x) => x.id === cur!.parentId);
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
        // значок папки из выгрузки Arklock восстанавливается вместе с папкой
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
      await ws.saveEntry(items[i]!.data, undefined, branchId);
      created++;
    } catch {
      failed++;
    }
    progress.value = i + 1;
  }
  report.value = { created, skipped, failed };
  busy.value = false;
  emit('done');
}

// ---- экспорт
const exportFormat = ref<'json' | 'csv' | 'encrypted'>('encrypted');
const confirmPlain = ref(false);
const exportPass = ref('');
const exportPass2 = ref('');

const pathOf = (id: string | null) => {
  const out: string[] = [];
  let cur = id;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const b = props.branches.find((x) => x.id === cur);
    if (!b) break;
    out.unshift(b.name);
    cur = b.parentId;
  }
  return out.join('/');
};

async function download(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    let body: string, name: string, type: string;
    if (exportFormat.value === 'csv') {
      body = exportCsv(props.entries, pathOf);
      name = 'arklock-export.csv';
      type = 'text/csv';
    } else if (exportFormat.value === 'json') {
      body = exportJson(props.entries, props.branches);
      name = 'arklock-export.json';
      type = 'application/json';
    } else {
      if (exportPass.value.length < 12) throw new Error(t('transfer.passTooShort'));
      if (exportPass.value !== exportPass2.value) throw new Error(t('auth.mismatch'));
      body = await exportEncrypted(exportJson(props.entries, props.branches), exportPass.value);
      name = 'arklock-export.encrypted.json';
      type = 'application/json';
    }
    const url = URL.createObjectURL(new Blob([body], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    await ws.audit('export', exportFormat.value, props.entries.length);
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('error.generic');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
  >
    <div class="card max-h-[90vh] w-full max-w-2xl overflow-auto p-4" data-testid="transfer-dialog">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="font-semibold">{{ t('transfer.title') }}</h2>
        <button type="button" class="btn" @click="emit('close')">✕</button>
      </div>
      <div class="mb-3 flex gap-1 border-b border-slate-200 text-sm dark:border-slate-800">
        <button
          type="button"
          class="px-3 py-1"
          :class="mode === 'import' ? 'border-b-2 border-brand-500 font-medium' : ''"
          data-testid="tab-import"
          @click="mode = 'import'"
        >
          {{ t('transfer.import') }}
        </button>
        <button
          type="button"
          class="px-3 py-1"
          :class="mode === 'export' ? 'border-b-2 border-brand-500 font-medium' : ''"
          data-testid="tab-export"
          @click="mode = 'export'"
        >
          {{ t('transfer.export') }}
        </button>
      </div>

      <div v-if="mode === 'import'" class="space-y-3 text-sm">
        <p v-if="!canWrite" class="text-amber-700">{{ t('transfer.readOnly') }}</p>
        <p class="text-slate-500">{{ t('transfer.formats') }}</p>
        <input
          type="file"
          accept=".csv,.json,.xml,.txt"
          data-testid="import-file"
          @change="onFile"
        />
        <div v-if="format === 'encrypted' && fileText" class="flex gap-2">
          <input
            v-model="passphrase"
            type="password"
            class="input"
            :placeholder="t('transfer.passphrase')"
            data-testid="import-pass"
          />
          <button
            type="button"
            class="btn"
            :disabled="busy"
            data-testid="import-decrypt"
            @click="preview"
          >
            {{ t('transfer.decrypt') }}
          </button>
        </div>
        <div v-if="format === 'csv' && rows.length" class="overflow-x-auto">
          <p class="mb-1 text-xs text-slate-500">{{ t('transfer.mapping') }}</p>
          <table class="min-w-full text-xs">
            <thead>
              <tr>
                <th v-for="(h, i) in rows[0]" :key="i" class="px-1 text-left">
                  <div class="truncate text-slate-500">{{ h }}</div>
                  <select
                    v-model="mapping[i]"
                    class="input !py-0.5 text-xs"
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
          </table>
        </div>
        <div v-if="result" data-testid="import-preview">
          <p>
            {{ t('transfer.found', { n: result.items.length })
            }}<span v-if="dups && (dups.duplicateOfExisting.size || dups.duplicateInFile.size)"
              >,
              {{
                t('transfer.duplicates', {
                  n: new Set([...dups.duplicateOfExisting, ...dups.duplicateInFile]).size,
                })
              }}</span
            >
          </p>
          <ul
            class="mt-1 max-h-40 overflow-auto rounded border border-slate-200 text-xs dark:border-slate-800"
          >
            <li
              v-for="(it, i) in result.items.slice(0, 100)"
              :key="i"
              class="flex justify-between border-b border-slate-100 px-2 py-0.5 last:border-0 dark:border-slate-800"
            >
              <span class="truncate"
                >{{ it.path.join(' / ') ? it.path.join(' / ') + ' / ' : ''
                }}{{ it.data.title }}</span
              ><span v-if="isDup(i)" class="badge">{{ t('transfer.dup') }}</span>
            </li>
          </ul>
          <ul v-if="result.errors.length" class="mt-1 text-xs text-amber-700">
            <li v-for="(er, i) in result.errors.slice(0, 10)" :key="i">{{ er }}</li>
          </ul>
          <label class="mt-2 flex items-center gap-2"
            ><input v-model="skipDuplicates" type="checkbox" />
            {{ t('transfer.skipDuplicates') }}</label
          >
          <button
            type="button"
            class="btn-primary mt-2"
            :disabled="busy || !canWrite || !result.items.length"
            data-testid="import-run"
            @click="runImport"
          >
            {{ t('transfer.run') }}
          </button>
          <span v-if="busy" class="ml-2 text-xs">{{ progress }} / {{ result.items.length }}</span>
        </div>
        <p
          v-if="report"
          class="rounded-md bg-emerald-50 p-2 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
          data-testid="import-report"
        >
          {{ t('transfer.report', report) }}
        </p>
      </div>

      <div v-else class="space-y-3 text-sm">
        <label class="block"
          ><span class="field-label">{{ t('transfer.format') }}</span>
          <select v-model="exportFormat" class="input" data-testid="export-format">
            <option value="encrypted">{{ t('transfer.fmtEncrypted') }}</option>
            <option value="json">{{ t('transfer.fmtJson') }}</option>
            <option value="csv">CSV</option>
          </select></label
        >
        <template v-if="exportFormat === 'encrypted'">
          <input
            v-model="exportPass"
            type="password"
            autocomplete="new-password"
            class="input"
            :placeholder="t('transfer.passphrase')"
            data-testid="export-pass"
          />
          <input
            v-model="exportPass2"
            type="password"
            autocomplete="new-password"
            class="input"
            :placeholder="t('auth.repeat')"
            data-testid="export-pass2"
          />
        </template>
        <label
          v-else
          class="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <input v-model="confirmPlain" type="checkbox" class="mt-1" data-testid="export-confirm" />
          <span>{{ t('transfer.plainWarning') }}</span></label
        >
        <button
          type="button"
          class="btn-primary"
          :disabled="busy || (exportFormat !== 'encrypted' && !confirmPlain)"
          data-testid="export-run"
          @click="download"
        >
          {{ t('transfer.download') }}
        </button>
      </div>
      <p v-if="error" class="mt-2 text-sm text-red-600" role="alert" data-testid="transfer-error">
        {{ error }}
      </p>
    </div>
  </div>
</template>
