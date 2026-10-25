<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import type { ActionItem } from './ActionMenu.vue';

/**
 * Меню по правой кнопке мыши у курсора. Не выходит за край экрана, закрывается по Escape,
 * щелчку снаружи и после выбора; стрелки переводят фокус между пунктами.
 */
const props = defineProps<{ x: number; y: number; items: ActionItem[]; label: string }>();
const emit = defineEmits<{ select: [id: string]; close: [] }>();
const root = ref<HTMLElement | null>(null);
const pos = ref({ left: props.x, top: props.y });

const menuItems = () => [...(root.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
function onKey(e: KeyboardEvent): void {
  const list = menuItems();
  const i = list.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'Escape') emit('close');
  else if (e.key === 'ArrowDown') (e.preventDefault(), list[(i + 1) % list.length]?.focus());
  else if (e.key === 'ArrowUp')
    (e.preventDefault(), list[(i - 1 + list.length) % list.length]?.focus());
}
function outside(e: Event): void {
  if (!root.value?.contains(e.target as Node)) emit('close');
}
onMounted(async () => {
  await nextTick();
  const r = root.value?.getBoundingClientRect();
  if (r) {
    pos.value = {
      left: Math.max(8, Math.min(props.x, innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(props.y, innerHeight - r.height - 8)),
    };
  }
  menuItems()[0]?.focus();
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('scroll', outside, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('scroll', outside, true);
});
</script>

<template>
  <div
    ref="root"
    class="fixed z-50 min-w-48 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-xl dark:border-slate-700 dark:bg-slate-900"
    :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
    role="menu"
    :aria-label="label"
    data-testid="context-menu"
    @keydown="onKey"
  >
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      role="menuitem"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-100 focus:bg-slate-100 dark:hover:bg-slate-800 dark:focus:bg-slate-800"
      :class="item.danger ? 'text-red-600' : ''"
      :data-testid="item.testid"
      @click="(emit('select', item.id), emit('close'))"
    >
      <Icon v-if="item.icon" :name="item.icon" class="size-4 opacity-80" />
      {{ item.label }}
    </button>
  </div>
</template>
