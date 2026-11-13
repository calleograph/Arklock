<script setup lang="ts">
import InfoHint from './InfoHint.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import { useWorkspaceStore } from '../stores/workspace';
import DepartmentDetail from './DepartmentDetail.vue';
import PersonPicker, { type Person } from './PersonPicker.vue';

/**
 * Мастер «Подразделения»: по списку создаёт для каждого отдела группу, закрытое пространство, сейф отдела и (по желанию)
 * отдельный сейф руководства — из существующих сущностей, без своей модели. Уже существующее используется повторно,
 * поэтому повтор после сбоя безопасен.
 */
const { t, locale } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      title: 'Подразделения',
      hint: 'Одно действие вместо четырёх разделов: группа, пространство, сейф и права создаются вместе. Существующее используется повторно.',
      dtPeople: 'Люди',
      dtVault: 'Сейф',
      dtRoles: 'Роли',
      dtOthers: 'Другим отделам',
      whatTitle: 'Как это устроено',
      whatGroup:
        'Люди отдела — это группа. Состав ведёт руководитель вручную или каталог домена: люди из связанной группы домена попадают в неё сами.',
      whatDept:
        'У отдела один сейф с паролями (по желанию ещё отдельный сейф руководства). Внутри сейфа — папки и записи. Все участники отдела видят сейф с выданной им ролью.',
      whatRole:
        'Читатель видит записи, редактор меняет их, администратор управляет доступом. Руководитель отдела — администратор его сейфов.',
      whatRoleTerm: 'Роль',
      whatPeople:
        'Человеку из другого отдела выдают доступ к одной папке или записи: в сейфе нажмите «Предоставить доступ». Он увидит только выданное, остальной сейф ему закрыт.',
      listTitle: 'Созданные подразделения',
      manage: 'Управлять',
      showArchived: 'Показывать архивные',
      archivedBadge: 'в архиве',
      listNone: 'Подразделений пока нет. Создайте первое ниже.',
      listHead: 'Руководитель',
      listMembers: 'Участников: {n}',
      listWaiting: 'ждут первого входа: {n}',
      listVaults: 'Сейфов: {n}',
      listNoHead: 'руководитель не назначен',
      step1: '1. Название',
      step2: '2. Руководитель',
      step2hint: 'Получит роль администратора в пространстве и сейфах отдела.',
      step3: '3. Участники',
      step3hint: 'Войдут в группу подразделения и получат доступ к сейфу отдела.',
      step4: '4. Что создать',
      step5: '5. Проверка и создание',
      fromDirectory: 'найден в каталоге, профиль будет создан при создании подразделения',
      one: 'Одно подразделение',
      many: 'Список',
      name: 'Название',
      description: 'Описание',
      head: 'Руководитель',
      headFind: 'Имя, логин или почта',
      members: 'Участники',
      membersFind: 'Имя, логин или почта',
      checking: 'проверяю…',
      list: 'По строке на подразделение: «Название; почта руководителя»',
      leadVault:
        'Создать ещё отдельный сейф для руководства (его не видят остальные сотрудники отдела)',
      folders: 'Начальные папки в сейфе отдела, через запятую',
      preview: 'Что будет сделано',
      create: 'Создать',
      creating: 'Создаю…',
      colName: 'Подразделение',
      colGroup: 'Группа',
      colSpace: 'Пространство',
      colVault: 'Сейф',
      colHead: 'Руководитель',
      colState: 'Результат',
      isNew: 'создать',
      reuse: 'есть',
      none: '—',
      problemEmpty: 'нет названия',
      problemLong: 'название длиннее 100 знаков',
      problemDup: 'повтор в списке',
      problemHead: 'руководитель не найден',
      done: 'Готово',
      pendingKeys:
        'Ключи сейфа участники получат при ближайшем входе администратора или собственном входе.',
      none2: 'Введите название подразделения.',
      leadSuffix: 'Руководство',
      vaultSuffix: 'Пароли',
    },
    en: {
      title: 'Departments',
      hint: 'One action instead of four sections: group, space, vault and permissions are created together. Existing items are reused.',
      dtPeople: 'People',
      dtVault: 'Vault',
      dtRoles: 'Roles',
      dtOthers: 'Other departments',
      whatTitle: 'How it works',
      whatGroup:
        'The people of the department are a group. The head keeps the membership by hand or the domain directory does: people from a linked domain group join by themselves.',
      whatDept:
        'A department has one vault with passwords (optionally a separate leadership vault). Inside are folders and entries. Every member sees the vault with the role given to them.',
      whatRole:
        'A reader sees entries, an editor changes them, an administrator manages access. The head of the department is the administrator of its vaults.',
      whatRoleTerm: 'Role',
      whatPeople:
        'A person from another department is given access to one folder or entry: press “Grant access” in the vault. They see only what was given; the rest of the vault stays closed.',
      listTitle: 'Created departments',
      manage: 'Manage',
      showArchived: 'Show archived',
      archivedBadge: 'archived',
      listNone: 'No departments yet. Create the first one below.',
      listHead: 'Head',
      listMembers: 'Members: {n}',
      listWaiting: 'waiting for first sign-in: {n}',
      listVaults: 'Vaults: {n}',
      listNoHead: 'no head assigned',
      step1: '1. Name',
      step2: '2. Head',
      step2hint: 'Becomes an administrator of the space and the department vaults.',
      step3: '3. Members',
      step3hint: 'Join the department group and get access to the department vault.',
      step4: '4. What to create',
      step5: '5. Review and create',
      fromDirectory: 'found in the directory, the profile is created together with the department',
      one: 'One department',
      many: 'List',
      name: 'Name',
      description: 'Description',
      head: 'Head',
      headFind: 'Name, login or e-mail',
      members: 'Members',
      membersFind: 'Name, login or e-mail',
      checking: 'checking…',
      list: 'One department per line: “Name; head email”',
      leadVault:
        'Also create a separate vault for leadership (other department staff cannot see it)',
      folders: 'Initial folders in the department vault, comma-separated',
      preview: 'What will be done',
      create: 'Create',
      creating: 'Creating…',
      colName: 'Department',
      colGroup: 'Group',
      colSpace: 'Space',
      colVault: 'Vault',
      colHead: 'Head',
      colState: 'Result',
      isNew: 'create',
      reuse: 'exists',
      none: '—',
      problemEmpty: 'no name',
      problemLong: 'name longer than 100 characters',
      problemDup: 'duplicate in the list',
      problemHead: 'head not found',
      done: 'Done',
      pendingKeys: 'Members receive the vault key on the next administrator sign-in or their own.',
      none2: 'Enter a department name.',
      leadSuffix: 'Leadership',
      vaultSuffix: 'Passwords',
    },
  },
});
void locale;
const ws = useWorkspaceStore();

