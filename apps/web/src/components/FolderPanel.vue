<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BranchItem } from '../services/model';
import EntryAccessPanel from './EntryAccessPanel.vue';
import EntryJournalPanel from './EntryJournalPanel.vue';
import EntrySettingsPanel from './EntrySettingsPanel.vue';
import Icon from './Icon.vue';
defineProps<{ vaultId: string; branch: BranchItem }>();
defineEmits<{ (e: 'changed'): void }>();
const { t } = useI18n();
const tab = ref<'access' | 'journal' | 'settings'>('access');
</script>

<template>
  <section class="card overflow-hidden" data-testid="folder-panel">
    <div class="flex items-center gap-2 border-b border-slate-200 p-4 dark:border-slate-800">
      <Icon name="folder" class="shrink-0" />
      <h2 class="min-w-0 break-words text-lg font-semibold">{{ branch.name }}</h2>
    </div>
    <div
      class="flex border-b border-slate-200 px-2 dark:border-slate-800"
      :aria-label="branch.name"
    >
      <button
        v-for="value in ['access', 'journal', 'settings'] as const"
        :key="value"
        type="button"
        class="flex-1 border-b-2 px-2 py-3 text-sm"
        :class="
          tab === value
            ? 'border-brand-500 font-medium text-brand-600 dark:text-brand-400'
            : 'border-transparent text-slate-500'
        "
        :aria-pressed="tab === value"
        :data-testid="`folder-tab-${value}`"
        @click="tab = value"
      >
        {{ t(`entryPanel.tabs.${value}`) }}
      </button>
    </div>
    <div class="p-4">
      <EntryAccessPanel
        v-show="tab === 'access'"
        :vault-id="vaultId"
        :entry-id="branch.id"
        target-type="branch"
        :active="tab === 'access'"
        @changed="$emit('changed')"
      />
      <EntryJournalPanel
        v-show="tab === 'journal'"
        :vault-id="vaultId"
        :entry-id="branch.id"
        target-type="branch"
        :active="tab === 'journal'"
      />
      <EntrySettingsPanel
        v-show="tab === 'settings'"
        :vault-id="vaultId"
        :entry-id="branch.id"
        target-type="branch"
        :active="tab === 'settings'"
      />
    </div>
  </section>
</template>
