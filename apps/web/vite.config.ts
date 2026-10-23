import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  // версия интерфейса в сборке: после обновления сервера вкладка со старым интерфейсом видит расхождение
  define: {
    __APP_VERSION__: JSON.stringify(
      readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim(),
    ),
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // шрифты отдаются отдельными файлами: data:-ссылки запрещены политикой содержимого (CSP font-src → 'self')
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
  },
});
