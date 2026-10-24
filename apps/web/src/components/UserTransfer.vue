<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';

/**
 * Перевод сотрудника в другое подразделение: сначала добавление в новую группу, затем исключение из прежней
 * (доступа не бывает «пустым» посередине). Исключение открывает «смените пароль» по тому, что сотрудник перестал видеть.
 */
const props = defineProps<{ userId: string; groups: { id: string; name: string }[] }>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      title: 'Перевод в другое подразделение',
      from: 'Из группы',
      to: 'В группу',
      pick: 'Выберите группу',
      go: 'Перевести',
      lose: 'Потеряет доступ к сейфам:',
      gain: 'Получит доступ к сейфам:',
      same: 'без изменений',
      done: 'Переведён',
      hint: 'По записям, которые сотрудник перестанет видеть, откроются события «смените пароль».',
    },
    en: {
      title: 'Transfer to another department',
      from: 'From group',
      to: 'To group',
      pick: 'Choose a group',
      go: 'Transfer',
      lose: 'Will lose access to vaults:',
      gain: 'Will gain access to vaults:',
      same: 'no change',
      done: 'Transferred',
      hint: 'Entries the employee stops seeing get “change the password” events.',
    },
  },
});
const open = ref(false);
const all = ref<{ id: string; name: string }[]>([]);
const from = ref('');
const to = ref('');
const lose = ref<string[]>([]);
const gain = ref<string[]>([]);
const busy = ref(false);
const error = ref('');
const notice = ref('');

const targets = computed(() => all.value.filter((c) => c.id !== from.value));

async function show(): Promise<void> {
  open.value = !open.value;
  if (open.value && !all.value.length) {
    try {
      all.value = await api('GET', '/admin/circles');
    } catch (e) {
      error.value = errorMessage(e, t);
    }
  }
  if (!from.value) from.value = props.groups[0]?.id ?? '';
}
const vaultsOf = async (id: string) =>
  (await api<{ id: string; name: string }[]>('GET', `/admin/circles/${id}/vaults`)).map((v) => v);
// предпросмотр: сейфы прежней группы, которых нет у новой, и наоборот
watch([from, to], async () => {
  lose.value = [];
  gain.value = [];
  if (!from.value || !to.value) return;
  try {
    const [a, b] = await Promise.all([vaultsOf(from.value), vaultsOf(to.value)]);
    lose.value = a.filter((x) => !b.some((y) => y.id === x.id)).map((x) => x.name);
    gain.value = b.filter((x) => !a.some((y) => y.id === x.id)).map((x) => x.name);
  } catch (e) {
    error.value = errorMessage(e, t);
  }
});

async function go(): Promise<void> {
  if (!from.value || !to.value || busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await api('PATCH', `/admin/circles/${to.value}/members`, { add: [props.userId] });
    await api('PATCH', `/admin/circles/${from.value}/members`, { remove: [props.userId] });
    notice.value = t('done');
    to.value = '';
    from.value = '';
    emit('changed');
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div data-testid="user-transfer">
    <button
      type="button"
      class="btn"
      :aria-expanded="open"
      data-testid="transfer-open"
      @click="show"
    >
      {{ t('title') }}
    </button>
    <div v-if="open" class="mt-2 space-y-2 text-sm">
      <div class="flex flex-wrap items-end gap-2">
        <label class="block"
          ><span class="field-label">{{ t('from') }}</span
          ><select v-model="from" class="input w-auto max-w-full" data-testid="transfer-from">
            <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select></label
        >
        <label class="block"
          ><span class="field-label">{{ t('to') }}</span
          ><select v-model="to" class="input w-auto max-w-full" data-testid="transfer-to">
            <option value="" disabled>{{ t('pick') }}</option>
            <option v-for="g in targets" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select></label
        >
        <button
          type="button"
          class="btn-primary"
          :disabled="busy || !from || !to"
          data-testid="transfer-go"
          @click="go"
        >
          {{ t('go') }}
        </button>
      </div>
      <p
        v-if="to"
        class="text-xs text-slate-600 dark:text-slate-300"
        data-testid="transfer-preview"
      >
        {{ t('lose') }} {{ lose.join(', ') || t('same') }} · {{ t('gain') }}
        {{ gain.join(', ') || t('same') }}
      </p>
      <p class="text-xs text-slate-500">{{ t('hint') }}</p>
      <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
      <p v-if="notice" class="text-emerald-700" role="status" data-testid="transfer-done">
        {{ notice }}
      </p>
    </div>
  </div>
</template>