/** Руководитель, найденный в каталоге по почте из списка: профиль создаётся вместе с подразделением. */
type Candidate = Person & { dir?: { profileId: string; dn: string } };
interface Dept {
  spaceId: string;
  circleId: string;
  name: string;
  description: string;
  heads: { id: string; name: string; pending: boolean }[];
  archived: boolean;
  members: number;
  waiting: number;
  vaults: number;
}
const depts = ref<Dept[] | null>(null);
/** Открытая для правки карточка подразделения (идентификатор пространства). */
const managing = ref('');
const showArchived = ref(false);
async function loadDepts(): Promise<void> {
  try {
    depts.value = (
      await api<{ items: Dept[] }>(
        'GET',
        `/admin/departments?limit=200${showArchived.value ? '&archived=1' : ''}`,
      )
    ).items;
  } catch {
    depts.value = null;
  }
}
const circleIds = ref<Record<string, string | null>>({});
const headCache = ref<Record<string, Candidate | null>>({});
const mode = ref<'one' | 'many'>('one');
const name = ref('');
const description = ref('');
const head = ref<Person[]>([]);
const listText = ref('');
const members = ref<Person[]>([]);
// сейф руководства — по желанию: по умолчанию у отдела один сейф с папками
const leadVault = ref(false);
const folders = ref('');
const busy = ref(false);
const error = ref('');
const results = ref<Record<string, string>>({});

