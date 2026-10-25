<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../services/api';
import { errorMessage } from '../services/helpers';

/** Открывает запись по короткой ссылке «/e/<код>». Право на запись проверяет сервер: знание ссылки доступа не даёт. */
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const missing = ref(false);
const error = ref('');

onMounted(async () => {
  try {
    const r = await api<{ vaultId: string; id: string }>(
      'GET',
      `/entries/by-short/${String(route.params.code)}`,
    );
    await router.replace({ path: '/', query: { vault: r.vaultId, entry: r.id } });
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) missing.value = true;
    else error.value = errorMessage(e, t);
  }
});
</script>

<template>
  <section class="mx-auto max-w-md space-y-3 py-8 text-center" data-testid="entry-link">
    <p v-if="missing" class="notice notice-warn" role="alert" data-testid="entry-link-missing">
      {{ t('entryPanel.linkNotFound') }}
    </p>
    <p v-else-if="error" class="notice notice-error" role="alert">{{ error }}</p>
    <p v-else class="text-slate-500" aria-busy="true">{{ t('entryPanel.linkOpening') }}</p>
    <RouterLink v-if="missing || error" to="/" class="btn">{{
      t('entryPanel.linkHome')
    }}</RouterLink>
  </section>
</template>
