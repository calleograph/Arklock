<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { createHandoff } from '@arklock/crypto';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import InfoHint from '../components/InfoHint.vue';
import PasswordGenerator from '../components/PasswordGenerator.vue';
import { api } from '../services/api';
import { errorMessage, when } from '../services/helpers';

/**
 * «Передача секрета»: пароль или данные для входа одной временной ссылкой. Содержимое шифруется здесь, в браузере;
 * ключ — во фрагменте ссылки (после «#»), сервер его не получает. После последнего открытия, срока или отзыва
 * сервер уничтожает шифртекст и свой ключ. Показать отправленное повторно нельзя: его нет ни у кого, кроме получателя.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      title: 'Передача секрета',
      hint: 'Временный пароль или данные для входа одной ссылкой. Содержимое шифруется в вашем браузере, ключ — только в ссылке. После открытия, по сроку или при отзыве оно уничтожается, повторно его не показать никому.',
      create: 'Новая передача',
      purpose: 'Назначение',
      purposeHint:
        'Видно только вам в списке передач (и хранится на сервере открыто): не пишите сюда сам секрет. Получатель видит назначение внутри секрета.',
      purposePh: 'Например: учётная запись нового сотрудника',
      password: 'Пароль',
      generate: 'Сгенерировать',
      login: 'Логин',
      person: 'Имя пользователя',
      url: 'Адрес сервиса',
      notes: 'Дополнительно',
      notesPh: 'Инструкция, срок смены пароля и т. п.',
      addField: 'Добавить поле',
      fieldName: 'Название поля',
      fieldValue: 'Значение',
      removeField: 'Удалить поле',
      lifetime: 'Срок действия',
      opens: 'Сколько раз можно открыть',
      protect: 'Код для получателя',
      protectHint:
        'Необязательно. Получатель введёт код перед открытием: передайте его другим каналом (звонком, лично). Тогда одной перехваченной ссылки мало.',
      protectPh: 'Не обязательно',
      mailTo: 'Отправить ссылку на почту',
      mailHint:
        'Необязательно. Arklock сам отправит получателю письмо со ссылкой. Ссылка при этом проходит через сервер и почту, поэтому для важного добавьте код и передайте его другим каналом.',
      mailPh: 'адрес получателя',
      mailSend: 'Отправить письмом',
      mailSent: 'Письмо отправлено: {to}',
      mailFailed:
        'Письмо не отправлено. Скопируйте ссылку и передайте её сами или попробуйте позже.',
      mailedTo: 'письмо: {to}',
      submit: 'Создать ссылку',
      empty: 'Заполните хотя бы одно поле с данными: пароль, логин, адрес или текст.',
      ready: 'Ссылка готова',
      readyHint:
        'Передайте ссылку получателю целиком, вместе с частью после «#». Сама ссылка — ключ: Arklock её не хранит и показать снова не сможет.',
      copy: 'Скопировать ссылку',
      copied: 'Скопировано',
      until: 'Действует до {at} · открытий: {n}',
      withCode: 'Получателю нужен код — передайте его отдельно',
      another: 'Ещё одна передача',
      list: 'Мои передачи',
      listHint:
        'Назначение, срок и сколько открытий осталось. Содержимое здесь не показывается: после создания оно есть только у получателя.',
      tabs: {
        active: 'Активные',
        used: 'Использованные',
        expired: 'Истёкшие',
        revoked: 'Отозванные',
      },
      none: 'Нет передач',
      noPurpose: 'Без назначения',
      fromEntry: 'из записи',
      created: 'создана {at}',
      expires: 'до {at}',
      ended: 'срок {at}',
      left: 'осталось открытий: {n} из {max}',
      opened: 'открыта {n} из {max}',
      destroyed: 'содержимое уничтожено',
      revoke: 'Отозвать',
      confirmRevoke: 'Отозвать ссылку «{name}»? Получатель её больше не откроет.',
      refresh: 'Обновить',
      min: '{n} минут',
      hours: '{n} ч',
      days: '{n} сут.',
    },
    en: {
      mailTo: 'Send the link by email',
      mailHint:
        'Optional. Arklock emails the link to the recipient. The link then passes through the server and mail, so for anything important add a code and pass it through another channel.',
      mailPh: 'recipient address',
      mailSend: 'Send by email',
      mailSent: 'Email sent: {to}',
      mailFailed: 'The email was not sent. Copy the link and pass it yourself, or try later.',
      mailedTo: 'emailed: {to}',
      refresh: 'Refresh',
      title: 'Send a secret',
      hint: 'A temporary password or sign-in details in one link. The content is encrypted in your browser and the key is only in the link. After it is opened, when it expires or when you revoke it, the content is destroyed and nobody can show it again.',
      create: 'New transfer',
      purpose: 'Purpose',
      purposeHint:
        'Only you see it in your list (it is stored on the server in plain text): do not put the secret here. The recipient sees the purpose inside the secret.',
      purposePh: 'For example: account for a new employee',
      password: 'Password',
      generate: 'Generate',
      login: 'Login',
      person: 'User name',
      url: 'Service address',
      notes: 'Additional information',
      notesPh: 'Instructions, when to change the password, etc.',
      addField: 'Add a field',
      fieldName: 'Field name',
      fieldValue: 'Value',
      removeField: 'Remove field',
      lifetime: 'Valid for',
      opens: 'How many times it can be opened',
      protect: 'Code for the recipient',
      protectHint:
        'Optional. The recipient enters the code before opening: pass it through another channel (a call, in person). Then an intercepted link alone is not enough.',
      protectPh: 'Optional',
      submit: 'Create link',
      empty: 'Fill in at least one field with data: password, login, address or text.',
      ready: 'The link is ready',
      readyHint:
        'Send the whole link to the recipient, including the part after “#”. The link itself is the key: Arklock does not keep it and cannot show it again.',
      copy: 'Copy link',
      copied: 'Copied',
      until: 'Valid until {at} · opens: {n}',
      withCode: 'The recipient needs the code — send it separately',
      another: 'Another transfer',
      list: 'My transfers',
      listHint:
        'Purpose, validity and opens left. The content is not shown here: after it is created only the recipient has it.',
      tabs: { active: 'Active', used: 'Used', expired: 'Expired', revoked: 'Revoked' },
      none: 'No transfers',
      noPurpose: 'No purpose',
      fromEntry: 'from an entry',
      created: 'created {at}',
      expires: 'until {at}',
      ended: 'ended {at}',
      left: 'opens left: {n} of {max}',
      opened: 'opened {n} of {max}',
      destroyed: 'content destroyed',
      revoke: 'Revoke',
      confirmRevoke: 'Revoke the link “{name}”? The recipient will not be able to open it.',
      min: '{n} minutes',
      hours: '{n} h',
      days: '{n} days',
    },
  },
});
const { t: tg } = useI18n();

const LIFETIMES = [30, 60, 240, 720, 1440, 4320];
const OPENS = [1, 2, 3, 5];
const limits = ref({ maxMinutes: 0, maxViews: 100 });
const lifetimes = computed(() =>
  LIFETIMES.filter((m) => !limits.value.maxMinutes || m <= limits.value.maxMinutes),
);
const opens = computed(() => OPENS.filter((n) => n <= limits.value.maxViews));
const lifetimeLabel = (m: number) =>
  m < 60 ? t('min', { n: m }) : m < 1440 ? t('hours', { n: m / 60 }) : t('days', { n: m / 1440 });

const blank = () => ({
  purpose: '',
  password: '',
  username: '',
  person: '',
  url: '',
  notes: '',
  fields: [] as { name: string; value: string }[],
  minutes: 30,
  views: 1,
  passphrase: '',
  mailTo: '',
});
const form = ref(blank());
const showPw = ref(false);
const showGen = ref(false);
const busy = ref(false);
const error = ref('');
const created = ref<{
  id: string;
  key: string;
  link: string;
  expiresAt: string;
  views: number;
  code: boolean;
} | null>(null);
const mailOn = ref(false);
const mailTo = ref('');
const mailState = ref<{ to: string; sent: boolean } | null>(null);
const mailBusy = ref(false);
const mailError = ref('');
const copied = ref(false);

const hasContent = computed(() => {
  const f = form.value;
  return (
    [f.password, f.username, f.person, f.url, f.notes].some((v) => v.trim()) ||
    f.fields.some((x) => x.value.trim())
  );
});

// подсказка «заполните хотя бы одно поле» исчезает, как только данные появились
watch(
  () => hasContent.value,
  (v) => {
    if (v && error.value === t('empty')) error.value = '';
  },
);
async function submit(): Promise<void> {
  error.value = '';
  if (!hasContent.value) {
    error.value = t('empty');
    return;
  }
  busy.value = true;
  const f = form.value;
  const id = crypto.randomUUID();
  try {
    const pkg = await createHandoff(
      id,
      {
        title: f.purpose.trim(),
        person: f.person.trim(),
        username: f.username.trim(),
        password: f.password,
        url: f.url.trim(),
        notes: f.notes,
        fields: f.fields
          .filter((x) => x.value.trim())
          .map((x) => ({ name: x.name.trim(), value: x.value })),
      },
      f.passphrase || undefined,
    );
    await api('POST', '/handoffs', {
      id,
      label: f.purpose.trim().slice(0, 100),
      ciphertext: pkg.ciphertext,
      hasPassphrase: !!f.passphrase,
      expiresInMinutes: f.minutes,
      maxViews: f.views,
      kind: 'secret',
    });
    created.value = {
      id,
      key: pkg.fragment,
      link: `${location.origin}/h/${id}#${pkg.fragment}`,
      expiresAt: new Date(Date.now() + f.minutes * 60_000).toISOString(),
      views: f.views,
      code: !!f.passphrase,
    };
    // введённое больше не нужно этой странице: секрет теперь есть только в ссылке
    form.value = { ...blank(), minutes: f.minutes, views: f.views };
    showPw.value = false;
    showGen.value = false;
    mailTo.value = f.mailTo.trim();
    mailState.value = null;
    mailError.value = '';
    if (mailOn.value && mailTo.value) await sendMail();
    else await load();
  } catch (e) {
    error.value = errorMessage(e, tg);
  } finally {
    busy.value = false;
  }
}
async function copyLink(): Promise<void> {
  if (!created.value) return;
  await navigator.clipboard.writeText(created.value.link).catch(() => undefined);
  copied.value = true;
  setTimeout(() => (copied.value = false), 2000);
}
/** Письмо получателю от сервиса: сервер собирает ссылку из своего публичного адреса и ключа, ключ не сохраняет. */
async function sendMail(): Promise<void> {
  if (!created.value || !mailTo.value.trim()) return;
  mailBusy.value = true;
  mailError.value = '';
  const to = mailTo.value.trim();
  try {
    const r = await api<{ sent: boolean }>('POST', `/handoffs/${created.value.id}/mail`, {
      to,
      key: created.value.key,
    });
    mailState.value = { to, sent: r.sent };
  } catch (e) {
    mailError.value = errorMessage(e, tg);
  } finally {
    mailBusy.value = false;
  }
  await load();
}
function another(): void {
  created.value = null;
  copied.value = false;
  mailState.value = null;
  mailError.value = '';
  void load();
}

