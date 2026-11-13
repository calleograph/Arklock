<script setup lang="ts">
import { useI18n } from 'vue-i18n';

/** Короткое объяснение раздела «Группы»: что это, чем отличается от подразделения и как связано с каталогом. */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      title: 'Что такое группа',
      what: 'Группа — набор людей, которому выдают доступ целиком: назначьте группе сейфы с ролью, и все её участники получат доступ. Состав можно вести вручную или связать группу с группой домена: тогда люди попадают в неё сами.',
      dept: 'Подразделение — готовый набор из группы, пространства и сейфа отдела. Его создают в разделе «Подразделения».',
      open: 'Открыть подразделения',
    },
    en: {
      title: 'What a group is',
      what: 'A group is a set of people given access as a whole: assign vaults with a role to the group and every member gets access. Keep the membership by hand or link the group to a domain group: then people join it by themselves.',
      dept: 'A department is a ready set of a group, a space and a department vault. Create it in the “Departments” section.',
      open: 'Open departments',
    },
  },
});
</script>

<template>
  <details class="card text-sm" data-testid="groups-explain">
    <summary class="min-h-11 cursor-pointer font-medium">{{ t('title') }}</summary>
    <div class="mt-2 space-y-2 text-xs text-slate-600 dark:text-slate-300">
      <p class="max-w-prose">{{ t('what') }}</p>
      <p class="max-w-prose">{{ t('dept') }}</p>
      <RouterLink to="/admin/departments" class="btn inline-flex">{{ t('open') }}</RouterLink>
    </div>
  </details>
</template>
