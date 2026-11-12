<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, api } from '../services/api';
import { errorMessage } from '../services/helpers';
import Icon from './Icon.vue';
import InfoHint from './InfoHint.vue';

/**
 * Единое окно «Предоставить доступ» для сейфа, папки и записи: один поиск по сотрудникам и группам,
 * несколько получателей за раз, общий уровень и срок с возможностью изменить уровень у каждого.
 * Само назначение выполняет вызывающий компонент (у сейфа — выдача ключа, у папки и записи — правило доступа).
 */
export interface Recipient {
  kind: 'user' | 'circle';
  id: string;
  name: string;
  email?: string;
  publicKey?: string;
  signPublicKey?: string;
  /** Профиль создан по каталогу, человек ещё не входил: роль назначается сразу, ключ сейфа — после его первого входа. */
  pending?: boolean;
  level: string;
}
/** Найденное в каталоге домена: выбор создаёт профиль (человек) или связанную группу (группа). */
type Result = Omit<Recipient, 'level'> & {
  dir?: { kind: 'person' | 'group'; profileId: string; dn: string };
};
const props = defineProps<{
  open: boolean;
  title: string;
  levels: { value: string; label: string; hint?: string; disabled?: boolean }[];
  defaultLevel: string;
  /** Уже имеющие доступ: в поиске помечаются, чтобы не назначать дважды. */
  existing?: string[];
  busy?: boolean;
  error?: string;
  /**
   * Что выдаётся: весь сейф (только участникам подразделения) или папка и запись (можно и человеку из другого
   * подразделения, в том числе из каталога: он станет гостем и увидит только выданное).
   */
  scope?: 'vault' | 'object';
}>();
const emit = defineEmits<{
  close: [];
  submit: [recipients: Recipient[], expiresAt: string | null];
}>();
const { t } = useI18n();

const dialog = ref<HTMLDialogElement | null>(null);
const query = ref('');
const results = ref<Result[]>([]);
// домен доступен только администраторам: после первого отказа его больше не опрашиваем
let directoryDenied = false;
const resolving = ref(false);
const circles = ref<{ id: string; name: string }[] | null>(null);
const picked = ref<Recipient[]>([]);
const level = ref(props.defaultLevel);
const term = ref<'none' | '1' | '7' | '30' | 'date'>('none');
const date = ref('');
const searching = ref(false);
const searchError = ref('');
const active = ref(-1);
const input = ref<HTMLInputElement | null>(null);

watch(
  () => props.open,
  async (open) => {
    if (open) {
      picked.value = [];
      query.value = '';
      results.value = [];
      level.value = props.defaultLevel;
      term.value = 'none';
      date.value = '';
      dialog.value?.showModal();
      await nextTick();
      input.value?.focus();
    } else dialog.value?.close();
  },
);

let timer: ReturnType<typeof setTimeout> | undefined;
watch(query, (q) => {
  clearTimeout(timer);
  active.value = -1;
  timer = setTimeout(() => void find(q.trim()), 220);
});
onBeforeUnmount(() => clearTimeout(timer));

async function find(q: string): Promise<void> {
  searchError.value = '';
  if (q.length < 2) {
    results.value = [];
    return;
  }
  searching.value = true;
  try {
    circles.value ??= await api<{ id: string; name: string }[]>('GET', '/directory/circles');
    const users = await api<
      { id: string; name: string; email: string; publicKey: string; signPublicKey: string }[]
    >('GET', `/directory/users?q=${encodeURIComponent(q)}`);
    const lower = q.toLowerCase();
    const local: Result[] = [
      ...users.map((u) => ({ kind: 'user' as const, ...u })),
      ...circles.value
        .filter((c) => c.name.toLowerCase().includes(lower))
        .map((c) => ({ kind: 'circle' as const, id: c.id, name: c.name })),
    ];
    results.value = local;
    // каталог домена: люди, которых ещё нет в Arklock, и группы, которые ещё не заведены
    if (!directoryDenied && props.scope !== 'vault') {
      const dir = await findInDirectory(q, circles.value);
      if (q === query.value.trim()) results.value = [...local, ...dir];
    }
  } catch (e) {
    searchError.value = errorMessage(e, t);
  } finally {
    searching.value = false;
  }
}

interface DirPerson {
  profileId: string;
  dn: string;
  name: string;
  email: string;
  existing: object | null;
}
interface DirGroup {
  profileId: string;
  dn: string;
  name: string;
  linked: { circleId: string }[];
}
async function findInDirectory(q: string, known: { id: string }[]): Promise<Result[]> {
  const enc = encodeURIComponent(q);
  // люди — любому сотруднику (политика «делиться с людьми вне подразделения»); группы домена — только администратору
  const [people, groups] = await Promise.all([
    api<{ items: DirPerson[] }>('GET', `/directory/people?limit=8&q=${enc}`).catch((e) => {
      if (e instanceof ApiError && (e.status === 403 || e.status === 401)) directoryDenied = true;
      return null;
    }),
    api<{ items: DirGroup[] }>('GET', `/admin/directory/groups?limit=6&q=${enc}`).catch(() => null),
  ]);
  return [
    ...(people?.items ?? [])
      .filter((p) => !p.existing && p.email)
      .map((p) => ({
        kind: 'user' as const,
        id: `dir:${p.dn}`,
        name: p.name,
        email: p.email,
        dir: { kind: 'person' as const, profileId: p.profileId, dn: p.dn },
      })),
    // группа домена, уже связанная с группой Arklock, найдена среди групп выше
    ...(groups?.items ?? [])
      .filter((g) => !g.linked.some((l) => known.some((c) => c.id === l.circleId)))
      .map((g) => ({
        kind: 'circle' as const,
        id: `dir:${g.dn}`,
        name: g.name,
        dir: { kind: 'group' as const, profileId: g.profileId, dn: g.dn },
      })),
  ];
}

