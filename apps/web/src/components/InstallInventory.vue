<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';

/** Фактические версии работающей установки: среда, база, хост и зависимости сервера. */
interface Inventory {
  app: { version: string; commit: string; builtAt: string };
  runtime: { node: string; openssl: string; os: string | null; arch: string };
  database: string | null;
  host: {
    docker: string | null;
    compose: string | null;
    os: string | null;
    kernel: string | null;
  } | null;
  dependencies: { name: string; version: string | null }[];
}
const { t } = useI18n();
const inv = ref<Inventory | null>(null);
const error = ref('');
onMounted(async () => {
  try {
    inv.value = await api<Inventory>('GET', '/admin/updates/inventory');
  } catch (e) {
    error.value = errorMessage(e, t);
  }
});
const rows = computed(() => {
  const i = inv.value;
  if (!i) return [];
  const all: [string, string | null][] = [
    ['Arklock', `${i.app.version} · ${i.app.commit.slice(0, 7)}`],
    ['Node.js', i.runtime.node],
    ['OpenSSL', i.runtime.openssl],
    [t('inventory.containerOs'), i.runtime.os ? `${i.runtime.os} (${i.runtime.arch})` : null],
    [t('inventory.database'), i.database?.split(' on ')[0]?.split(',')[0] ?? null],
    ['Docker', i.host?.docker ?? null],
    ['Docker Compose', i.host?.compose ?? null],
    [t('inventory.hostOs'), i.host?.os ?? null],
    [t('inventory.kernel'), i.host?.kernel ?? null],
  ];
  return all.filter(([, v]) => v);
});
</script>

<template>
  <div data-testid="inventory">
    <h2 class="mb-1 font-medium">{{ t('inventory.title') }}</h2>
    <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
    <template v-else-if="inv">
      <dl
        class="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white text-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900"
      >
        <div v-for="[k, v] in rows" :key="k" class="flex justify-between gap-3 px-4 py-1.5">
          <dt class="text-slate-500">{{ k }}</dt>
          <dd class="num text-right" data-testid="inventory-row">{{ v }}</dd>
        </div>
      </dl>
      <details class="mt-2 text-sm">
        <summary class="cursor-pointer text-slate-600 dark:text-slate-300">
          {{ t('inventory.deps', { n: inv.dependencies.length }) }}
        </summary>
        <ul class="mt-1 grid gap-x-4 sm:grid-cols-2">
          <li v-for="d in inv.dependencies" :key="d.name" class="flex justify-between gap-2 py-0.5">
            <span class="truncate font-mono text-xs">{{ d.name }}</span>
            <span class="num text-xs text-slate-500">{{ d.version ?? '—' }}</span>
          </li>
        </ul>
      </details>
      <p class="mt-1 text-xs text-slate-500">
        {{ t('inventory.hint') }}
        <a
          class="underline"
          :href="`https://github.com/calleograph/Arklock/releases/tag/v${inv.app.version}`"
          target="_blank"
          rel="noopener noreferrer"
          >{{ t('inventory.sbom') }}</a
        >
      </p>
    </template>
  </div>
</template>
