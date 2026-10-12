<script setup lang="ts">
/** Небольшой набор линейных значков в цвет текста: единый вид во всех темах (вместо эмодзи). */
defineProps<{
  name:
    'all' | 'star' | 'archive' | 'trash' | 'folder' | 'plus' | 'key' | 'inbox' | 'search' | 'lock';
}>();
const paths: Record<string, string> = {
  all: 'M4 5h16M4 12h16M4 19h16',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.2 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z',
  archive: 'M3 6h18v4H3zM5 10v9h14v-9M10 14h4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  folder:
    'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z',
  plus: 'M12 5v14M5 12h14',
  key: 'M14.5 9.5a4 4 0 1 1-1.2-2.8M13 10l7 7-2 2-2-2-2 .5L14 15l-1.5-1.5',
  inbox: 'M3 13l2.5-7h13L21 13v6H3zM3 13h5l1 2h6l1-2h5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  lock: 'M5 11h14v9H5zM8 11V8a4 4 0 0 1 8 0v3',
};
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    class="inline-block size-4 shrink-0"
    fill="none"
    stroke="currentColor"
    stroke-width="1.9"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name]" />
  </svg>
</template>
