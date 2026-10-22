<script lang="ts">
import type { IconName } from './Icon.vue';

export interface ActionItem {
  id: string;
  label: string;
  icon?: IconName;
  danger?: boolean;
  testid?: string;
}
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';

/**
 * Выпадающее меню действий: одна кнопка вместо ряда кнопок. Закрывается по Escape, нажатию вне меню и после выбора;
 * стрелки переводят фокус между пунктами. data-testid пункта — `testid` из описания пункта.
 */
defineOptions({ inheritAttrs: false });
withDefaults(
  defineProps<{
    items: ActionItem[];
    /** Текст на кнопке; без него кнопка показывает «⋯» и `title` как подпись для экранных дикторов. */
    label?: string;
    title: string;
    align?: 'left' | 'right';
  }>(),
  { label: '', align: 'right' },
);
const emit = defineEmits<{ select: [id: string] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const id = `menu-${Math.random().toString(36).slice(2, 9)}`;

const itemsEl = () => [...(root.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
async function toggle(): Promise<void> {
  open.value = !open.value;
  if (open.value) {
    await nextTick();
    itemsEl()[0]?.focus();
  }
}
function close(focusTrigger = false): void {
  open.value = false;
  if (focusTrigger) trigger.value?.focus();
}
function choose(item: ActionItem): void {
  close(true);
  emit('select', item.id);
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    close(true);
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const list = itemsEl();
  const at = list.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? list.length - 1
        : (at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
  list[next]?.focus();
}
function onDocumentClick(e: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) close();
}
onMounted(() => document.addEventListener('click', onDocumentClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick));
</script>

<template>
  <div ref="root" class="relative inline-block" @keydown="onKey">
    <button
      ref="trigger"
      type="button"
      v-bind="$attrs"
      :class="
        label
          ? 'btn'
          : 'inline-flex size-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
      "
      :aria-label="label ? undefined : title"
      :title="label ? undefined : title"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="open ? id : undefined"
      @click.stop="toggle"
    >
      <template v-if="label"
        >{{ label }}
        <svg viewBox="0 0 20 20" class="size-4 opacity-70" aria-hidden="true">
          <path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" /></svg
      ></template>
      <Icon v-else name="more" class="!size-5" />
    </button>
    <div
      v-if="open"
      :id="id"
      role="menu"
      :aria-label="title"
      class="menu-pop absolute top-full z-40 mt-1 min-w-56 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white p-1 text-sm shadow-xl dark:border-slate-700 dark:bg-slate-900"
      :class="align === 'right' ? 'right-0' : 'left-0'"
    >
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        role="menuitem"
        tabindex="-1"
        class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left focus:bg-slate-100 focus:outline-none hover:bg-slate-100 dark:hover:bg-slate-800 dark:focus:bg-slate-800"
        :class="item.danger ? 'text-red-600 dark:text-red-400' : ''"
        :data-testid="item.testid"
        @click="choose(item)"
      >
        <Icon v-if="item.icon" :name="item.icon" class="size-4 opacity-80" />
        <span class="min-w-0 flex-1">{{ item.label }}</span>
      </button>
    </div>
  </div>
</template>
