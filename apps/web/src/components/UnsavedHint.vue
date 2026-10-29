<script setup lang="ts">
import { useI18n } from 'vue-i18n';

/** Рядом с «Сохранить»: говорит, применены ли изменения. Одинаков во всех формах с кнопкой сохранения. */
defineProps<{ dirty: boolean }>();
const { t } = useI18n();
</script>

<template>
  <span
    v-if="dirty"
    class="text-xs font-medium text-amber-700 dark:text-amber-300"
    aria-live="polite"
    data-testid="unsaved-hint"
    >{{ t('common.unsaved') }}</span
  >
</template>
