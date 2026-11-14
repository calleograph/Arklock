<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import Icon from './Icon.vue';

/**
 * Режим ключей шифрования: «Строгий» (ключи только у сотрудников) или «Простой вход» (секрет разблокировки хранит сервер).
 * Отдельный раздел, чтобы переключатель с такими последствиями не прятался среди настроек. Меняет только главный администратор.
 */
type Mode = 'strict' | 'managed';
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      now: 'Сейчас включён',
      strict: 'Строгий',
      managed: 'Простой вход',
      held: 'Секрет разблокировки хранится на сервере у сотрудников: {n}',
      heldNone: 'Секретов сотрудников на сервере нет',
      chiefOnly: 'Режим меняет только главный администратор.',
      on: 'Включён',
      choose: 'Выбрать',
      strictTitle: 'Строгий: ключи только у сотрудников',
      strictBody:
        'Сотрудник из каталога сам придумывает пароль разблокировки сейфов и хранит ключ восстановления. Доступ к сейфу ждёт, пока доверенный сотрудник откроет Arklock и передаст ключ.',
      strictWho:
        'Кто может прочитать данные: только сотрудники с доступом. Сервер и его администраторы не могут.',
      managedTitle: 'Простой вход: ключи хранит сервер',
      managedBody:
        'Сотрудник входит доменным логином и вторым фактором и сразу видит назначенные сейфы. Пароль разблокировки и ключ восстановления не нужны. Ключи сейфов выдаёт сам сервер.',
      managedWho:
        'Кто может прочитать данные: сотрудники с доступом, а также тот, кто управляет сервером и его базой. Включается только при обязательном втором факторе для всех.',
      scope: 'Действует для новых учётных записей. Созданные раньше входят прежним способом.',
      confirmManaged:
        'Включить «Простой вход»?\n\nСервер будет хранить секреты разблокировки сотрудников и сам выдавать ключи сейфов. Тот, кто управляет сервером и его базой, сможет расшифровать данные сотрудников, созданных в этом режиме. Второй фактор станет обязательным для всех. Ключи сотрудника выдаются сразу после первого входа, а при первом входе единственное доказательство личности — доменный пароль (администраторы получат уведомление о каждом таком входе). Секрет разблокировки получает любой действующий сеанс сотрудника: украденный токен сеанса открывает все данные этого сотрудника.\n\nСотрудники, созданные в этом режиме, останутся с секретом на сервере и после возврата к строгому режиму.',
      confirmStrictHeld:
        'Вернуть «Строгий» режим?\n\nНовые сотрудники из каталога снова получат пароль разблокировки. Но секреты {n} сотрудников, уже созданных в режиме «Простой вход», останутся на сервере: они по-прежнему входят без пароля разблокировки, а тот, кто управляет сервером и его базой, по-прежнему может расшифровать их данные.',
      confirmStrict: 'Вернуть «Строгий» режим для новых сотрудников из каталога?',
      saved: 'Сохранено',
    },
    en: {
      now: 'Currently enabled',
      strict: 'Strict',
      managed: 'Simple sign-in',
      held: 'Employees whose unlock secret is stored on the server: {n}',
      heldNone: 'No employee secrets are stored on the server',
      chiefOnly: 'Only the chief administrator can change the mode.',
      on: 'Enabled',
      choose: 'Choose',
      strictTitle: 'Strict: keys only with employees',
      strictBody:
        'A directory employee makes up an unlock password for the vaults and keeps a recovery key. Access to a vault waits until a trusted employee opens Arklock and passes the key on.',
      strictWho:
        'Who can read the data: only employees with access. The server and its administrators cannot.',
      managedTitle: 'Simple sign-in: the server holds the keys',
      managedBody:
        'The employee signs in with the domain login and a second factor and sees the assigned vaults at once. No unlock password and no recovery key. The server issues the vault keys itself.',
      managedWho:
        'Who can read the data: employees with access, and whoever runs the server and its database. Requires two-factor authentication for everyone.',
      scope: 'Applies to new accounts. Accounts created earlier sign in the way they did before.',
      confirmManaged:
        'Turn on “Simple sign-in”?\n\nThe server will store employees’ unlock secrets and issue vault keys itself. Whoever runs the server and its database will be able to decrypt the data of employees created in this mode. Two-factor authentication becomes mandatory for everyone. An employee’s keys are issued right after the first sign-in, and at the first sign-in the only proof of identity is the domain password (administrators are notified of each such sign-in). Any active session of the employee receives the unlock secret: a stolen session token opens all of that employee’s data.\n\nEmployees created in this mode keep their secret on the server even after you return to the strict mode.',
      confirmStrictHeld:
        'Return to the “Strict” mode?\n\nNew directory employees will get an unlock password again. But the secrets of {n} employees already created in “Simple sign-in” stay on the server: they still sign in without an unlock password, and whoever runs the server and its database can still decrypt their data.',
      confirmStrict: 'Return to the “Strict” mode for new directory employees?',
      saved: 'Saved',
    },
  },
});

