<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
// всплывающий текст не должен выходить за край экрана: у правого края раскрываем влево
const alignRight = ref(false);
watch(shown, (v) => {
  if (v && root.value)
    alignRight.value = root.value.getBoundingClientRect().left + 270 > window.innerWidth;
});
const id = `hint-${Math.random().toString(36).slice(2, 9)}`;

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
    class="relative inline-flex align-middle"
    @mouseenter="peek = true"
    @mouseleave="peek = false"
  >
    <button
      type="button"
      class="inline-flex size-6 items-center justify-center rounded-full text-slate-500 hover:text-brand-600 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand-500"
      data-testid="info-hint"
      :aria-label="t('help.about')"
      :aria-expanded="pinned"
      :aria-describedby="shown ? id : undefined"
      @click.stop.prevent="pinned = !pinned"
      @focus="peek = true"
      @blur="peek = false"
    >
      <span
        class="inline-flex size-4 items-center justify-center rounded-full border border-current text-[10px] font-semibold leading-none"
        aria-hidden="true"
        >i</span
      >
    </button>
    <span
      v-if="shown"
      :id="id"
      role="tooltip"
      class="menu-pop absolute top-full z-50 mt-1 w-64 max-w-[80vw] rounded-xl border border-slate-200 bg-white p-3 text-xs font-normal leading-relaxed text-slate-700 shadow-xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
      :class="alignRight ? 'right-0' : 'left-0'"
    >
      {{ text }}
      <span v-if="details && pinned" class="mt-1.5 block text-slate-500">{{ details }}</span>
      <span v-else-if="details" class="mt-1 block text-slate-400">{{ t('help.moreHint') }}</span>
    </span>
  </span>
</template>
