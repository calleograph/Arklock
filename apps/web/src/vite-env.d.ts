/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

/** Версия интерфейса из файла VERSION на момент сборки. */
declare const __APP_VERSION__: string;
