<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * Информационная подсказка «i»: наведение или фокус показывают короткий текст, нажатие (в том числе на телефоне)
 * закрепляет её и раскрывает подробности. Закрывается по Escape и по нажатию вне подсказки.
 */
defineProps<{ text: string; details?: string }>();
const { t } = useI18n();
const root = ref<HTMLElement | null>(null);
const pinned = ref(false);
const peek = ref(false);
const shown = computed(() => pinned.value || peek.value);
const id = `hint-${Math.random().toString(36).slice(2, 9)}`;
// всплывающий текст не выходит за край экрана: после отрисовки сдвигается внутрь (до показа кадра).
// Ширина раскладки, а не innerWidth: мобильный браузер уменьшает масштаб под вылезающий текст, и innerWidth растёт
const shift = ref(0);
// у нижнего края окна подсказка раскрывается вверх, а не уходит за экран
const above = ref(false);
watch(shown, async (v) => {
  if (!v) return;
  shift.value = 0;
  above.value = false;
  await nextTick();
  const tip = document.getElementById(id)?.getBoundingClientRect();
  if (!tip) return;
  const vw = document.documentElement.clientWidth;
  shift.value = Math.min(Math.max(tip.left, 8), vw - tip.width - 8) - tip.left;
  const triggerTop = root.value?.getBoundingClientRect().top ?? 0;
  if (tip.bottom > window.innerHeight - 8 && triggerTop - tip.height - 8 > 8) above.value = true;
});

function onDocumentClick(e: MouseEvent): void {
  if (pinned.value && root.value && !root.value.contains(e.target as Node)) pinned.value = false;
}
function onDocumentKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  pinned.value = false;
  peek.value = false;
}
onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onDocumentKey);
});
</script>

<template>
  <span
    ref="root"
    class="relative -my-1 inline-flex align-middle"
    @mouseenter="peek = true"
    @mouseleave="peek = false"
  >
    <!-- не <button>: кнопка внутри подписи поля перехватывает её, и у поля пропадает название (подпись относится к первому управляемому элементу) -->
    <span
      role="button"
      tabindex="0"
      class="inline-flex size-6 items-center justify-center rounded-full text-slate-500 hover:text-brand-600 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand-500"
      data-testid="info-hint"
      :aria-label="t('help.about')"
      :aria-expanded="pinned"
      :aria-describedby="shown ? id : undefined"
      @click.stop.prevent="pinned = !pinned"
      @keydown.enter.stop.prevent="pinned = !pinned"
      @keydown.space.stop.prevent="pinned = !pinned"
      @focus="peek = true"
      @blur="peek = false"
    >
      <span
        class="inline-flex size-4 items-center justify-center rounded-full border border-current text-xs font-semibold leading-none"
        aria-hidden="true"
        >i</span
      >
    </span>
    <span
      v-if="shown"
      :id="id"
      role="tooltip"
      class="menu-pop absolute left-0 z-50 w-64 max-w-[80vw] rounded-xl border border-slate-200 bg-white p-3 text-xs font-normal leading-relaxed text-slate-700 shadow-xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
      :class="above ? 'bottom-full mb-1' : 'top-full mt-1'"
      :style="shift ? { left: `${shift}px` } : undefined"
    >
      {{ text }}
      <span v-if="details && pinned" class="mt-1.5 block text-slate-500">{{ details }}</span>
      <span v-else-if="details" class="mt-1 block text-slate-400">{{ t('help.moreHint') }}</span>
    </span>
  </span>
</template>
