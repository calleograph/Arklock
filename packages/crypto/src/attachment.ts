import { CryptoAuthError, CryptoFormatError, concat, randomBytes, utf8 } from './bytes.js';
import { ctx } from './context.js';

/**
 * Шифрование вложений кусками (потоковая обработка без загрузки файла целиком в память).
 * Формат файла: последовательность кадров  [длина шифртекста: uint32 BE][nonce 12][шифртекст||тег 16].
 * Каждый кусок шифруется AES-256-GCM с контекстом (id вложения, номер куска, признак последнего):
 * перестановка, удаление, дублирование и усечение (отрезание хвоста) обнаруживаются.
 */
export const CHUNK_SIZE = 1024 * 1024;
const NONCE = 12;
const TAG = 16;

async function key(raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  if (raw.length !== 32) throw new CryptoFormatError('attachment key must be 32 bytes');
  return globalThis.crypto.subtle.importKey(
    'raw',
    raw as Uint8Array<ArrayBuffer>,
    'AES-GCM',
    false,
    [usage],
  );
}

export async function encryptChunk(
  attKey: Uint8Array,
  attachmentId: string,
  index: number,
  last: boolean,
  plain: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = randomBytes(NONCE);
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: utf8(ctx('att-chunk', attachmentId, index, last ? 1 : 0)),
        tagLength: 128,
      },
      await key(attKey, 'encrypt'),
      plain as Uint8Array<ArrayBuffer>,
    ),
  );
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, ct.length);
  return concat(header, nonce, ct);
}

export async function decryptChunk(
  attKey: Uint8Array,
  attachmentId: string,
  index: number,
  last: boolean,
  frameBody: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (frameBody.length < NONCE + TAG) throw new CryptoFormatError('attachment chunk is too short');
  try {
    return new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: frameBody.slice(0, NONCE),
          additionalData: utf8(ctx('att-chunk', attachmentId, index, last ? 1 : 0)),
          tagLength: 128,
        },
        await key(attKey, 'decrypt'),
        frameBody.slice(NONCE) as Uint8Array<ArrayBuffer>,
      ),
    );
  } catch {
    throw new CryptoAuthError();
  }
}

/** Размер зашифрованного файла по размеру открытого (для проверки квот до отправки). */
export function encryptedSize(plainSize: number, chunkSize = CHUNK_SIZE): number {
  const chunks = Math.max(1, Math.ceil(plainSize / chunkSize));
  return plainSize + chunks * (4 + NONCE + TAG);
}

/** Шифрование Blob/массива целиком (для небольших файлов и тестов): возвращает кадры по порядку. */
export async function encryptAttachment(
  attKey: Uint8Array,
  attachmentId: string,
  data: Uint8Array,
  chunkSize = CHUNK_SIZE,
): Promise<Uint8Array<ArrayBuffer>> {
  const total = Math.max(1, Math.ceil(data.length / chunkSize));
  const frames: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    frames.push(
      await encryptChunk(
        attKey,
        attachmentId,
        i,
        i === total - 1,
        data.slice(i * chunkSize, (i + 1) * chunkSize),
      ),
    );
  }
  return concat(...frames);
}

/** Разбор последовательности кадров: итератор отдаёт тела кадров и признак последнего. */
export function* iterateFrames(buf: Uint8Array): Generator<{ body: Uint8Array; last: boolean }> {
  let off = 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new CryptoFormatError('truncated attachment frame header');
    const len = view.getUint32(off);
    const body = buf.subarray(off + 4, off + 4 + NONCE + len);
    if (body.length !== NONCE + len) throw new CryptoFormatError('truncated attachment frame');
    off += 4 + NONCE + len;
    yield { body, last: off >= buf.length };
  }
}

export async function decryptAttachment(
  attKey: Uint8Array,
  attachmentId: string,
  encrypted: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  let i = 0;
  for (const { body, last } of iterateFrames(encrypted)) {
    parts.push(await decryptChunk(attKey, attachmentId, i++, last, body));
  }
  if (!parts.length) throw new CryptoFormatError('empty attachment');
  return concat(...parts);
}
