<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, api } from '../services/api';
import { errorMessage } from '../services/helpers';

/**
 * Выбор сотрудников поиском на сервере: список целиком не загружается (в организации на десятки тысяч человек
 * его не нужно ни грузить, ни листать). Выбранные показываются отдельно от найденных.
 *
 * Если подключён каталог (Active Directory, LDAP), поиск идёт и в нём: найденный человек добавляется кнопкой «+», и для него
 * создаётся профиль Arklock без входа самого человека. Сейфы он получит, когда сам войдёт в первый раз.
 */
export interface Person {
  id: string;
  name: string;
  email: string;
  title: string | null;
  department: string | null;
  authSource: string;
  /** Профиль создан администратором, человек ещё не входил: доступа к сейфам пока нет. */
  pending?: boolean;
}
interface Found {
  profileId: string;
  profileName: string;
  dn: string;
  guid: string;
  name: string;
  email: string;
  login: string;
  title: string;
  department: string;
  existing: { id: string; state: 'active' | 'pending' | 'disabled' } | null;
}
const props = withDefaults(
  defineProps<{
    modelValue: Person[];
    multiple?: boolean;
    placeholder?: string;
    testid: string;
    /** Уже участвуют: показываются в результатах отмеченными и не выбираются повторно. */
    exclude?: string[];
    /** Искать и в каталоге домена (если он подключён). */
    directory?: boolean;
  }>(),
  { directory: true },
);
const emit = defineEmits<{ 'update:modelValue': [Person[]] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      found: 'Найдено: {n}',
      more: 'Показаны первые {n}. Уточните запрос.',
      none: 'Никого не найдено',
      noneDirectory: 'Никого не найдено ни в Arklock, ни в каталоге',
      picked: 'Выбрано',
      remove: 'Убрать: {name}',
      already: 'уже в группе',
      pending: 'ждёт первого входа',
      source: { local: 'локальная', ldap: 'каталог', oidc: 'SSO', saml: 'SAML' },
      inArklock: 'В Arklock',
      inDirectory: 'В каталоге',
      add: 'Добавить',
      addNamed: 'Добавить: {name}',
      adding: 'Добавляю…',
      added: 'добавлен',
      hint: 'Введите не меньше двух букв: имя, логин или почту.',
      directoryNote:
        'Человек из каталога получит профиль Arklock сразу. Доступ к сейфам появится после его первого входа.',
      noEmail: 'в каталоге нет почты',
      directoryProblem: 'Каталог «{name}» не ответил. Поиск по Arklock работает.',
      err: {
        directory_not_allowed:
          'Правило входа этого каталога не допускает этого человека. Измените правило или выберите другого.',
        directory_no_email: 'В записи каталога нет адреса почты: профиль создать нельзя.',
        directory_account_disabled: 'Учётная запись в каталоге отключена.',
        directory_person_not_found: 'Запись в каталоге не найдена: обновите поиск.',
        account_exists_local:
          'Человек с этой почтой уже есть в Arklock вне каталога. Найдите его в списке «В Arklock».',
        account_disabled_in_arklock: 'Этот сотрудник заблокирован в Arklock.',
        ldap_unavailable:
          'Каталог недоступен. Повторите позже или проверьте подключение в настройках.',
        ldap_disabled: 'Вход через этот каталог выключен.',
        ldap_changed: 'Настройки каталога изменились. Повторите.',
      },
    },
    en: {
      found: 'Found: {n}',
      more: 'Showing the first {n}. Narrow the search.',
      none: 'Nobody found',
      noneDirectory: 'Nobody found in Arklock or in the directory',
      picked: 'Selected',
      remove: 'Remove: {name}',
      already: 'already in the group',
      pending: 'waiting for first sign-in',
      source: { local: 'local', ldap: 'directory', oidc: 'SSO', saml: 'SAML' },
      inArklock: 'In Arklock',
      inDirectory: 'In the directory',
      add: 'Add',
      addNamed: 'Add: {name}',
      adding: 'Adding…',
      added: 'added',
      hint: 'Type at least two letters: name, login or e-mail.',
      directoryNote:
        'A person from the directory gets an Arklock profile right away. Vault access appears after their first sign-in.',
      noEmail: 'no e-mail in the directory',
      directoryProblem: 'The directory “{name}” did not answer. Arklock search still works.',
      err: {
        directory_not_allowed:
          'The sign-in rule of this directory does not allow this person. Change the rule or pick someone else.',
        directory_no_email:
          'The directory entry has no e-mail address: a profile cannot be created.',
        directory_account_disabled: 'The directory account is disabled.',
        directory_person_not_found: 'The directory entry was not found: refresh the search.',
        account_exists_local:
          'A person with this e-mail already exists in Arklock outside the directory. Find them in the “In Arklock” list.',
        account_disabled_in_arklock: 'This employee is blocked in Arklock.',
        ldap_unavailable:
          'The directory is unavailable. Try again later or check the connection in settings.',
        ldap_disabled: 'Sign-in through this directory is turned off.',
        ldap_changed: 'The directory settings changed. Try again.',
      },
    },
  },
});
const LIMIT = 12;
const q = ref('');
const items = ref<Person[]>([]);
const total = ref(0);
const domain = ref<Found[]>([]);
const configured = ref(false);
const problems = ref<string[]>([]);
const busy = ref(false);
const adding = ref('');
const error = ref('');
const open = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;

