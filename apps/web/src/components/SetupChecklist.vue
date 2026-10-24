<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';

/**
 * «Начало работы» для нового администратора: что настроено, что нет и куда нажать. Состояние берётся из настроек,
 * поэтому список не нужно вести вручную; когда всё сделано (или администратор скрыл список), блок исчезает.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      title: 'Начало работы',
      hint: 'Шесть шагов от установки до первых сотрудников. Отмечено то, что уже сделано.',
      url: 'Публичный HTTPS-адрес',
      urlHint: 'Без HTTPS браузер не даёт шифровать — по адресу локальной сети вход не заработает.',
      mail: 'Почта для приглашений и уведомлений',
      backup: 'Первая резервная копия',
      dept: 'Подразделения (группа, пространство, сейф)',
      people: 'Сотрудники',
      mfa: 'Второй фактор для администраторов',
      open: 'Открыть',
      hide: 'Скрыть',
      done: 'Готово',
      left: 'Осталось шагов: {n}',
    },
    en: {
      title: 'Getting started',
      hint: 'Six steps from installation to your first employees. Finished steps are checked.',
      url: 'Public HTTPS address',
      urlHint:
        'Without HTTPS the browser will not allow encryption — sign-in will not work on a LAN address.',
      mail: 'Mail for invitations and notifications',
      backup: 'First backup',
      dept: 'Departments (group, space, vault)',
      people: 'Employees',
      mfa: 'Second factor for administrators',
      open: 'Open',
      hide: 'Hide',
      done: 'Done',
      left: 'Steps left: {n}',
    },
  },
});
const KEY = 'arklock.setup.hidden';
const hidden = ref(false);
try {
  hidden.value = localStorage.getItem(KEY) === '1';
} catch {
  /* хранилище недоступно — блок просто показывается */
}
const state = ref<Record<string, boolean> | null>(null);

onMounted(async () => {
  if (hidden.value) return;
  const ok = async <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
  const [net, smtp, backups, spaces, users, invitations, settings] = await Promise.all([
    ok(api<{ publicUrl: { https: boolean } }>('GET', '/admin/network')),
    ok(api<{ configured: boolean }>('GET', '/admin/smtp')),
    ok(api<{ backups: { items: unknown[] } | null }>('GET', '/admin/backups')),
    ok(api<{ isDefault: boolean }[]>('GET', '/spaces')),
    ok(api<unknown[]>('GET', '/admin/users')),
    ok(api<unknown[]>('GET', '/admin/invitations')),
    ok(api<Record<string, unknown>>('GET', '/admin/settings')),
  ]);
  state.value = {
    url: !!net?.publicUrl.https,
    mail: !!smtp?.configured,
    backup: (backups?.backups?.items.length ?? 0) > 0,
    dept: (spaces ?? []).some((s) => !s.isDefault),
    people: (users?.length ?? 0) > 1 || (invitations?.length ?? 0) > 0,
    mfa:
      settings?.['security.mfaRequired'] !== undefined &&
      settings['security.mfaRequired'] !== 'off',
  };
});

const steps = [
  { id: 'url', to: '/admin/settings?section=network', hint: true },
  { id: 'mail', to: '/admin/smtp' },
  { id: 'backup', to: '/admin/backups' },
  { id: 'dept', to: '/admin/departments' },
  { id: 'people', to: '/admin/invitations' },
  { id: 'mfa', to: '/admin/settings?section=security' },
] as const;
const left = computed(() => steps.filter((s) => !state.value?.[s.id]).length);
const show = computed(() => !hidden.value && state.value !== null && left.value > 0);
function hide(): void {
  hidden.value = true;
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* не критично */
  }
}
</script>

<template>
  <section v-if="show" class="card space-y-2 p-4 text-sm" data-testid="setup-checklist">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 class="font-medium">{{ t('title') }}</h2>
        <p class="text-xs text-slate-500">{{ t('hint') }} {{ t('left', { n: left }) }}</p>
      </div>
      <button type="button" class="btn-ghost text-xs" data-testid="setup-hide" @click="hide">
        {{ t('hide') }}
      </button>
    </div>
    <ul class="divide-y divide-slate-200 dark:divide-slate-800">
      <li
        v-for="s in steps"
        :key="s.id"
        class="flex flex-wrap items-center justify-between gap-2 py-1.5"
        :data-testid="`setup-${s.id}`"
        :data-done="state?.[s.id] ? '1' : '0'"
      >
        <span class="min-w-0">
          <span :class="state?.[s.id] ? 'text-emerald-600' : 'text-slate-400'" aria-hidden="true">{{
            state?.[s.id] ? '✓' : '○'
          }}</span>
          <span class="sr-only">{{ state?.[s.id] ? t('done') : '' }}</span>
          {{ t(s.id) }}
          <span v-if="'hint' in s && !state?.[s.id]" class="block pl-5 text-xs text-slate-500">{{
            t('urlHint')
          }}</span>
        </span>
        <RouterLink v-if="!state?.[s.id]" :to="s.to" class="btn text-xs">{{
          t('open')
        }}</RouterLink>
      </li>
    </ul>
  </section>
</template>
