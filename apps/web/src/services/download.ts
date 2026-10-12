/**
 * Приёмники для потокового скачивания: данные пишутся по мере расшифровки, файл целиком в памяти не собирается.
 *  1) service worker: ответ на синтетический адрес собирается из потока сообщений (обычная загрузка браузера, без диалогов);
 *  2) File System Access API (если service worker ещё не управляет страницей): запись прямо в выбранный файл;
 *  3) запасной вариант для небольших файлов: сборка Blob в памяти (не используется для крупных вложений).
 */
export interface Sink {
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
}

/** Размер, до которого допустим запасной вариант без потока. */
export const MEMORY_FALLBACK_LIMIT = 64 * 1024 * 1024;

type SaveWindow = Window & {
  showSaveFilePicker?: (o: { suggestedName: string }) => Promise<{
    createWritable: () => Promise<{
      write: (b: Uint8Array<ArrayBuffer>) => Promise<void>;
      close: () => Promise<void>;
      abort: () => Promise<void>;
    }>;
  }>;
};

export async function openSink(name: string, size: number): Promise<Sink> {
  const sw = navigator.serviceWorker?.controller;
  if (sw) {
    const id = crypto.randomUUID();
    const channel = new MessageChannel();
    // Запрос на /sw-download/<id> отправляется только после подтверждения от service worker: сообщение и запрос из разных
    // источников могут обрабатываться в обратном порядке. Нет подтверждения — используются запасные приёмники.
    const ready = new Promise<boolean>((resolve) => {
      channel.port1.onmessage = (m) => resolve(m.data === 'ready');
      setTimeout(() => resolve(false), 5000);
    });
    sw.postMessage({ type: 'download', id, name }, [channel.port2]);
    if (await ready) {
      channel.port1.onmessage = null;
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.src = `/sw-download/${id}`;
      document.body.appendChild(frame);
      return {
        write: async (c) => {
          const copy = c.slice();
          channel.port1.postMessage(copy, [copy.buffer]);
        },
        close: async () => {
          channel.port1.postMessage(null);
          setTimeout(() => frame.remove(), 60_000);
        },
        abort: async () => {
          channel.port1.postMessage('abort');
          frame.remove();
        },
      };
    }
  }
  const w = window as SaveWindow;
  if (w.showSaveFilePicker) {
    const handle = await w.showSaveFilePicker({ suggestedName: name });
    const f = await handle.createWritable();
    return {
      write: (c) => f.write(c as Uint8Array<ArrayBuffer>),
      close: () => f.close(),
      abort: () => f.abort(),
    };
  }
  if (size > MEMORY_FALLBACK_LIMIT)
    throw new Error('streaming download is not available in this browser');
  const parts: Uint8Array<ArrayBuffer>[] = [];
  return {
    write: async (c) => void parts.push(c.slice() as Uint8Array<ArrayBuffer>),
    close: async () => {
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
    abort: async () => void (parts.length = 0),
  };
}
