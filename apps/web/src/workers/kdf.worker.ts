/// <reference lib="webworker" />
import { deriveMasterKeys } from '@arklock/crypto';
import type { KdfParams } from '@arklock/crypto';

/**
 * Argon2id выполняется в отдельном потоке: интерфейс не блокируется. Мастер-пароль приходит сообщением,
 * нигде не сохраняется и не журналируется; в ответ возвращаются только производные ключи.
 */
interface Request {
  id: number;
  password: string;
  salt: Uint8Array;
  accountId: string;
  params: KdfParams;
}

self.onmessage = async (ev: MessageEvent<Request>) => {
  const { id, password, salt, accountId, params } = ev.data;
  try {
    const keys = await deriveMasterKeys(password, salt, accountId, params);
    (self as unknown as Worker).postMessage(
      { id, ok: true, wrapKey: keys.wrapKey, authKey: keys.authKey },
      [keys.wrapKey.buffer, keys.authKey.buffer],
    );
  } catch (e) {
    (self as unknown as Worker).postMessage({
      id,
      ok: false,
      error: e instanceof Error ? e.name : 'Error',
    });
  }
};
