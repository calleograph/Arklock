<script setup lang="ts">
import InfoHint from './InfoHint.vue';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, api } from '../services/api';
import { errorMessage } from '../services/helpers';

/**
 * Связь группы Arklock с группами каталога. Участники группы домена попадают в группу Arklock сами: при первом входе,
 * при сверке с каталогом и сразу, если у них уже есть профиль. Прежде чем связать или разорвать связь, показывается,
 * кого и какие права это затронет.
 */
const props = defineProps<{ circleId: string; circleName: string }>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      title: 'Группы домена',
      lead: 'Участников группы домена Arklock добавляет в эту группу сам. Вручную их добавлять не нужно.',
      none: 'С этой группой не связана ни одна группа домена.',
      noDirectory:
        'Каталог не подключён или вход через него выключен. Подключите Active Directory в разделе «Каталог», и здесь появится поиск групп домена.',
      find: 'Найти группу домена: название',
      hint: 'Введите не меньше двух букв названия.',
      found: 'Найдено в каталоге',
      noneFound: 'Групп с таким названием в каталоге нет',
      linkedTo: 'уже связана с «{name}»',
      link: 'Связать',
      unlink: 'Отвязать',
      linkedItem: '{group} · {profile}',
      problem: 'Каталог «{name}» не ответил. Попробуйте позже или проверьте подключение.',
      loading: 'Считаю, кого это затронет…',
      pvLinkTitle: 'Связать «{group}» с группой «{circle}»',
      pvUnlinkTitle: 'Отвязать «{group}» от группы «{circle}»',
      pvDomain: 'В группе домена: {n} чел.',
      pvDomainMore: 'В группе домена: больше {n} чел. (показаны первые)',
      pvHave: 'У {n} уже есть профиль Arklock',
      pvWaiting: ', из них {n} ещё не входили',
      pvJoin: 'В эту группу войдут сразу: {n}',
      pvAlready: 'уже в группе: {n}',
      pvLater:
        'Остальные ({n}) попадут в группу при первом входе или когда вы выберете их в поиске по домену.',
      pvGives: 'Каждый участник группы получает',
      pvNoVaults: 'Пока ни одного сейфа: группа даёт доступ, только когда ей назначены сейфы.',
      pvVault: '«{name}» — {role}',
      pvAdminRole:
        'Административная роль «{name}»: участники получат права управления. Проверьте состав группы домена.',
      confirmLink: 'Связать',
      confirmUnlink: 'Отвязать',
      cancel: 'Отмена',
      unlinkMembers: 'Пришли из каталога: {n} чел.',
      keep: 'Оставить их в группе (рекомендуется). Дальше вы ведёте состав сами.',
      drop: 'Убрать из группы тех, кто пришёл из каталога. Они потеряют доступ сейфов группы, пароли и ключи сейфов будут обновлены.',
      stillMapped:
        'Группа связана и с другими группами домена: их участников каталог по-прежнему ведёт.',
      doneLink: 'Связано. Добавлено в группу сразу: {n}.',
      doneUnlink: 'Связь снята. Убрано из группы: {n}.',
      roles: {
        admin: 'администратор',
        editor: 'редактор',
        reader: 'читатель',
        limited: 'ограниченный',
      },
      err: {
        ldap_unavailable: 'Каталог недоступен. Повторите позже.',
        dn_outside_base: 'Группа вне области поиска этого подключения.',
        too_many_links: 'Связей слишком много: не больше 200 на подключение.',
        ldap_changed: 'Настройки каталога изменились. Повторите.',
      },
    },
    en: {
      title: 'Domain groups',
      lead: 'Arklock adds the members of a domain group to this group itself. You do not need to add them by hand.',
      none: 'No domain group is linked to this group.',
      noDirectory:
        'No directory is connected or sign-in through it is off. Connect Active Directory in the “Directory” section and group search appears here.',
      find: 'Find a domain group: name',
      hint: 'Type at least two letters of the name.',
      found: 'Found in the directory',
      noneFound: 'No groups with this name in the directory',
      linkedTo: 'already linked to “{name}”',
      link: 'Link',
      unlink: 'Unlink',
      linkedItem: '{group} · {profile}',
      problem: 'The directory “{name}” did not answer. Try later or check the connection.',
      loading: 'Counting who this affects…',
      pvLinkTitle: 'Link “{group}” to the group “{circle}”',
      pvUnlinkTitle: 'Unlink “{group}” from the group “{circle}”',
      pvDomain: 'In the domain group: {n}',
      pvDomainMore: 'In the domain group: more than {n} (first ones shown)',
      pvHave: '{n} already have an Arklock profile',
      pvWaiting: ', {n} of them have not signed in yet',
      pvJoin: 'Join this group right away: {n}',
      pvAlready: 'already in the group: {n}',
      pvLater:
        'The others ({n}) join at their first sign-in or when you pick them in the domain search.',
      pvGives: 'Every member of the group gets',
      pvNoVaults: 'No vaults yet: the group gives access only once vaults are assigned to it.',
      pvVault: '“{name}” — {role}',
      pvAdminRole:
        'Administrative role “{name}”: members get management rights. Check the domain group membership.',
      confirmLink: 'Link',
      confirmUnlink: 'Unlink',
      cancel: 'Cancel',
      unlinkMembers: 'Came from the directory: {n}',
      keep: 'Keep them in the group (recommended). You manage the membership from now on.',
      drop: 'Remove those who came from the directory. They lose the group’s vault access; vault keys are renewed.',
      stillMapped:
        'The group is also linked to other domain groups: the directory still manages their members.',
      doneLink: 'Linked. Added to the group right away: {n}.',
      doneUnlink: 'Link removed. Removed from the group: {n}.',
      roles: { admin: 'admin', editor: 'editor', reader: 'reader', limited: 'limited' },
      err: {
        ldap_unavailable: 'The directory is unavailable. Try again later.',
        dn_outside_base: 'The group is outside the search scope of this connection.',
        too_many_links: 'Too many links: at most 200 per connection.',
        ldap_changed: 'The directory settings changed. Try again.',
      },
    },
  },
});

