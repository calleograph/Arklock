<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import Icon from './Icon.vue';

/**
 * Единое окно «Предоставить доступ» для сейфа, папки и записи: один поиск по сотрудникам и группам,
 * несколько получателей за раз, общий уровень и срок с возможностью изменить уровень у каждого.
 * Само назначение выполняет вызывающий компонент (у сейфа — выдача ключа, у папки и записи — правило доступа).
 */
export interface Recipient {
  kind: 'user' | 'circle';
  id: string;
  name: string;
  email?: string;
  publicKey?: string;
  signPublicKey?: string;
  level: string;
}
const props = defineProps<{
  open: boolean;
  title: string;
  levels: { value: string; label: string; hint?: string; disabled?: boolean }[];
  defaultLevel: string;
  /** Уже имеющие доступ: в поиске помечаются, чтобы не назначать дважды. */
  existing?: string[];
  busy?: boolean;
  error?: string;
}>();
const emit = defineEmits<{
  close: [];
  submit: [recipients: Recipient[], expiresAt: string | null];
}>();
const { t } = useI18n();

const dialog = ref<HTMLDialogElement | null>(null);
const query = ref('');
const results = ref<Omit<Recipient, 'level'>[]>([]);
const circles = ref<{ id: string; name: string }[] | null>(null);
const picked = ref<Recipient[]>([]);
const level = ref(props.defaultLevel);
const term = ref<'none' | '1' | '7' | '30' | 'date'>('none');
const date = ref('');
const searching = ref(false);
const searchError = ref('');
const active = ref(-1);
const input = ref<HTMLInputElement | null>(null);

watch(
  () => props.open,
  async (open) => {
    if (open) {
      picked.value = [];
      query.value = '';
      results.value = [];
      level.value = props.defaultLevel;
      term.value = 'none';
      date.value = '';
      dialog.value?.showModal();
      await nextTick();
      input.value?.focus();
    } else dialog.value?.close();
  },
);

let timer: ReturnType<typeof setTimeout> | undefined;
watch(query, (q) => {
  clearTimeout(timer);
  active.value = -1;
  timer = setTimeout(() => void find(q.trim()), 220);
});
onBeforeUnmount(() => clearTimeout(timer));

async function find(q: string): Promise<void> {
  searchError.value = '';
  if (q.length < 2) {
    results.value = [];
    return;
  }
  searching.value = true;
  try {
    circles.value ??= await api<{ id: string; name: string }[]>('GET', '/directory/circles');
    const users = await api<
      { id: string; name: string; email: string; publicKey: string; signPublicKey: string }[]
    >('GET', `/directory/users?q=${encodeURIComponent(q)}`);
    const lower = q.toLowerCase();
    results.value = [
      ...users.map((u) => ({ kind: 'user' as const, ...u })),
      ...circles.value
        .filter((c) => c.name.toLowerCase().includes(lower))
        .map((c) => ({ kind: 'circle' as const, id: c.id, name: c.name })),
    ];
  } catch (e) {
    searchError.value = errorMessage(e, t);
  } finally {
    searching.value = false;
  }
}

const key = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;
const isPicked = (r: { kind: string; id: string }) => picked.value.some((p) => key(p) === key(r));
const has = (r: { id: string }) => props.existing?.includes(r.id) ?? false;