onMounted(async () => {
  void loadDepts();
  try {
    if (!ws.vaults.length) await ws.loadVaults();
  } catch (e) {
    error.value = errorMessage(e, t);
  }
});

/** Группа по точному названию: ищется на сервере, список групп целиком не грузится. */
async function findCircle(n: string): Promise<string | null> {
  const r = await api<{ items: { id: string; name: string }[] }>(
    'GET',
    `/admin/circles?limit=20&q=${encodeURIComponent(n)}`,
  );
  return r.items.find((c) => c.name === n)?.id ?? null;
}
async function findPerson(email: string): Promise<Candidate | null> {
  const r = await api<{ items: Person[] }>(
    'GET',
    `/admin/people?status=active&limit=5&q=${encodeURIComponent(email)}`,
  );
  const local = r.items.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (local) return local;
  // нет в Arklock — ищем в каталоге домена по точному совпадению почты
  try {
    const d = await api<{
      items: {
        profileId: string;
        dn: string;
        name: string;
        email: string;
        existing: object | null;
      }[];
    }>('GET', `/admin/people/directory?limit=5&q=${encodeURIComponent(email)}`);
    const m = d.items.find((x) => x.email.toLowerCase() === email.toLowerCase() && !x.existing);
    if (m)
      return {
        id: '',
        name: m.name,
        email: m.email,
        title: null,
        department: null,
        authSource: 'ldap',
        pending: true,
        dir: { profileId: m.profileId, dn: m.dn },
      };
  } catch {
    /* каталог не подключён или недоступен: остаётся поиск по Arklock */
  }
  return null;
}
let timer: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(timer));

interface Item {
  name: string;
  head: Candidate | null;
  headEmail: string;
  members: string[];
}
const items = computed<Item[]>(() => {
  if (mode.value === 'one')
    return name.value.trim()
      ? [
          {
            name: name.value.trim(),
            head: head.value[0] ?? null,
            headEmail: '',
            members: members.value.map((m) => m.id),
          },
        ]
      : [];
  return listText.value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [n = '', h = ''] = l.split(/[;\t]/).map((x) => x.trim());
      return { name: n, head: headCache.value[h.toLowerCase()] ?? null, headEmail: h, members: [] };
    });
});
// поиск на сервере для новых названий и адресов из списка; пока ответа нет, создание заблокировано
watch(
  () => [items.value.map((i) => i.name), items.value.map((i) => i.headEmail)] as const,
  ([names, emails]) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        for (const n of new Set(names.slice(0, 300)))
          if (n && !(n in circleIds.value)) circleIds.value[n] = await findCircle(n);
        for (const e of new Set(emails.slice(0, 300).map((x) => x.toLowerCase())))
          if (e && !(e in headCache.value)) headCache.value[e] = await findPerson(e);
      } catch (e) {
        error.value = errorMessage(e, t);
      }
    }, 300);
  },
  { immediate: true },
);

const spaceOf = (n: string) => ws.spaces.find((s) => s.name === n);
const mainName = (n: string) => `${n} · ${t('vaultSuffix')}`;
/** Сейф отдела: под новым названием («Отдел · Пароли»); созданный прежней версией назван как сам отдел. */
const vaultOf = (n: string) =>
  ws.vaults.find((v) => v.spaceId === spaceOf(n)?.id && (v.name === mainName(n) || v.name === n));
