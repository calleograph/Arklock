<script setup lang="ts">
import { computed, ref } from 'vue';
import { email as emailSchema } from '@arklock/contracts';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../services/api';
import { errorMessage } from '../services/helpers';
import { parseCsv } from '../services/transfer';
import InfoHint from './InfoHint.vue';

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
      hint: 'По строке: «Имя; почта; группа». Группа необязательна — это название группы (подразделения), в которую сотрудник попадёт после активации; несколько групп разделяются знаком «|». Либо загрузите файл CSV.',
      file: 'Загрузить CSV',
      sample: 'Скачать пример CSV',
      fileHelp:
        'Файл UTF-8; обязательный столбец email; имя — из столбцов name или first_name и last_name; группы — из столбцов groups и department. Столбец username не используется: входом служит почта. Пароли в файле не нужны — сотрудник задаёт свой при активации.',
      noEmailColumn: 'В файле нет столбца email в первой строке.',
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
      hint: 'One per line: “Name; email; group”. The group is optional — the name of the group (department) the person joins after activation; separate several groups with “|”. Or upload a CSV file.',
      file: 'Upload CSV',
      sample: 'Download sample CSV',
      fileHelp:
        'UTF-8 file; the email column is required; the name comes from name or first_name and last_name; groups come from groups and department. The username column is not used: the email is the sign-in. No passwords belong in the file — each person sets their own on activation.',
      noEmailColumn: 'The first row of the file has no email column.',
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
      const names = group
        .split('|')
        .map((x) => x.trim())
        .filter(Boolean);
      const found = names.map((n) =>
        props.circles.find((c) => c.name.toLowerCase() === n.toLowerCase()),
      );
      const key = mail.toLowerCase();
      const problems = [
        !name && t('noName'),
        !emailSchema.safeParse(mail).success && t('badEmail'),
        found.some((c) => !c) && t('unknownGroup'),
        seen.has(key) && t('dup'),
      ].filter(Boolean) as string[];
      seen.add(key);
      return {
        name,
        mail,
        group: names.join(' | '),
        circleIds: found.filter((c): c is { id: string; name: string } => !!c).map((c) => c.id),
        problems,
      };
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
        circleIds: r.circleIds,
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

const HEADER = /^(email|e-?mail|почта)$/i;
/** CSV → строки «Имя; почта; группы»: столбцы определяются по заголовкам, лишнее (username и т. п.) игнорируется. */
async function onFile(ev: Event): Promise<void> {
  error.value = '';
  const f = (ev.target as HTMLInputElement).files?.[0];
  (ev.target as HTMLInputElement).value = '';
  if (!f) return;
  const grid = parseCsv(await f.text());
  const head = (grid[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const mailAt = head.findIndex((h) => HEADER.test(h));
  if (mailAt < 0) {
    error.value = t('noEmailColumn');
    return;
  }
  const nameAt = col('name', 'display_name', 'displayname', 'имя', 'фио');
  const firstAt = col('first_name', 'firstname');
  const lastAt = col('last_name', 'lastname');
  const userAt = col('username', 'login');
  const groupAt = col('groups', 'group', 'группы', 'группа');
  const deptAt = col('department', 'подразделение');
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  text.value = grid
    .slice(1)
    .map((r) => {
      const name =
        cell(r, nameAt) || `${cell(r, firstAt)} ${cell(r, lastAt)}`.trim() || cell(r, userAt);
      const groups = [
        ...new Set(
          [...cell(r, deptAt).split(/[|;]/), ...cell(r, groupAt).split(/[|;]/)]
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      ];
      return [name, cell(r, mailAt), groups.join(' | ')].join('; ');
    })
    .join('\n');
}

function downloadSample(): void {
  const csv =
    '\ufeffusername,first_name,last_name,email,department,groups\r\n' +
    'ivanov,Иван,Иванов,ivanov@example.com,ИТ,IT\r\n' +
    'petrova,Анна,Петрова,petrova@example.com,Маркетинг,Marketing\r\n' +
    'sidorov,Пётр,Сидоров,sidorov@example.com,Бухгалтерия,\r\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'arklock-users-sample.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
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
      <div class="flex flex-wrap items-center gap-2">
        <label class="btn cursor-pointer"
          >{{ t('file') }}
          <input
            type="file"
            accept=".csv,.txt"
            class="sr-only"
            data-testid="bulk-invite-file"
            @change="onFile"
        /></label>
        <button type="button" class="btn" data-testid="bulk-invite-sample" @click="downloadSample">
          {{ t('sample') }}
        </button>
        <InfoHint :text="t('fileHelp')" />
      </div>
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
      <p v-if="error" class="text-red-600" role="alert" data-testid="bulk-invite-error">
        {{ error }}
      </p>
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
