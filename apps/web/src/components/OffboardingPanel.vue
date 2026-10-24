<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { i18n } from '../i18n';
import { api } from '../services/api';
import { errorMessage, vaultLabel } from '../services/helpers';

const props = defineProps<{
  user: { id: string; name: string };
  candidates: { id: string; name: string; email: string }[];
  isFull: boolean;
}>();
const emit = defineEmits<{ close: []; done: [] }>();
// сообщения об ошибках и названия сейфов берутся из общего словаря
const gt = i18n.global.t as (k: string) => string;

const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      title: 'Увольнение сотрудника',
      what: 'Учётная запись будет заблокирована, сеансы завершены, права и участие в группах сняты, токены и внешние ссылки отозваны. Записи и ключи сейфов не удаляются. Личный сейф остаётся нетронутым, его содержимое администратору недоступно.',
      vaults: 'Корпоративные сейфы сотрудника',
      none: 'У сотрудника нет корпоративных сейфов.',
      entries: 'записей',
      lastOwner: 'Единственный владелец: выберите нового владельца',
      pick: 'Новый владелец',
      pickHint:
        'Новый владелец должен уже входить в сейф и иметь его текущий ключ. Иначе сначала выдайте ему доступ в настройках сейфа.',
      risk: 'Сотрудник — единственный хранитель ключа этих сейфов. После блокировки открыть их будет некому, кроме корпоративного восстановления. Подтверждаю этот риск.',
      stats: 'Будет отозвано: сеансов {s}, токенов API {a}, внешних ссылок {l}.',
      confirm: 'Уволить и заблокировать',
      cancel: 'Отмена',
      close: 'Закрыть',
      doneTitle: 'Готово: сотрудник заблокирован',
      rotate:
        'Сотрудник мог сохранить ключи этих сейфов и пароли из них. Смените ключ шифрования в настройках сейфа и смените пароли во внешних системах:',
      transferNeeded:
        'Назначьте нового владельца для каждого сейфа, где сотрудник — единственный владелец.',
      adminOnly: 'Передачу владения выполняет только полный администратор.',
    },
    en: {
      title: 'Offboard an employee',
      what: 'The account will be blocked, sessions ended, rights and group memberships removed, API tokens and external links revoked. Vault entries and keys are not deleted. The personal vault stays untouched and its contents are not available to administrators.',
      vaults: "The employee's corporate vaults",
      none: 'The employee has no corporate vaults.',
      entries: 'entries',
      lastOwner: 'Only owner: choose a new owner',
      pick: 'New owner',
      pickHint:
        'The new owner must already be a member of the vault and hold its current key. Otherwise give them access in the vault settings first.',
      risk: 'The employee is the only holder of the key for these vaults. After blocking, only corporate recovery can open them. I accept this risk.',
      stats: 'Will be revoked: {s} sessions, {a} API tokens, {l} external links.',
      confirm: 'Offboard and block',
      cancel: 'Cancel',
      close: 'Close',
      doneTitle: 'Done: the employee is blocked',
      rotate:
        'The employee may have saved the keys of these vaults and the passwords in them. Rotate the vault key in its settings and change the passwords in external systems:',
      transferNeeded: 'Choose a new owner for every vault where the employee is the only owner.',
      adminOnly: 'Only a full administrator can hand over ownership.',
    },
  },
});

interface Preview {
  vaults: { id: string; name: string; role: string; entries: number; lastOwner: boolean }[];
  accessRisks: { id: string; name: string }[];
  apiTokens: number;
  externalLinks: number;
  sessions: number;
}
const preview = ref<Preview | null>(null);
const heirs = ref<Record<string, string>>({});
const ack = ref(false);
const busy = ref(false);
const error = ref('');
const result = ref<{ rotateVaults: { id: string; name: string; entries: number }[] } | null>(null);

onMounted(async () => {
  try {
    preview.value = await api<Preview>('GET', `/admin/users/${props.user.id}/offboarding`);
  } catch (e) {
    error.value = errorMessage(e, gt);
  }
});