// ---- список
interface Row {
  id: string;
  label: string;
  kind: 'entry' | 'secret';
  hasPassphrase: boolean;
  createdAt: string;
  expiresAt: string;
  maxViews: number;
  views: number;
  destroyed: boolean;
  mailedTo: string | null;
  status: 'active' | 'used' | 'expired' | 'revoked';
}
const tabs = ['active', 'used', 'expired', 'revoked'] as const;
const tab = ref<(typeof tabs)[number]>('active');
const rows = ref<Row[]>([]);
const shown = computed(() => rows.value.filter((r) => r.status === tab.value));
const count = (s: (typeof tabs)[number]) => rows.value.filter((r) => r.status === s).length;
const listError = ref('');
async function load(): Promise<void> {
  listError.value = '';
  try {
    rows.value = await api<Row[]>('GET', '/handoffs');
  } catch (e) {
    listError.value = errorMessage(e, tg);
  }
}
async function revoke(r: Row): Promise<void> {
  if (!window.confirm(t('confirmRevoke', { name: r.label || t('noPurpose') }))) return;
  try {
    await api('DELETE', `/handoffs/${r.id}`);
    await load();
  } catch (e) {
    listError.value = errorMessage(e, tg);
  }
}
onMounted(async () => {
  const policy = await api<Record<string, unknown>>('GET', '/auth/policy').catch(
    (): Record<string, unknown> => ({}),
  );
  limits.value = {
    maxMinutes: Number(policy['links.maxMinutes'] ?? 0) || 0,
    maxViews: Number(policy['links.maxViews'] ?? 100) || 100,
  };
  mailOn.value = policy['links.mail'] === true;
  if (!lifetimes.value.includes(form.value.minutes))
    form.value.minutes = lifetimes.value.at(-1) ?? limits.value.maxMinutes;
  await load();
});
</script>

