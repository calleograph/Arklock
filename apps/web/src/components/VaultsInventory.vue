<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, vaultLabel, when } from '../services/helpers';
import { useAuthStore } from '../stores/auth';

/** Инвентаризация сейфов для главного администратора: страницами, с поиском и отбором по типу; только метаданные. */
const { t } = useI18n();
const auth = useAuthStore();
interface Row {
  id: string;
  kind: 'corporate' | 'managed' | 'private';
  name: string | null;
  space: string | null;
  owner: string | null;
  people: number;
  entries: number;
  lastChange: string | null;
  pendingKeys: number;
  guardians: string[];
}
const PAGE = 50;
const rows = ref<Row[]>([]);
const total = ref(0);
const counts = ref({ corporate: 0, managed: 0, private: 0 });
const kind = ref<'' | 'corporate' | 'managed' | 'private'>('');
const q = ref('');
const page = ref(0);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;

async function load(): Promise<void> {
  try {
    const p = new URLSearchParams({
      limit: String(PAGE),
      offset: String(page.value * PAGE),
      q: q.value.trim(),
    });
    if (kind.value) p.set('kind', kind.value);
    const r = await api<{ items: Row[]; total: number; counts: typeof counts.value }>(
      'GET',
      `/admin/vaults?${p}`,
    );
    rows.value = r.items;
    total.value = r.total;
    counts.value = r.counts;
    error.value = '';
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
onMounted(() => {
  if (auth.user?.chief) void load();
});
watch([kind, q], () => {
  page.value = 0;
  clearTimeout(timer);
  timer = setTimeout(() => void load(), 250);
});
onBeforeUnmount(() => clearTimeout(timer));
const go = (n: number) => {
  page.value += n;
  void load();
};
const label = (r: Row) =>
  r.kind === 'private' ? t('managed.privateName') : vaultLabel({ name: r.name, kind: 'shared' }, t);
const to = computed(() => Math.min(total.value, (page.value + 1) * PAGE));
</script>

<template>
  <section class="space-y-3" data-testid="vaults-inventory">
    <div>
      <h2 class="text-base font-semibold">{{ t('managed.inventory') }}</h2>
      <p class="mt-1 max-w-prose text-xs text-slate-500">{{ t('managed.inventoryHint') }}</p>
    </div>
    <p v-if="!auth.user?.chief" class="notice notice-warn">{{ t('managed.onlyChief') }}</p>
    <template v-else>
      <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-0.5 text-xs dark:bg-slate-800">
          <button
            v-for="k in ['', 'corporate', 'managed', 'private'] as const"
            :key="k"
            type="button"
            class="seg"
            :class="kind === k ? 'seg-on' : ''"
            :data-testid="`vaults-kind-${k || 'all'}`"
            @click="kind = k"
          >
            {{ t(`managed.kind.${k || 'all'}`) }}
            <span v-if="k" class="ml-0.5 text-slate-500">{{ counts[k] }}</span>
          </button>
        </div>
        <input
          v-model="q"
          type="search"
          class="input w-full sm:w-72"
          :placeholder="t('managed.find')"
          :aria-label="t('managed.find')"
          data-testid="vaults-search"
        />
      </div>
      <div class="card overflow-x-auto">
        <table class="min-w-full text-sm" data-testid="vaults-table">
          <thead class="text-left text-xs text-slate-500">
            <tr>
              <th class="px-3 py-2">{{ t('managed.colName') }}</th>
              <th>{{ t('managed.colType') }}</th>
              <th>{{ t('managed.colSpace') }}</th>
              <th>{{ t('managed.colOwner') }}</th>
              <th>{{ t('managed.colPeople') }}</th>
              <th>{{ t('managed.colEntries') }}</th>
              <th>{{ t('managed.colLast') }}</th>
              <th>{{ t('managed.colKeys') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in rows"
              :key="r.id"
              class="border-t border-slate-200 dark:border-slate-800"
              data-testid="vault-row"
            >
              <td class="px-3 py-2 font-medium">
                {{ label(r) }}
                <div v-if="r.guardians.length" class="text-xs font-normal text-slate-500">
                  {{ t('managed.guardians', { list: r.guardians.join(', ') }) }}
                </div>
              </td>
              <td>{{ t(`managed.kind.${r.kind}`) }}</td>
              <td>{{ r.space ?? '—' }}</td>
              <td>{{ r.owner ?? '—' }}</td>
              <td>{{ r.people }}</td>
              <td>{{ r.entries }}</td>
              <td class="text-xs">{{ r.lastChange ? when(r.lastChange) : '—' }}</td>
              <td class="text-xs" :class="r.pendingKeys ? 'text-amber-700' : 'text-emerald-700'">
                {{
                  r.pendingKeys
                    ? t('managed.keysPending', { n: r.pendingKeys })
                    : t('managed.keysOk')
                }}
              </td>
            </tr>
          </tbody>
        </table>
        <div
          class="flex items-center justify-between border-t border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-800"
        >
          <span data-testid="vaults-range">
            {{ t('managed.of', { from: total ? page * PAGE + 1 : 0, to, total }) }}
          </span>
          <span class="flex gap-1">
            <button type="button" class="btn" :disabled="page === 0" @click="go(-1)">
              {{ t('admin.pagePrev') }}
            </button>
            <button type="button" class="btn" :disabled="to >= total" @click="go(1)">
              {{ t('admin.pageNext') }}
            </button>
          </span>
        </div>
      </div>
    </template>
  </section>
</template>