const orphaned = computed(() => preview.value?.vaults.filter((v) => v.lastOwner) ?? []);
const ready = computed(
  () =>
    !!preview.value &&
    orphaned.value.every((v) => heirs.value[v.id]) &&
    (!preview.value.accessRisks.length || ack.value) &&
    (props.isFull || !orphaned.value.length),
);

async function submit(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    result.value = await api('POST', `/admin/users/${props.user.id}/offboard`, {
      transfers: Object.entries(heirs.value)
        .filter(([, to]) => to)
        .map(([vaultId, toUserId]) => ({ vaultId, toUserId })),
      acknowledgeAccessRisk: ack.value || undefined,
    });
    emit('done');
  } catch (e) {
    error.value = errorMessage(e, gt);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section
    class="card my-3 space-y-3 border-red-300 p-4 text-sm dark:border-red-900"
    role="group"
    :aria-label="t('title')"
    data-testid="offboarding"
  >
    <h2>{{ t('title') }}: {{ user.name }}</h2>
    <template v-if="result">
      <p class="font-medium text-emerald-700 dark:text-emerald-300" role="status">
        {{ t('doneTitle') }}
      </p>
      <template v-if="result.rotateVaults.length">
        <p>{{ t('rotate') }}</p>
        <ul class="list-disc pl-5" data-testid="offboarding-rotate">
          <li v-for="v in result.rotateVaults" :key="v.id">
            {{ vaultLabel(v, gt) }} · {{ t('entries') }}: {{ v.entries }}
          </li>
        </ul>
      </template>
      <button type="button" class="btn" @click="emit('close')">{{ t('close') }}</button>
    </template>
    <template v-else-if="preview">
      <p>{{ t('what') }}</p>
      <p class="text-xs text-slate-500">
        {{ t('stats', { s: preview.sessions, a: preview.apiTokens, l: preview.externalLinks }) }}
      </p>
      <h3 class="font-medium">{{ t('vaults') }}</h3>
      <p v-if="!preview.vaults.length" class="text-slate-500">{{ t('none') }}</p>
      <ul v-else class="divide-y divide-slate-200 dark:divide-slate-800">
        <li v-for="v in preview.vaults" :key="v.id" class="space-y-1 py-2">
          <p class="break-words font-medium">
            {{ vaultLabel(v, gt) }}
            <span class="text-xs font-normal text-slate-500"
              >· {{ v.entries }} {{ t('entries') }}</span
            >
          </p>
          <label v-if="v.lastOwner" class="block">
            <span class="text-amber-700 dark:text-amber-300">{{ t('lastOwner') }}</span>
            <select
              v-model="heirs[v.id]"
              class="input mt-1"
              :aria-label="`${t('pick')}: ${v.name}`"
              :data-testid="`offboarding-heir-${v.name}`"
            >
              <option value="" disabled>{{ t('pick') }}…</option>
              <option v-for="c in candidates" :key="c.id" :value="c.id">
                {{ c.name }} ({{ c.email }})
              </option>
            </select>
          </label>
        </li>
      </ul>
      <p v-if="orphaned.length" class="text-xs text-slate-500">
        {{ t('pickHint') }} {{ isFull ? '' : t('adminOnly') }}
      </p>
      <label v-if="preview.accessRisks.length" class="flex items-start gap-2 text-amber-800">
        <input v-model="ack" type="checkbox" class="mt-1" data-testid="offboarding-ack" />
        <span>{{ t('risk') }}</span>
      </label>
      <p v-if="error" class="text-red-600" role="alert" data-testid="offboarding-error">
        {{ error }}
      </p>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="btn-danger"
          :disabled="!ready || busy"
          data-testid="offboarding-confirm"
          @click="submit"
        >
          {{ t('confirm') }}
        </button>
        <button type="button" class="btn" @click="emit('close')">{{ t('cancel') }}</button>
      </div>
    </template>
    <p v-else-if="error" class="text-red-600" role="alert">{{ error }}</p>
  </section>
</template>