const state = ref<{
  mode: Mode;
  mfaRequired: string;
  managedUsers: number;
  canChange: boolean;
} | null>(null);
const error = ref('');
const notice = ref('');
const busy = ref(false);

async function load(): Promise<void> {
  try {
    state.value = await api('GET', '/admin/settings/key-mode');
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
onMounted(load);

const cards = computed(() => [
  { id: 'strict' as const, title: t('strictTitle'), body: t('strictBody'), who: t('strictWho') },
  {
    id: 'managed' as const,
    title: t('managedTitle'),
    body: t('managedBody'),
    who: t('managedWho'),
  },
]);

async function choose(mode: Mode): Promise<void> {
  if (!state.value || mode === state.value.mode) return;
  const ask =
    mode === 'managed'
      ? t('confirmManaged')
      : state.value.managedUsers > 0
        ? t('confirmStrictHeld', { n: state.value.managedUsers })
        : t('confirmStrict');
  if (!window.confirm(ask)) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await api(
      'PUT',
      '/admin/settings',
      mode === 'managed'
        ? { 'security.mfaRequired': 'all', 'security.keyMode': 'managed' }
        : { 'security.keyMode': 'strict' },
    );
    notice.value = t('saved');
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="space-y-3" data-testid="keymode">
    <p v-if="error" class="text-sm text-red-600" role="alert">{{ error }}</p>
    <p
      v-if="notice"
      class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
      role="status"
    >
      {{ notice }}
    </p>
    <template v-if="state">
      <p class="text-sm" data-testid="keymode-status">
        {{ t('now') }}: <strong>{{ t(state.mode) }}</strong> ·
        <span class="text-slate-600 dark:text-slate-300" data-testid="keymode-held">{{
          state.managedUsers ? t('held', { n: state.managedUsers }) : t('heldNone')
        }}</span>
      </p>
      <p v-if="!state.canChange" class="text-sm text-slate-500">{{ t('chiefOnly') }}</p>
      <div class="grid gap-3 md:grid-cols-2">
        <article
          v-for="c in cards"
          :key="c.id"
          class="card flex flex-col gap-2 p-4 text-sm"
          :data-testid="`keymode-card-${c.id}`"
        >
          <h3 class="flex items-center gap-2 font-medium">
            <Icon :name="c.id === 'strict' ? 'lock' : 'key'" class="size-4 opacity-80" />{{
              c.title
            }}
          </h3>
          <p>{{ c.body }}</p>
          <p class="text-slate-600 dark:text-slate-300">{{ c.who }}</p>
          <p class="text-xs text-slate-500">{{ t('scope') }}</p>
          <button
            type="button"
            class="mt-auto self-start"
            :class="state.mode === c.id ? 'btn' : 'btn-primary'"
            :disabled="busy || !state.canChange || state.mode === c.id"
            :data-testid="`keymode-${c.id}`"
            @click="choose(c.id)"
          >
            {{ state.mode === c.id ? t('on') : t('choose') }}
          </button>
        </article>
      </div>
    </template>
  </section>
</template>
