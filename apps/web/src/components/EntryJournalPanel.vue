<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, when } from '../services/helpers';
const props = withDefaults(
  defineProps<{
    vaultId: string;
    entryId: string;
    active: boolean;
    targetType?: 'entry' | 'branch';
  }>(),
  { targetType: 'entry' },
);
const base = computed(
  () =>
    `/vaults/${props.vaultId}/${props.targetType === 'branch' ? 'branches' : 'entries'}/${props.entryId}`,
);
const { t, te } = useI18n();
const rows = ref<
  | {
      id: number;
      actor: string | null;
      actorName?: string | null;
      action: string;
      at: string;
      detail: Record<string, unknown> | null;
      clientReported: boolean;
    }[]
  | null
>(null);
const error = ref('');
const busy = ref(false);
async function load(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    rows.value = await api('GET', `${base.value}/journal`);
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
watch(
  () => props.active,
  (active) => {
    if (active) void load();
  },
  { immediate: true },
);
const actionLabel = (action: string) => {
  const key = `entryPanel.actions.${action.replaceAll('.', '_')}`;
  return te(key) ? t(key) : action;
};
const query = ref('');
// поиск по тому, что видно в строке: действию, автору, полю и дате
const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q || !rows.value) return rows.value ?? [];
  return rows.value.filter((r) =>
    [
      actionLabel(r.action),
      r.actorName ?? r.actor ?? '',
      r.detail?.field ? t(`entryPanel.fields.${r.detail.field}`) : '',
      when(r.at),
    ].some((x) => x.toLowerCase().includes(q)),
  );
});
</script>

<template>
  <div class="space-y-3 text-sm" data-testid="entry-journal">
    <div class="flex items-center justify-between gap-2">
      <h3 class="font-medium">{{ t('entryPanel.events') }}</h3>
      <button type="button" class="btn" :disabled="busy" @click="load">
        {{ t('entryPanel.refresh') }}
      </button>
    </div>
    <p class="text-xs text-slate-500">{{ t('entryPanel.journalHint') }}</p>
    <input
      v-if="rows && rows.length > 3"
      v-model="query"
      type="search"
      class="input"
      :placeholder="t('entryPanel.journalSearch')"
      :aria-label="t('entryPanel.journalSearch')"
      data-testid="journal-search"
    />
    <p v-if="error" role="alert" class="text-red-600">{{ error }}</p>
    <p v-if="!rows && busy" class="text-slate-500">{{ t('common.working') }}</p>
    <p v-else-if="rows && !rows.length" class="text-slate-500">{{ t('entryPanel.noEvents') }}</p>
    <p v-else-if="rows && !shown.length" class="text-slate-500">{{ t('entryPanel.noMatches') }}</p>
    <ol v-else class="divide-y divide-slate-200 dark:divide-slate-800">
      <li
        v-for="row in shown"
        :key="row.id"
        class="space-y-0.5 py-2"
        data-testid="entry-journal-row"
      >
        <div class="flex flex-wrap justify-between gap-2">
          <span class="font-medium">{{ actionLabel(row.action) }}</span
          ><time class="text-xs text-slate-500" :datetime="row.at">{{ when(row.at) }}</time>
        </div>
        <p class="text-xs text-slate-500 [overflow-wrap:anywhere]">
          {{ row.actorName || row.actor || t('entryPanel.system')
          }}<span v-if="row.clientReported"> · {{ t('entryPanel.clientReported') }}</span
          ><span v-if="row.detail?.field"> · {{ t(`entryPanel.fields.${row.detail.field}`) }}</span>
        </p>
      </li>
    </ol>
  </div>
</template>
