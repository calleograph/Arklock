<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVaultStore } from '../stores/vault';
import type { EntryData, EntryItem } from '../stores/vault';
import { errorMessage, generatePassword } from '../services/helpers';

const { t } = useI18n();
const vault = useVaultStore();

const query = ref('');
const editing = ref<EntryItem | null>(null);
const creating = ref(false);
const form = ref<EntryData>(blank());
const showPassword = ref(false);
const error = ref('');
const busy = ref(false);
const revealed = ref<string | null>(null);
const copiedId = ref<string | null>(null);
let clipboardTimer: ReturnType<typeof setTimeout> | null = null;

function blank(): EntryData {
  return { title: '', username: '', password: '', url: '', notes: '' };
}

onMounted(async () => {
  try {
    await vault.load();
  } catch (e) {
    error.value = errorMessage(e, t);
  }
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return vault.sorted;
  return vault.sorted.filter((i) =>
    [i.data.title, i.data.username, i.data.url].some((v) => v.toLowerCase().includes(q)),
  );
});

function openNew(): void {
  editing.value = null;
  creating.value = true;
  form.value = blank();
  showPassword.value = false;
  error.value = '';
}

function openEdit(item: EntryItem): void {
  editing.value = item;
  creating.value = true;
  form.value = { ...item.data };
  showPassword.value = false;
  error.value = '';
}

function closeForm(): void {
  creating.value = false;
  editing.value = null;
  form.value = blank();
}

