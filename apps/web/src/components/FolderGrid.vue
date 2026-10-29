<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BranchItem } from '../services/model';
import Icon from './Icon.vue';
import ObjectIcon from './ObjectIcon.vue';

/**
 * Папки текущего расположения — компактные строки в несколько колонок. Подпапки и записи считаются
 * только по доступному сотруднику: список строится из того, что сервер отдал ему в дереве.
 */
const props = defineProps<{
  folders: BranchItem[];
  /** записи в папке (без вложенных) */
  counts: Map<string | null, number>;
  /** вложенные папки */
  kids: Map<string | null, BranchItem[]>;
  canCreate: boolean;
  /** подпись кнопки называет место, куда попадёт папка */
  createLabel: string;
  /** меняется при переходе в другую папку: длинный список снова сворачивается */
  where: string | null;
}>();
const emit = defineEmits<{
  open: [id: string];
  create: [];
  menu: [b: BranchItem];
  drop: [id: string];
}>();
const { t } = useI18n();
const PAGE = 12;
const all = ref(false);
watch(
  () => props.where,
  () => (all.value = false),
);
const visible = computed(() => (all.value ? props.folders : props.folders.slice(0, PAGE)));
</script>

<template>
  <section
    v-if="folders.length || canCreate"
    :aria-label="t('vault.folders')"
    data-testid="folder-section"
  >
    <div class="mb-1 flex items-center justify-between gap-2">
      <h3 class="text-xs font-medium uppercase text-slate-500">
        {{ t('vault.folders') }}<template v-if="folders.length"> · {{ folders.length }}</template>
      </h3>
      <button
        v-if="canCreate"
        type="button"
        class="btn !min-h-0 !px-2 !py-1 text-xs"
        :title="createLabel"
        data-testid="btn-create-folder"
        @click="emit('create')"
      >
        <Icon name="folder-plus" class="size-4" /> {{ t('ws.newFolderHere') }}
      </button>
    </div>
    <p v-if="!folders.length" class="px-1 text-xs text-slate-500" data-testid="no-folders">
      {{ t('ws.noFolders') }}
    </p>
    <ul
      v-else
      class="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-x-1 gap-y-0.5"
      data-testid="folder-tiles"
    >
      <li
        v-for="b in visible"
        :key="b.id"
        class="group relative flex items-center rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
        data-testid="folder-tile"
        @contextmenu.prevent="emit('menu', b)"
        @dragover.prevent
        @drop.prevent="emit('drop', b.id)"
      >
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
          :aria-label="t('ws.openFolder', { name: b.name })"
          :data-testid="`tile-open-${b.name}`"
          @click="emit('open', b.id)"
        >
          <ObjectIcon :icon="b.icon" kind="folder" variant="inline" />
          <span class="min-w-0 truncate font-medium">{{ b.name }}</span>
          <Icon
            v-if="b.pinned"
            name="star"
            class="size-3 shrink-0 fill-amber-400 text-amber-500"
            :aria-label="t('vault.favorites')"
          />
          <Icon
            v-if="b.access === 'reader' || b.access === 'structure'"
            name="lock"
            class="size-3 shrink-0 text-slate-400"
            :title="b.access === 'reader' ? t('ws.folderReadOnly') : t('ws.folderStructure')"
            :aria-label="b.access === 'reader' ? t('ws.folderReadOnly') : t('ws.folderStructure')"
          />
          <span class="ml-auto flex shrink-0 items-center gap-1.5 pl-1 text-xs text-slate-500">
            <span
              v-if="kids.get(b.id)?.length"
              class="flex items-center gap-0.5"
              :title="t('ws.folderChildren', { n: kids.get(b.id)!.length })"
              data-testid="tile-children"
              ><Icon name="folder" class="size-3" />{{ kids.get(b.id)!.length }}</span
            >
            <span
              v-if="b.access !== 'structure' && counts.get(b.id)"
              :title="t('ws.folderEntries', { n: counts.get(b.id) ?? 0 })"
              data-testid="tile-count"
              >{{ counts.get(b.id) ?? 0 }}</span
            >
          </span>
        </button>
        <button
          type="button"
          class="mr-1 rounded px-1 text-slate-500 hover:bg-slate-200 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 dark:hover:bg-slate-700"
          :aria-label="`${t('ws.folderActions')}: ${b.name}`"
          :data-testid="`tile-menu-${b.name}`"
          @click.stop="emit('menu', b)"
        >
          <Icon name="more" class="size-4" />
        </button>
      </li>
    </ul>
    <button
      v-if="folders.length > PAGE"
      type="button"
      class="mt-1 px-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
      data-testid="folders-toggle"
      @click="all = !all"
    >
      {{ all ? t('ws.showFewer') : t('ws.showAllFolders', { n: folders.length }) }}
    </button>
  </section>
</template>
