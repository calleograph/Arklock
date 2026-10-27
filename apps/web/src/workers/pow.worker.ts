/// <reference lib="webworker" />

/** Подбор для дополнительной проверки входа: число, при котором SHA-256(salt + число) начинается с bits нулевых бит. */
interface Request {
  salt: string;
  bits: number;
}

function zeroBits(d: Uint8Array): number {
  let n = 0;
  for (const b of d) {
    if (b === 0) n += 8;
    else return n + Math.clz32(b) - 24;
  }
  return n;
}

self.onmessage = async (ev: MessageEvent<Request>) => {
  const { salt, bits } = ev.data;
  const enc = new TextEncoder();
  for (let number = 0; ; number++) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${salt}${number}`)));
    if (zeroBits(d) >= bits) {
      (self as unknown as Worker).postMessage({ number });
      return;
    }
  }
};
