<script setup lang="ts">
import { useI18n } from 'vue-i18n';

/** Короткое объяснение раздела «Группы»: что это и как связано с каталогом. */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      title: 'Что такое группа',
      what: 'Группа — набор людей, которому выдают доступ целиком: назначьте группе сейфы с ролью, и все её участники получат доступ. Называйте группы по отделам. Состав можно вести вручную или связать группу с группой домена: тогда люди попадают в неё сами.',
    },
    en: {
      title: 'What a group is',
      what: 'A group is a set of people given access as a whole: assign vaults with a role to the group and every member gets access. Name groups after departments. Keep the membership by hand or link the group to a domain group: then people join it by themselves.',
    },
  },
});
</script>

<template>
  <details class="card text-sm" data-testid="groups-explain">
    <summary class="min-h-11 cursor-pointer font-medium">{{ t('title') }}</summary>
    <div class="mt-2 space-y-2 text-xs text-slate-600 dark:text-slate-300">
      <p class="max-w-prose">{{ t('what') }}</p>
    </div>
  </details>
</template>