<template>
  <section class="mx-auto max-w-4xl space-y-4" data-testid="send-secret-page">
    <header class="flex min-h-11 items-center gap-1">
      <h1>{{ t('title') }}</h1>
      <InfoHint :text="t('hint')" />
    </header>

    <!-- готовая ссылка -->
    <div v-if="created" class="card space-y-3 p-4" data-testid="send-ready" role="status">
      <h2 class="flex items-center gap-1 font-medium">
        <Icon name="check" class="text-emerald-600" /> {{ t('ready')
        }}<InfoHint :text="t('readyHint')" />
      </h2>
      <div class="flex flex-wrap gap-2">
        <input
          :value="created.link"
          readonly
          class="input min-w-0 flex-1 font-mono text-sm"
          :aria-label="t('ready')"
          data-testid="send-link"
          @focus="($event.target as HTMLInputElement).select()"
        />
        <button type="button" class="btn-primary" data-testid="send-copy" @click="copyLink">
          <Icon name="copy" /> {{ copied ? t('copied') : t('copy') }}
        </button>
      </div>
      <form v-if="mailOn" class="flex flex-wrap gap-2" @submit.prevent="sendMail">
        <input
          v-model="mailTo"
          type="email"
          class="input min-w-0 flex-1"
          :placeholder="t('mailPh')"
          :aria-label="t('mailTo')"
          data-testid="send-mail-to"
        />
        <button
          type="submit"
          class="btn"
          :disabled="mailBusy || !mailTo.trim()"
          data-testid="send-mail"
        >
          <Icon name="mail" /> {{ t('mailSend') }}
        </button>
      </form>
      <p
        v-if="mailState"
        class="text-sm"
        :class="mailState.sent ? 'text-emerald-700 dark:text-emerald-400' : 'field-error'"
        data-testid="send-mail-state"
      >
        {{ mailState.sent ? t('mailSent', { to: mailState.to }) : t('mailFailed') }}
      </p>
      <p v-if="mailError" class="field-error" role="alert">{{ mailError }}</p>
      <p class="text-sm text-slate-600 dark:text-slate-300">
        {{ t('until', { at: when(created.expiresAt), n: created.views }) }}
        <template v-if="created.code"> · {{ t('withCode') }}</template>
      </p>
      <button type="button" class="btn" data-testid="send-another" @click="another">
        <Icon name="plus" /> {{ t('another') }}
      </button>
    </div>

    <!-- форма -->
    <form
      v-else
      class="card p-4"
      autocomplete="off"
      :aria-label="t('create')"
      data-testid="send-form"
      @submit.prevent="submit"
    >
      <div class="form-grid">
        <label class="block span-2">
          <span class="inline-flex items-center gap-1"
            >{{ t('purpose') }}<InfoHint :text="t('purposeHint')"
          /></span>
          <input
            v-model="form.purpose"
            class="input"
            maxlength="100"
            :placeholder="t('purposePh')"
            data-testid="send-purpose"
          />
        </label>
        <label class="block">
          {{ t('password') }}
          <span class="relative mt-1 block">
            <input
              v-model="form.password"
              :type="showPw ? 'text' : 'password'"
              autocomplete="new-password"
              class="input pr-24 font-mono"
              data-testid="send-password"
            />
            <span class="absolute inset-y-0 right-0 flex items-center">
              <IconButton
                :icon="showPw ? 'eye-off' : 'eye'"
                :label="showPw ? tg('common.hide') : tg('common.show')"
                @click="showPw = !showPw"
              />
              <IconButton
                icon="dice"
                :label="t('generate')"
                data-testid="send-generate"
                @click="showGen = !showGen"
              />
            </span>
          </span>
        </label>
        <label class="block">
          {{ t('login') }}
          <input v-model="form.username" class="input" data-testid="send-login" />
        </label>
        <PasswordGenerator
          v-if="showGen"
          class="span-2"
          :min-length="16"
          @use="(v: string) => ((form.password = v), (showPw = true), (showGen = false))"
        />
        <label class="block">
          {{ t('person') }}
          <input v-model="form.person" class="input" data-testid="send-person" />
        </label>
        <label class="block">
          {{ t('url') }}
          <input v-model="form.url" class="input" inputmode="url" data-testid="send-url" />
        </label>
        <label class="block span-2">
          {{ t('notes') }}
          <textarea
            v-model="form.notes"
            rows="2"
            class="input"
            :placeholder="t('notesPh')"
            data-testid="send-notes"
          />
        </label>
        <template v-for="(f, i) in form.fields" :key="i">
          <label class="block">
            {{ t('fieldName') }}
            <input v-model="f.name" class="input" :data-testid="`send-field-name-${i}`" />
          </label>
          <label class="block">
            {{ t('fieldValue') }}
            <span class="relative mt-1 block">
              <input v-model="f.value" class="input pr-12" :data-testid="`send-field-value-${i}`" />
              <span class="absolute inset-y-0 right-0 flex items-center">
                <IconButton
                  icon="trash"
                  :label="`${t('removeField')}: ${f.name || i + 1}`"
                  @click="form.fields.splice(i, 1)"
                />
              </span>
            </span>
          </label>
        </template>
        <div class="btn-row">
          <button
            type="button"
            class="btn"
            data-testid="send-add-field"
            @click="form.fields.push({ name: '', value: '' })"
          >
            <Icon name="plus" /> {{ t('addField') }}
          </button>
        </div>
        <hr class="border-slate-200 dark:border-slate-800" />
        <label class="block">
          {{ t('lifetime') }}
          <select v-model.number="form.minutes" class="input" data-testid="send-lifetime">
            <option v-for="m in lifetimes" :key="m" :value="m">{{ lifetimeLabel(m) }}</option>
          </select>
        </label>
        <label class="block">
          {{ t('opens') }}
          <select v-model.number="form.views" class="input" data-testid="send-opens">
            <option v-for="n in opens" :key="n" :value="n">{{ n }}</option>
          </select>
        </label>
        <label class="block">
          <span class="inline-flex items-center gap-1"
            >{{ t('protect') }}<InfoHint :text="t('protectHint')"
          /></span>
          <input
            v-model="form.passphrase"
            type="text"
            autocomplete="off"
            class="input"
            :placeholder="t('protectPh')"
            data-testid="send-code"
          />
        </label>
        <label v-if="mailOn" class="block">
          <span class="inline-flex items-center gap-1"
            >{{ t('mailTo') }}<InfoHint :text="t('mailHint')"
          /></span>
          <input
            v-model="form.mailTo"
            type="email"
            class="input"
            :placeholder="t('mailPh')"
            data-testid="send-email"
          />
        </label>
        <p v-if="error" class="field-error" role="alert" data-testid="send-error">{{ error }}</p>
        <div class="btn-row">
          <button type="submit" class="btn-primary" :disabled="busy" data-testid="send-submit">
            <Icon :name="mailOn && form.mailTo.trim() ? 'mail' : 'share'" /> {{ t('submit') }}
          </button>
        </div>
      </div>
    </form>

    <!-- список -->
    <div class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <div class="mr-auto flex items-center gap-1">
          <h2 class="flex items-center gap-1 font-medium">
            {{ t('list') }}<InfoHint :text="t('listHint')" />
          </h2>
          <IconButton icon="sync" :label="t('refresh')" data-testid="send-refresh" @click="load" />
        </div>
        <div class="flex flex-wrap gap-2" role="tablist">
          <button
            v-for="s in tabs"
            :key="s"
            type="button"
            role="tab"
            class="btn"
            :class="tab === s ? 'btn-primary' : ''"
            :aria-selected="tab === s"
            :data-testid="`send-tab-${s}`"
            @click="tab = s"
          >
            {{ t(`tabs.${s}`) }} · {{ count(s) }}
          </button>
        </div>
      </div>
      <p v-if="listError" class="field-error" role="alert">{{ listError }}</p>
      <ul
        class="card divide-y divide-slate-200 text-sm dark:divide-slate-800"
        data-testid="send-list"
      >
        <li
          v-for="r in shown"
          :key="r.id"
          class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
          data-testid="send-row"
        >
          <div class="min-w-0 flex-1 space-y-1">
            <div class="break-words font-medium">
              {{ r.label || t('noPurpose') }}
              <span v-if="r.kind === 'entry'" class="badge ml-1">{{ t('fromEntry') }}</span>
              <span v-if="r.hasPassphrase" class="badge ml-1">{{ t('protect') }}</span>
            </div>
            <div class="break-words text-xs text-slate-500">
              {{ t('created', { at: when(r.createdAt) }) }} ·
              {{
                r.status === 'active'
                  ? t('expires', { at: when(r.expiresAt) })
                  : t('ended', { at: when(r.expiresAt) })
              }}
              ·
              {{
                r.status === 'active'
                  ? t('left', { n: r.maxViews - r.views, max: r.maxViews })
                  : t('opened', { n: r.views, max: r.maxViews })
              }}
              <template v-if="r.mailedTo"> · {{ t('mailedTo', { to: r.mailedTo }) }}</template>
              <template v-if="r.status !== 'active' && r.destroyed">
                · {{ t('destroyed') }}</template
              >
            </div>
          </div>
          <button
            v-if="r.status === 'active'"
            type="button"
            class="btn"
            :data-testid="`send-revoke-${r.label}`"
            @click="revoke(r)"
          >
            {{ t('revoke') }}
          </button>
        </li>
        <li v-if="!shown.length" class="px-4 py-3 text-slate-500" data-testid="send-none">
          {{ t('none') }}
        </li>
      </ul>
    </div>
  </section>
</template>
