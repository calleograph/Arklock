<script setup lang="ts">
import InfoHint from './InfoHint.vue';

/**
 * Строка «вкл/выкл» для настроек: подпись слева (с подсказкой «i» при необходимости), переключатель справа.
 * Одинаковый размер и выравнивание везде; остаётся настоящим флажком — работает с клавиатуры и в формах.
 * Атрибуты (data-testid, disabled) передаются самому переключателю.
 */
defineOptions({ inheritAttrs: false });
defineProps<{ label: string; hint?: string; details?: string }>();
const model = defineModel<boolean>();
</script>

<template>
  <label class="flex min-h-8 items-center justify-between gap-3">
    <span class="inline-flex items-center gap-1">
      {{ label }}<InfoHint v-if="hint" :text="hint" :details="details" />
    </span>
    <input v-model="model" type="checkbox" class="switch" v-bind="$attrs" />
  </label>
</template>
