<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ObjectIcon from './ObjectIcon.vue';
import {
  COLOR_CLASS,
  ICON_CATALOG,
  ICON_COLORS,
  rasterizeIcon,
  type IconColor,
  type ObjectIcon as Icon,
} from '../services/objectIcons';

/** Компактный выбор значка: каталог с поиском, цвет, своё изображение, сброс. */
const props = defineProps<{ modelValue?: Icon; kind: 'folder' | 'entry'; label?: string }>();
const emit = defineEmits<{ 'update:modelValue': [Icon | undefined] }>();
const { t, locale } = useI18n();
const query = ref('');
const error = ref('');

const names = computed(() => {
  const q = query.value.trim().toLowerCase();
  return Object.entries(ICON_CATALOG)
    .filter(([name, v]) => !q || name.includes(q) || v.words.includes(q))
    .map(([name]) => name);
});
// подпись значка: на русском — первое слово описания, на английском — имя значка
const nameLabel = (name: string) =>
  locale.value === 'ru' ? (ICON_CATALOG[name]?.words.split(' ')[0] ?? name) : name;

function set(patch: Partial<Icon>): void {
  const next: Icon = { ...props.modelValue, ...patch };
  for (const k of Object.keys(next) as (keyof Icon)[]) if (next[k] === undefined) delete next[k];
  emit('update:modelValue', next.name || next.image || next.color ? next : undefined);
}
function pick(name: string): void {
  set({ name, image: undefined });
}
function color(c: IconColor): void {
  set({ color: c === 'default' ? undefined : c });
}
async function upload(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  error.value = '';
  try {
    set({ image: await rasterizeIcon(file), name: undefined });
  } catch (err) {
    error.value = t((err as Error).message === 'too_big' ? 'icons.tooBig' : 'icons.unsupported');
  }
}
</script>

<template>
  <div class="space-y-2 text-sm" data-testid="icon-picker">
    <div class="flex items-center gap-2">
      <ObjectIcon :icon="modelValue" :kind="kind" :label="label" />
      <input
        v-model="query"
        type="search"
        class="input"
        :placeholder="t('icons.search')"
        :aria-label="t('icons.search')"
        data-testid="icon-search"
      />
    </div>
    <div
      class="grid max-h-40 grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1 overflow-y-auto p-1"
      role="listbox"
      :aria-label="t('icons.catalog')"
    >
      <button
        v-for="name in names"
        :key="name"
        type="button"
        role="option"
        class="flex size-9 items-center justify-center rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
        :class="modelValue?.name === name ? 'ring-2 ring-brand-500' : ''"
        :aria-selected="modelValue?.name === name"
        :aria-label="nameLabel(name)"
        :title="nameLabel(name)"
        :data-testid="`icon-${name}`"
        @click="pick(name)"
      >
        <svg
          viewBox="0 0 24 24"
          class="size-5"
          :class="COLOR_CLASS[modelValue?.color ?? 'default']"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path :d="ICON_CATALOG[name]!.path" />
        </svg>
      </button>
      <p v-if="!names.length" class="col-span-full py-2 text-xs text-slate-500">
        {{ t('icons.nothing') }}
      </p>
    </div>
    <div
      class="flex flex-wrap items-center gap-1.5"
      role="radiogroup"
      :aria-label="t('icons.color')"
    >
      <button
        v-for="c in ICON_COLORS"
        :key="c"
        type="button"
        role="radio"
        class="flex size-7 items-center justify-center rounded-full ring-1 ring-slate-300 dark:ring-slate-600"
        :class="(modelValue?.color ?? 'default') === c ? 'ring-2 !ring-brand-500' : ''"
        :aria-checked="(modelValue?.color ?? 'default') === c"
        :aria-label="t(`icons.colors.${c}`)"
        :title="t(`icons.colors.${c}`)"
        :data-testid="`icon-color-${c}`"
        @click="color(c)"
      >
        <span class="size-3.5 rounded-full bg-current" :class="COLOR_CLASS[c]" />
      </button>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <label class="btn cursor-pointer">
        {{ t('icons.upload') }}
        <input
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          class="sr-only"
          data-testid="icon-upload"
          @change="upload"
        />
      </label>
      <button
        v-if="modelValue"
        type="button"
        class="btn-ghost"
        data-testid="icon-reset"
        @click="emit('update:modelValue', undefined)"
      >
        {{ t('icons.reset') }}
      </button>
      <span class="text-xs text-slate-500">{{ t('icons.uploadHint') }}</span>
    </div>
    <p v-if="error" class="text-xs text-red-600" role="alert">{{ error }}</p>
  </div>
</template>
