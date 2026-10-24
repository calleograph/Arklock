<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';

/**
 * Выбор сотрудников поиском на сервере: список целиком не загружается (в организации на десятки тысяч человек
 * его не нужно ни грузить, ни листать). Выбранные показываются отдельно от найденных.
 */
export interface Person {
  id: string;
  name: string;
  email: string;
  title: string | null;
  department: string | null;
  authSource: string;
}
const props = defineProps<{
  modelValue: Person[];
  multiple?: boolean;
  placeholder?: string;
  testid: string;
  /** Уже участвуют: показываются в результатах отмеченными и не выбираются повторно. */
  exclude?: string[];
}>();
const emit = defineEmits<{ 'update:modelValue': [Person[]] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      found: 'Найдено: {n}',
      more: 'Показаны первые {n}. Уточните запрос.',
      none: 'Никого не найдено',
      picked: 'Выбрано',
      remove: 'Убрать: {name}',
      already: 'уже в группе',
      source: { local: 'локальная', ldap: 'каталог', oidc: 'SSO', saml: 'SAML' },
    },
    en: {
      found: 'Found: {n}',
      more: 'Showing the first {n}. Narrow the search.',
      none: 'Nobody found',
      picked: 'Selected',
      remove: 'Remove: {name}',
      already: 'already in the group',
      source: { local: 'local', ldap: 'directory', oidc: 'SSO', saml: 'SAML' },
    },
  },
});
const LIMIT = 12;
const q = ref('');
const items = ref<Person[]>([]);
const total = ref(0);
const busy = ref(false);
const error = ref('');
const open = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;

async function search(): Promise<void> {
  const mine = ++seq;
  busy.value = true;
  error.value = '';
  try {
    const r = await api<{ items: Person[]; total: number }>(
      'GET',
      `/admin/people?status=active&limit=${LIMIT}&q=${encodeURIComponent(q.value.trim())}`,
    );
    // ответ на устаревший запрос не затирает свежий
    if (mine !== seq) return;
    items.value = r.items;
    total.value = r.total;
  } catch (e) {
    if (mine === seq) error.value = errorMessage(e, t);
  } finally {
    if (mine === seq) busy.value = false;
  }
}
watch(q, () => {
  open.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => void search(), 250);
});
onBeforeUnmount(() => clearTimeout(timer));

const chosen = (p: Person) => props.modelValue.some((x) => x.id === p.id);
function pick(p: Person): void {
  if (props.exclude?.includes(p.id)) return;
  if (!props.multiple) {
    emit('update:modelValue', [p]);
    q.value = '';
    open.value = false;
    return;
  }
  emit(
    'update:modelValue',
    chosen(p) ? props.modelValue.filter((x) => x.id !== p.id) : [...props.modelValue, p],
  );
}
const drop = (p: Person) =>
  emit(
    'update:modelValue',
    props.modelValue.filter((x) => x.id !== p.id),
  );
function onEnter(): void {
  const first = items.value.find((p) => !props.exclude?.includes(p.id));
  if (first) pick(first);
}
function onFocus(): void {
  open.value = true;
  if (!items.value.length && !busy.value) void search();
}
const meta = (p: Person) => [p.email, p.department, p.title].filter(Boolean).join(' · ');
</script>

<template>
  <div class="space-y-1" :data-testid="testid">
    <ul v-if="modelValue.length" class="flex flex-wrap gap-1" :aria-label="t('picked')">
      <li
        v-for="p in modelValue"
        :key="p.id"
        class="inline-flex items-center gap-1 rounded-md bg-slate-100 py-0.5 pl-2 pr-1 text-xs dark:bg-slate-800"
        :data-testid="`${testid}-chip-${p.email}`"
      >
        {{ p.name }}
        <button
          type="button"
          class="rounded px-1 text-slate-500 hover:text-red-600"
          :aria-label="t('remove', { name: p.name })"
          @click="drop(p)"
        >
          ×
        </button>
      </li>
    </ul>
    <input
      v-model="q"
      type="search"
      class="input"
      autocomplete="off"
      :placeholder="placeholder"
      :aria-label="placeholder"
      :data-testid="`${testid}-input`"
      @focus="onFocus"
      @keydown.enter.prevent="onEnter"
      @keydown.esc="open = false"
    />
    <div
      v-if="open"
      class="rounded-md border border-slate-200 text-sm dark:border-slate-700"
      :aria-busy="busy"
    >
      <p v-if="error" class="px-2 py-1 text-red-600" role="alert">{{ error }}</p>
      <ul v-else-if="items.length" class="max-h-48 overflow-y-auto">
        <li v-for="p in items" :key="p.id">
          <button
            type="button"
            class="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-slate-100 disabled:opacity-60 dark:hover:bg-slate-800"
            :disabled="exclude?.includes(p.id)"
            :data-testid="`${testid}-result-${p.email}`"
            @click="pick(p)"
          >
            <span v-if="multiple" aria-hidden="true">{{
              chosen(p) || exclude?.includes(p.id) ? '☑' : '☐'
            }}</span>
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium">{{ p.name }}</span>
              <span class="block truncate text-xs text-slate-500">{{ meta(p) }}</span>
            </span>
            <span class="shrink-0 text-xs text-slate-500">
              {{ exclude?.includes(p.id) ? t('already') : t(`source.${p.authSource}`) }}
            </span>
          </button>
        </li>
      </ul>
      <p v-else-if="!busy" class="px-2 py-1 text-slate-500">{{ t('none') }}</p>
      <p
        v-if="items.length"
        class="border-t border-slate-200 px-2 py-0.5 text-xs text-slate-500 dark:border-slate-700"
      >
        {{ total > items.length ? t('more', { n: items.length }) : t('found', { n: total }) }}
      </p>
    </div>
  </div>
</template>
