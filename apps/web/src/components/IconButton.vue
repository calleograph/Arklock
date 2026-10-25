<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon, { type IconName } from './Icon.vue';

/**
 * Кнопка-значок с подсказкой: название видно при наведении и при фокусе с клавиатуры,
 * а для программ доступно через aria-label. Остальные атрибуты (data-testid, обработчики) передаются кнопке.
 * Подсказка выводится в body и позиционируется по экрану: контейнеры с прокруткой и верхняя панель её не обрезают,
 * у края экрана она сдвигается внутрь, а если сверху нет места — показывается под кнопкой.
 */
const props = withDefaults(
  defineProps<{
    icon: IconName;
    label: string;
    /** Подсказка выводится над кнопкой (по умолчанию) или под ней. */
    placement?: 'top' | 'bottom';
    active?: boolean;
  }>(),
  { placement: 'top', active: false },
);

const btn = ref<HTMLButtonElement | null>(null);
const tipEl = ref<HTMLElement | null>(null);
const tip = ref<{ left: number; top: number } | null>(null);
const GAP = 8;

async function show(): Promise<void> {
  // сначала подсказка рисуется вне экрана, чтобы измерить её размер
  tip.value = { left: -9999, top: -9999 };
  await nextTick();
  const b = btn.value?.getBoundingClientRect();
  const t = tipEl.value?.getBoundingClientRect();
  if (!b || !t) return;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let top = props.placement === 'top' ? b.top - t.height - GAP : b.bottom + GAP;
  if (top < 4) top = b.bottom + GAP;
  else if (top + t.height > vh - 4) top = b.top - t.height - GAP;
  const left = Math.min(Math.max(b.left + b.width / 2 - t.width / 2, 4), vw - t.width - 4);
  tip.value = { left, top };
}
const hide = (): void => {
  tip.value = null;
};
// прокрутка в любом контейнере уводит кнопку из-под подсказки
onMounted(() => window.addEventListener('scroll', hide, true));
onBeforeUnmount(() => window.removeEventListener('scroll', hide, true));
</script>

<template>
  <button
    ref="btn"
    type="button"
    class="spring relative inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:shadow-[var(--ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
    :class="active ? 'bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-500' : ''"
    :aria-label="label"
    :aria-pressed="active || undefined"
    @mouseenter="show"
    @mouseleave="hide"
    @focus="($event.target as HTMLElement).matches(':focus-visible') && show()"
    @blur="hide"
    @click="hide"
    @keydown.esc="hide"
  >
    <Transition name="swap" mode="out-in">
      <Icon :key="icon" :name="icon" class="!size-5" />
    </Transition>
    <Teleport to="body">
      <span
        v-if="tip"
        ref="tipEl"
        role="tooltip"
        class="pointer-events-none fixed z-[60] whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg dark:bg-slate-100 dark:text-slate-900"
        :style="{ left: `${tip.left}px`, top: `${tip.top}px` }"
      >
        {{ label }}
      </span>
    </Teleport>
  </button>
</template>
