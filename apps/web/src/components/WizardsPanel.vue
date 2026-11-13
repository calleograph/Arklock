<script setup lang="ts">
import InfoHint from './InfoHint.vue';
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import DirectoryGuide from './DirectoryGuide.vue';
import Icon, { type IconName } from './Icon.vue';

/**
 * «Мастера настройки»: точка входа к сложным операциям, которые выполняются в несколько шагов. Мастер не единственный
 * способ: каждая настройка доступна и в своём разделе.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      title: 'Мастера настройки',
      hint: 'Пошаговые сценарии для сложных операций. Каждую настройку можно изменить и в её обычном разделе.',
      open: 'Открыть',
      done: 'выполнено',
      todo: 'не выполнено',
      stepsDone: 'Готово {n} из {m}',
      step: {
        ldapConn: 'Адрес каталога и служебная учётная запись',
        ldapTls: 'Защищённое соединение (LDAPS или StartTLS) с проверкой сертификата',
        ldapGroups: 'Сопоставление групп каталога группам Arklock',
        ldapSync: 'Первая сверка с каталогом',
        backupFirst: 'Первая резервная копия',
        backupSchedule: 'Расписание копий',
        backupOffsite: 'Отправка копий на S3 или SMB',
        backupRestore: 'Проверка восстановления во временную базу (в списке копий)',
        recRecipient: 'Назначен получатель офлайн-пакета',
        recVaults: 'Корпоративные сейфы подключены ({n} из {m})',
        setupHttps: 'Публичный адрес с HTTPS',
        setupMail: 'Почта (SMTP) настроена',
        setupMfa: 'Двухфакторная защита обязательна',
        deptCreated: 'Создано хотя бы одно подразделение',
        deptHeads: 'У каждого подразделения есть руководитель',
        deptVaults: 'У каждого подразделения есть сейф',
        peopleCreated: 'Сотрудники добавлены',
        peopleSignedIn: 'Хотя бы один сотрудник уже вошёл',
      },
      setup: 'Первоначальная настройка',
      setupText:
        'Публичный HTTPS-адрес, почта, резервная копия, подразделения, сотрудники, двухфакторная защита. Пройденные шаги отмечаются сами по фактической настройке.',
      dept: 'Создать подразделение',
      deptText:
        'Название, описание, руководитель (поиск по каталогу), участники, группа, пространство, сейф отдела и сейф руководства создаются вместе, с предпросмотром. Можно вставить список подразделений.',
      people: 'Добавить сотрудников',
      peopleText:
        'Один сотрудник, список или файл CSV (пример можно скачать), выбор групп, предпросмотр с проверкой ошибок и коды активации. Пароли в файл не нужны.',
      ldap: 'Подключить Active Directory',
      ldapText:
        'Адрес LDAPS, сертификат центра сертификации, служебная учётная запись, проверка соединения и пробного пользователя, сопоставление групп.',
      backup: 'Резервное копирование',
      backupText:
        'Создайте копию, при необходимости настройте отправку на S3 или SMB и расписание, затем проверьте восстановление во временную базу. Ключ шифрования копий храните отдельно от них.',
      recovery: 'Корпоративное восстановление',
      recoveryText:
        'Зачем: если все, у кого есть ключ сейфа, недоступны, уполномоченный администратор вернёт доступ по заранее подготовленному офлайн-пакету. Защищены только подключённые корпоративные сейфы; личные приватные сейфы не открываются. Ответственного назначьте заранее; при увольнении владельца передайте владение другому участнику.',
    },
    en: {
      title: 'Setup wizards',
      hint: 'Step-by-step flows for complex operations. Every setting can also be changed in its regular section.',
      open: 'Open',
      done: 'done',
      todo: 'not done',
      stepsDone: 'Done {n} of {m}',
      step: {
        ldapConn: 'Directory address and service account',
        ldapTls: 'Secure connection (LDAPS or StartTLS) with certificate checking',
        ldapGroups: 'Directory groups mapped to Arklock groups',
        ldapSync: 'First directory sync',
        backupFirst: 'First backup',
        backupSchedule: 'Backup schedule',
        backupOffsite: 'Sending backups to S3 or SMB',
        backupRestore: 'Restore test into a temporary database (in the backup list)',
        recRecipient: 'An offline-package recipient is set',
        recVaults: 'Corporate vaults connected ({n} of {m})',
        setupHttps: 'Public address with HTTPS',
        setupMail: 'E-mail (SMTP) is set up',
        setupMfa: 'Two-factor protection is required',
        deptCreated: 'At least one department is created',
        deptHeads: 'Every department has a head',
        deptVaults: 'Every department has a vault',
        peopleCreated: 'Employees are added',
        peopleSignedIn: 'At least one employee has already signed in',
      },
      setup: 'First-time setup',
      setupText:
        'Public HTTPS address, mail, a backup, departments, employees, two-factor protection. Finished steps are ticked by themselves from the actual configuration.',
      dept: 'Create a department',
      deptText:
        'Name, description, head (directory search), members, group, space, department vault and management vault are created together, with a preview. You can paste a list of departments.',
      people: 'Add employees',
      peopleText:
        'One employee, a list or a CSV file (a sample can be downloaded), group choice, a preview with error checks and activation codes. No passwords belong in the file.',
      ldap: 'Connect Active Directory',
      ldapText:
        'LDAPS address, certificate authority certificate, service account, a connection check and a test user, group mapping.',
      backup: 'Backups',
      backupText:
        'Make a backup, optionally set up sending to S3 or SMB and a schedule, then test restoring into a temporary database. Keep the backup encryption key apart from the backups.',
      recovery: 'Corporate recovery',
      recoveryText:
        'Why: if everyone holding a vault key is unavailable, an authorized administrator restores access from a pre-made offline package. Only connected corporate vaults are protected; private personal vaults are never opened. Name the responsible person in advance; when an owner leaves, pass ownership to another member.',
    },
  },
});
interface Step {
  id: string;
  done: boolean | null;
  to: string;
  params?: Record<string, number>;
}
const steps = ref<Record<string, Step[]>>({});
const ok = async <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
onMounted(async () => {
  const [ldap, backups, offsite, recovery, diag, depts, people] = await Promise.all([
    ok(
      api<{
        profiles: {
          url: string;
          bindDn: string;
          hasBindPassword: boolean;
          startTls: boolean;
          insecureTls: boolean;
          groups: unknown[];
          lastSync: unknown;
        }[];
      }>('GET', '/admin/ldap/profiles'),
    ),
    ok(
      api<{ backups: { items: unknown[] } | null; schedule?: { enabled: boolean } | null }>(
        'GET',
        '/admin/backups',
      ),
    ),
    ok(api<{ offsite: { configured: boolean } | null }>('GET', '/admin/backups/offsite')),
    ok(
      api<{ recipient: unknown; vaults: { enrolled: boolean }[] }>(
        'GET',
        '/admin/corporate-recovery',
      ),
    ),
    ok(api<{ checks: { id: string; level: string }[] }>('GET', '/admin/diagnostics')),
    ok(
      api<{ items: { heads: unknown[]; vaults: number }[] }>('GET', '/admin/departments?limit=200'),
    ),
    ok(api<{ waiting: number; signedIn: number }>('GET', '/admin/people/summary')),
  ]);
  const good = (id: string) => diag?.checks.find((c) => c.id === id)?.level === 'ok';
  const p = ldap?.profiles?.[0];
  const secure = !!p && (/^ldaps:/i.test(p.url) || p.startTls) && !p.insecureTls;
  steps.value = {
    setup: [
      { id: 'setupHttps', done: good('public-url'), to: '/admin/settings?section=network' },
      { id: 'setupMail', done: good('smtp'), to: '/admin/smtp' },
      { id: 'setupMfa', done: good('mfa-policy'), to: '/admin/settings?section=security' },
    ],
    dept: [
      { id: 'deptCreated', done: (depts?.items.length ?? 0) > 0, to: '/admin/departments' },
      {
        id: 'deptHeads',
        done: !!depts?.items.length && depts.items.every((d) => d.heads.length > 0),
        to: '/admin/departments',
      },
      {
        id: 'deptVaults',
        done: !!depts?.items.length && depts.items.every((d) => d.vaults > 0),
        to: '/admin/departments',
      },
    ],
    people: [
      {
        id: 'peopleCreated',
        done: (people?.waiting ?? 0) + (people?.signedIn ?? 0) > 0,
        to: '/admin/invitations',
      },
      { id: 'peopleSignedIn', done: (people?.signedIn ?? 0) > 0, to: '/admin/users' },
    ],
    ldap: [
      { id: 'ldapConn', done: !!p?.url && !!p.bindDn && p.hasBindPassword, to: '/admin/ldap' },
      { id: 'ldapTls', done: secure, to: '/admin/ldap' },
      { id: 'ldapGroups', done: !!p && p.groups.length > 0, to: '/admin/ldap' },
      { id: 'ldapSync', done: !!p?.lastSync, to: '/admin/ldap' },
    ],
    backup: [
      { id: 'backupFirst', done: (backups?.backups?.items.length ?? 0) > 0, to: '/admin/backups' },
      { id: 'backupSchedule', done: !!backups?.schedule?.enabled, to: '/admin/backups' },
      { id: 'backupOffsite', done: !!offsite?.offsite?.configured, to: '/admin/backups' },
      { id: 'backupRestore', done: null, to: '/admin/backups' },
    ],
    recovery: [
      {
        id: 'recRecipient',
        done: !!recovery?.recipient,
        to: '/admin/settings?section=security',
      },
      {
        id: 'recVaults',
        done: !!recovery && recovery.vaults.length > 0 && recovery.vaults.every((v) => v.enrolled),
        to: '/admin/settings?section=security',
        params: {
          n: recovery?.vaults.filter((v) => v.enrolled).length ?? 0,
          m: recovery?.vaults.length ?? 0,
        },
      },
    ],
  };
});
const progress = (id: string) => {
  const list = (steps.value[id] ?? []).filter((x) => x.done !== null);
  return { n: list.filter((x) => x.done).length, m: list.length };
};

const CARDS: { id: string; to: string; icon: IconName }[] = [
  { id: 'setup', to: '/admin/overview', icon: 'check' },
  { id: 'dept', to: '/admin/departments', icon: 'building' },
  { id: 'people', to: '/admin/invitations', icon: 'user-plus' },
  // порядок по парам с одинаковым числом шагов: карточки в ряду одной высоты без пустот
  { id: 'recovery', to: '/admin/settings?section=security', icon: 'shield' },
  { id: 'ldap', to: '/admin/ldap', icon: 'idcard' },
  { id: 'backup', to: '/admin/backups', icon: 'database' },
];
</script>

<template>
  <section class="space-y-3" data-testid="wizards">
    <DirectoryGuide />
    <div class="grid gap-3 md:grid-cols-2">
      <article v-for="c in CARDS" :key="c.id" class="card flex flex-col gap-2 p-4 text-sm">
        <h3 class="flex items-center gap-2 font-medium">
          <Icon :name="c.icon" class="size-4 opacity-80" />{{ t(c.id)
          }}<InfoHint :text="t(`${c.id}Text`)" />
        </h3>
        <template v-if="steps[c.id]">
          <p class="text-xs font-medium" data-testid="wizard-progress">
            {{ t('stepsDone', progress(c.id)) }}
          </p>
          <ol class="space-y-1 text-xs">
            <li v-for="st in steps[c.id]" :key="st.id" class="flex items-start gap-2">
              <span
                class="mt-3.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none"
                :class="
                  st.done
                    ? 'border-emerald-600 bg-emerald-600 text-white'
                    : 'border-slate-400 text-transparent'
                "
                role="img"
                :aria-label="st.done ? t('done') : st.done === null ? '' : t('todo')"
                >✓</span
              >
              <RouterLink :to="st.to" class="block min-h-11 py-3.5 leading-4 hover:underline">{{
                t(`step.${st.id}`, st.params ?? {})
              }}</RouterLink>
            </li>
          </ol>
        </template>
        <RouterLink :to="c.to" class="btn mt-auto self-start" :data-testid="`wizard-${c.id}`">{{
          t('open')
        }}</RouterLink>
      </article>
    </div>
  </section>
</template>
