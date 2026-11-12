<script setup lang="ts">
import InfoHint from './InfoHint.vue';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';

/**
 * «Что дальше» для сотрудников из каталога: шаги идут по порядку, текущий выделен, у каждого — что это и зачем.
 * Состояние берётся из фактических настроек, поэтому после подключения каталога администратор сразу видит следующий шаг.
 */
const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      title: 'Сотрудники из каталога: шаги по порядку',
      lead: 'Пройдите шаги сверху вниз. Выполненные отмечаются сами, по настройкам.',
      now: 'Сейчас',
      open: 'Открыть',
      allDone:
        'Все шаги выполнены. Новых сотрудников добавляйте через поиск по каталогу в любом поле выбора человека.',
      step: {
        connect: {
          t: 'Подключить каталог',
          d: 'Адрес сервера, служебная учётная запись, защищённое соединение. После проверки Arklock сам определяет тип каталога и Base DN.',
        },
        login: {
          t: 'Проверить вход обычного сотрудника',
          d: 'Введите логин и пароль любого сотрудника: Arklock покажет, нашёл ли он человека, принял ли пароль и сможет ли тот войти.',
        },
        access: {
          t: 'Выбрать, кому разрешён вход',
          d: 'Все действующие учётные записи каталога или только участники выбранных групп домена. Без выбора вход выключен.',
        },
        departments: {
          t: 'Создать подразделения',
          d: 'Подразделение — это группа, закрытое пространство и сейф отдела, созданные вместе. Руководителя и участников выбирают поиском по каталогу.',
        },
        groups: {
          t: 'Связать группы домена с группами Arklock',
          d: 'Состав группы домена сам попадает в группу Arklock, а группе назначаются сейфы. Тогда доступ меняется вслед за каталогом.',
        },
        people: {
          t: 'Сотрудники входят по доменному логину',
          d: 'Профили созданы, ключи шифрования сотрудник создаёт сам при первом входе. Сообщите адрес Arklock: достаточно логина и пароля домена.',
        },
      },
      waiting: 'Ждут первого входа: {n}',
      signedIn: 'Уже входили: {n}',
    },
    en: {
      title: 'Directory employees: steps in order',
      lead: 'Go through the steps from top to bottom. Finished ones are ticked by themselves from the settings.',
      now: 'Now',
      open: 'Open',
      allDone:
        'All steps are done. Add new employees through the directory search in any person field.',
      step: {
        connect: {
          t: 'Connect the directory',
          d: 'Server address, service account, secure connection. After the check Arklock detects the directory type and the Base DN itself.',
        },
        login: {
          t: 'Check an ordinary employee sign-in',
          d: 'Enter the login and password of any employee: Arklock shows whether the person was found, the password accepted and the sign-in will work.',
        },
        access: {
          t: 'Choose who may sign in',
          d: 'All active directory accounts, or only members of chosen domain groups. Until you choose, sign-in stays off.',
        },
        departments: {
          t: 'Create departments',
          d: 'A department is a group, a private space and a department vault created together. Pick the head and members from the directory.',
        },
        groups: {
          t: 'Link domain groups to Arklock groups',
          d: 'The members of a domain group join the Arklock group by themselves and the group gets vaults. Access then follows the directory.',
        },
        people: {
          t: 'Employees sign in with the domain login',
          d: 'Profiles are created; the employee makes the encryption keys at the first sign-in. Tell them the Arklock address: the domain login and password are enough.',
        },
      },
      waiting: 'Waiting for the first sign-in: {n}',
      signedIn: 'Already signed in: {n}',
    },
  },
});

interface Step {
  id: 'connect' | 'login' | 'access' | 'departments' | 'groups' | 'people';
  done: boolean;
  to: string;
}
const steps = ref<Step[]>([]);
const loaded = ref(false);
const waiting = ref(0);
const signedIn = ref(0);