function pick(r: Omit<Recipient, 'level'>): void {
  if (!isPicked(r)) picked.value.push({ ...r, level: level.value });
  query.value = '';
  results.value = [];
  input.value?.focus();
}
function onKey(e: KeyboardEvent): void {
  if (!results.value.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = results.value.length;
    active.value = (active.value + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
  } else if (e.key === 'Enter' && active.value >= 0) {
    e.preventDefault();
    pick(results.value[active.value]!);
  }
}
// общий уровень меняет уровень у всех ещё не изменённых вручную получателей
watch(level, (next, prev) => {
  for (const p of picked.value) if (p.level === prev) p.level = next;
});

const expiresAt = computed(() => {
  if (term.value === 'none') return null;
  if (term.value === 'date')
    return date.value ? new Date(`${date.value}T23:59:59`).toISOString() : null;
  return new Date(Date.now() + Number(term.value) * 86_400_000).toISOString();
});
const ready = computed(
  () => picked.value.length > 0 && !(term.value === 'date' && !date.value) && !props.busy,
);
const levelHint = computed(() => props.levels.find((l) => l.value === level.value)?.hint ?? '');
</script>

<template>
  <dialog
    ref="dialog"
    class="modal-fade m-auto w-[min(36rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-visible"
    :aria-label="title"
    data-testid="grant-dialog"
    @close="emit('close')"
    @cancel.prevent="emit('close')"
  >
    <form
      class="flex max-h-[calc(100dvh-2rem)] flex-col"
      @submit.prevent="emit('submit', picked, expiresAt)"
    >
      <header class="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
        <h2>{{ title }}</h2>
      </header>
      <div class="space-y-4 overflow-y-auto px-5 py-4 text-sm">
        <div class="relative">
          <label class="field-label" for="grant-search">{{ t('grantDlg.recipients') }}</label>
          <div
            class="input flex min-h-10 flex-wrap items-center gap-1.5 !py-1.5 focus-within:border-brand-500 focus-within:shadow-[var(--ring)]"
          >
            <span
              v-for="p in picked"
              :key="key(p)"
              class="badge-brand gap-1 !py-1 text-[13px]"
              data-testid="grant-chip"
            >
              <Icon :name="p.kind === 'user' ? 'user' : 'users'" class="size-3.5" />{{ p.name }}
              <button
                type="button"
                class="ml-0.5 rounded px-0.5 leading-none hover:bg-brand-100"
                :aria-label="`${t('grantDlg.removeRecipient')}: ${p.name}`"
                @click="picked = picked.filter((x) => key(x) !== key(p))"
              >
                ×
              </button>
            </span>
            <input
              id="grant-search"
              ref="input"
              v-model="query"
              class="chip-input min-w-40 flex-1 bg-transparent py-0.5"
              autocomplete="off"
              role="combobox"
              aria-autocomplete="list"
              :aria-expanded="results.length > 0"
              aria-controls="grant-results"
              :aria-activedescendant="active >= 0 ? `grant-opt-${active}` : undefined"
              :placeholder="picked.length ? '' : t('grantDlg.searchPlaceholder')"
              data-testid="grant-search"
              @keydown="onKey"
            />
          </div>
          <ul
            v-if="results.length || (query.trim().length >= 2 && !searching)"
            id="grant-results"
            role="listbox"
            class="menu-pop absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl dark:border-slate-700 dark:bg-slate-900"
          >
            <li
              v-for="(r, i) in results"
              :id="`grant-opt-${i}`"
              :key="key(r)"
              role="option"
              :aria-selected="i === active"
              class="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2"
              :class="
                i === active
                  ? 'bg-slate-100 dark:bg-slate-800'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
              "
              :data-testid="`grant-option-${r.email ?? r.name}`"
              @mousedown.prevent="pick(r)"
            >
              <Icon
                :name="r.kind === 'user' ? 'user' : 'users'"
                class="size-4 shrink-0 text-slate-500"
              />
              <span class="min-w-0 flex-1">
                <span class="block truncate font-medium">{{ r.name }}</span>
                <span class="block truncate text-xs text-slate-500">{{
                  r.kind === 'user' ? r.email : t('grantDlg.group')
                }}</span>
              </span>
              <span v-if="isPicked(r)" class="text-xs text-brand-600">{{
                t('grantDlg.picked')
              }}</span>
              <span v-else-if="has(r)" class="text-xs text-slate-500">{{
                t('grantDlg.hasAccess')
              }}</span>
            </li>
            <li v-if="!results.length" class="px-3 py-2 text-slate-500">
              {{ t('grantDlg.nothing') }}
            </li>
          </ul>
          <p v-if="searchError" class="mt-1 text-xs text-red-600" role="alert">{{ searchError }}</p>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="field-label">{{ t('grantDlg.level') }}</span>
            <select v-model="level" class="input" data-testid="grant-level">
              <option v-for="l in levels" :key="l.value" :value="l.value" :disabled="l.disabled">
                {{ l.label }}
              </option>
            </select>
          </label>
          <label class="block">
            <span class="field-label">{{ t('grantDlg.term') }}</span>
            <select v-model="term" class="input" data-testid="grant-term">
              <option value="none">{{ t('grantDlg.terms.none') }}</option>
              <option value="1">{{ t('grantDlg.terms.day') }}</option>
              <option value="7">{{ t('grantDlg.terms.week') }}</option>
              <option value="30">{{ t('grantDlg.terms.month') }}</option>
              <option value="date">{{ t('grantDlg.terms.date') }}</option>
            </select>
          </label>
        </div>
        <p v-if="levelHint" class="-mt-2 text-xs text-slate-500">{{ levelHint }}</p>
        <label v-if="term === 'date'" class="block">
          <span class="field-label">{{ t('grantDlg.until') }}</span>
          <input v-model="date" type="date" class="input" required data-testid="grant-date" />
        </label>

        <!-- разные уровни: у каждого получателя свой -->
        <ul
          v-if="picked.length > 1"
          class="divide-y divide-slate-200 rounded-[10px] border border-slate-200 dark:divide-slate-800 dark:border-slate-800"
        >
          <li v-for="p in picked" :key="key(p)" class="flex items-center gap-2 px-3 py-1.5">
            <Icon
              :name="p.kind === 'user' ? 'user' : 'users'"
              class="size-4 shrink-0 text-slate-500"
            />
            <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
            <select
              v-model="p.level"
              class="input w-auto"
              :aria-label="`${t('grantDlg.level')}: ${p.name}`"
            >
              <option v-for="l in levels" :key="l.value" :value="l.value" :disabled="l.disabled">
                {{ l.label }}
              </option>
            </select>
          </li>
        </ul>
        <p v-if="error" class="notice notice-error" role="alert" data-testid="grant-error">
          {{ error }}
        </p>
      </div>
      <footer
        class="flex justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800"
      >
        <button type="button" class="btn" @click="emit('close')">{{ t('common.cancel') }}</button>
        <button
          type="submit"
          class="btn-primary"
          :disabled="!ready"
          :aria-busy="busy || undefined"
          data-testid="grant-submit"
        >
          {{ t('grantDlg.submit') }}
        </button>
      </footer>
    </form>
  </dialog>
</template>
