<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import { useWorkspaceStore } from '../stores/workspace';
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
      one: 'Одно подразделение',
      many: 'Список',
      name: 'Название',
      description: 'Описание',
      head: 'Руководитель',
      headFind: 'Найти руководителя: имя, почта, должность',
      members: 'Участники',
      membersFind: 'Найти участников: имя, почта, подразделение',
      checking: 'проверяю…',
      list: 'По строке на подразделение: «Название; почта руководителя»',
      leadVault: 'Отдельный сейф для руководства (его не видят остальные сотрудники отдела)',
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
    },
    en: {
      title: 'Departments',
      hint: 'One action instead of four sections: group, space, vault and permissions are created together. Existing items are reused.',
      one: 'One department',
      many: 'List',
      name: 'Name',
      description: 'Description',
      head: 'Head',
      headFind: 'Find the head: name, email, title',
      members: 'Members',
      membersFind: 'Find members: name, email, department',
      checking: 'checking…',
      list: 'One department per line: “Name; head email”',
      leadVault: 'Separate vault for leadership (other department staff cannot see it)',
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
    },
  },
});
void locale;
const ws = useWorkspaceStore();

const circleIds = ref<Record<string, string | null>>({});
const headCache = ref<Record<string, Person | null>>({});
const mode = ref<'one' | 'many'>('one');
const name = ref('');
const description = ref('');
const head = ref<Person[]>([]);
const listText = ref('');
const members = ref<Person[]>([]);
const leadVault = ref(true);
const folders = ref('');
const busy = ref(false);
const error = ref('');
const results = ref<Record<string, string>>({});

onMounted(async () => {
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
async function findPerson(email: string): Promise<Person | null> {
  const r = await api<{ items: Person[] }>(
    'GET',
    `/admin/people?status=active&limit=5&q=${encodeURIComponent(email)}`,
  );
  return r.items.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null;
}
let timer: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(timer));

interface Item {
  name: string;
  head: Person | null;
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
const vaultOf = (n: string) => ws.vaults.find((v) => v.name === n && v.spaceId === spaceOf(n)?.id);
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

async function build(it: Item): Promise<void> {
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
  if (!vaultId) vaultId = await ws.createVault(it.name, { spaceId: space.id, select: false });
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
  busy.value = false;
}
</script>

<template>
  <section class="card space-y-4 p-4 text-sm" data-testid="departments">
    <div>
      <h2 class="font-medium">{{ t('title') }}</h2>
      <p class="max-w-prose text-xs text-slate-500">{{ t('hint') }}</p>
    </div>
    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
    <div class="flex gap-1 rounded-lg bg-slate-100 p-0.5 text-xs dark:bg-slate-800 w-fit">
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

    <div v-if="mode === 'one'" class="grid gap-x-3 gap-y-2 sm:grid-cols-2">
      <label class="block"
        ><span class="field-label">{{ t('name') }}</span
        ><input v-model="name" maxlength="100" class="input" data-testid="dept-name"
      /></label>
      <label class="block"
        ><span class="field-label">{{ t('description') }}</span
        ><input v-model="description" maxlength="500" class="input" data-testid="dept-description"
      /></label>
      <div>
        <span class="field-label">{{ t('head') }}</span>
        <PersonPicker v-model="head" :placeholder="t('headFind')" testid="dept-head" />
      </div>
      <div>
        <span class="field-label">{{ t('members') }}</span>
        <PersonPicker
          v-model="members"
          multiple
          :placeholder="t('membersFind')"
          testid="dept-member"
        />
      </div>
    </div>
    <label v-else class="block"
      ><span class="field-label">{{ t('list') }}</span
      ><textarea
        v-model="listText"
        rows="6"
        class="input font-mono"
        spellcheck="false"
        data-testid="dept-list"
      ></textarea>
    </label>

    <label class="flex items-start gap-2"
      ><input v-model="leadVault" type="checkbox" class="mt-0.5" data-testid="dept-lead" />
      {{ t('leadVault') }}</label
    >
    <label class="block"
      ><span class="field-label">{{ t('folders') }}</span
      ><input v-model="folders" class="input" data-testid="dept-folders"
    /></label>

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
              <td>{{ p.head?.name ?? t('none') }}</td>
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
      <span class="text-xs text-slate-500">{{ t('pendingKeys') }}</span>
    </div>
  </section>
</template>
