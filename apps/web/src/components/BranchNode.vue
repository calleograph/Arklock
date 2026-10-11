<script setup lang="ts">
import { computed } from 'vue';
import type { BranchItem } from '../services/model';

const props = defineProps<{
  node: BranchItem;
  all: BranchItem[];
  selected: string | null;
  depth: number;
  counts: Map<string | null, number>;
  collapsed: Set<string>;
}>();
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
      class="group flex items-center gap-1 rounded px-1 py-1 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
      :class="selected === node.id ? 'bg-slate-100 font-medium dark:bg-slate-800' : ''"
      :style="{ paddingLeft: `${depth * 12 + 4}px` }"
      data-testid="branch-row"
      @dragover.prevent
      @drop.prevent="emit('drop', { branchId: node.id })"
    >
      <button
        type="button"
        class="w-4 shrink-0 text-xs text-slate-500"
        :aria-label="open ? 'collapse' : 'expand'"
        :disabled="!children.length"
        @click="emit('toggle', node.id)"
      >
        {{ children.length ? (open ? '▾' : '▸') : '' }}
      </button>
      <button
        type="button"
        class="min-w-0 flex-1 truncate text-left"
        @click="emit('select', node.id)"
      >
        📁 {{ node.name }}
      </button>
      <span class="text-xs text-slate-400">{{ counts.get(node.id) ?? '' }}</span>
      <button
        v-if="node.access !== 'reader'"
        type="button"
        class="invisible text-slate-500 group-hover:visible"
        aria-label="menu"
        @click.stop="emit('menu', node)"
      >
        ⋯
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
