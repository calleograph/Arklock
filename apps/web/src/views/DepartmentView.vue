<script setup lang="ts">
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import DepartmentDetail from '../components/DepartmentDetail.vue';
import PageHeading from '../components/PageHeading.vue';
import { useWorkspaceStore } from '../stores/workspace';

/** Страница подразделения для его руководителя: те же возможности, что в администрировании, без административных разделов. */
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const ws = useWorkspaceStore();
const back = () => router.push('/');
onMounted(() => {
  if (!ws.vaults.length) void ws.loadVaults().catch(() => undefined);
});
</script>

<template>
  <section class="space-y-4" data-testid="department-page">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <PageHeading :title="t('dept.page')" :hint="t('dept.pageHint')" />
      <button type="button" class="btn" data-testid="department-back" @click="back">
        {{ t('dept.back') }}
      </button>
    </div>
    <DepartmentDetail
      :key="String(route.params.id)"
      :space-id="String(route.params.id)"
      @close="back"
    />
  </section>
</template>
