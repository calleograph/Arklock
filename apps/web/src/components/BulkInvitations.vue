<script setup lang="ts">
import { computed, ref } from 'vue';
import { email as emailSchema } from '@arklock/contracts';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../services/api';
import { errorMessage } from '../services/helpers';

/**
 * Приглашения списком: «Имя; почта; группа» по строке. Предпросмотр до отправки, коды активации — один раз
 * в таблице результата и в файле CSV (на сервере они не хранятся в открытом виде).
 */
const props = defineProps<{ circles: { id: string; name: string }[] }>();
const emit = defineEmits<{ created: [] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      title: 'Пригласить списком',
      hint: 'По строке: «Имя; почта; группа». Группа необязательна — это название группы (подразделения), в которую сотрудник попадёт после активации.',
      days: 'Срок кода, дней',
      go: 'Создать приглашения',
      working: 'Создаю…',
      colName: 'Имя',
      colEmail: 'Почта',
      colGroup: 'Группа',
      colState: 'Результат',
      colCode: 'Код активации',
      noGroup: 'нет',
      badEmail: 'неверная почта',
      unknownGroup: 'группа не найдена',
      dup: 'повтор в списке',
      noName: 'нет имени',
      exists: 'уже есть',
      done: 'создано',
      once: 'Коды показываются один раз — сохраните файл или передайте их сотрудникам.',
      csv: 'Скачать CSV',
      problems: 'Исправьте строки с ошибками — создание отключено.',
    },
    en: {
      title: 'Invite from a list',
      hint: 'One per line: “Name; email; group”. The group is optional — the name of the group (department) the person joins after activation.',
      days: 'Code lifetime, days',
      go: 'Create invitations',
      working: 'Creating…',
      colName: 'Name',
      colEmail: 'Email',
      colGroup: 'Group',
      colState: 'Result',
      colCode: 'Activation code',
      noGroup: 'none',
      badEmail: 'invalid email',
      unknownGroup: 'group not found',
      dup: 'duplicate in the list',
      noName: 'no name',
      exists: 'already exists',
      done: 'created',
      once: 'Codes are shown once — save the file or hand them to the employees.',
      csv: 'Download CSV',
      problems: 'Fix the rows with errors — creation is disabled.',
    },
  },
});

const text = ref('');
const days = ref(7);
const busy = ref(false);
const error = ref('');
const results = ref<Record<string, { state: string; code?: string }>>({});

const rows = computed(() => {
  const seen = new Set<string>();
  return text.value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name = '', mail = '', group = ''] = l.split(/[;\t]/).map((x) => x.trim());
      const circle = group
        ? props.circles.find((c) => c.name.toLowerCase() === group.toLowerCase())
        : undefined;
      const key = mail.toLowerCase();
      const problems = [
        !name && t('noName'),
        !emailSchema.safeParse(mail).success && t('badEmail'),
        group && !circle && t('unknownGroup'),
        seen.has(key) && t('dup'),
      ].filter(Boolean) as string[];
      seen.add(key);
      return { name, mail, group, circleId: circle?.id, problems };
    });
});
const ready = computed(() => rows.value.length > 0 && rows.value.every((r) => !r.problems.length));
const finished = computed(() => Object.keys(results.value).length > 0 && !busy.value);

async function create(): Promise<void> {
  if (!ready.value || busy.value) return;
  busy.value = true;
  error.value = '';
  results.value = {};
  for (const r of rows.value) {
    try {
      const res = await api<{ code: string }>('POST', '/admin/invitations', {
        email: r.mail,
        displayName: r.name,
        role: 'member',
        expiresInDays: Number(days.value),
        sendEmail: false,
        circleIds: r.circleId ? [r.circleId] : [],
      });
      results.value[r.mail] = { state: t('done'), code: res.code };
    } catch (e) {
      results.value[r.mail] = {
        state:
          e instanceof ApiError && e.code === 'already_exists' ? t('exists') : errorMessage(e, t),
      };
    }
  }
  busy.value = false;
  emit('created');
}

function download(): void {
  const esc = (v: string) => `"${v.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
  const lines = [
    ['name', 'email', 'group', 'code'].join(','),
    ...rows.value.map((r) =>
      [r.name, r.mail, r.group, results.value[r.mail]?.code ?? ''].map(esc).join(','),
    ),
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'arklock-invitations.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
</script>

<template>
  <details class="card max-w-3xl p-4 text-sm">
    <summary class="cursor-pointer font-medium" data-testid="bulk-invite">{{ t('title') }}</summary>
    <div class="mt-3 space-y-3">
      <p class="max-w-prose text-xs text-slate-500">{{ t('hint') }}</p>
      <textarea
        v-model="text"
        rows="6"
        class="input font-mono"
        spellcheck="false"
        data-testid="bulk-invite-text"
      ></textarea>
      <label class="inline-flex items-center gap-2"
        >{{ t('days') }}
        <input v-model.number="days" type="number" min="1" max="60" class="input w-20"
      /></label>
      <div
        v-if="rows.length"
        class="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-700"
      >
        <table class="min-w-full text-xs" data-testid="bulk-invite-table">
          <thead class="text-left text-slate-500">
            <tr>
              <th class="px-2 py-1">{{ t('colName') }}</th>
              <th>{{ t('colEmail') }}</th>
              <th>{{ t('colGroup') }}</th>
              <th>{{ t('colState') }}</th>
              <th v-if="finished">{{ t('colCode') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in rows"
              :key="r.mail + r.name"
              class="border-t border-slate-200 dark:border-slate-800"
              data-testid="bulk-invite-row"
            >
              <td class="px-2 py-1">{{ r.name }}</td>
              <td>{{ r.mail }}</td>
              <td>{{ r.group || t('noGroup') }}</td>
              <td data-testid="bulk-invite-state">
                <span v-if="r.problems.length" class="text-red-600">{{
                  r.problems.join('; ')
                }}</span>
                <span v-else>{{ results[r.mail]?.state ?? '' }}</span>
              </td>
              <td v-if="finished" class="font-mono">{{ results[r.mail]?.code ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="rows.length && !ready" class="text-xs text-red-600">{{ t('problems') }}</p>
      <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="btn-primary"
          :disabled="!ready || busy"
          data-testid="bulk-invite-go"
          @click="create"
        >
          {{ busy ? t('working') : t('go') }}
        </button>
        <template v-if="finished">
          <button type="button" class="btn" data-testid="bulk-invite-csv" @click="download">
            {{ t('csv') }}
          </button>
          <span class="text-xs text-slate-500">{{ t('once') }}</span>
        </template>
      </div>
    </div>
  </details>
</template>
