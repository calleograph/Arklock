<script setup lang="ts">
import InfoHint from './InfoHint.vue';

/**
 * Шапка страницы: название и рядом значок «?» с пояснением. Пояснения не пишутся под названием: страница начинается
 * с содержимого, а подсказка открывается по наведению или нажатию.
 */
defineProps<{ title: string; hint?: string }>();
</script>

<template>
  <header class="flex min-h-11 items-center gap-1" data-testid="page-heading">
    <h2 class="text-base font-semibold">{{ title }}</h2>
    <InfoHint v-if="hint" :text="hint" />
  </header>
</template>
