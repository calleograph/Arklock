<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, api } from '../services/api';
import { errorMessage } from '../services/helpers';

/** Выбор групп поиском на сервере: список групп целиком не загружается. Выбранные показываются отдельно от найденных. */
export interface Group {
  id: string;
  name: string;
}
const props = withDefaults(
  defineProps<{
    modelValue: Group[];
    placeholder?: string;
    testid: string;
    /** Искать и среди групп каталога домена (если он подключён): «+» создаёт и связывает группу Arklock. */
    directory?: boolean;
  }>(),
  { directory: true },
);
const emit = defineEmits<{ 'update:modelValue': [Group[]] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      none: 'Групп не найдено',
      inArklock: 'Группы Arklock',
      inDirectory: 'Группы каталога',
      add: 'Добавить группу домена: {name}',
      note: 'Для группы домена будет создана группа Arklock с таким же названием; её состав ведёт каталог.',
      adding: 'Добавляю…',
      failed: 'Не удалось добавить группу домена.',
      more: 'Показаны первые {n}. Уточните запрос.',
      remove: 'Убрать: {name}',
    },
    en: {
      none: 'No groups found',
      inArklock: 'Arklock groups',
      inDirectory: 'Directory groups',
      add: 'Add domain group: {name}',
      note: 'An Arklock group with the same name is created for a domain group; the directory manages its members.',
      adding: 'Adding…',
      failed: 'The domain group could not be added.',
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
const domain = ref<{ profileId: string; dn: string; name: string }[]>([]);
const adding = ref('');
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
  const term = q.value.trim();
  if (mine !== seq) return;
  if (!props.directory || term.length < 2) {
    domain.value = [];
    return;
  }
  try {
    const d = await api<{
      items: { profileId: string; dn: string; name: string; linked: object[] }[];
    }>('GET', `/admin/directory/groups?limit=8&q=${encodeURIComponent(term)}`);
    if (mine === seq) domain.value = d.items.filter((g) => !g.linked.length);
  } catch {
    // каталог не подключён или нет права: остаются группы Arklock
    if (mine === seq) domain.value = [];
  }
}
async function addDomain(g: { profileId: string; dn: string; name: string }): Promise<void> {
  if (adding.value) return;
  adding.value = g.dn;
  try {
    const r = await api<{ circle: Group }>('POST', '/admin/directory/groups/use', {
      profileId: g.profileId,
      dn: g.dn,
    });
    domain.value = domain.value.filter((x) => x.dn !== g.dn);
    if (!chosen(r.circle)) emit('update:modelValue', [...props.modelValue, r.circle]);
    items.value = [r.circle, ...items.value.filter((x) => x.id !== r.circle.id)];
  } catch (e) {
    error.value = e instanceof ApiError ? errorMessage(e, t) : t('failed');
  } finally {
    adding.value = '';
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
      <p v-else-if="!domain.length" class="px-2 py-1 text-slate-500">{{ t('none') }}</p>
      <template v-if="domain.length">
        <p
          class="border-t border-slate-200 px-2 pt-1 text-xs font-medium text-slate-500 dark:border-slate-700"
          :data-testid="`${testid}-directory-title`"
        >
          {{ t('inDirectory') }}
        </p>
        <ul class="max-h-40 overflow-y-auto">
          <li
            v-for="g in domain"
            :key="`${g.profileId}:${g.dn}`"
            class="flex min-h-11 items-center gap-2 px-2 py-1"
          >
            <span class="min-w-0 flex-1 truncate">{{ g.name }}</span>
            <button
              type="button"
              class="btn min-h-11 min-w-11 shrink-0 justify-center"
              :disabled="!!adding"
              :aria-label="t('add', { name: g.name })"
              :data-testid="`${testid}-add-${g.name}`"
              @click="addDomain(g)"
            >
              {{ adding === g.dn ? t('adding') : '+' }}
            </button>
          </li>
        </ul>
        <p class="px-2 pb-1 text-xs text-slate-500">{{ t('note') }}</p>
      </template>
      <p
        v-if="total > items.length"
        class="border-t border-slate-200 px-2 py-0.5 text-xs text-slate-500 dark:border-slate-700"
      >
        {{ t('more', { n: items.length }) }}
      </p>
    </div>
  </div>
</template>