async function submit(): Promise<void> {
  error.value = '';
  if (!form.value.title.trim()) {
    error.value = t('vault.titleRequired');
    return;
  }
  busy.value = true;
  try {
    await vault.save({ ...form.value, title: form.value.title.trim() }, editing.value ?? undefined);
    closeForm();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}

async function remove(item: EntryItem): Promise<void> {
  if (!window.confirm(t('common.confirmDelete'))) return;
  try {
    await vault.remove(item);
    if (editing.value?.id === item.id) closeForm();
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}

/** Копирование с автоочисткой буфера обмена через 30 секунд (если в нём всё ещё наш секрет). */
async function copySecret(item: EntryItem): Promise<void> {
  try {
    await navigator.clipboard.writeText(item.data.password);
    copiedId.value = item.id;
    if (clipboardTimer) clearTimeout(clipboardTimer);
    const secret = item.data.password;
    clipboardTimer = setTimeout(async () => {
      copiedId.value = null;
      try {
        if ((await navigator.clipboard.readText()) === secret)
          await navigator.clipboard.writeText('');
      } catch {
        /* чтение буфера может быть запрещено — тогда просто убираем отметку */
      }
    }, 30_000);
  } catch {
    /* буфер обмена недоступен */
  }
}

function generate(): void {
  form.value.password = generatePassword(20);
  showPassword.value = true;
}
</script>

<template>
  <section>
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-xl font-semibold">{{ t('vault.title') }}</h1>
      <button
        type="button"
        class="rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600"
        data-testid="add-entry"
        @click="openNew"
      >
        {{ t('vault.add') }}
      </button>
    </div>

    <p
      v-if="error && !creating"
      class="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-if="vault.skipped"
      class="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200"
      role="alert"
    >
      {{ t('vault.skipped', { n: vault.skipped }) }}
    </p>

    <input
      v-model="query"
      type="search"
      :placeholder="t('vault.search')"
      class="mb-4 w-full rounded-md border border-slate-300 bg-transparent px-3 py-2 text-sm dark:border-slate-700"
      data-testid="search"
    />

    <div class="grid gap-4 md:grid-cols-[1fr_22rem]">
      <ul
        class="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900"
        data-testid="entry-list"
      >
        <li
          v-if="!vault.loading && !vault.items.length"
          class="px-4 py-6 text-center text-sm text-slate-500"
        >
          {{ t('vault.empty') }}
        </li>
        <li v-else-if="!filtered.length" class="px-4 py-6 text-center text-sm text-slate-500">
          {{ t('vault.noMatch') }}
        </li>
        <li
          v-for="item in filtered"
          :key="item.id"
          class="flex items-center justify-between gap-3 px-4 py-3"
          data-testid="entry-row"
        >
          <button
            type="button"
            class="min-w-0 flex-1 text-left"
            @click="revealed = revealed === item.id ? null : item.id"
          >
            <div class="truncate font-medium">{{ item.data.title }}</div>
            <div class="truncate text-xs text-slate-500">
              {{ item.data.username }} <span v-if="item.data.url">· {{ item.data.url }}</span>
            </div>
            <div
              v-if="revealed === item.id"
              class="mt-1 break-all font-mono text-sm"
              data-testid="revealed-password"
            >
              {{ item.data.password }}
            </div>
          </button>
          <div class="flex shrink-0 gap-1 text-sm">
            <button
              type="button"
              class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              @click="copySecret(item)"
            >
              {{ copiedId === item.id ? t('common.copied') : t('common.copy') }}
            </button>
            <button
              type="button"
              class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              @click="openEdit(item)"
            >
              {{ t('vault.edit') }}
            </button>
          </div>
        </li>
      </ul>

      <form
        v-if="creating"
        class="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
        @submit.prevent="submit"
      >
        <label class="block text-sm">
          <span class="mb-1 block">{{ t('vault.entryTitle') }}</span>
          <input
            v-model="form.title"
            required
            maxlength="200"
            class="field"
            data-testid="f-title"
          />
        </label>
        <label class="block text-sm">
          <span class="mb-1 block">{{ t('vault.username') }}</span>
          <input
            v-model="form.username"
            maxlength="200"
            autocomplete="off"
            class="field"
            data-testid="f-username"
          />
        </label>
        <label class="block text-sm">
          <span class="mb-1 block">{{ t('vault.password') }}</span>
          <div class="flex gap-1">
            <input
              v-model="form.password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="new-password"
              class="field font-mono"
              data-testid="f-password"
            />
            <button
              type="button"
              class="rounded border border-slate-300 px-2 text-xs dark:border-slate-700"
              @click="showPassword = !showPassword"
            >
              {{ showPassword ? t('common.hide') : t('common.show') }}
            </button>
          </div>
          <button
            type="button"
            class="mt-1 text-xs text-brand-600 underline dark:text-brand-500"
            @click="generate"
          >
            {{ t('vault.generate') }}
          </button>
        </label>
        <label class="block text-sm">
          <span class="mb-1 block">{{ t('vault.url') }}</span>
          <input v-model="form.url" maxlength="500" class="field" data-testid="f-url" />
        </label>
        <label class="block text-sm">
          <span class="mb-1 block">{{ t('vault.notes') }}</span>
          <textarea
            v-model="form.notes"
            rows="3"
            maxlength="5000"
            class="field"
            data-testid="f-notes"
          />
        </label>
        <p
          v-if="error"
          class="text-sm text-red-600 dark:text-red-400"
          role="alert"
          data-testid="form-error"
        >
          {{ error }}
        </p>
        <div class="flex justify-between gap-2">
          <div class="flex gap-2">
            <button
              type="submit"
              class="rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-60"
              :disabled="busy"
              data-testid="f-save"
            >
              {{ t('common.save') }}
            </button>
            <button
              type="button"
              class="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
              @click="closeForm"
            >
              {{ t('common.cancel') }}
            </button>
          </div>
          <button
            v-if="editing"
            type="button"
            class="rounded-md px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
            @click="remove(editing)"
          >
            {{ t('common.delete') }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.field {
  width: 100%;
  border-radius: 0.375rem;
  border: 1px solid rgb(203 213 225);
  background: transparent;
  padding: 0.4rem 0.6rem;
}
.field:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 1px;
}
:global(html.dark) .field {
  border-color: rgb(51 65 85);
}
</style>