interface Link {
  profileId: string;
  profileName: string;
  dn: string;
  name: string;
}
interface Hit {
  profileId: string;
  profileName: string;
  dn: string;
  name: string;
  linked: { circleId: string; circleName: string }[];
}
interface Preview {
  action: 'link' | 'unlink';
  group: string;
  domainMembers?: number;
  truncated?: boolean;
  withProfile?: number;
  waiting?: number;
  withoutProfile?: number;
  willJoin?: number;
  alreadyMembers?: number;
  directoryMembers?: number;
  stillMapped?: boolean;
  vaults: { name: string; role: string }[];
  adminRole: string | null;
}

const links = ref<Link[]>([]);
const configured = ref(false);
const loaded = ref(false);
const q = ref('');
const hits = ref<Hit[]>([]);
const problems = ref<string[]>([]);
const searching = ref(false);
const error = ref('');
const notice = ref('');
/** Выбранное действие: связать/отвязать и рассчитанное влияние. */
const pending = ref<{ action: 'link' | 'unlink'; profileId: string; dn: string } | null>(null);
const preview = ref<Preview | null>(null);
const keepMembers = ref(true);
const busy = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;

const KNOWN = ['ldap_unavailable', 'dn_outside_base', 'too_many_links', 'ldap_changed'];
const fail = (e: unknown) =>
  e instanceof ApiError && KNOWN.includes(e.code) ? t(`err.${e.code}`) : errorMessage(e, t);

async function load(): Promise<void> {
  try {
    const r = await api<{ configured: boolean; links: Link[] }>(
      'GET',
      `/admin/circles/${props.circleId}/directory-links`,
    );
    links.value = r.links;
    configured.value = r.configured;
  } catch (e) {
    error.value = fail(e);
  } finally {
    loaded.value = true;
  }
}
onMounted(load);
onBeforeUnmount(() => clearTimeout(timer));
watch(() => props.circleId, load);

async function search(): Promise<void> {
  const mine = ++seq;
  const term = q.value.trim();
  if (term.length < 2) {
    hits.value = [];
    return;
  }
  searching.value = true;
  try {
    const r = await api<{ items: Hit[]; problems: { profileName: string }[] }>(
      'GET',
      `/admin/directory/groups?limit=10&q=${encodeURIComponent(term)}`,
    );
    if (mine !== seq) return;
    hits.value = r.items;
    problems.value = r.problems.map((p) => p.profileName);
  } catch (e) {
    if (mine === seq) error.value = fail(e);
  } finally {
    if (mine === seq) searching.value = false;
  }
}
watch(q, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void search(), 250);
});

