<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { errorMessage } from '../services/helpers';
import { useAuthStore } from '../stores/auth';
import { useWorkspaceStore } from '../stores/workspace';

/**
 * Создание персонального корпоративного сейфа. Условия показываются до создания: кто получит доступ и с какой ролью.
 * Это не приватный сейф: организация объявила, что к нему имеют доступ группы-хранители.
 */
const emit = defineEmits<{ close: []; done: [] }>();
const { t } = useI18n();
const ws = useWorkspaceStore();
const auth = useAuthStore();
const understood = ref(false);
const busy = ref(false);
const error = ref('');

async function create(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const name = `${t('managed.prefix')} · ${auth.user?.displayName || auth.user?.email}`;
    const id = await ws.createVault(name, { managed: true });
    // ключ хранителям выдаёт клиент владельца
    await ws.distributePending(id).catch(() => 0);
    emit('done');
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    :aria-label="t('managed.title')"
  >
    <div
      class="card max-h-[90vh] w-full max-w-lg space-y-3 overflow-auto p-4 text-sm"
      data-testid="managed-dialog"
    >
      <h2 class="font-semibold">{{ t('managed.title') }}</h2>
      <p>{{ t('managed.what') }}</p>
      <ul class="list-disc space-y-1 pl-5">
        <li>
          {{ t('managed.who') }}
          <strong data-testid="managed-guardians">{{
            ws.managedPolicy.guardians.join(', ')
          }}</strong>
          ({{ t(`managed.role.${ws.managedPolicy.role}`) }}).
        </li>
        <li>{{ t('managed.you') }}</li>
        <li>{{ t('managed.private') }}</li>
      </ul>
      <label class="flex items-start gap-2">
        <input v-model="understood" type="checkbox" class="mt-1" data-testid="managed-understood" />
        <span>{{ t('managed.understood') }}</span>
      </label>
      <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
      <div class="flex gap-2">
        <button
          type="button"
          class="btn-primary"
          :disabled="!understood || busy"
          data-testid="managed-create"
          @click="create"
        >
          {{ t('managed.create') }}
        </button>
        <button type="button" class="btn" @click="emit('close')">{{ t('common.cancel') }}</button>
      </div>
    </div>
  </div>
</template>