async function search(): Promise<void> {
  const mine = ++seq;
  busy.value = true;
  error.value = '';
  const term = q.value.trim();
  try {
    const [local, dir] = await Promise.all([
      api<{ items: Person[]; total: number }>(
        'GET',
        `/admin/people?status=active&limit=${LIMIT}&q=${encodeURIComponent(term)}`,
      ),
      props.directory && term.length >= 2
        ? api<{
            configured: boolean;
            items: Found[];
            problems: { profileName: string }[];
          }>('GET', `/admin/people/directory?limit=${LIMIT}&q=${encodeURIComponent(term)}`).catch(
            () => null,
          )
        : Promise.resolve(null),
    ]);
    // ответ на устаревший запрос не затирает свежий
    if (mine !== seq) return;
    items.value = local.items;
    total.value = local.total;
    configured.value = dir?.configured ?? configured.value;
    // те, кто уже есть в Arklock, показаны в первом списке; из каталога — только ещё не заведённые
    domain.value = (dir?.items ?? []).filter((d) => !d.existing);
    problems.value = (dir?.problems ?? []).map((p) => p.profileName);
  } catch (e) {
    if (mine === seq) error.value = errorMessage(e, t);
  } finally {
    if (mine === seq) busy.value = false;
  }
}
watch(q, () => {
  open.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => void search(), 250);
});
onBeforeUnmount(() => clearTimeout(timer));

const chosen = (p: Person) => props.modelValue.some((x) => x.id === p.id);
function pick(p: Person): void {
  if (props.exclude?.includes(p.id)) return;
  if (!props.multiple) {
    emit('update:modelValue', [p]);
    q.value = '';
    open.value = false;
    return;
  }
  emit(
    'update:modelValue',
    chosen(p) ? props.modelValue.filter((x) => x.id !== p.id) : [...props.modelValue, p],
  );
}
const drop = (p: Person) =>
  emit(
    'update:modelValue',
    props.modelValue.filter((x) => x.id !== p.id),
  );

/** Человек из каталога: создаём профиль и выбираем его, как любого найденного. */
async function addFromDirectory(d: Found): Promise<void> {
  if (adding.value || !d.email) return;
  adding.value = d.dn;
  error.value = '';
  try {
    const r = await api<Person>('POST', '/admin/people/directory/provision', {
      profileId: d.profileId,
      dn: d.dn,
    });
    const person: Person = { ...r, title: r.title ?? null, department: r.department ?? null };
    // в списке каталога он больше не нужен: теперь он среди сотрудников Arklock
    domain.value = domain.value.filter((x) => x.dn !== d.dn);
    items.value = [person, ...items.value.filter((x) => x.id !== person.id)];
    pick(person);
  } catch (e) {
    const known = e instanceof ApiError ? errs.value[e.code as keyof typeof errs.value] : undefined;
    error.value = known ?? errorMessage(e, t);
  } finally {
    adding.value = '';
  }
}
const errs = computed(() => ({
  directory_not_allowed: t('err.directory_not_allowed'),
  directory_no_email: t('err.directory_no_email'),
  directory_account_disabled: t('err.directory_account_disabled'),
  directory_person_not_found: t('err.directory_person_not_found'),
  account_exists_local: t('err.account_exists_local'),
  account_disabled_in_arklock: t('err.account_disabled_in_arklock'),
  ldap_unavailable: t('err.ldap_unavailable'),
  ldap_disabled: t('err.ldap_disabled'),
  ldap_changed: t('err.ldap_changed'),
}));

function onEnter(): void {
  const first = items.value.find((p) => !props.exclude?.includes(p.id));
  if (first) pick(first);
  else if (domain.value[0]) void addFromDirectory(domain.value[0]);
}
function onFocus(): void {
  open.value = true;
  if (!items.value.length && !busy.value) void search();
}
const meta = (p: { email: string; department: string | null; title: string | null }) =>
  [p.email, p.department, p.title].filter(Boolean).join(' · ');
</script>

