<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, spaceLabel, vaultLabel, when } from '../services/helpers';
import { confirmStepUp } from '../services/stepup';
import { useAuthStore } from '../stores/auth';
import PersonPicker, { type Person as Found } from './PersonPicker.vue';

/**
 * Главный администратор и обзор организации. Роль только передаётся: преемник подтверждает приём своим
 * мастер-паролем. Обзор — метаданные (названия, владельцы, число участников и записей), без содержимого.
 */
const { t } = useI18n();
const auth = useAuthStore();
type Person = { id: string; name: string; email: string };
interface Chief extends Person {
  authSource: string;
  since: string | null;
  disabled: boolean;
}
interface Status {
  chief: Person | null;
  chiefs: Chief[];
  you: boolean;
  offer: { to: Person | null; expiresAt: string } | null;
  offers: { to: Person | null; expiresAt: string }[];
}
interface VaultRow {
  id: string;
  name: string | null;
  owners: string[];
  members: number;
  groups: number;
  entries: number;
  lastChange: string | null;
  security: { high: number; medium: number; checkedAt: string | null };
}
interface SpaceRow {
  id: string;
  name: string;
  archived: boolean;
  publicToOrg: boolean;
  isDefault: boolean;
  vaults: VaultRow[];
}
// итог подразделения: открытые события по риску и сейфы, которые ни разу не проверялись
const totals = (sp: SpaceRow) => ({
  high: sp.vaults.reduce((a, v) => a + v.security.high, 0),
  medium: sp.vaults.reduce((a, v) => a + v.security.medium, 0),
  unchecked: sp.vaults.filter((v) => !v.security.checkedAt).length,
});
// рейтинг подразделений по риску: у организации с десятками отделов подробные таблицы — это сотни строк
const ranking = computed(() =>
  structure.value
    .filter((s) => s.vaults.length)
    .map((s) => ({ s, ...totals(s), entries: s.vaults.reduce((a, v) => a + v.entries, 0) }))
    .sort(
      (a, b) =>
        b.high - a.high ||
        b.medium - a.medium ||
        b.unchecked - a.unchecked ||
        a.s.name.localeCompare(b.s.name, undefined, { numeric: true }),
    ),
);
const status = ref<Status | null>(null);
const structure = ref<SpaceRow[]>([]);
const successorPick = ref<Found[]>([]);
const successor = computed(() => successorPick.value[0]?.id ?? '');
const password = ref('');
const query = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');

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
      structure.value = await api<SpaceRow[]>('GET', '/admin/structure');
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
// ---- несколько главных администраторов
const appointPick = ref<Found[]>([]);
const appointPassword = ref('');
const removing = ref<string | null>(null);
const removePassword = ref('');
async function appoint(): Promise<void> {
  const target = appointPick.value[0];
  if (!target || !appointPassword.value || !auth.user) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const headers = await confirmStepUp(auth.user, appointPassword.value);
    await api('POST', '/admin/chief/appoint', { userId: target.id }, { headers });
    appointPassword.value = '';
    appointPick.value = [];
    notice.value = t('chief.addSent');
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
async function withdraw(userId: string): Promise<void> {
  try {
    await api('DELETE', `/admin/chief/appoint/${userId}`);
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
async function removeChief(id: string): Promise<void> {
  if (!removePassword.value || !auth.user) return;
  busy.value = true;
  error.value = '';
  try {
    const headers = await confirmStepUp(auth.user, removePassword.value);
    await api('DELETE', `/admin/chief/${id}`, undefined, { headers });
    removePassword.value = '';
    removing.value = null;
    notice.value = t('chief.removed');
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
const activeChiefs = computed(() => status.value?.chiefs.filter((c) => !c.disabled).length ?? 0);

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
      <div
        v-if="status?.chiefs.length"
        class="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-700"
        data-testid="chief-current"
      >
        <table class="min-w-full text-sm" data-testid="chief-table">
          <thead class="text-left text-xs text-slate-500">
            <tr>
              <th class="px-2 py-1">{{ t('chief.colName') }}</th>
              <th>{{ t('chief.colLogin') }}</th>
              <th>{{ t('chief.colSource') }}</th>
              <th>{{ t('chief.colSince') }}</th>
              <th>{{ t('chief.colStatus') }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in status.chiefs"
              :key="c.id"
              class="border-t border-slate-200 dark:border-slate-800"
              data-testid="chief-row"
            >
              <td class="px-2 py-1 font-medium">
                {{ c.name }}
                <span v-if="c.id === auth.user?.id" class="badge ml-1">{{ t('chief.you') }}</span>
              </td>
              <td>{{ c.email }}</td>
              <td>{{ t(`chief.source.${c.authSource}`) }}</td>
              <td>{{ c.since ? when(c.since) : '—' }}</td>
              <td>{{ c.disabled ? t('chief.blocked') : t('chief.active') }}</td>
              <td class="px-2 text-right">
                <template v-if="status.you">
                  <button
                    v-if="removing !== c.id"
                    type="button"
                    class="btn"
                    :disabled="activeChiefs < 2 && !c.disabled"
                    :title="activeChiefs < 2 && !c.disabled ? t('chief.lastOne') : undefined"
                    :data-testid="`chief-remove-${c.email}`"
                    @click="((removing = c.id), (removePassword = ''))"
                  >
                    {{ t('chief.remove') }}
                  </button>
                  <form v-else class="inline-flex gap-1" @submit.prevent="removeChief(c.id)">
                    <input
                      v-model="removePassword"
                      type="password"
                      autocomplete="current-password"
                      class="input w-40"
                      :placeholder="t('chief.password')"
                      required
                      data-testid="chief-remove-password"
                    />
                    <button type="submit" class="btn-danger" :disabled="busy">
                      {{ t('chief.removeConfirm') }}
                    </button>
                  </form>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
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
        <div v-if="status.offers.length" class="notice notice-warn" data-testid="chief-offers">
          <strong>{{ t('chief.offers') }}:</strong>
          <span
            v-for="o in status.offers"
            :key="o.to?.id"
            class="ml-2 inline-flex items-center gap-1"
          >
            {{ o.to?.name ?? '—' }}, {{ when(o.expiresAt) }}
            <button type="button" class="btn" @click="o.to && withdraw(o.to.id)">
              {{ t('chief.cancel') }}
            </button>
          </span>
        </div>
        <details class="rounded-[10px] border border-slate-200 p-3 dark:border-slate-700">
          <summary class="cursor-pointer font-medium" data-testid="chief-add">
            {{ t('chief.add') }}
          </summary>
          <form class="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]" @submit.prevent="appoint">
            <label
              ><span class="field-label">{{ t('chief.colName') }}</span>
              <PersonPicker
                v-model="appointPick"
                :exclude="status.chiefs.map((c) => c.id)"
                :placeholder="t('chief.choose')"
                testid="chief-add-person"
            /></label>
            <label
              ><span class="field-label">{{ t('chief.password') }}</span>
              <input
                v-model="appointPassword"
                type="password"
                autocomplete="current-password"
                class="input"
                required
                data-testid="chief-add-password"
            /></label>
            <button
              type="submit"
              class="btn-primary self-end"
              :disabled="busy"
              data-testid="chief-add-send"
            >
              {{ t('chief.send') }}
            </button>
          </form>
          <p class="mt-2 text-xs text-slate-500">{{ t('chief.addHint') }}</p>
        </details>
        <details class="rounded-[10px] border border-slate-200 p-3 dark:border-slate-700">
          <summary class="cursor-pointer font-medium" data-testid="chief-transfer">
            {{ t('chief.transfer') }}
          </summary>
          <form class="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]" @submit.prevent="offer">
            <label
              ><span class="field-label">{{ t('chief.successor') }}</span>
              <PersonPicker
                v-model="successorPick"
                :exclude="status?.chief ? [status.chief.id] : []"
                :placeholder="t('chief.choose')"
                testid="chief-successor"
            /></label>
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
          class="input w-full sm:w-80"
          :placeholder="t('chief.find')"
          :aria-label="t('chief.find')"
        />
      </div>
      <div v-if="ranking.length > 3 && !query" class="mt-3" data-testid="structure-rank">
        <h3 class="text-sm font-semibold">{{ t('chief.rank') }}</h3>
        <p class="text-xs text-slate-500">{{ t('chief.rankHint') }}</p>
        <div
          class="mt-1 max-h-64 overflow-auto rounded-md border border-slate-200 dark:border-slate-700"
        >
          <table class="min-w-full text-sm">
            <thead class="sticky top-0 bg-white text-left text-xs text-slate-500 dark:bg-slate-900">
              <tr>
                <th class="px-2 py-1">{{ t('chief.rank') }}</th>
                <th>{{ t('chief.rankVaults') }}</th>
                <th>{{ t('chief.entries') }}</th>
                <th>{{ t('chief.rankHigh') }}</th>
                <th>{{ t('chief.rankMedium') }}</th>
                <th>{{ t('chief.rankUnchecked') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in ranking"
                :key="r.s.id"
                class="border-t border-slate-200 dark:border-slate-800"
                data-testid="structure-rank-row"
              >
                <td class="px-2 py-1">
                  <button type="button" class="font-medium underline" @click="query = r.s.name">
                    {{ spaceLabel(r.s, t) }}
                  </button>
                </td>
                <td class="tabular-nums">{{ r.s.vaults.length }}</td>
                <td class="tabular-nums">{{ r.entries }}</td>
                <td class="tabular-nums" :class="r.high ? 'font-medium text-red-600' : ''">
                  {{ r.high }}
                </td>
                <td class="tabular-nums" :class="r.medium ? 'text-amber-700' : ''">
                  {{ r.medium }}
                </td>
                <td class="tabular-nums">{{ r.unchecked }}</td>
              </tr>
            </tbody>
          </table>
        </div>
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
          <span
            v-if="s.vaults.length"
            class="ml-2 text-xs font-normal"
            :data-testid="`structure-risk-${s.id}`"
            >{{ t('chief.riskTotals', totals(s)) }}</span
          >
        </h3>
        <p v-if="!s.vaults.length" class="text-xs text-slate-500">{{ t('chief.noVaults') }}</p>
        <div v-else class="mt-1 overflow-x-auto">
          <table class="min-w-full text-sm">
            <thead class="text-left text-xs text-slate-500">
              <tr>
                <th class="py-1 pr-3">{{ t('chief.vault') }}</th>
                <th class="pr-3">{{ t('chief.owners') }}</th>
                <th class="pr-3">{{ t('chief.members') }}</th>
                <th class="pr-3">{{ t('chief.groups') }}</th>
                <th class="pr-3">{{ t('chief.entries') }}</th>
                <th class="pr-3">{{ t('chief.security') }}</th>
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
                <td class="pr-3 tabular-nums">{{ v.members }}</td>
                <td class="pr-3 tabular-nums">{{ v.groups }}</td>
                <td class="pr-3 tabular-nums">{{ v.entries }}</td>
                <td
                  class="whitespace-nowrap pr-3 text-xs"
                  :title="v.security.checkedAt ? when(v.security.checkedAt) : ''"
                  data-testid="structure-security"
                >
                  <span v-if="!v.security.checkedAt" class="text-slate-500">{{
                    t('chief.unchecked')
                  }}</span>
                  <template v-else-if="v.security.high || v.security.medium">
                    <span v-if="v.security.high" class="text-red-600">{{
                      t('chief.high', { n: v.security.high })
                    }}</span>
                    <span v-if="v.security.high && v.security.medium"> · </span>
                    <span v-if="v.security.medium" class="text-amber-700 dark:text-amber-300">{{
                      t('chief.medium', { n: v.security.medium })
                    }}</span>
                  </template>
                  <span v-else class="text-emerald-700 dark:text-emerald-300">{{
                    t('chief.clean')
                  }}</span>
                </td>
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
