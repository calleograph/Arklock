<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../services/api';
import { confirmStepUp, stepUpHeaders } from '../services/stepup';
import { useAuthStore } from '../stores/auth';
import { errorMessage } from '../services/helpers';
import InfoHint from './InfoHint.vue';

/** «Сеть и доступ»: публичный адрес задаётся здесь; параметры хоста показываются с объяснением, где их менять. */
const { t } = useI18n();
interface View {
  publicUrl: {
    value: string | null;
    source: 'panel' | 'install' | null;
    install: string | null;
    https: boolean;
  };
  listen: { bind: string | null; port: number | null; containerPort: number };
  trustedProxyHops: number;
  dependents: { passkeys: number; oidc: boolean; saml: boolean };
}
const v = ref<View | null>(null);
const draft = ref('');
const error = ref('');
const notice = ref('');
const busy = ref(false);
const editing = ref(false);
const here = location.origin;
const auth = useAuthStore();
// смена адреса меняет ссылки в письмах и приглашениях: подтверждение паролем разблокировки сейфов, как у отката и удаления копий
const password = ref('');
const needPassword = ref(!stepUpHeaders());

async function load(): Promise<void> {
  try {
    v.value = await api<View>('GET', '/admin/network');
    draft.value = v.value.publicUrl.value ?? '';
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
onMounted(load);

/** Открыт ли Arklock сейчас по этому адресу: самая надёжная проверка без запросов во внутреннюю сеть. */
const openedHere = computed(() => !!v.value?.publicUrl.value && here === v.value.publicUrl.value);
const changing = computed(
  () => draft.value.trim().replace(/\/$/, '') !== (v.value?.publicUrl.value ?? ''),
);
async function save(value: string | null): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const headers =
      stepUpHeaders() ?? (auth.user ? await confirmStepUp(auth.user, password.value) : {});
    password.value = '';
    needPassword.value = false;
    v.value = await api<View>('PUT', '/admin/network', { publicUrl: value }, { headers });
    draft.value = v.value.publicUrl.value ?? '';
    editing.value = false;
    notice.value = t('network.saved');
  } catch (e) {
    // подтверждение истекло (15 минут): снова спросить пароль разблокировки сейфов
    if (e instanceof ApiError && e.code === 'reauth_required') needPassword.value = true;
    const reason = e instanceof ApiError && (e.details as { reason?: string } | undefined)?.reason;
    error.value = reason ? t(`network.invalid.${reason}`) : errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
const useCurrent = () => (draft.value = here);
</script>

<template>
  <section class="card space-y-4 p-4 text-sm" data-testid="network-settings">
    <div>
      <h2>{{ t('network.title') }}</h2>
      <p class="text-xs text-slate-500">{{ t('network.intro') }}</p>
    </div>
    <p v-if="error" class="notice notice-error" role="alert" data-testid="network-error">
      {{ error }}
    </p>
    <p v-if="notice" class="notice notice-ok" role="status">{{ notice }}</p>
    <template v-if="v">
      <div
        id="public-url"
        class="space-y-2 rounded-[10px] border border-slate-200 p-3 dark:border-slate-800"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="inline-flex items-center gap-1 font-medium"
            >{{ t('network.publicUrl') }}<InfoHint :text="t('network.publicUrlHint')"
          /></span>
          <span class="text-xs text-slate-500">{{
            v.publicUrl.source === 'panel'
              ? t('network.sourcePanel')
              : v.publicUrl.source === 'install'
                ? t('network.sourceInstall')
                : t('network.sourceNone')
          }}</span>
        </div>
        <template v-if="!editing">
          <p class="break-all font-mono" data-testid="network-public-url">
            {{ v.publicUrl.value ?? t('network.notSet') }}
          </p>
          <p v-if="v.publicUrl.value && !v.publicUrl.https" class="text-red-600">
            {{ t('network.noHttps') }}
          </p>
          <p v-else-if="openedHere" class="text-emerald-700 dark:text-emerald-300">
            {{ t('network.openedHere') }}
          </p>
          <p v-else-if="v.publicUrl.value" class="text-amber-700 dark:text-amber-300">
            {{ t('network.openedElsewhere', { here }) }}
          </p>
          <button type="button" class="btn" data-testid="network-edit" @click="editing = true">
            {{ v.publicUrl.value ? t('network.change') : t('network.set') }}
          </button>
        </template>
        <form v-else class="space-y-2" @submit.prevent="save(draft.trim() || null)">
          <input
            v-model="draft"
            class="input font-mono"
            placeholder="https://ark.example.com"
            inputmode="url"
            autocomplete="off"
            :aria-label="t('network.publicUrl')"
            data-testid="network-url-input"
          />
          <button
            v-if="draft !== here"
            type="button"
            class="text-xs text-brand-600 underline"
            @click="useCurrent"
          >
            {{ t('network.useCurrent', { here }) }}
          </button>
          <!-- что изменится: администратор видит последствия до сохранения -->
          <ul
            v-if="changing && v.publicUrl.value"
            class="list-disc space-y-0.5 pl-5 text-xs text-amber-800 dark:text-amber-200"
          >
            <li v-if="v.dependents.passkeys">
              {{ t('network.effectPasskeys', { n: v.dependents.passkeys }) }}
            </li>
            <li v-if="v.dependents.oidc">{{ t('network.effectOidc') }}</li>
            <li v-if="v.dependents.saml">{{ t('network.effectSaml') }}</li>
            <li>{{ t('network.effectLinks') }}</li>
          </ul>
          <label v-if="needPassword" class="block max-w-sm"
            ><span class="field-label">{{ t('chief.password') }}</span>
            <input
              v-model="password"
              type="password"
              autocomplete="current-password"
              class="input"
              data-testid="network-password"
          /></label>
          <div class="flex flex-wrap gap-2">
            <button
              type="submit"
              class="btn-primary"
              :disabled="busy || !changing || (needPassword && !password)"
              data-testid="network-save"
            >
              {{ t('common.save') }}
            </button>
            <button
              type="button"
              class="btn"
              @click="((editing = false), (draft = v.publicUrl.value ?? ''))"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              v-if="v.publicUrl.source === 'panel' && v.publicUrl.install"
              type="button"
              class="btn-ghost"
              :disabled="busy || (needPassword && !password)"
              @click="save(null)"
            >
              {{ t('network.resetToInstall', { url: v.publicUrl.install }) }}
            </button>
          </div>
        </form>
      </div>

      <dl
        class="divide-y divide-slate-200 rounded-[10px] border border-slate-200 dark:divide-slate-800 dark:border-slate-800"
      >
        <div class="grid gap-1 px-3 py-2 sm:grid-cols-[14rem_1fr]">
          <dt class="font-medium">{{ t('network.listen') }}</dt>
          <dd>
            <span v-if="v.listen.bind || v.listen.port" class="font-mono"
              >{{ v.listen.bind ?? '—' }}:{{ v.listen.port ?? '—' }}</span
            >
            <span v-else>{{ t('network.notSet') }}</span>
            <p class="text-xs text-slate-500">{{ t('network.listenHint') }}</p>
          </dd>
        </div>
        <div class="grid gap-1 px-3 py-2 sm:grid-cols-[14rem_1fr]">
          <dt class="font-medium">{{ t('network.proxy') }}</dt>
          <dd>
            <span class="num">{{ v.trustedProxyHops }}</span>
            <p class="text-xs text-slate-500">{{ t('network.proxyHint') }}</p>
          </dd>
        </div>
        <div class="grid gap-1 px-3 py-2 sm:grid-cols-[14rem_1fr]">
          <dt class="font-medium">{{ t('network.https') }}</dt>
          <dd>
            {{ v.publicUrl.https ? t('network.httpsOn') : t('network.httpsOff') }}
            <p class="text-xs text-slate-500">{{ t('network.httpsHint') }}</p>
          </dd>
        </div>
      </dl>
      <p class="text-xs text-slate-500">{{ t('network.hostNote') }}</p>
    </template>
  </section>
</template>
