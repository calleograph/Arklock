<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

/**
 * Секрет с эффектом «расшифровки»: при показе символы на мгновение перебираются и складываются слева направо.
 * Перебор — случайные знаки из того же алфавита, а не части секрета; при «уменьшить движение» значение появляется сразу.
 */
const props = defineProps<{ value: string; shown: boolean; mask?: string }>();
const MASK = '••••••••••';
const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789#%&*+=?@';
const text = ref(props.shown ? props.value : (props.mask ?? MASK));
const busy = ref(false);
let frame = 0;

function stop(): void {
  cancelAnimationFrame(frame);
  busy.value = false;
}
function reveal(): void {
  stop();
  const value = props.value;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced || value.length > 120) {
    text.value = value;
    return;
  }
  const start = performance.now();
  const total = Math.min(420, 180 + value.length * 12);
  busy.value = true;
  const tick = (now: number): void => {
    const done = Math.floor(((now - start) / total) * value.length);
    if (done >= value.length) {
      text.value = value;
      busy.value = false;
      return;
    }
    let out = value.slice(0, Math.max(0, done));
    for (let i = Math.max(0, done); i < value.length; i++)
      out += value[i] === ' ' ? ' ' : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
    text.value = out;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}
watch(
  () => [props.shown, props.value] as const,
  ([shown]) => {
    if (shown) reveal();
    else {
      stop();
      text.value = props.mask ?? MASK;
    }
  },
);
onBeforeUnmount(stop);
</script>

<template>
  <span class="break-all font-mono" :aria-busy="busy || undefined">{{ text }}</span>
</template>
