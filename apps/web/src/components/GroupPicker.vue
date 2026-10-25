<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';

/** Выбор групп поиском на сервере: список групп целиком не загружается. Выбранные показываются отдельно от найденных. */
export interface Group {
  id: string;
  name: string;
}
const props = defineProps<{ modelValue: Group[]; placeholder?: string; testid: string }>();
const emit = defineEmits<{ 'update:modelValue': [Group[]] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      none: 'Групп не найдено',
      more: 'Показаны первые {n}. Уточните запрос.',
      remove: 'Убрать: {name}',
    },
    en: {
      none: 'No groups found',
      more: 'Showing the first {n}. Narrow the search.',
      remove: 'Remove: {name}',
    },
  },
});
const q = ref('');
const items = ref<(Group & { members?: number })[]>([]);
const total = ref(0);
const open = ref(false);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;
async function search(): Promise<void> {
  const mine = ++seq;
  try {
    const r = await api<{ items: (Group & { members?: number })[]; total: number }>(
      'GET',
      `/admin/circles?limit=10&q=${encodeURIComponent(q.value.trim())}`,
    );
    if (mine !== seq) return;
    items.value = r.items;
    total.value = r.total;
    error.value = '';
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
watch(q, () => {
  open.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => void search(), 250);
});
onBeforeUnmount(() => clearTimeout(timer));
const chosen = (g: Group) => props.modelValue.some((x) => x.id === g.id);
const toggle = (g: Group) =>
  emit(
    'update:modelValue',
    chosen(g)
      ? props.modelValue.filter((x) => x.id !== g.id)
      : [...props.modelValue, { id: g.id, name: g.name }],
  );
</script>

<template>
  <div class="space-y-1" :data-testid="testid">
    <ul v-if="modelValue.length" class="flex flex-wrap gap-1">
      <li
        v-for="g in modelValue"
        :key="g.id"
        class="inline-flex items-center gap-1 rounded-md bg-slate-100 py-0.5 pl-2 pr-1 text-xs dark:bg-slate-800"
        :data-testid="`${testid}-chip-${g.name}`"
      >
        {{ g.name }}
        <button
          type="button"
          class="rounded px-1 text-slate-500 hover:text-red-600"
          :aria-label="t('remove', { name: g.name })"
          @click="toggle(g)"
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
      @focus="((open = true), items.length || search())"
      @keydown.esc="open = false"
    />
    <div v-if="open" class="rounded-md border border-slate-200 text-sm dark:border-slate-700">
      <p v-if="error" class="px-2 py-1 text-red-600" role="alert">{{ error }}</p>
      <ul v-else-if="items.length" class="max-h-40 overflow-y-auto">
        <li v-for="g in items" :key="g.id">
          <button
            type="button"
            class="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
            :data-testid="`${testid}-result-${g.name}`"
            @click="toggle(g)"
          >
            <span aria-hidden="true">{{ chosen(g) ? '☑' : '☐' }}</span>
            <span class="min-w-0 flex-1 truncate">{{ g.name }}</span>
            <span v-if="g.members !== undefined" class="text-xs text-slate-500">{{
              g.members
            }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="px-2 py-1 text-slate-500">{{ t('none') }}</p>
      <p
        v-if="total > items.length"
        class="border-t border-slate-200 px-2 py-0.5 text-xs text-slate-500 dark:border-slate-700"
      >
        {{ t('more', { n: items.length }) }}
      </p>
    </div>
  </div>
</template>