onMounted(async () => {
  const ok = async <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
  const [ldap, depts, people] = await Promise.all([
    ok(
      api<{
        profiles: {
          enabled: boolean;
          access: string | null;
          groups: unknown[];
          status: { connection?: { ok: boolean }; login?: { ok: boolean } };
        }[];
      }>('GET', '/admin/ldap/profiles'),
    ),
    ok(api<{ items: unknown[] }>('GET', '/admin/departments?limit=1')),
    ok(api<{ waiting: number; signedIn: number }>('GET', '/admin/people/summary')),
  ]);
  const p = ldap?.profiles?.[0];
  waiting.value = people?.waiting ?? 0;
  signedIn.value = people?.signedIn ?? 0;
  steps.value = [
    { id: 'connect', done: !!p?.status.connection?.ok, to: '/admin/ldap#connection' },
    { id: 'login', done: !!p?.status.login?.ok, to: '/admin/ldap#login-check' },
    { id: 'access', done: !!p?.enabled && !!p.access, to: '/admin/ldap#access' },
    { id: 'departments', done: (depts?.items.length ?? 0) > 0, to: '/admin/departments' },
    { id: 'groups', done: (p?.groups.length ?? 0) > 0, to: '/admin/circles' },
    { id: 'people', done: signedIn.value > 0, to: '/admin/users' },
  ];
  loaded.value = true;
});
/** Первый невыполненный шаг: идти нужно по порядку, поэтому «сейчас» только он. */
const current = computed(() => steps.value.find((s) => !s.done)?.id ?? null);
void props;
</script>

<template>
  <section v-if="loaded" class="card space-y-3 p-4 text-sm" data-testid="directory-guide">
    <div>
      <h2 class="font-medium">
        {{ t('title') }}<InfoHint class="ml-1" :text="current ? t('lead') : t('allDone')" />
      </h2>
    </div>
    <ol class="space-y-2">
      <li
        v-for="(s, i) in steps"
        :key="s.id"
        class="grid grid-cols-[32px_1fr] items-start gap-x-3 rounded-lg p-2"
        :class="current === s.id ? 'bg-slate-100 dark:bg-slate-800/60' : ''"
        :data-testid="`guide-${s.id}`"
        :data-state="s.done ? 'done' : current === s.id ? 'now' : 'later'"
        :aria-current="current === s.id ? 'step' : undefined"
      >
        <span
          class="mt-0.5 inline-flex size-8 items-center justify-center rounded-full border text-xs font-medium"
          :class="
            s.done
              ? 'border-emerald-600 bg-emerald-600 text-white'
              : current === s.id
                ? 'border-brand-600 text-brand-700 dark:text-brand-300'
                : 'border-slate-300 text-slate-500 dark:border-slate-600'
          "
          aria-hidden="true"
          >{{ s.done ? '✓' : i + 1 }}</span
        >
        <div class="min-w-0 space-y-1">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="font-medium">
              {{ t(`step.${s.id}.t`) }}
              <span v-if="current === s.id" class="badge-brand ml-1 text-xs">{{ t('now') }}</span>
            </h3>
            <RouterLink
              v-if="current === s.id"
              :to="s.to"
              class="btn-primary shrink-0"
              :data-testid="`guide-open-${s.id}`"
              >{{ t('open') }}</RouterLink
            >
            <RouterLink v-else-if="!s.done" :to="s.to" class="btn shrink-0">{{
              t('open')
            }}</RouterLink>
          </div>
          <p class="max-w-prose text-xs text-slate-600 dark:text-slate-300">
            {{ t(`step.${s.id}.d`) }}
          </p>
          <p v-if="s.id === 'people' && (waiting || signedIn)" class="text-xs text-slate-500">
            <span v-if="waiting">{{ t('waiting', { n: waiting }) }}</span
            ><span v-if="waiting && signedIn"> · </span
            ><span v-if="signedIn">{{ t('signedIn', { n: signedIn }) }}</span>
          </p>
        </div>
      </li>
    </ol>
  </section>
</template>
