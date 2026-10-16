<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useWorkspaceStore } from '../stores/workspace';
const ws = useWorkspaceStore();
const router = useRouter();
const { t } = useI18n();
const result = ref<Awaited<ReturnType<typeof ws.searchEverywhere>> | null>(null);
const busy = ref(false);
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => `${ws.searchQuery}|${ws.vaults.map((v) => `${v.id}:${v.unlocked}`).join(',')}`,
  () => {
    clearTimeout(timer);
    const current = ++generation;
    result.value = null;
    busy.value = false;
    if (ws.searchQuery.trim().length < 2) return;
    busy.value = true;
    timer = setTimeout(async () => {
      const found = await ws.searchEverywhere(ws.searchQuery);
      if (generation === current) {
        result.value = found;
        busy.value = false;
      }
    }, 300);
  },
);
onBeforeUnmount(() => {
  generation++;
  clearTimeout(timer);
});
function open(entry: { id: string; vaultId: string }): void {
  ws.searchQuery = '';
  void router.push({ path: '/', query: { vault: entry.vaultId, entry: entry.id } });
}
</script>

<template>
  <section
    v-if="ws.searchQuery.trim().length >= 2"
    class="card absolute left-0 right-0 top-full z-40 mt-2 max-h-[65vh] overflow-y-auto p-2 text-sm shadow-lg"
    :aria-label="t('corporate.globalSearch')"
    data-testid="global-search-results"
  >
    <p class="px-2 py-1 text-xs text-slate-500">{{ t('corporate.globalSearch') }}</p>
    <p v-if="busy" class="p-2 text-slate-500" role="status">{{ t('common.working') }}</p>
    <template v-if="result">
      <p
        v-if="result.unavailable"
        class="p-2 text-xs text-amber-700 dark:text-amber-300"
        role="status"
      >
        {{ t('corporate.searchPartial', { n: result.unavailable }) }}
      </p>
      <p v-if="!result.matches.length" class="p-2 text-slate-500">{{ t('vault.noMatch') }}</p>
      <ul>
        <li v-for="entry in result.matches.slice(0, 100)" :key="entry.id">
          <button
            type="button"
            class="w-full rounded-md px-2 py-2 text-left hover:bg-brand-50 focus-visible:bg-brand-50"
            data-testid="global-search-result"
            @click.prevent="open(entry)"
          >
            <span class="block truncate font-medium">{{ entry.title }}</span>
            <span class="block truncate text-xs text-slate-500"
              >{{ entry.vaultName ?? t('vault.locker')
              }}<span v-if="entry.path"> / {{ entry.path }}</span> · {{ entry.username }}</span
            >
          </button>
        </li>
      </ul>
      <p v-if="result.matches.length > 100" class="p-2 text-xs text-slate-500">
        {{ t('corporate.refineSearch') }}
      </p>
    </template>
  </section>
</template>
