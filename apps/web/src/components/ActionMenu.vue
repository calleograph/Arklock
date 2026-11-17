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
const props = withDefaults(
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
// меню вынесено в body: таблица с прокруткой (overflow) или «стеклянная» карточка (backdrop-filter) его не обрезают
const pos = ref<{ top: string; left: string }>({ top: '0px', left: '0px' });
const root = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const id = `menu-${Math.random().toString(36).slice(2, 9)}`;

const itemsEl = () => [...(menu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
/** Меню у кнопки, в пределах окна: прижато к заданной стороне, вверх — если снизу не помещается (до отрисовки кадра). */
function place(): void {
  const r = trigger.value?.getBoundingClientRect();
  const m = menu.value?.getBoundingClientRect();
  if (!r || !m) return;
  // ширина раскладки, а не innerWidth: мобильный браузер уменьшает масштаб под вылезающее меню, и innerWidth растёт
  const vw = document.documentElement.clientWidth;
  const left = props.align === 'right' ? r.right - m.width : r.left;
  const below = r.bottom + 4;
  const top =
    below + m.height > window.innerHeight - 8 && r.top - m.height - 4 >= 8
      ? r.top - m.height - 4
      : below;
  pos.value = { top: `${top}px`, left: `${Math.max(8, Math.min(left, vw - m.width - 8))}px` };
}
async function toggle(): Promise<void> {
  open.value = !open.value;
  if (open.value) {
    await nextTick();
    place();
    // при прокрутке и изменении размера меню следует за кнопкой
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    itemsEl()[0]?.focus({ preventScroll: true });
  } else close();
}
function close(focusTrigger = false): void {
  open.value = false;
  window.removeEventListener('scroll', place, true);
  window.removeEventListener('resize', place);
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
  const t = e.target as Node;
  if (open.value && !root.value?.contains(t) && !menu.value?.contains(t)) close();
}
onMounted(() => document.addEventListener('click', onDocumentClick));
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  close();
});
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
        ><Icon name="more" class="!size-5 sm:hidden" /><span class="max-sm:sr-only">{{
          label
        }}</span>
        <svg viewBox="0 0 20 20" class="size-4 opacity-70 max-sm:hidden" aria-hidden="true">
          <path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" /></svg
      ></template>
      <Icon v-else name="more" class="!size-5" />
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        :id="id"
        ref="menu"
        role="menu"
        :aria-label="title"
        class="menu-pop fixed z-50 min-w-56 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white p-1 text-sm shadow-xl dark:border-slate-700 dark:bg-slate-900"
        :style="pos"
        @keydown="onKey"
      >
        <button
          v-for="item in items"
          :key="item.id"
          type="button"
          role="menuitem"
          tabindex="-1"
          class="tap-target flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left focus:bg-slate-100 focus:outline-none hover:bg-slate-100 dark:hover:bg-slate-800 dark:focus:bg-slate-800"
          :class="item.danger ? 'text-red-600 dark:text-red-400' : ''"
          :data-testid="item.testid"
          @click="choose(item)"
        >
          <Icon v-if="item.icon" :name="item.icon" class="size-4 opacity-80" />
          <span class="min-w-0 flex-1">{{ item.label }}</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>
