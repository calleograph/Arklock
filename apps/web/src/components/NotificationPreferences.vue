<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
const { t } = useI18n();
const categories = ['access', 'security', 'sharing', 'system'] as const;
const form = ref<Record<(typeof categories)[number], boolean> | null>(null);
const busy = ref(false);
const error = ref('');
const notice = ref('');
onMounted(async () => {
  try {
    form.value = await api('GET', '/notifications/preferences');
  } catch (e) {
    error.value = errorMessage(e, t);
  }
});
async function save(): Promise<void> {
  if (!form.value || busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await api('PUT', '/notifications/preferences', form.value);
    notice.value = t('notifications.saved');
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <form class="card space-y-3 p-4" data-testid="notification-preferences" @submit.prevent="save">
    <h2 class="font-medium">{{ t('notifications.preferences') }}</h2>
    <p class="text-xs text-slate-500">{{ t('notifications.preferencesHint') }}</p>
    <fieldset v-if="form" :disabled="busy" class="flex flex-wrap gap-4 text-sm">
      <label v-for="category in categories" :key="category" class="flex items-center gap-2"
        ><input
          v-model="form[category]"
          type="checkbox"
          :data-testid="`notification-pref-${category}`"
        />{{ t(`notifications.categories.${category}`) }}</label
      >
    </fieldset>
    <p v-if="error" role="alert" class="text-sm text-red-600">{{ error }}</p>
    <p v-if="notice" role="status" class="text-sm text-emerald-700 dark:text-emerald-300">
      {{ notice }}
    </p>
    <button v-if="form" type="submit" class="btn" :disabled="busy">{{ t('common.save') }}</button>
  </form>
</template>
