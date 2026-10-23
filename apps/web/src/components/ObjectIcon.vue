<script setup lang="ts">
import { computed } from 'vue';
import { COLOR_CLASS, iconPath, type ObjectIcon } from '../services/objectIcons';

/**
 * Значок папки или записи: своё изображение, значок каталога в выбранном цвете
 * или прежний вид по умолчанию (папка — контур папки, запись — первая буква названия).
 */
const props = withDefaults(
  defineProps<{
    icon?: ObjectIcon;
    kind: 'folder' | 'entry';
    label?: string;
    /** tile — плитка в списке записей, inline — значок в строке дерева */
    variant?: 'tile' | 'inline';
  }>(),
  { variant: 'tile', label: '' },
);
const path = computed(
  () => iconPath(props.icon?.name) ?? (props.kind === 'folder' ? iconPath('folder') : null),
);
const color = computed(() => COLOR_CLASS[props.icon?.color ?? 'default']);
const letter = computed(() => (props.label || '?').trim().charAt(0).toUpperCase());
</script>

<template>
  <span
    v-if="variant === 'tile'"
    class="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] ring-1 ring-inset"
    :class="
      icon?.image || icon?.name
        ? 'bg-slate-50 ring-slate-500/10 dark:bg-slate-800'
        : 'bg-brand-50 text-sm font-semibold text-brand-700 ring-brand-500/10'
    "
    aria-hidden="true"
    data-testid="object-icon"
  >
    <img v-if="icon?.image" :src="icon.image" alt="" class="size-6 object-contain" />
    <svg
      v-else-if="icon?.name && path"
      viewBox="0 0 24 24"
      class="size-5"
      :class="color"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path :d="path" />
    </svg>
    <template v-else>{{ letter }}</template>
  </span>
  <span
    v-else
    class="inline-flex shrink-0 align-[-3px]"
    aria-hidden="true"
    data-testid="object-icon"
  >
    <img v-if="icon?.image" :src="icon.image" alt="" class="size-4 rounded-[3px] object-contain" />
    <svg
      v-else-if="path"
      viewBox="0 0 24 24"
      class="size-4"
      :class="color"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path :d="path" />
    </svg>
  </span>
</template>
