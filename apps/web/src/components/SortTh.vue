<script setup lang="ts">
/** Заголовок столбца, по которому сортируется таблица: aria-sort, стрелка направления, у неактивного — бледная «↕». */
defineProps<{ label: string; dir: 'asc' | 'desc' | null; testid?: string }>();
defineEmits<{ sort: [] }>();
</script>

<template>
  <th :aria-sort="dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'">
    <button
      type="button"
      class="inline-flex items-center gap-1 hover:text-slate-800 dark:hover:text-slate-200"
      :data-testid="testid"
      @click="$emit('sort')"
    >
      {{ label
      }}<span aria-hidden="true" :class="dir ? '' : 'opacity-40'">{{
        dir === 'desc' ? '↓' : dir === 'asc' ? '↑' : '↕'
      }}</span>
    </button>
  </th>
</template>