const leadName = (n: string) => `${n} · ${t('leadSuffix')}`;
const plan = computed(() =>
  items.value.map((it, i) => {
    const problems: string[] = [];
    if (!it.name) problems.push(t('problemEmpty'));
    if (it.name.length > 100) problems.push(t('problemLong'));
    if (items.value.findIndex((x) => x.name === it.name) !== i) problems.push(t('problemDup'));
    if (it.headEmail && headCache.value[it.headEmail.toLowerCase()] === undefined)
      problems.push(t('checking'));
    else if (it.headEmail && !it.head) problems.push(`${t('problemHead')}: ${it.headEmail}`);
    if (it.name && circleIds.value[it.name] === undefined) problems.push(t('checking'));
    return {
      ...it,
      problems,
      circle: !!circleIds.value[it.name],
      space: !!spaceOf(it.name),
      vault: !!vaultOf(it.name),
    };
  }),
);
const ready = computed(() => plan.value.length > 0 && plan.value.every((p) => !p.problems.length));
const mark = (exists: boolean) => (exists ? t('reuse') : t('isNew'));

async function build(source: Item): Promise<void> {
  let it = source;
  // руководитель найден в каталоге: профиль создаётся сейчас, до назначения ролей
  if (it.head?.dir) {
    const made = await api<Person>('POST', '/admin/people/directory/provision', it.head.dir);
    it = {
      ...it,
      head: { ...made, title: made.title ?? null, department: made.department ?? null },
    };
  }
  let circleId = circleIds.value[it.name] ?? undefined;
  if (!circleId) {
    circleId = (
      await api<{ id: string }>('POST', '/admin/circles', {
        name: it.name,
        ...(mode.value === 'one' && description.value.trim()
          ? { description: description.value.trim() }
          : {}),
      })
    ).id;
    circleIds.value[it.name] = circleId;
  }
  const add = [...new Set([...(it.head ? [it.head.id] : []), ...it.members])];
  if (add.length) await api('PATCH', `/admin/circles/${circleId}/members`, { add });
  let space = spaceOf(it.name);
  if (!space) {
    await api('POST', '/spaces', {
      name: it.name,
      publicToOrg: false,
      ...(mode.value === 'one' && description.value.trim()
        ? { description: description.value.trim() }
        : {}),
    });
    await ws.loadVaults();
    space = spaceOf(it.name);
  }
  if (!space) throw new Error('space');
  await api('PUT', `/spaces/${space.id}/circles/${circleId}`, { role: 'member' });
  if (it.head) await api('PUT', `/spaces/${space.id}/users/${it.head.id}`, { role: 'admin' });
  let vaultId = vaultOf(it.name)?.id;
  if (!vaultId)
    vaultId = await ws.createVault(mainName(it.name), { spaceId: space.id, select: false });
  await api('PUT', `/vaults/${vaultId}/circles/${circleId}`, { role: 'editor' });
  const headUser = it.head
    ? (
        await api<{ id: string; email: string; publicKey: string; signPublicKey: string }[]>(
          'GET',
          `/directory/users?q=${encodeURIComponent(it.head.email)}`,
        )
      ).find((u) => u.id === it.head!.id)
    : undefined;
  const addHead = async (vid: string) => {
    if (!headUser) return;
    // участие через группу не считается: руководителю нужна своя роль администратора сейфа
    const mine = (await ws.members(vid)).members.find((m) => m.userId === headUser.id);
    if (mine?.directRole !== 'admin') await ws.addMember(vid, headUser, 'admin');
  };
  await addHead(vaultId);
  if (leadVault.value && it.head) {
    let lead = ws.vaults.find((v) => v.name === leadName(it.name) && v.spaceId === space!.id)?.id;
    if (!lead) lead = await ws.createVault(leadName(it.name), { spaceId: space.id, select: false });
    await addHead(lead);
  }
  const names = folders.value
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  if (names.length) {
    await ws.select(vaultId);
    const have = new Set(ws.branches.map((b) => b.name));
    for (const f of names) if (!have.has(f)) await ws.createBranch(f, null);
  }
  await ws.distributePending(vaultId).catch(() => 0);
}

