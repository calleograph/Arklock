<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, spaceLabel, vaultLabel, when } from '../services/helpers';
import { confirmStepUp } from '../services/stepup';
import { useAuthStore } from '../stores/auth';

/**
 * Главный администратор и обзор организации. Роль только передаётся: преемник подтверждает приём своим
 * мастер-паролем. Обзор — метаданные (названия, владельцы, число участников и записей), без содержимого.
 */
const { t } = useI18n();
const auth = useAuthStore();
type Person = { id: string; name: string; email: string };
interface Status {
  chief: Person | null;
  you: boolean;
  offer: { to: Person | null; expiresAt: string } | null;
}
interface VaultRow {
  id: string;
  name: string | null;
  owners: string[];
  members: number;
  groups: number;
  entries: number;
  lastChange: string | null;
}
interface SpaceRow {
  id: string;
  name: string;
  archived: boolean;
  publicToOrg: boolean;
  isDefault: boolean;
  vaults: VaultRow[];
}
const status = ref<Status | null>(null);
const structure = ref<SpaceRow[]>([]);
const people = ref<(Person & { disabled: boolean })[]>([]);
const successor = ref('');
const password = ref('');
const query = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');

const candidates = computed(() =>
  people.value.filter((p) => !p.disabled && p.id !== status.value?.chief?.id),
);
const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return structure.value;
  return structure.value
    .map((s) => ({
      ...s,
      vaults: s.vaults.filter((v) =>
        [s.name, v.name ?? '', ...v.owners].some((x) => x.toLowerCase().includes(q)),
      ),
    }))
    .filter((s) => s.vaults.length);
});

async function load(): Promise<void> {
  error.value = '';
  try {
    status.value = await api<Status>('GET', '/admin/chief');
    if (status.value.you) {
      const [s, u] = await Promise.all([
        api<SpaceRow[]>('GET', '/admin/structure'),
        api<(Person & { disabled: boolean })[]>('GET', '/admin/users'),
      ]);
      structure.value = s;
      people.value = u;
    }
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
onMounted(load);

async function offer(): Promise<void> {
  if (!successor.value || !password.value || !auth.user) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const headers = await confirmStepUp(auth.user, password.value);
    await api('POST', '/admin/chief/transfer', { userId: successor.value }, { headers });
    password.value = '';
    notice.value = t('chief.offered');
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
async function cancel(): Promise<void> {
  busy.value = true;
  try {
    await api('DELETE', '/admin/chief/transfer');
    notice.value = '';
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="space-y-4" data-testid="organization">
    <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
    <section class="card space-y-3 p-4 text-sm">
      <div>
        <h2>{{ t('chief.title') }}</h2>
        <p class="mt-1 text-xs text-slate-500">{{ t('chief.intro') }}</p>
      </div>
      <p v-if="status?.chief" data-testid="chief-current">
        <strong>{{ status.chief.name }}</strong>
        <span class="text-slate-500"> · {{ status.chief.email }}</span>
        <span v-if="status.you" class="badge ml-1">{{ t('chief.you') }}</span>
      </p>
      <p v-else-if="status" class="text-slate-500">{{ t('chief.none') }}</p>

      <template v-if="status?.you">
        <p v-if="notice" class="notice notice-ok" role="status">{{ notice }}</p>
        <div v-if="status.offer" class="notice notice-warn" data-testid="chief-offer">
          {{
            t('chief.pending', {
              name: status.offer.to?.name ?? '—',
              until: when(status.offer.expiresAt),
            })
          }}
          <button type="button" class="btn ml-2" :disabled="busy" @click="cancel">
            {{ t('chief.cancel') }}
          </button>
        </div>
        <details class="rounded-[10px] border border-slate-200 p-3 dark:border-slate-700">
          <summary class="cursor-pointer font-medium" data-testid="chief-transfer">
            {{ t('chief.transfer') }}
          </summary>
          <form class="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]" @submit.prevent="offer">
            <label
              ><span class="field-label">{{ t('chief.successor') }}</span>
              <select v-model="successor" class="input" required data-testid="chief-successor">
                <option value="" disabled>{{ t('chief.choose') }}</option>
                <option v-for="p in candidates" :key="p.id" :value="p.id">
                  {{ p.name }} · {{ p.email }}
                </option>
              </select></label
            >
            <label
              ><span class="field-label">{{ t('chief.password') }}</span>
              <input
                v-model="password"
                type="password"
                autocomplete="current-password"
                class="input"
                required
                data-testid="chief-password"
            /></label>
            <button
              type="submit"
              class="btn-primary self-end"
              :disabled="busy"
              data-testid="chief-offer-send"
            >
              {{ t('chief.send') }}
            </button>
          </form>
          <p class="mt-2 text-xs text-slate-500">{{ t('chief.transferHint') }}</p>
        </details>
      </template>
      <p v-else-if="status" class="text-xs text-slate-500">{{ t('chief.onlyChief') }}</p>
    </section>

    <section v-if="status?.you" class="card p-4 text-sm" data-testid="structure">
      <div class="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2>{{ t('chief.structure') }}</h2>
          <p class="mt-1 text-xs text-slate-500">{{ t('chief.structureHint') }}</p>
        </div>
        <input
          v-model="query"
          type="search"
          class="input w-full sm:w-64"
          :placeholder="t('chief.find')"
          :aria-label="t('chief.find')"
        />
      </div>
      <p v-if="!shown.length" class="mt-3 text-slate-500">{{ t('chief.nothing') }}</p>
      <div v-for="s in shown" :key="s.id" class="mt-4">
        <h3 class="text-sm font-semibold">
          {{ spaceLabel(s, t) }}
          <span class="text-xs font-normal text-slate-500"
            >·
            {{
              s.archived ? t('chief.archived') : s.publicToOrg ? t('chief.open') : t('chief.closed')
            }}</span
          >
        </h3>
        <p v-if="!s.vaults.length" class="text-xs text-slate-500">{{ t('chief.noVaults') }}</p>
        <div v-else class="mt-1 overflow-x-auto">
          <table class="min-w-full text-sm">
            <thead class="text-left text-xs text-slate-500">
              <tr>
                <th class="py-1 pr-3">{{ t('chief.vault') }}</th>
                <th class="pr-3">{{ t('chief.owners') }}</th>
                <th class="pr-3 text-right">{{ t('chief.members') }}</th>
                <th class="pr-3 text-right">{{ t('chief.groups') }}</th>
                <th class="pr-3 text-right">{{ t('chief.entries') }}</th>
                <th>{{ t('chief.lastChange') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="v in s.vaults"
                :key="v.id"
                class="border-t border-slate-200 dark:border-slate-800"
                data-testid="structure-vault"
              >
                <td class="py-1 pr-3 font-medium">{{ vaultLabel(v, t) }}</td>
                <td class="pr-3">{{ v.owners.join(', ') || '—' }}</td>
                <td class="pr-3 text-right tabular-nums">{{ v.members }}</td>
                <td class="pr-3 text-right tabular-nums">{{ v.groups }}</td>
                <td class="pr-3 text-right tabular-nums">{{ v.entries }}</td>
                <td class="whitespace-nowrap text-xs">
                  {{ v.lastChange ? when(v.lastChange) : '—' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </div>
</template>
