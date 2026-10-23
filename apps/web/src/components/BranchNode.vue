<script setup lang="ts">
import Icon from './Icon.vue';
import ObjectIcon from './ObjectIcon.vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BranchItem } from '../services/model';

const props = defineProps<{
  node: BranchItem;
  all: BranchItem[];
  selected: string | null;
  depth: number;
  counts: Map<string | null, number>;
  collapsed: Set<string>;
}>();
const { t } = useI18n();
const emit = defineEmits<{
  (e: 'select', id: string): void;
  (e: 'toggle', id: string): void;
  (e: 'menu', b: BranchItem): void;
  (e: 'drop', payload: { branchId: string }): void;
}>();

const children = computed(() =>
  props.all
    .filter((b) => b.parentId === props.node.id)
    .sort((a, b) => a.name.localeCompare(b.name)),
);
const open = computed(() => !props.collapsed.has(props.node.id));
</script>

<template>
  <li>
    <div
      class="group relative flex items-center gap-1 rounded-lg px-1 py-1 text-sm text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      :class="selected === node.id ? 'nav-link-active !text-brand-700' : ''"
      :style="{ paddingLeft: `${depth * 12 + 4}px` }"
      data-testid="branch-row"
      @contextmenu.prevent="emit('menu', node)"
      @dragover.prevent
      @drop.prevent="emit('drop', { branchId: node.id })"
    >
      <button
        type="button"
        class="flex size-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-200 disabled:invisible dark:hover:bg-slate-700"
        :aria-label="`${open ? t('ws.collapse') : t('ws.expand')}: ${node.name}`"
        :aria-expanded="children.length ? open : undefined"
        :disabled="!children.length"
        @click="emit('toggle', node.id)"
      >
        <svg
          viewBox="0 0 16 16"
          class="size-3 transition-transform duration-200"
          :class="open ? 'rotate-90' : ''"
          aria-hidden="true"
        >
          <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" />
        </svg>
      </button>
      <button
        type="button"
        class="min-w-0 flex-1 truncate text-left"
        @click="emit('select', node.id)"
      >
        <ObjectIcon :icon="node.icon" kind="folder" variant="inline" class="mr-1" />{{ node.name
        }}<Icon
          v-if="node.pinned"
          name="star"
          class="ml-1 inline size-3 fill-amber-400 align-[-1px] text-amber-500"
          :aria-label="t('vault.favorites')"
        />
      </button>
      <span class="text-xs text-slate-400">{{ counts.get(node.id) ?? '' }}</span>
      <button
        type="button"
        class="rounded px-1 text-slate-500 hover:bg-slate-200 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 dark:hover:bg-slate-700"
        :aria-label="`${t('ws.folderActions')}: ${node.name}`"
        :data-testid="`folder-menu-${node.name}`"
        @click.stop="emit('menu', node)"
      >
        <Icon name="more" class="size-4" />
      </button>
    </div>
    <ul v-if="open && children.length">
      <BranchNode
        v-for="c in children"
        :key="c.id"
        :node="c"
        :all="all"
        :selected="selected"
        :depth="depth + 1"
        :counts="counts"
        :collapsed="collapsed"
        @select="(id) => emit('select', id)"
        @toggle="(id) => emit('toggle', id)"
        @menu="(b) => emit('menu', b)"
        @drop="(p) => emit('drop', p)"
      />
    </ul>
  </li>
</template>
