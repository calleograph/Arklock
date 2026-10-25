<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import Icon from './Icon.vue';
import {
  refreshNotificationCount,
  setNotificationCount,
  unreadNotifications,
} from '../services/notifications';
const { t } = useI18n();
const route = useRoute();
function refresh(): void {
  if (document.visibilityState === 'visible')
    void refreshNotificationCount().catch(() => undefined);
}
watch(() => route.fullPath, refresh);
onMounted(() => {
  refresh();
  window.addEventListener('focus', refresh);
});
onBeforeUnmount(() => {
  setNotificationCount(0);
  window.removeEventListener('focus', refresh);
});
</script>
<template>
  <RouterLink
    to="/notifications"
    class="btn-ghost relative"
    :aria-label="t('notifications.bell', { n: unreadNotifications })"
    data-testid="notification-bell"
  >
    <Icon name="bell" class="size-4" />
    <span
      v-if="unreadNotifications"
      class="absolute -right-1 -top-1 min-w-4 rounded-full bg-red-600 px-1 text-center text-xs font-semibold leading-4 text-white"
      data-testid="notification-unread"
      >{{ unreadNotifications > 99 ? '99+' : unreadNotifications }}</span
    >
  </RouterLink>
</template>
