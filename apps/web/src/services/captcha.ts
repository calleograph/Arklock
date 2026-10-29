import { ref } from 'vue';
import type { CaptchaSolution } from '@arklock/contracts';
import { ApiError } from './api';

/** Идёт дополнительная проверка (показывается строкой состояния на странице входа). */
export const captchaBusy = ref(false);

type Challenge = Omit<CaptchaSolution, 'number'>;

/** Подбор числа в отдельном потоке (интерфейс не блокируется); без Worker — в основном потоке порциями. */
export async function findNumber(c: Pick<Challenge, 'salt' | 'bits'>): Promise<number> {
  if (typeof Worker !== 'undefined') {
    return new Promise<number>((resolve, reject) => {
      const w = new Worker(new URL('../workers/pow.worker.ts', import.meta.url), {
        type: 'module',
      });
      w.onmessage = (ev: MessageEvent<{ number: number }>) => {
        w.terminate();
        resolve(ev.data.number);
      };
      w.onerror = () => {
        w.terminate();
        reject(new Error('pow_worker'));
      };
      w.postMessage({ salt: c.salt, bits: c.bits });
    });
  }
  const enc = new TextEncoder();
  for (let n = 0; ; n++) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${c.salt}${n}`)));
    let z = 0;
    for (const b of d) {
      if (b === 0) z += 8;
      else {
        z += Math.clz32(b) - 24;
        break;
      }
    }
    if (z >= c.bits) return n;
  }
}

/**
 * Выполняет запрос; если сервер просит дополнительную проверку (после нескольких ошибок входа), решает задание
 * и повторяет запрос. working сообщает интерфейсу, что идёт проверка (для статуса «Проверяем…»).
 */
export async function withCaptcha<T>(
  run: (captcha?: CaptchaSolution) => Promise<T>,
  working?: (on: boolean) => void,
): Promise<T> {
  let captcha: CaptchaSolution | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(captcha);
    } catch (e) {
      const challenge = (e as ApiError).details as { captcha?: Challenge } | undefined;
      if (
        !(e instanceof ApiError) ||
        e.code !== 'captcha_required' ||
        !challenge?.captcha ||
        attempt >= 2
      )
        throw e;
      captchaBusy.value = true;
      working?.(true);
      try {
        captcha = { ...challenge.captcha, number: await findNumber(challenge.captcha) };
      } finally {
        captchaBusy.value = false;
        working?.(false);
      }
    }
  }
}
