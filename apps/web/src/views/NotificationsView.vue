<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../services/api';
import { errorMessage, when } from '../services/helpers';
import {
  unreadNotifications,
  setNotificationCount,
  type NotificationList,
  type NotificationRow,
} from '../services/notifications';
import { useWorkspaceStore } from '../stores/workspace';
import NotificationPreferences from '../components/NotificationPreferences.vue';
const { t, te } = useI18n();
const router = useRouter();
const ws = useWorkspaceStore();
const views = ['inbox', 'unread', 'archived'] as const;
const view = ref<(typeof views)[number]>('inbox');
const rows = ref<NotificationRow[]>([]);
const next = ref<number | null>(null);
const busy = ref(false);
const loaded = ref(false);
const error = ref('');
function message(row: NotificationRow): string {
  const key = `notifications.events.${row.event.replaceAll('.', '_').replaceAll('-', '_')}`;
  return te(key) ? t(key) : t('notifications.event');
}
async function load(more = false): Promise<void> {
  busy.value = true;
  error.value = '';
  const selected = view.value;
  try {
    const result = await api<NotificationList>(
      'GET',
      `/notifications?view=${selected}${more && next.value ? `&before=${next.value}` : ''}`,
    );
    if (selected !== view.value) return;
    rows.value = more ? [...rows.value, ...result.items] : result.items;
    next.value = result.next;
    setNotificationCount(result.unread);
    loaded.value = true;
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
onMounted(() => load());
watch(view, () => {
  rows.value = [];
  loaded.value = false;
  void load();
});
async function change(
  row: NotificationRow,
  body: { read?: boolean; archived?: boolean },
): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api('PATCH', `/notifications/${row.id}`, body);
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
async function bulk(action: 'read-all' | 'archive-all'): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api('POST', `/notifications/${action}`, {});
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
async function open(row: NotificationRow): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const destination = await api<{ path: string; vaultId?: string }>(
      'GET',
      `/notifications/${row.id}/destination`,
    );
    await api('PATCH', `/notifications/${row.id}`, { read: true });
    if (!row.readAt && !row.archivedAt)
      setNotificationCount(Math.max(0, unreadNotifications.value - 1));
    if (destination.vaultId) {
      await ws.loadVaults();
      if (ws.vaults.some((v) => v.id === destination.vaultId)) await ws.select(destination.vaultId);
    }
    await router.push(destination.path);
  } catch (e) {
    error.value =
      e instanceof ApiError && e.code === 'notification_target_unavailable'
        ? t('notifications.unavailable')
        : errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
const vaultName = (row: NotificationRow) =>
  row.vaultId ? ws.vaults.find((v) => v.id === row.vaultId)?.name : '';
</script>
<template>
  <section class="mx-auto max-w-4xl space-y-5" data-testid="notifications-page">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1>{{ t('notifications.title') }}</h1>
        <p class="mt-1 text-sm text-slate-500">{{ t('notifications.hint') }}</p>
      </div>
      <button class="btn" type="button" :disabled="busy" @click="load()">
        {{ t('entryPanel.refresh') }}
      </button>
    </header>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap gap-2">
        <button
          v-for="value in views"
          :key="value"
          type="button"
          :class="view === value ? 'btn-primary' : 'btn'"
          :aria-pressed="view === value"
          :disabled="busy"
          :data-testid="`notifications-view-${value}`"
          @click="view = value"
        >
          {{ t(`notifications.views.${value}`) }}
        </button>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          class="btn"
          type="button"
          :disabled="busy || !unreadNotifications"
          data-testid="notifications-read-all"
          @click="bulk('read-all')"
        >
          {{ t('notifications.readAll') }}</button
        ><button
          class="btn"
          type="button"
          :disabled="busy || view === 'archived' || !rows.length"
          @click="bulk('archive-all')"
        >
          {{ t('notifications.archiveAll') }}
        </button>
      </div>
    </div>
    <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
    <p v-if="busy && !loaded" class="text-sm text-slate-500">{{ t('common.working') }}</p>
    <p v-else-if="loaded && !rows.length" class="card p-5 text-sm text-slate-500">
      {{ t('notifications.empty') }}
    </p>
    <ol class="space-y-2">
      <li
        v-for="row in rows"
        :key="row.id"
        class="card p-4"
        :class="!row.readAt ? 'border-l-4 border-l-brand-500' : ''"
        data-testid="notification-row"
      >
        <div class="flex flex-wrap justify-between gap-2">
          <p class="font-medium">{{ message(row) }}</p>
          <time :datetime="row.createdAt" class="text-xs text-slate-500">{{
            when(row.createdAt)
          }}</time>
        </div>
        <p class="mt-1 text-xs text-slate-500">
          {{ t(`notifications.categories.${row.category}`)
          }}<span v-if="vaultName(row)"> · {{ vaultName(row) }}</span
          ><span v-if="!row.readAt"> · {{ t('notifications.new') }}</span>
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            v-if="row.resourceType !== 'handoff' && row.resourceType !== 'circle'"
            class="btn"
            type="button"
            :disabled="busy"
            data-testid="notification-open"
            @click="open(row)"
          >
            {{ t('notifications.open') }}</button
          ><button
            class="btn"
            type="button"
            :disabled="busy"
            data-testid="notification-read"
            @click="change(row, { read: !row.readAt })"
          >
            {{ t(row.readAt ? 'notifications.markUnread' : 'notifications.markRead') }}</button
          ><button
            class="btn"
            type="button"
            :disabled="busy"
            data-testid="notification-archive"
            @click="change(row, { archived: !row.archivedAt })"
          >
            {{ t(row.archivedAt ? 'notifications.restore' : 'notifications.archive') }}
          </button>
        </div>
      </li>
    </ol>
    <button v-if="next" class="btn" type="button" :disabled="busy" @click="load(true)">
      {{ t('notifications.more') }}
    </button>
    <NotificationPreferences />
  </section>
</template>
