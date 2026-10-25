<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { authKeyFor } from '../services/account';
import { errorMessage, when } from '../services/helpers';
import { useAuthStore } from '../stores/auth';

/** Преемнику предложена роль главного администратора: он принимает её своим паролем разблокировки сейфов или отказывается. */
const { t } = useI18n();
const auth = useAuthStore();
const offer = ref<{ from: { name: string; email: string } | null; expiresAt: string } | null>(null);
const password = ref('');
const busy = ref(false);
const error = ref('');
const accepted = ref(false);

onMounted(async () => {
  try {
    offer.value = (await api<{ offer: typeof offer.value }>('GET', '/auth/chief-offer')).offer;
  } catch {
    /* предложения нет или сеть недоступна: карточка просто не показывается */
  }
});

async function accept(): Promise<void> {
  if (!auth.user || !password.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api('POST', '/auth/chief-offer/accept', {
      authKey: await authKeyFor(auth.user, password.value),
    });
    password.value = '';
    accepted.value = true;
    offer.value = null;
    auth.user = { ...auth.user, role: 'admin', chief: true, delegated: false };
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
async function decline(): Promise<void> {
  busy.value = true;
  try {
    await api('POST', '/auth/chief-offer/decline');
    offer.value = null;
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <p v-if="accepted" class="notice notice-ok" role="status" data-testid="chief-accepted">
    {{ t('chief.accepted') }}
  </p>
  <section v-else-if="offer" class="card space-y-2 p-4 text-sm" data-testid="chief-offer-card">
    <h2>{{ t('chief.offerTitle') }}</h2>
    <p>
      {{ t('chief.offerText', { name: offer.from?.name ?? '—', until: when(offer.expiresAt) }) }}
    </p>
    <p class="text-xs text-slate-500">{{ t('chief.intro') }}</p>
    <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
    <form class="flex flex-wrap items-end gap-2" @submit.prevent="accept">
      <label class="min-w-56 flex-1"
        ><span class="field-label">{{ t('chief.password') }}</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          class="input"
          required
          data-testid="chief-accept-password"
      /></label>
      <button type="submit" class="btn-primary" :disabled="busy" data-testid="chief-accept">
        {{ t('chief.accept') }}
      </button>
      <button type="button" class="btn" :disabled="busy" @click="decline">
        {{ t('chief.decline') }}
      </button>
    </form>
  </section>
</template>
