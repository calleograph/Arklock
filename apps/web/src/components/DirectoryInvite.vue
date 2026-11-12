<script setup lang="ts">
import InfoHint from './InfoHint.vue';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import GroupPicker, { type Group } from './GroupPicker.vue';
import PersonPicker, { type Person } from './PersonPicker.vue';

/**
 * «Из каталога домена»: вместо приглашения с кодом сотрудников домена находят поиском, добавляют кнопкой «+» и сразу
 * включают в нужные группы. Роли и права сотрудники получают через группы; войти они смогут по доменному логину.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      title: 'Добавить сотрудников из каталога',
      lead: 'Находите людей поиском по каталогу домена и добавляйте кнопкой «+». Приглашение с кодом не нужно: сотрудник входит по доменному логину и паролю. Права он получает через группы.',
      people: 'Сотрудники',
      peopleFind: 'Найти сотрудников: имя, логин или почта',
      groups: 'Группы (права доступа)',
      groupsFind: 'Найти группу Arklock или группу домена',
      groupsHint: 'Без групп сотрудник получит только профиль. Группы можно назначить и позже.',
      submit: 'Добавить в группы',
      submitNoGroups: 'Профили созданы',
      busy: 'Добавляю…',
      done: 'Готово: сотрудников {n}, групп {m}. Ключи сейфов они получат после первого входа.',
      doneNoGroups: 'Профили созданы: {n}. Группы можно назначить позже.',
      waiting: 'Профили без входа: доступ к сейфам появится после первого входа сотрудника.',
    },
    en: {
      title: 'Add employees from the directory',
      lead: 'Find people by searching the domain directory and add them with “+”. No invitation code is needed: the employee signs in with the domain login and password. Rights come through groups.',
      people: 'Employees',
      peopleFind: 'Find employees: name, login or e-mail',
      groups: 'Groups (access rights)',
      groupsFind: 'Find an Arklock group or a domain group',
      groupsHint: 'Without groups the employee gets only a profile. Groups can be assigned later.',
      submit: 'Add to groups',
      submitNoGroups: 'Profiles created',
      busy: 'Adding…',
      done: 'Done: {n} employees, {m} groups. They get the vault keys after the first sign-in.',
      doneNoGroups: 'Profiles created: {n}. Groups can be assigned later.',
      waiting:
        'Profiles without a sign-in: vault access appears after the employee’s first sign-in.',
    },
  },
});
const configured = ref(false);
const people = ref<Person[]>([]);
const groups = ref<Group[]>([]);
const busy = ref(false);
const error = ref('');
const notice = ref('');

onMounted(async () => {
  try {
    configured.value = (
      await api<{ configured: boolean }>('GET', '/admin/people/directory?q=')
    ).configured;
  } catch {
    // нет права на каталог или он не подключён: блок скрыт
    configured.value = false;
  }
});

/** Профили уже созданы выбором «+»; здесь они включаются в группы. */
async function submit(): Promise<void> {
  if (!people.value.length || busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    for (const g of groups.value)
      await api('PATCH', `/admin/circles/${g.id}/members`, {
        add: people.value.map((p) => p.id),
      });
    notice.value = groups.value.length
      ? t('done', { n: people.value.length, m: groups.value.length })
      : t('doneNoGroups', { n: people.value.length });
    people.value = [];
    groups.value = [];
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
const label = computed(() => (groups.value.length ? t('submit') : t('submitNoGroups')));
</script>

<template>
  <section v-if="configured" class="card space-y-4 p-4 text-sm" data-testid="directory-invite">
    <div>
      <h2 class="text-base font-semibold">
        {{ t('title') }}<InfoHint class="ml-1" :text="t('lead')" />
      </h2>
    </div>
    <div class="space-y-1">
      <span class="field-label">{{ t('people') }}</span>
      <PersonPicker
        v-model="people"
        multiple
        :placeholder="t('peopleFind')"
        testid="dir-invite-person"
      />
    </div>
    <div class="space-y-1">
      <span class="field-label">{{ t('groups') }}</span>
      <GroupPicker v-model="groups" :placeholder="t('groupsFind')" testid="dir-invite-group" />
      <p class="text-xs text-slate-500">{{ t('groupsHint') }}</p>
    </div>
    <p v-if="people.some((p) => p.pending)" class="text-xs text-slate-500">{{ t('waiting') }}</p>
    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
    <p
      v-if="notice"
      class="text-emerald-700 dark:text-emerald-300"
      role="status"
      data-testid="dir-invite-done"
    >
      {{ notice }}
    </p>
    <button
      type="button"
      class="btn-primary"
      :disabled="!people.length || busy"
      data-testid="dir-invite-submit"
      @click="submit"
    >
      {{ busy ? t('busy') : label }}
    </button>
  </section>
</template>
