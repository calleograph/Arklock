<script setup lang="ts">
import { onErrorCaptured, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * Граница ошибок раздела: сбой отрисовки внутри остаётся внутри. Остальной интерфейс (шапка, меню) работает,
 * а на месте раздела — понятное сообщение и «Повторить». Состояние сбрасывается при смене resetKey (раздела).
 */
const props = defineProps<{ resetKey?: string }>();
const { t } = useI18n();
const failed = ref<string | null>(null);
const version = ref(0);

onErrorCaptured((err, _inst, info) => {
  failed.value = err instanceof Error ? err.message : String(err);
  console.error('[ui] ошибка в разделе:', info, err);
  return false;
});
watch(
  () => props.resetKey,
  () => (failed.value = null),
);
function retry() {
  failed.value = null;
  version.value++;
}
</script>

<template>
  <div v-if="failed !== null" class="notice notice-warn" role="alert" data-testid="section-error">
    <div class="space-y-2">
      <p class="font-medium">{{ t('common.sectionFailed') }}</p>
      <p class="text-xs opacity-80">{{ t('common.sectionFailedHint') }}</p>
      <p class="break-words font-mono text-xs opacity-70" data-testid="section-error-detail">
        {{ failed }}
      </p>
      <button type="button" class="btn" data-testid="section-error-retry" @click="retry">
        {{ t('common.retry') }}
      </button>
    </div>
  </div>
  <slot v-else :key="version" />
</template>
