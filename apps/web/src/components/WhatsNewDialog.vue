<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import { between, inline, loadReleases, RELEASES_URL, type Release } from '../services/releases';

/** Окно «Что нового»: текущая версия, сводка пропущенных версий и, по желанию, прежние. */
const props = defineProps<{ from: string | null }>();
const emit = defineEmits<{ close: [] }>();
const { t, locale } = useI18n();
const auth = useAuthStore();
const all = ref<Release[]>([]);
const failed = ref(false);
const older = ref(false);
const current = __APP_VERSION__;

const shown = computed(() => {
  const mine = between(all.value, props.from, current);
  return mine.length ? mine : all.value.slice(0, 1);
});
const previous = computed(() => all.value.filter((r) => !shown.value.includes(r)));
const date = (d: string | null) =>
  d
    ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'long' }).format(new Date(`${d}T00:00:00`))
    : '';

onMounted(async () => {
  try {
    all.value = await loadReleases();
  } catch {
    failed.value = true;
  }
  // сводка показана: повторять сообщение об обновлении не нужно
  void auth.markReleaseSeen(current).catch(() => undefined);
});
</script>

<template>
  <div
    class="modal-scrim flex items-center justify-center p-4"
    role="dialog"
    aria-modal="true"
    :aria-label="t('whatsnew.title', { v: current })"
    @keydown.esc="emit('close')"
  >
    <div
      class="modal flex max-h-[90vh] w-full max-w-2xl flex-col text-sm"
      data-testid="whatsnew-dialog"
    >
      <header
        class="flex items-start justify-between gap-3 border-b border-slate-200 p-4 dark:border-slate-800"
      >
        <div>
          <h2 class="text-lg font-semibold">{{ t('whatsnew.title', { v: current }) }}</h2>
          <p v-if="shown[0]?.date" class="text-xs text-slate-500">
            {{ t('whatsnew.released', { d: date(shown[0].date) }) }}
          </p>
        </div>
        <button type="button" class="btn-ghost" data-testid="whatsnew-close" @click="emit('close')">
          {{ t('whatsnew.close') }}
        </button>
      </header>
      <div class="space-y-5 overflow-auto p-4">
        <p v-if="failed" class="notice notice-warn">{{ t('whatsnew.failed') }}</p>
        <p v-else-if="!all.length" class="text-slate-500">{{ t('whatsnew.loading') }}</p>
        <template v-for="r in shown" :key="r.version">
          <section :data-testid="`release-${r.version}`">
            <h3 v-if="shown.length > 1" class="mb-2 text-base">
              {{ r.version }}
              <span class="text-xs font-normal text-slate-500">{{ date(r.date) }}</span>
            </h3>
            <div v-for="s in r.sections" :key="s.id" class="mb-3">
              <h4 class="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {{ t(`whatsnew.cat.${s.id}`) }}
              </h4>
              <ul class="list-disc space-y-1.5 pl-5">
                <!-- eslint-disable-next-line vue/no-v-html -- текст экранируется в inline() -->
                <li v-for="(i, n) in s.items" :key="n" v-html="inline(i)" />
              </ul>
            </div>
          </section>
        </template>
        <div v-if="previous.length">
          <button
            type="button"
            class="btn"
            data-testid="whatsnew-older"
            :aria-expanded="older"
            @click="older = !older"
          >
            {{ older ? t('whatsnew.hideOlder') : t('whatsnew.showOlder') }}
          </button>
          <div v-if="older" class="mt-4 space-y-5" data-testid="whatsnew-older-list">
            <section v-for="r in previous" :key="r.version">
              <h3 class="mb-2 text-base">
                {{ r.version }}
                <span class="text-xs font-normal text-slate-500">{{ date(r.date) }}</span>
              </h3>
              <div v-for="s in r.sections" :key="s.id" class="mb-3">
                <h4 class="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {{ t(`whatsnew.cat.${s.id}`) }}
                </h4>
                <ul class="list-disc space-y-1.5 pl-5">
                  <!-- eslint-disable-next-line vue/no-v-html -- текст экранируется в inline() -->
                  <li v-for="(i, n) in s.items" :key="n" v-html="inline(i)" />
                </ul>
              </div>
            </section>
          </div>
        </div>
      </div>
      <footer
        class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 p-4 text-xs text-slate-500 dark:border-slate-800"
      >
        <span>{{ t('whatsnew.langNote') }}</span>
        <a
          :href="`${RELEASES_URL}/tag/v${current}`"
          target="_blank"
          rel="noopener noreferrer"
          class="font-medium text-brand-700 underline"
          data-testid="whatsnew-full"
          >{{ t('whatsnew.full') }}</a
        >
      </footer>
    </div>
  </div>
</template>
