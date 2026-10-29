<script setup lang="ts">
import InfoHint from './InfoHint.vue';

/**
 * Параметр «вкл/выкл»: флажок слева рядом с названием, подсказка «i» после названия, пояснение под ним.
 * Один вид во всех разделах; остаётся настоящим флажком — работает с клавиатуры и в формах.
 * Атрибуты (data-testid, disabled) передаются самому флажку.
 */
defineOptions({ inheritAttrs: false });
defineProps<{ label: string; hint?: string; details?: string; note?: string }>();
const model = defineModel<boolean>();
</script>

<template>
  <label class="check-row">
    <input v-model="model" type="checkbox" v-bind="$attrs" />
    <span class="check-text">
      <span>{{ label }}<InfoHint v-if="hint" class="ml-1" :text="hint" :details="details" /></span>
      <span v-if="note" class="check-hint">{{ note }}</span>
    </span>
  </label>
</template>
