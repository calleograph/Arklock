<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BranchItem } from '../services/model';
import Icon from './Icon.vue';

/** Путь к текущей папке; длинный путь сворачивается в «…» (остаются корень и три последних уровня). */
const props = defineProps<{ rootLabel: string; trail: BranchItem[] }>();
const emit = defineEmits<{ open: [id: string | null] }>();
const { t } = useI18n();
const TAIL = 3;
const hidden = computed(() => props.trail.slice(0, Math.max(0, props.trail.length - TAIL)));
const shown = computed(() => props.trail.slice(hidden.value.length));
const more = ref<HTMLDetailsElement | null>(null);
function go(id: string | null): void {
  if (more.value) more.value.open = false;
  emit('open', id);
}
const parent = computed(() => props.trail[props.trail.length - 2]?.id ?? null);
</script>

<template>
  <nav
    class="flex min-w-0 items-start gap-1 text-sm"
    :aria-label="t('ws.path')"
    data-testid="breadcrumbs"
  >
    <button
      v-if="trail.length"
      type="button"
      class="btn !min-h-0 shrink-0 !p-1"
      :title="t('ws.upLevel')"
      :aria-label="t('ws.upLevel')"
      data-testid="crumb-up"
      @click="go(parent)"
    >
      <Icon name="external" class="size-4 -rotate-90" />
    </button>
    <ol class="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5 py-1">
      <li class="min-w-0">
        <button
          type="button"
          class="max-w-[12rem] truncate rounded px-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
          :title="t('vault.all')"
          data-testid="crumb-root"
          :aria-current="trail.length ? undefined : 'page'"
          :class="trail.length ? '' : 'font-semibold text-slate-900 dark:text-slate-100'"
          @click="go(null)"
        >
          {{ rootLabel }}
        </button>
      </li>
      <li v-if="hidden.length" class="relative flex items-center gap-1">
        <span class="text-slate-400" aria-hidden="true">/</span>
        <details ref="more">
          <summary
            class="cursor-pointer list-none rounded px-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            :aria-label="t('ws.hiddenLevels')"
            data-testid="crumb-more"
          >
            …
          </summary>
          <ul
            class="card absolute left-0 top-full z-20 mt-1 max-w-[16rem] space-y-0.5 p-1 shadow-lg"
          >
            <li v-for="b in hidden" :key="b.id">
              <button
                type="button"
                class="block w-full truncate rounded px-2 py-1 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                @click="go(b.id)"
              >
                {{ b.name }}
              </button>
            </li>
          </ul>
        </details>
      </li>
      <li v-for="(b, i) in shown" :key="b.id" class="flex min-w-0 items-center gap-1">
        <span class="text-slate-400" aria-hidden="true">/</span>
        <span
          v-if="i === shown.length - 1"
          class="max-w-[16rem] truncate px-1 font-semibold"
          aria-current="page"
          data-testid="crumb-current"
          >{{ b.name }}</span
        >
        <button
          v-else
          type="button"
          class="max-w-[12rem] truncate rounded px-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
          data-testid="crumb"
          @click="go(b.id)"
        >
          {{ b.name }}
        </button>
      </li>
    </ol>
  </nav>
</template>
