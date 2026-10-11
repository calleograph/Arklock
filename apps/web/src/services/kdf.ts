import {
  CryptoFormatError,
  DEFAULT_KDF,
  deriveMasterKeys,
  type KdfParams,
  type MasterKeys,
} from '@arklock/crypto';

let seq = 0;
let busy = false;

/** Состояние для интерфейса: идёт ли вычисление ключей. */
export const kdfState = {
  get busy() {
    return busy;
  },
};

export class KdfBusyError extends Error {
  constructor() {
    super('another key derivation is in progress');
    this.name = 'KdfBusyError';
  }
}

export class KdfCancelledError extends Error {
  constructor() {
    super('key derivation was cancelled');
    this.name = 'KdfCancelledError';
  }
}

/**
 * Получение ключей из мастер-пароля в Web Worker (Argon2id не блокирует интерфейс).
 * Одновременно допускается одна операция (повторные запуски отклоняются); операцию можно отменить через AbortSignal —
 * рабочий поток при этом уничтожается. Если Worker недоступен, вычисление выполняется в основном потоке.
 */
export async function deriveKeys(
  password: string,
  salt: Uint8Array,
  accountId: string,
  params: KdfParams = DEFAULT_KDF,
  signal?: AbortSignal,
): Promise<MasterKeys> {
  if (busy) throw new KdfBusyError();
  busy = true;
  try {
    if (typeof Worker === 'undefined')
      return await deriveMasterKeys(password, salt, accountId, params);
    const worker = new Worker(new URL('../workers/kdf.worker.ts', import.meta.url), {
      type: 'module',
    });
    const id = ++seq;
    return await new Promise<MasterKeys>((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener('abort', onAbort);
        worker.terminate();
      };
      const onAbort = () => {
        done();
        reject(new KdfCancelledError());
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort);
      worker.onmessage = (
        ev: MessageEvent<{
          id: number;
          ok: boolean;
          wrapKey?: Uint8Array;
          authKey?: Uint8Array;
          error?: string;
        }>,
      ) => {
        if (ev.data.id !== id) return;
        done();
        if (ev.data.ok && ev.data.wrapKey && ev.data.authKey)
          resolve({
            wrapKey: ev.data.wrapKey as MasterKeys['wrapKey'],
            authKey: ev.data.authKey as MasterKeys['authKey'],
          });
        else
          reject(
            ev.data.error === 'CryptoFormatError'
              ? new CryptoFormatError('weak or invalid KDF parameters')
              : new Error('key derivation failed'),
          );
      };
      worker.onerror = () => {
        done();
        reject(new Error('key derivation worker failed'));
      };
      worker.postMessage({ id, password, salt, accountId, params });
    });
  } finally {
    busy = false;
  }
}