async function ask(action: 'link' | 'unlink', profileId: string, dn: string): Promise<void> {
  error.value = '';
  notice.value = '';
  pending.value = { action, profileId, dn };
  preview.value = null;
  keepMembers.value = true;
  try {
    preview.value = await api<Preview>('POST', '/admin/directory/groups/preview', {
      profileId,
      dn,
      circleId: props.circleId,
      action,
    });
  } catch (e) {
    error.value = fail(e);
    pending.value = null;
  }
}

async function confirm(): Promise<void> {
  if (!pending.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const r = await api<{ added: number; removed: number }>(
      'PUT',
      `/admin/circles/${props.circleId}/directory-links`,
      {
        profileId: pending.value.profileId,
        dn: pending.value.dn,
        action: pending.value.action,
        keepMembers: keepMembers.value,
      },
    );
    notice.value =
      pending.value.action === 'link'
        ? t('doneLink', { n: r.added })
        : t('doneUnlink', { n: r.removed });
    pending.value = null;
    preview.value = null;
    q.value = '';
    hits.value = [];
    await load();
    emit('changed');
  } catch (e) {
    error.value = fail(e);
  } finally {
    busy.value = false;
  }
}
const cancel = () => {
  pending.value = null;
  preview.value = null;
};
const linkedHere = (h: Hit) =>
  links.value.some((l) => l.profileId === h.profileId && l.dn === h.dn);
const otherLink = (h: Hit) => h.linked.find((l) => l.circleId !== props.circleId);
</script>