const key = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;
const isPicked = (r: { kind: string; id: string }) => picked.value.some((p) => key(p) === key(r));
const has = (r: { id: string }) => props.existing?.includes(r.id) ?? false;

const dirErrors: Record<string, string> = {
  directory_not_allowed: 'grantDlg.errNotAllowed',
  directory_no_email: 'grantDlg.errNoEmail',
  account_exists_local: 'grantDlg.errLocal',
  account_disabled_in_arklock: 'grantDlg.errBlocked',
  ldap_unavailable: 'grantDlg.errUnavailable',
  provision_admin_only: 'grantDlg.errProvision',
  outside_sharing_off: 'grantDlg.errOutsideOff',
};
async function pick(r: Result): Promise<void> {
  if (resolving.value) return;
  let chosen: Omit<Recipient, 'level'> = r;
  if (r.dir) {
    resolving.value = true;
    searchError.value = '';
    try {
      if (r.dir.kind === 'person') {
        const p = await api<{ id: string; name: string; email: string }>(
          'POST',
          '/directory/people/provision',
          { profileId: r.dir.profileId, dn: r.dir.dn },
        );
        chosen = {
          kind: 'user',
          id: p.id,
          name: p.name,
          email: p.email,
          publicKey: '',
          signPublicKey: '',
          pending: true,
        };
      } else {
        const g = await api<{ circle: { id: string; name: string } }>(
          'POST',
          '/admin/directory/groups/use',
          { profileId: r.dir.profileId, dn: r.dir.dn },
        );
        chosen = { kind: 'circle', id: g.circle.id, name: g.circle.name };
        circles.value = null;
      }
    } catch (e) {
      searchError.value =
        e instanceof ApiError && dirErrors[e.code] ? t(dirErrors[e.code]!) : errorMessage(e, t);
      return;
    } finally {
      resolving.value = false;
    }
  }
  if (!isPicked(chosen)) picked.value.push({ ...chosen, level: level.value });
  query.value = '';
  results.value = [];
  input.value?.focus();
}
function onKey(e: KeyboardEvent): void {
  if (!results.value.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = results.value.length;
    active.value = (active.value + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
  } else if (e.key === 'Enter' && active.value >= 0) {
    e.preventDefault();
    pick(results.value[active.value]!);
  }
}
// общий уровень меняет уровень у всех ещё не изменённых вручную получателей
watch(level, (next, prev) => {
  for (const p of picked.value) if (p.level === prev) p.level = next;
});

const expiresAt = computed(() => {
  if (term.value === 'none') return null;
  if (term.value === 'date')
    return date.value ? new Date(`${date.value}T23:59:59`).toISOString() : null;
  return new Date(Date.now() + Number(term.value) * 86_400_000).toISOString();
});
const ready = computed(
  () => picked.value.length > 0 && !(term.value === 'date' && !date.value) && !props.busy,
);
const levelHint = computed(() => props.levels.find((l) => l.value === level.value)?.hint ?? '');
</script>

<template>
  <dialog
    ref="dialog"
    class="modal-fade m-auto w-[min(36rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-visible"
    :aria-label="title"
    data-testid="grant-dialog"
    @close="emit('close')"
    @cancel.prevent="emit('close')"
  >
    <form
      class="flex max-h-[calc(100dvh-2rem)] flex-col"
      @submit.prevent="emit('submit', picked, expiresAt)"
    >
      <header class="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
        <h2>{{ title }}</h2>
      </header>
      <div class="space-y-4 overflow-y-auto px-5 py-4 text-sm">
        <div class="relative">
          <div class="flex items-center gap-1">
            <label class="field-label !mb-0" for="grant-search">{{
              t('grantDlg.recipients')
            }}</label>
            <InfoHint
              :text="scope === 'vault' ? t('grantDlg.hintVault') : t('grantDlg.hintObject')"
            />
          </div>
          <div
            class="input flex min-h-10 flex-wrap items-center gap-1.5 !py-1.5 focus-within:border-brand-500 focus-within:shadow-[var(--ring)]"
          >
            <span
              v-for="p in picked"
              :key="key(p)"
              class="badge-brand gap-1 !py-1 text-xs"
              data-testid="grant-chip"
            >
              <Icon :name="p.kind === 'user' ? 'user' : 'users'" class="size-3.5" />{{ p.name }}
              <button
                type="button"
                class="ml-0.5 rounded px-0.5 leading-none hover:bg-brand-100"
                :aria-label="`${t('grantDlg.removeRecipient')}: ${p.name}`"
                @click="picked = picked.filter((x) => key(x) !== key(p))"
              >
                ×
              </button>
            </span>
            <input
              id="grant-search"
              ref="input"
              v-model="query"
              class="chip-input min-w-40 flex-1 bg-transparent py-0.5"
              autocomplete="off"
              role="combobox"
              aria-autocomplete="list"
              :aria-expanded="results.length > 0"
              aria-controls="grant-results"
              :aria-activedescendant="active >= 0 ? `grant-opt-${active}` : undefined"
              :placeholder="picked.length ? '' : t('grantDlg.searchPlaceholder')"
              data-testid="grant-search"
              @keydown="onKey"
            />
          </div>
          <ul
            v-if="results.length || (query.trim().length >= 2 && !searching)"
            id="grant-results"
            role="listbox"
            class="menu-pop absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl dark:border-slate-700 dark:bg-slate-900"
          >
            <li
              v-for="(r, i) in results"
              :id="`grant-opt-${i}`"
              :key="key(r)"
              role="option"
              :aria-selected="i === active"
              class="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2"
              :class="
                i === active
                  ? 'bg-slate-100 dark:bg-slate-800'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
              "
              :data-testid="`grant-option-${r.email ?? r.name}`"
              @mousedown.prevent="pick(r)"
            >
              <Icon
                :name="r.kind === 'user' ? 'user' : 'users'"
                class="size-4 shrink-0 text-slate-500"
              />
              <span class="min-w-0 flex-1">
                <span class="block truncate font-medium">{{ r.name }}</span>
                <span class="block truncate text-xs text-slate-500">{{
                  r.kind === 'user' ? r.email : t('grantDlg.group')
                }}</span>
              </span>
              <span
                v-if="r.dir"
                class="shrink-0 text-xs text-slate-500"
                :data-testid="`grant-directory-${r.email ?? r.name}`"
                >{{ t('grantDlg.fromDirectory') }} +</span
              >
              <span v-else-if="isPicked(r)" class="text-xs text-brand-600">{{
                t('grantDlg.picked')
              }}</span>
              <span v-else-if="has(r)" class="text-xs text-slate-500">{{
                t('grantDlg.hasAccess')
              }}</span>
            </li>
            <li v-if="!results.length" class="px-3 py-2 text-slate-500">
              {{ t('grantDlg.nothing') }}
            </li>
          </ul>
          <p v-if="searchError" class="mt-1 text-xs text-red-600" role="alert">{{ searchError }}</p>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="field-label">{{ t('grantDlg.level') }}</span>
            <select v-model="level" class="input" data-testid="grant-level">
              <option v-for="l in levels" :key="l.value" :value="l.value" :disabled="l.disabled">
                {{ l.label }}
              </option>
            </select>
          </label>
          <label class="block">
            <span class="field-label">{{ t('grantDlg.term') }}</span>
            <select v-model="term" class="input" data-testid="grant-term">
              <option value="none">{{ t('grantDlg.terms.none') }}</option>
              <option value="1">{{ t('grantDlg.terms.day') }}</option>
              <option value="7">{{ t('grantDlg.terms.week') }}</option>
              <option value="30">{{ t('grantDlg.terms.month') }}</option>
              <option value="date">{{ t('grantDlg.terms.date') }}</option>
            </select>
          </label>
        </div>
        <p v-if="levelHint" class="-mt-2 text-xs text-slate-500">{{ levelHint }}</p>
        <label v-if="term === 'date'" class="block">
          <span class="field-label">{{ t('grantDlg.until') }}</span>
          <input v-model="date" type="date" class="input" required data-testid="grant-date" />
        </label>

        <!-- разные уровни: у каждого получателя свой -->
        <ul
          v-if="picked.length > 1"
          class="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800"
        >
          <li v-for="p in picked" :key="key(p)" class="flex items-center gap-2 px-3 py-1.5">
            <Icon
              :name="p.kind === 'user' ? 'user' : 'users'"
              class="size-4 shrink-0 text-slate-500"
            />
            <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
            <select
              v-model="p.level"
              class="input w-auto"
              :aria-label="`${t('grantDlg.level')}: ${p.name}`"
            >
              <option v-for="l in levels" :key="l.value" :value="l.value" :disabled="l.disabled">
                {{ l.label }}
              </option>
            </select>
          </li>
        </ul>
        <p v-if="error" class="notice notice-error" role="alert" data-testid="grant-error">
          {{ error }}
        </p>
      </div>
      <footer
        class="flex justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800"
      >
        <button type="button" class="btn" @click="emit('close')">{{ t('common.cancel') }}</button>
        <button
          type="submit"
          class="btn-primary"
          :disabled="!ready"
          :aria-busy="busy || undefined"
          data-testid="grant-submit"
        >
          {{ t('grantDlg.submit') }}
        </button>
      </footer>
    </form>
  </dialog>
</template>
