<script setup lang="ts">
import Icon, { type IconName } from './Icon.vue';

/**
 * Кнопка-значок с подсказкой: название видно при наведении и при фокусе с клавиатуры,
 * а для программ доступно через aria-label. Остальные атрибуты (data-testid, обработчики) передаются кнопке.
 */
withDefaults(
  defineProps<{
    icon: IconName;
    label: string;
    /** Подсказка выводится над кнопкой (по умолчанию) или под ней. */
    placement?: 'top' | 'bottom';
    active?: boolean;
  }>(),
  { placement: 'top', active: false },
);
</script>

<template>
  <button
    type="button"
    class="group relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
    :class="active ? 'bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-500' : ''"
    :aria-label="label"
    :aria-pressed="active || undefined"
  >
    <Icon :name="icon" class="!size-5" />
    <span
      role="tooltip"
      class="pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 dark:bg-slate-100 dark:text-slate-900"
      :class="placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'"
    >
      {{ label }}
    </span>
  </button>
</template>
