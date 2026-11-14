<script setup lang="ts">
import InfoHint from './InfoHint.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, vaultLabel, when } from '../services/helpers';
import { useAuthStore } from '../stores/auth';
import { useWorkspaceStore } from '../stores/workspace';

/** Сейфы организации для главного администратора: страницами и с поиском; только сведения о доступе. */
const { t } = useI18n();
const auth = useAuthStore();
const ws = useWorkspaceStore();
/** Сейфы, в которых просматривающий участник: только их настройки он может открыть. */
const mine = computed(() => new Set(ws.vaults.map((v) => v.id)));
interface Row {
  id: string;
  name: string | null;
  owner: string | null;
  people: number;
  groups: string[];
  entries: number;
  lastChange: string | null;
  pendingKeys: number;
  security: { high: number; medium: number; checkedAt: string | null };
}
const PAGE = 50;
const rows = ref<Row[]>([]);
const total = ref(0);
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
    const r = await api<{ items: Row[]; total: number }>('GET', `/admin/vaults?${p}`);
    rows.value = r.items;
    total.value = r.total;
    error.value = '';
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
onMounted(() => {
  if (auth.user?.chief) void load();
  if (!ws.vaults.length) void ws.loadVaults().catch(() => undefined);
});
watch(q, () => {
  page.value = 0;
  clearTimeout(timer);
  timer = setTimeout(() => void load(), 250);
});
onBeforeUnmount(() => clearTimeout(timer));
const go = (n: number) => {
  page.value += n;
  void load();
};
const to = computed(() => Math.min(total.value, (page.value + 1) * PAGE));
</script>

<template>
  <section class="space-y-3" data-testid="vaults-inventory">
    <p v-if="!auth.user?.chief" class="notice notice-warn">{{ t('vaultList.onlyChief') }}</p>
    <template v-else>
      <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
      <input
        v-model="q"
        type="search"
        class="input w-full sm:w-72"
        :placeholder="t('vaultList.find')"
        :aria-label="t('vaultList.find')"
        data-testid="vaults-search"
      />
      <div class="card overflow-x-auto">
        <table class="table-cards min-w-full text-sm" data-testid="vaults-table">
          <thead class="text-left text-xs text-slate-500">
            <tr>
              <th class="px-3 py-2">{{ t('vaultList.colName') }}</th>
              <th>{{ t('vaultList.colOwner') }}</th>
              <th>{{ t('vaultList.colGroups') }}</th>
              <th>{{ t('vaultList.colPeople') }}</th>
              <th>{{ t('vaultList.colEntries') }}</th>
              <th>{{ t('vaultList.colSecurity') }}</th>
              <th>{{ t('vaultList.colLast') }}</th>
              <th>{{ t('vaultList.colKeys') }}</th>
              <th class="pr-3">{{ t('vaultList.colActions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!rows.length">
              <td colspan="9" class="px-3 py-4 text-slate-500">{{ t('vaultList.empty') }}</td>
            </tr>
            <tr
              v-for="r in rows"
              :key="r.id"
              class="border-t border-slate-200 dark:border-slate-800"
              data-testid="vault-row"
            >
              <td class="cell-main px-3 py-2 font-medium">
                {{ vaultLabel({ name: r.name }, t) }}
              </td>
              <td :data-label="t('vaultList.colOwner')">{{ r.owner ?? '—' }}</td>
              <td :data-label="t('vaultList.colGroups')" data-testid="vault-row-groups">
                {{ r.groups.join(', ') || t('vaultList.noGroups') }}
              </td>
              <td :data-label="t('vaultList.colPeople')" class="tabular-nums">{{ r.people }}</td>
              <td :data-label="t('vaultList.colEntries')" class="tabular-nums">{{ r.entries }}</td>
              <td
                :data-label="t('vaultList.colSecurity')"
                class="whitespace-nowrap text-xs"
                :title="r.security.checkedAt ? when(r.security.checkedAt) : ''"
                data-testid="vault-row-security"
              >
                <span v-if="!r.security.checkedAt" class="text-slate-500">{{
                  t('vaultList.unchecked')
                }}</span>
                <template v-else-if="r.security.high || r.security.medium">
                  <span v-if="r.security.high" class="text-red-600">{{
                    t('vaultList.high', { n: r.security.high })
                  }}</span>
                  <span v-if="r.security.high && r.security.medium"> · </span>
                  <span v-if="r.security.medium" class="text-amber-700 dark:text-amber-300">{{
                    t('vaultList.medium', { n: r.security.medium })
                  }}</span>
                </template>
                <span v-else class="text-emerald-700 dark:text-emerald-300">{{
                  t('vaultList.clean')
                }}</span>
              </td>
              <td :data-label="t('vaultList.colLast')" class="text-xs">
                {{ r.lastChange ? when(r.lastChange) : '—' }}
              </td>
              <td
                :data-label="t('vaultList.colKeys')"
                class="text-xs"
                :class="r.pendingKeys ? 'text-amber-700' : 'text-emerald-700'"
              >
                {{
                  r.pendingKeys
                    ? t('vaultList.keysPending', { n: r.pendingKeys })
                    : t('vaultList.keysOk')
                }}
              </td>
              <td class="cell-action pr-3 text-xs">
                <RouterLink
                  v-if="mine.has(r.id)"
                  :to="`/vault/${r.id}/settings`"
                  class="btn"
                  :data-testid="`vault-settings-${r.id}`"
                  >{{ t('vaultList.openSettings') }}</RouterLink
                >
                <span v-else class="inline-flex items-center gap-1 text-slate-500"
                  >{{ t('vaultList.notMember') }}<InfoHint :text="t('vaultList.notMemberHint')"
                /></span>
              </td>
            </tr>
          </tbody>
        </table>
        <div
          class="flex items-center justify-between border-t border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-800"
        >
          <span data-testid="vaults-range">
            {{ t('vaultList.of', { from: total ? page * PAGE + 1 : 0, to, total }) }}
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