<template>
  <div class="space-y-1" :data-testid="testid">
    <ul v-if="modelValue.length" class="flex flex-wrap gap-1" :aria-label="t('picked')">
      <li
        v-for="p in modelValue"
        :key="p.id"
        class="inline-flex items-center gap-1 rounded-md bg-slate-100 py-0.5 pl-2 pr-1 text-xs dark:bg-slate-800"
        :data-testid="`${testid}-chip-${p.email}`"
      >
        {{ p.name }}
        <span v-if="p.pending" class="text-slate-500">· {{ t('pending') }}</span>
        <button
          type="button"
          class="rounded px-1 text-slate-500 hover:text-red-600"
          :aria-label="t('remove', { name: p.name })"
          @click="drop(p)"
        >
          ×
        </button>
      </li>
    </ul>
    <input
      v-model="q"
      type="search"
      class="input"
      autocomplete="off"
      :placeholder="placeholder"
      :aria-label="placeholder"
      :data-testid="`${testid}-input`"
      @focus="onFocus"
      @keydown.enter.prevent="onEnter"
      @keydown.esc="open = false"
    />
    <div
      v-if="open"
      class="rounded-md border border-slate-200 text-sm dark:border-slate-700"
      :aria-busy="busy"
    >
      <p v-if="error" class="px-2 py-1 text-red-600" role="alert" :data-testid="`${testid}-error`">
        {{ error }}
      </p>
      <template v-if="items.length || domain.length">
        <p
          v-if="domain.length"
          class="px-2 pt-1 text-xs font-medium text-slate-500"
          :data-testid="`${testid}-local-title`"
        >
          {{ t('inArklock') }}
        </p>
        <ul v-if="items.length" class="max-h-48 overflow-y-auto">
          <li v-for="p in items" :key="p.id">
            <button
              type="button"
              class="flex min-h-11 w-full items-center gap-2 px-2 py-1 text-left hover:bg-slate-100 disabled:opacity-60 dark:hover:bg-slate-800"
              :disabled="exclude?.includes(p.id)"
              :data-testid="`${testid}-result-${p.email}`"
              @click="pick(p)"
            >
              <span v-if="multiple" aria-hidden="true">{{
                chosen(p) || exclude?.includes(p.id) ? '☑' : '☐'
              }}</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate font-medium">{{ p.name }}</span>
                <span class="block truncate text-xs text-slate-500">{{ meta(p) }}</span>
              </span>
              <span class="shrink-0 text-xs text-slate-500">
                {{
                  exclude?.includes(p.id)
                    ? t('already')
                    : p.pending
                      ? t('pending')
                      : t(`source.${p.authSource}`)
                }}
              </span>
            </button>
          </li>
        </ul>
        <template v-if="domain.length">
          <p
            class="border-t border-slate-200 px-2 pt-1 text-xs font-medium text-slate-500 dark:border-slate-700"
            :data-testid="`${testid}-directory-title`"
          >
            {{ t('inDirectory') }}
          </p>
          <ul class="max-h-48 overflow-y-auto">
            <li
              v-for="d in domain"
              :key="`${d.profileId}:${d.dn}`"
              class="flex min-h-11 items-center gap-2 px-2 py-1"
              :data-testid="`${testid}-directory-${d.email || d.login}`"
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate font-medium">{{ d.name }}</span>
                <span class="block truncate text-xs text-slate-500">{{
                  d.email ? meta(d) : t('noEmail')
                }}</span>
              </span>
              <button
                type="button"
                class="btn min-h-11 min-w-11 shrink-0 justify-center"
                :disabled="!!adding || !d.email"
                :aria-label="t('addNamed', { name: d.name })"
                :title="t('add')"
                :data-testid="`${testid}-add-${d.email || d.login}`"
                @click="addFromDirectory(d)"
              >
                {{ adding === d.dn ? t('adding') : '+' }}
              </button>
            </li>
          </ul>
          <p class="px-2 pb-1 text-xs text-slate-500">{{ t('directoryNote') }}</p>
        </template>
      </template>
      <p v-else-if="!busy && !error" class="px-2 py-1 text-slate-500">
        {{ configured ? t('noneDirectory') : t('none') }}
      </p>
      <p v-if="problems.length" class="px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
        {{ t('directoryProblem', { name: problems.join(', ') }) }}
      </p>
      <p
        v-if="items.length"
        class="border-t border-slate-200 px-2 py-0.5 text-xs text-slate-500 dark:border-slate-700"
      >
        {{ total > items.length ? t('more', { n: items.length }) : t('found', { n: total }) }}
      </p>
      <p v-else-if="configured && q.trim().length < 2" class="px-2 py-1 text-xs text-slate-500">
        {{ t('hint') }}
      </p>
    </div>
  </div>
</template>
