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
    class="spring group relative inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-[9px] text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:shadow-[var(--ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
    :class="active ? 'bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-500' : ''"
    :aria-label="label"
    :aria-pressed="active || undefined"
  >
    <Transition name="swap" mode="out-in">
      <Icon :key="icon" :name="icon" class="!size-5" />
    </Transition>
    <!-- скрытая подсказка сжата до нуля: у края экрана она не создаёт горизонтальную прокрутку -->
    <span
      role="tooltip"
      class="pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white opacity-0 shadow-lg transition-[opacity,scale] duration-150 scale-0 group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100 dark:bg-slate-100 dark:text-slate-900"
      :class="placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'"
    >
      {{ label }}
    </span>
  </button>
</template>
