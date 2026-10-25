<script setup lang="ts">
import { useI18n } from 'vue-i18n';
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
const CARDS: { id: string; to: string; icon: IconName }[] = [
  { id: 'setup', to: '/admin/overview', icon: 'check' },
  { id: 'dept', to: '/admin/departments', icon: 'building' },
  { id: 'people', to: '/admin/invitations', icon: 'user-plus' },
  { id: 'ldap', to: '/admin/ldap', icon: 'idcard' },
  { id: 'backup', to: '/admin/backups', icon: 'database' },
  { id: 'recovery', to: '/admin/settings?section=security', icon: 'shield' },
];
</script>

<template>
  <section class="space-y-3" data-testid="wizards">
    <div>
      <h2 class="text-base font-semibold">{{ t('title') }}</h2>
      <p class="mt-1 max-w-prose text-xs text-slate-500">{{ t('hint') }}</p>
    </div>
    <div class="grid gap-3 md:grid-cols-2">
      <article v-for="c in CARDS" :key="c.id" class="card flex flex-col gap-2 p-4 text-sm">
        <h3 class="flex items-center gap-2 font-medium">
          <Icon :name="c.icon" class="size-4 opacity-80" />{{ t(c.id) }}
        </h3>
        <p class="flex-1 text-xs text-slate-600 dark:text-slate-300">{{ t(`${c.id}Text`) }}</p>
        <RouterLink :to="c.to" class="btn self-start" :data-testid="`wizard-${c.id}`">{{
          t('open')
        }}</RouterLink>
      </article>
    </div>
  </section>
</template>
