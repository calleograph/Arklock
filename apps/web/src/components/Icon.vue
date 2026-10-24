<script setup lang="ts">
/** Линейные значки в цвет текста: единый вид во всех темах (вместо эмодзи и текстовых кнопок). */
export type IconName =
  | 'all'
  | 'star'
  | 'archive'
  | 'trash'
  | 'folder'
  | 'folder-plus'
  | 'plus'
  | 'key'
  | 'inbox'
  | 'search'
  | 'lock'
  | 'edit'
  | 'eye'
  | 'eye-off'
  | 'copy'
  | 'external'
  | 'share'
  | 'check'
  | 'user'
  | 'users'
  | 'shield'
  | 'chart'
  | 'bell'
  | 'log'
  | 'help'
  | 'logout'
  | 'settings'
  | 'database'
  | 'sync'
  | 'tag'
  | 'file'
  | 'text'
  | 'totp'
  | 'dice'
  | 'transfer'
  | 'globe'
  | 'mail'
  | 'server'
  | 'pulse'
  | 'building'
  | 'plug'
  | 'cpu'
  | 'idcard'
  | 'certificate'
  | 'user-plus'
  | 'more';

defineProps<{ name: IconName }>();

const paths: Record<IconName, string> = {
  all: 'M4 5h16M4 12h16M4 19h16',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.2 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z',
  archive: 'M3 6h18v4H3zM5 10v9h14v-9M10 14h4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  folder:
    'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z',
  'folder-plus':
    'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18zM12 11v5M9.5 13.5h5',
  plus: 'M12 5v14M5 12h14',
  key: 'M14.5 9.5a4 4 0 1 1-1.2-2.8M13 10l7 7-2 2-2-2-2 .5L14 15l-1.5-1.5',
  inbox: 'M3 13l2.5-7h13L21 13v6H3zM3 13h5l1 2h6l1-2h5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  lock: 'M5 11h14v9H5zM8 11V8a4 4 0 0 1 8 0v3',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zM12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z',
  'eye-off':
    'M3 3l18 18M10.6 6.2A9.6 9.6 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.8M6.1 6.9C3.6 8.6 2 12 2 12s3.5 6 10 6c1.7 0 3.2-.5 4.5-1.2',
  copy: 'M9 9h10v11H9zM5 15V4h11',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  share:
    'M16 6l-8 4 8 4M7 10a3 3 0 1 0 0 .01M20 6a2 2 0 1 0 0 .01M20 18a2 2 0 1 0 0 .01M18 6.7l-9.8 4.9M8 13.4l9.8 4.9',
  check: 'M4 12.5l5 5L20 6.5',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c1.2-3.5 4.2-5 8-5s6.8 1.5 8 5',
  users:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.8-3 3.3-4.5 6.5-4.5s5.7 1.5 6.5 4.5M16 4.5a3.5 3.5 0 0 1 0 6.8M18.5 15.5c1.1.7 1.8 2 2 4.5',
  shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2zM10 20a2 2 0 0 0 4 0',
  log: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4zM5 17a3 3 0 0 1 3-3h11M9 8h6',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01',
  logout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h11',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  database:
    'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  sync: 'M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4',
  tag: 'M3 12V4h8l10 10-8 8L3 12zM7.5 8a.5.5 0 1 0 0 .01',
  file: 'M6 3h8l4 4v14H6V3zM14 3v4h4',
  text: 'M5 6h14M5 11h14M5 16h9',
  totp: 'M12 6v6l4 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  dice: 'M4 4h16v16H4zM8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01',
  mail: 'M3 6h18v12H3zM3 7l9 7 9-7',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  pulse: 'M3 12h4l2-6 4 12 2-6h6',
  building: 'M5 21V4h9v17M14 9h5v12M8 8h3M8 12h3M8 16h3M3 21h18',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  cpu: 'M7 7h10v10H7zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4',
  idcard:
    'M3 5h18v14H3zM8 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5 16c.5-1.5 1.7-2 3-2s2.5.5 3 2M14 9h4M14 13h4',
  certificate: 'M5 4h14v11H5zM8 8h8M8 11h5M9 15l-1 5 4-2 4 2-1-5',
  'user-plus': 'M10 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM3 20c1-3.5 3.7-5 7-5M18 8v6M15 11h6',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  transfer: 'M7 4v14M3 14l4 4 4-4M17 20V6M13 10l4-4 4 4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
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