async function create(): Promise<void> {
  if (!ready.value || busy.value) return;
  busy.value = true;
  error.value = '';
  results.value = {};
  for (const p of plan.value) {
    results.value[p.name] = t('creating');
    try {
      await build(p);
      results.value[p.name] = t('done');
    } catch (e) {
      results.value[p.name] = errorMessage(e, t);
    }
  }
  await ws.loadVaults().catch(() => undefined);
  await loadDepts();
  busy.value = false;
  // созданное подразделение сразу открывается: туда можно добавить людей и назначить руководителей
  const only = plan.value.length === 1 ? spaceOf(plan.value[0]!.name) : undefined;
  if (only && results.value[plan.value[0]!.name] === t('done')) {
    managing.value = only.id;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}
</script>

<template>
  <section class="space-y-6 text-sm" data-testid="departments">
    <details class="card" :open="depts !== null && !depts.length" data-testid="dept-explain">
      <summary class="min-h-11 cursor-pointer font-medium">{{ t('whatTitle') }}</summary>
      <dl class="mt-2 grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[8rem_1fr]">
        <dt class="font-medium">{{ t('dtPeople') }}</dt>
        <dd class="max-w-prose text-slate-600 dark:text-slate-300">{{ t('whatGroup') }}</dd>
        <dt class="font-medium">{{ t('dtVault') }}</dt>
        <dd class="max-w-prose text-slate-600 dark:text-slate-300">{{ t('whatDept') }}</dd>
        <dt class="font-medium">{{ t('dtRoles') }}</dt>
        <dd class="max-w-prose text-slate-600 dark:text-slate-300">{{ t('whatRole') }}</dd>
        <dt class="font-medium">{{ t('dtOthers') }}</dt>
        <dd class="max-w-prose text-slate-600 dark:text-slate-300">{{ t('whatPeople') }}</dd>
      </dl>
    </details>

    <section class="space-y-2" data-testid="dept-list-created">
      <h3 class="font-medium">{{ t('listTitle') }}</h3>
      <label class="flex min-h-11 items-center gap-2 text-xs text-slate-500"
        ><input
          v-model="showArchived"
          type="checkbox"
          data-testid="dept-show-archived"
          @change="loadDepts"
        />{{ t('showArchived') }}</label
      >
      <p v-if="depts && !depts.length" class="text-xs text-slate-500" data-testid="dept-list-empty">
        {{ t('listNone') }}
      </p>
      <DepartmentDetail
        v-if="managing"
        :key="managing"
        :space-id="managing"
        @close="managing = ''"
        @changed="loadDepts"
      />
      <ul v-else-if="depts" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <li
          v-for="d in depts"
          :key="d.spaceId"
          class="card flex flex-col gap-2 p-4"
          data-testid="dept-card"
        >
          <h4 class="truncate font-medium" :title="d.name">
            {{ d.name }}<span v-if="d.archived" class="badge ml-2">{{ t('archivedBadge') }}</span>
          </h4>
          <p class="flex-1 text-xs text-slate-600 dark:text-slate-300">
            <span class="font-medium">{{ t('listHead') }}:</span>
            {{ d.heads.map((h) => h.name).join(', ') || t('listNoHead') }}
          </p>
          <p class="text-xs text-slate-500">
            {{ t('listMembers', { n: d.members })
            }}<span v-if="d.waiting"> · {{ t('listWaiting', { n: d.waiting }) }}</span> ·
            {{ t('listVaults', { n: d.vaults }) }}
          </p>
          <button
            type="button"
            class="btn self-start"
            :data-testid="`dept-manage-${d.name}`"
            @click="managing = d.spaceId"
          >
            {{ t('manage') }}
          </button>
        </li>
      </ul>
    </section>

    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>

    <div class="card space-y-6 p-4">
      <div class="flex w-fit gap-1 rounded-lg bg-slate-100 p-0.5 text-xs dark:bg-slate-800">
        <button
          v-for="m in ['one', 'many'] as const"
          :key="m"
          type="button"
          class="seg"
          :class="mode === m ? 'seg-on' : ''"
          :data-testid="`dept-mode-${m}`"
          @click="mode = m"
        >
          {{ t(m) }}
        </button>
      </div>

      <template v-if="mode === 'one'">
        <fieldset class="space-y-2">
          <legend class="font-medium">{{ t('step1') }}</legend>
          <div class="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            <label class="block"
              ><span class="field-label">{{ t('name') }}</span
              ><input v-model="name" maxlength="100" class="input" data-testid="dept-name"
            /></label>
            <label class="block"
              ><span class="field-label">{{ t('description') }}</span
              ><input
                v-model="description"
                maxlength="500"
                class="input"
                data-testid="dept-description"
            /></label>
          </div>
        </fieldset>
        <fieldset class="space-y-2">
          <legend class="font-medium">
            {{ t('step2') }}<InfoHint class="ml-1" :text="t('step2hint')" />
          </legend>
          <PersonPicker v-model="head" :placeholder="t('headFind')" testid="dept-head" />
        </fieldset>
        <fieldset class="space-y-2">
          <legend class="font-medium">
            {{ t('step3') }}<InfoHint class="ml-1" :text="t('step3hint')" />
          </legend>
          <PersonPicker
            v-model="members"
            multiple
            :placeholder="t('membersFind')"
            testid="dept-member"
          />
        </fieldset>
      </template>
      <fieldset v-else class="space-y-2">
        <legend class="font-medium">{{ t('step1') }}</legend>
        <label class="block"
          ><span class="field-label">{{ t('list') }}</span
          ><textarea
            v-model="listText"
            rows="6"
            class="input font-mono"
            spellcheck="false"
            data-testid="dept-list"
          ></textarea>
        </label>
      </fieldset>

      <fieldset class="space-y-2">
        <legend class="font-medium">{{ t('step4') }}</legend>
        <label class="flex min-h-11 items-start gap-2"
          ><input v-model="leadVault" type="checkbox" class="mt-0.5" data-testid="dept-lead" />
          {{ t('leadVault') }}</label
        >
        <label class="block"
          ><span class="field-label">{{ t('folders') }}</span
          ><input v-model="folders" class="input" data-testid="dept-folders"
        /></label>
      </fieldset>

      <fieldset class="space-y-2">
        <legend class="font-medium">{{ t('step5') }}</legend>
        <div v-if="plan.length" data-testid="dept-preview">
          <h3 class="mb-1 text-xs font-medium text-slate-500">{{ t('preview') }}</h3>
          <div class="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-700">
            <table class="min-w-full text-xs">
              <thead class="text-left text-slate-500">
                <tr>
                  <th class="px-2 py-1">{{ t('colName') }}</th>
                  <th>{{ t('colGroup') }}</th>
                  <th>{{ t('colSpace') }}</th>
                  <th>{{ t('colVault') }}</th>
                  <th>{{ t('colHead') }}</th>
                  <th>{{ t('colState') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="p in plan"
                  :key="p.name"
                  class="border-t border-slate-200 dark:border-slate-800"
                  data-testid="dept-row"
                >
                  <td class="px-2 py-1 font-medium">{{ p.name }}</td>
                  <td>{{ mark(p.circle) }}</td>
                  <td>{{ mark(p.space) }}</td>
                  <td>{{ mark(p.vault) }}</td>
                  <td>
                    {{ p.head?.name ?? t('none') }}
                    <span v-if="p.head?.dir" class="block text-slate-500">{{
                      t('fromDirectory')
                    }}</span>
                  </td>
                  <td data-testid="dept-state">
                    <span v-if="p.problems.length" class="text-red-600">{{
                      p.problems.join('; ')
                    }}</span>
                    <span v-else>{{ results[p.name] ?? '' }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <p v-else class="text-xs text-slate-500">{{ t('none2') }}</p>
        <div class="flex flex-wrap items-center gap-3">
          <button
            type="button"
            class="btn-primary"
            :disabled="!ready || busy"
            data-testid="dept-create"
            @click="create"
          >
            {{ busy ? t('creating') : t('create') }}
          </button>
          <InfoHint :text="t('pendingKeys')" />
        </div>
      </fieldset>
    </div>
  </section>
</template>
