<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import { disablePin, enablePin, hasPin, PIN_PATTERN, pinDeviceId } from '../services/pin';
import { useAuthStore } from '../stores/auth';

const { t, d } = useI18n();
const auth = useAuthStore();
const policy = ref(false);
const devices = ref<{ id: string; name: string; lastUsedAt: string | null }[]>([]);
const active = ref(false);
const password = ref('');
const pin = ref('');
const repeat = ref('');
const error = ref('');
const notice = ref('');
const busy = ref(false);

async function load(): Promise<void> {
  const r = await api<{ enabled: boolean; devices: typeof devices.value }>('GET', '/auth/pin');
  policy.value = r.enabled;
  devices.value = r.devices;
  // PIN на этом устройстве действует, только если сервер ещё помнит устройство
  active.value =
    !!auth.user &&
    hasPin(auth.user.id) &&
    r.devices.some((x) => x.id === pinDeviceId(auth.user!.id));
}
onMounted(() => load().catch((e) => (error.value = errorMessage(e, t))));

async function run(fn: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await fn();
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
const enable = () =>
  run(async () => {
    if (!PIN_PATTERN.test(pin.value)) throw new Error(t('pin.format'));
    if (pin.value !== repeat.value) throw new Error(t('pin.mismatch'));
    await enablePin(auth.user!, password.value, pin.value, navigator.platform || 'Browser');
    password.value = pin.value = repeat.value = '';
    notice.value = t('pin.saved');
  });
const disable = () =>
  run(async () => {
    await disablePin(auth.user!.id);
    notice.value = t('pin.removed');
  });
const remove = (id: string) =>
  run(async () => {
    if (id === pinDeviceId(auth.user!.id)) await disablePin(auth.user!.id);
    else await api('DELETE', `/auth/pin/${id}`);
  });
</script>

<template>
  <div data-testid="pin-settings">
    <h2>{{ t('pin.title') }}</h2>
    <p class="mb-3 mt-1 text-sm text-slate-500">{{ t('pin.hint') }}</p>
    <p v-if="error" class="notice notice-error mb-3" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice notice-ok mb-3" role="status">{{ notice }}</p>
    <p v-if="!policy" class="text-sm text-slate-500">{{ t('pin.off') }}</p>
    <template v-else>
      <div v-if="active" class="flex flex-wrap items-center gap-3 text-sm">
        <span>{{ t('pin.active') }}</span>
        <button
          type="button"
          class="btn"
          :disabled="busy"
          data-testid="pin-disable"
          @click="disable"
        >
          {{ t('pin.disable') }}
        </button>
      </div>
      <form v-else class="grid max-w-sm gap-2 text-sm" @submit.prevent="enable">
        <label
          >{{ t('pin.password')
          }}<input
            v-model="password"
            type="password"
            required
            autocomplete="current-password"
            class="input"
            data-testid="pin-password"
        /></label>
        <label
          >{{ t('pin.pin')
          }}<input
            v-model="pin"
            type="password"
            inputmode="numeric"
            pattern="[0-9]{6,12}"
            required
            autocomplete="off"
            class="input"
            data-testid="pin-new"
        /></label>
        <label
          >{{ t('pin.repeat')
          }}<input
            v-model="repeat"
            type="password"
            inputmode="numeric"
            required
            autocomplete="off"
            class="input"
            data-testid="pin-repeat"
        /></label>
        <button type="submit" class="btn-primary" :disabled="busy" data-testid="pin-enable">
          {{ t('pin.enable') }}
        </button>
      </form>
      <div v-if="devices.length" class="mt-4">
        <h3 class="text-sm font-medium">{{ t('pin.devices') }}</h3>
        <ul class="mt-1 divide-y divide-slate-200 text-sm dark:divide-slate-800">
          <li
            v-for="x in devices"
            :key="x.id"
            class="flex items-center justify-between gap-2 py-1.5"
          >
            <span class="min-w-0 break-words"
              >{{ x.name }} ·
              <span class="text-xs text-slate-500">{{
                x.lastUsedAt
                  ? `${t('pin.lastUsed')} ${d(new Date(x.lastUsedAt), 'short')}`
                  : t('pin.never')
              }}</span></span
            >
            <button type="button" class="btn-danger" :disabled="busy" @click="remove(x.id)">
              {{ t('pin.remove') }}
            </button>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
