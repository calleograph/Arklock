<script setup lang="ts">
import InfoHint from './InfoHint.vue';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, when } from '../services/helpers';
import { confirmStepUp } from '../services/stepup';
import { useAuthStore } from '../stores/auth';
import PersonPicker, { type Person as Found } from './PersonPicker.vue';

/**
 * Главный администратор. Роль только передаётся: преемник подтверждает приём своим паролем разблокировки сейфов.
 * Обзор всех сейфов — в разделе «Сейфы».
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
const status = ref<Status | null>(null);
const successorPick = ref<Found[]>([]);
const successor = computed(() => successorPick.value[0]?.id ?? '');
const password = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');

async function load(): Promise<void> {
  error.value = '';
  try {
    status.value = await api<Status>('GET', '/admin/chief');
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
        <h2>{{ t('chief.title') }}<InfoHint class="ml-1" :text="t('chief.intro')" /></h2>
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
        <details class="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
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
                :directory="false"
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
        <details class="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
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
                :directory="false"
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
  </div>
</template>