<template>
  <section
    class="space-y-2 rounded-md bg-slate-50 p-3 text-xs dark:bg-slate-800/50"
    data-testid="domain-links"
  >
    <div>
      <h3 class="text-sm font-medium">
        {{ t('title') }}<InfoHint class="ml-1" :text="t('lead')" />
      </h3>
    </div>
    <p v-if="error" class="text-red-600" role="alert" data-testid="domain-links-error">
      {{ error }}
    </p>
    <p
      v-if="notice"
      class="text-emerald-700 dark:text-emerald-300"
      role="status"
      data-testid="domain-links-notice"
    >
      {{ notice }}
    </p>

    <ul v-if="links.length" class="space-y-1" data-testid="domain-links-list">
      <li
        v-for="l in links"
        :key="`${l.profileId}:${l.dn}`"
        class="flex min-h-11 items-center justify-between gap-2"
      >
        <span class="min-w-0 truncate font-medium">{{
          t('linkedItem', { group: l.name, profile: l.profileName })
        }}</span>
        <button
          type="button"
          class="btn shrink-0"
          :data-testid="`domain-unlink-${l.name}`"
          @click="ask('unlink', l.profileId, l.dn)"
        >
          {{ t('unlink') }}
        </button>
      </li>
    </ul>
    <p v-else-if="loaded" class="text-slate-500">{{ t('none') }}</p>

    <template v-if="loaded && configured">
      <input
        v-model="q"
        type="search"
        class="input"
        autocomplete="off"
        :placeholder="t('find')"
        :aria-label="t('find')"
        data-testid="domain-group-input"
      />
      <p v-if="q.trim().length < 2" class="text-slate-500">{{ t('hint') }}</p>
      <div v-else class="rounded-md border border-slate-200 dark:border-slate-700">
        <p class="px-2 pt-1 font-medium text-slate-500">{{ t('found') }}</p>
        <ul v-if="hits.length">
          <li
            v-for="h in hits"
            :key="`${h.profileId}:${h.dn}`"
            class="flex min-h-11 items-center gap-2 px-2 py-1"
            :data-testid="`domain-hit-${h.name}`"
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium">{{ h.name }}</span>
              <span class="block truncate text-slate-500">
                <template v-if="linkedHere(h)">{{ t('linkedTo', { name: circleName }) }}</template>
                <template v-else-if="otherLink(h)">{{
                  t('linkedTo', { name: otherLink(h)!.circleName })
                }}</template>
                <template v-else>{{ h.profileName }}</template>
              </span>
            </span>
            <button
              v-if="!linkedHere(h)"
              type="button"
              class="btn shrink-0"
              :disabled="!!pending"
              :data-testid="`domain-link-${h.name}`"
              @click="ask('link', h.profileId, h.dn)"
            >
              {{ t('link') }}
            </button>
          </li>
        </ul>
        <p v-else-if="!searching" class="px-2 py-1 text-slate-500">{{ t('noneFound') }}</p>
        <p v-if="problems.length" class="px-2 py-1 text-amber-700 dark:text-amber-300">
          {{ t('problem', { name: problems.join(', ') }) }}
        </p>
      </div>
    </template>
    <p v-else-if="loaded" class="text-slate-500" data-testid="domain-links-nodir">
      {{ t('noDirectory') }}
    </p>

    <div
      v-if="pending"
      class="space-y-2 rounded-md border border-slate-300 bg-white p-3 dark:border-slate-600 dark:bg-slate-900"
      role="group"
      data-testid="domain-preview"
    >
      <p v-if="!preview" class="text-slate-500">{{ t('loading') }}</p>
      <template v-else>
        <h4 class="text-sm font-medium">
          {{
            t(preview.action === 'link' ? 'pvLinkTitle' : 'pvUnlinkTitle', {
              group: preview.group,
              circle: circleName,
            })
          }}
        </h4>
        <ul v-if="preview.action === 'link'" class="list-disc space-y-0.5 pl-4">
          <li data-testid="pv-domain">
            {{
              preview.truncated
                ? t('pvDomainMore', { n: preview.domainMembers })
                : t('pvDomain', { n: preview.domainMembers })
            }}
          </li>
          <li>
            {{ t('pvHave', { n: preview.withProfile })
            }}<span v-if="preview.waiting">{{ t('pvWaiting', { n: preview.waiting }) }}</span>
          </li>
          <li data-testid="pv-join">
            {{ t('pvJoin', { n: preview.willJoin })
            }}<span v-if="preview.alreadyMembers">
              · {{ t('pvAlready', { n: preview.alreadyMembers }) }}</span
            >
          </li>
          <li v-if="preview.withoutProfile">{{ t('pvLater', { n: preview.withoutProfile }) }}</li>
        </ul>
        <template v-else>
          <p data-testid="pv-unlink-members">
            {{ t('unlinkMembers', { n: preview.directoryMembers }) }}
          </p>
          <p v-if="preview.stillMapped" class="text-slate-500">{{ t('stillMapped') }}</p>
          <fieldset v-else-if="preview.directoryMembers" class="space-y-1">
            <label class="flex min-h-11 items-start gap-2"
              ><input v-model="keepMembers" type="radio" :value="true" class="mt-0.5" /><span>{{
                t('keep')
              }}</span></label
            >
            <label class="flex min-h-11 items-start gap-2"
              ><input
                v-model="keepMembers"
                type="radio"
                :value="false"
                class="mt-0.5"
                data-testid="pv-drop"
              /><span>{{ t('drop') }}</span></label
            >
          </fieldset>
        </template>
        <div>
          <p class="font-medium">{{ t('pvGives') }}</p>
          <p v-if="!preview.vaults.length" class="text-slate-500">{{ t('pvNoVaults') }}</p>
          <ul v-else class="list-disc pl-4">
            <li v-for="v in preview.vaults" :key="v.name">
              {{ t('pvVault', { name: v.name, role: t(`roles.${v.role}`) }) }}
            </li>
          </ul>
          <p v-if="preview.adminRole !== null" class="mt-1 text-amber-700 dark:text-amber-300">
            {{ t('pvAdminRole', { name: preview.adminRole }) }}
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            :class="preview.action === 'unlink' && !keepMembers ? 'btn-danger' : 'btn-primary'"
            :disabled="busy"
            data-testid="domain-confirm"
            @click="confirm"
          >
            {{ preview.action === 'link' ? t('confirmLink') : t('confirmUnlink') }}
          </button>
          <button type="button" class="btn" :disabled="busy" @click="cancel">
            {{ t('cancel') }}
          </button>
        </div>
      </template>
    </div>
  </section>
</template>
