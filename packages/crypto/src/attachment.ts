import { decrypt, encrypt, generateKey } from './aead.js';
import {
  CryptoAuthError,
  CryptoFormatError,
  concat,
  fromUtf8,
  randomBytes,
  utf8,
} from './bytes.js';
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

export interface AttachmentMeta {
  name: string;
  type: string;
  size: number;
}

export interface SealedAttachment {
  id: string;
  wrappedKey: string;
  metaCipher: string;
  keyVersion: number;
  /** Зашифрованный файл (кадры), его длина — объявляемый серверу размер. */
  file: Uint8Array<ArrayBuffer>;
}

/** Шифрует файл новым ключом вложения; ключ вложения оборачивается ключом хранилища, метаданные шифруются ключом вложения. */
export async function sealAttachment(
  vaultKey: Uint8Array,
  vaultId: string,
  keyVersion: number,
  meta: AttachmentMeta,
  data: Uint8Array,
  id: string = globalThis.crypto.randomUUID(),
): Promise<SealedAttachment> {
  const ak = generateKey();
  try {
    return {
      id,
      keyVersion,
      wrappedKey: await encrypt(vaultKey, ak, ctx('att-key', vaultId, id, keyVersion)),
      metaCipher: await encrypt(ak, utf8(JSON.stringify(meta)), ctx('att-meta', vaultId, id)),
      file: await encryptAttachment(ak, id, data),
    };
  } finally {
    ak.fill(0);
  }
}

/** Разворачивает ключ вложения (его надо обнулить после использования). */
export function openAttachmentKey(
  vaultKey: Uint8Array,
  vaultId: string,
  att: { id: string; wrappedKey: string; keyVersion: number },
): Promise<Uint8Array<ArrayBuffer>> {
  return decrypt(vaultKey, att.wrappedKey, ctx('att-key', vaultId, att.id, att.keyVersion));
}

export async function openAttachmentMeta(
  vaultKey: Uint8Array,
  vaultId: string,
  att: { id: string; wrappedKey: string; metaCipher: string; keyVersion: number },
): Promise<AttachmentMeta> {
  const ak = await openAttachmentKey(vaultKey, vaultId, att);
  try {
    const raw = await decrypt(ak, att.metaCipher, ctx('att-meta', vaultId, att.id));
    const m = JSON.parse(fromUtf8(raw)) as Partial<AttachmentMeta>;
    return {
      name: typeof m.name === 'string' ? m.name : 'file',
      type: typeof m.type === 'string' ? m.type : '',
      size: typeof m.size === 'number' ? m.size : 0,
    };
  } finally {
    ak.fill(0);
  }
}

export async function openAttachmentFile(
  vaultKey: Uint8Array,
  vaultId: string,
  att: { id: string; wrappedKey: string; keyVersion: number },
  encrypted: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const ak = await openAttachmentKey(vaultKey, vaultId, att);
  try {
    return await decryptAttachment(ak, att.id, encrypted);
  } finally {
    ak.fill(0);
  }
}

/** Перешифровывает вложение новым ключом хранилища (при ротации): новый ключ вложения, новые метаданные и файл. */
export async function rewrapAttachment(
  oldVaultKey: Uint8Array,
  newVaultKey: Uint8Array,
  vaultId: string,
  att: { id: string; wrappedKey: string; metaCipher: string; keyVersion: number },
  encrypted: Uint8Array,
  newKeyVersion: number,
): Promise<SealedAttachment> {
  const meta = await openAttachmentMeta(oldVaultKey, vaultId, att);
  const plain = await openAttachmentFile(oldVaultKey, vaultId, att, encrypted);
  try {
    return await sealAttachment(newVaultKey, vaultId, newKeyVersion, meta, plain, att.id);
  } finally {
    plain.fill(0);
  }
}

// ------------------------------------------------------------------ потоковая обработка (постоянная память)

/** Число кусков шифрования для файла данного размера (пустой файл — один пустой кусок). */
export const chunkCount = (plainSize: number, chunkSize = CHUNK_SIZE): number =>
  Math.max(1, Math.ceil(plainSize / chunkSize));

/**
 * Потоковое расшифрование: принимает байты из сети порциями любого размера и отдаёт открытые куски по мере готовности.
 * Последний кадр заранее неизвестен, поэтому кадр обрабатывается, когда пришёл следующий или поток закончился (finish).
 * Подмена, перестановка, удаление и усечение обнаруживаются так же, как при расшифровании целиком.
 */
export class AttachmentDecryptor {
  private buf = new Uint8Array(0);
  private held: Uint8Array | null = null;
  private index = 0;

  constructor(
    private readonly attKey: Uint8Array,
    private readonly attachmentId: string,
  ) {}

  private frames(): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0);
      if (len > CHUNK_SIZE + TAG) throw new CryptoFormatError('attachment frame is too large');
      const total = 4 + NONCE + len;
      if (this.buf.length < total) break;
      out.push(this.buf.slice(4, total));
      this.buf = this.buf.subarray(total);
    }
    return out;
  }

  async push(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>[]> {
    this.buf = this.buf.length ? concat(this.buf, bytes) : bytes.slice();
    const out: Uint8Array<ArrayBuffer>[] = [];
    for (const frame of this.frames()) {
      if (this.held)
        out.push(
          await decryptChunk(this.attKey, this.attachmentId, this.index++, false, this.held),
        );
      this.held = frame;
    }
    return out;
  }

  async finish(): Promise<Uint8Array<ArrayBuffer>[]> {
    if (this.buf.length) throw new CryptoFormatError('truncated attachment');
    if (!this.held) throw new CryptoFormatError('empty attachment');
    const last = await decryptChunk(this.attKey, this.attachmentId, this.index++, true, this.held);
    this.held = null;
    return [last];
  }
}

/** Файл → кадры по одному, не загружая его целиком: куски читаются через slice. */
export async function* encryptStream(
  attKey: Uint8Array,
  attachmentId: string,
  size: number,
  readSlice: (start: number, end: number) => Promise<Uint8Array>,
  chunkSize = CHUNK_SIZE,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const total = chunkCount(size, chunkSize);
  for (let i = 0; i < total; i++) {
    const plain = await readSlice(i * chunkSize, Math.min(size, (i + 1) * chunkSize));
    yield await encryptChunk(attKey, attachmentId, i, i === total - 1, plain);
  }
}

/** Заголовок вложения для ступенчатой загрузки: новый ключ вложения, обёрнутый ключом хранилища, и зашифрованные метаданные. */
export async function beginAttachment(
  vaultKey: Uint8Array,
  vaultId: string,
  keyVersion: number,
  meta: AttachmentMeta,
  id: string = globalThis.crypto.randomUUID(),
): Promise<{ id: string; ak: Uint8Array<ArrayBuffer>; wrappedKey: string; metaCipher: string }> {
  const ak = generateKey();
  return {
    id,
    ak,
    wrappedKey: await encrypt(vaultKey, ak, ctx('att-key', vaultId, id, keyVersion)),
    metaCipher: await encrypt(ak, utf8(JSON.stringify(meta)), ctx('att-meta', vaultId, id)),
  };
}

/**
 * Потоковое перешифрование файла под другой ключ вложения (ротация ключа хранилища) с постоянным расходом памяти:
 * кадры старого файла поступают порциями, кадры нового отдаются по мере готовности.
 */
export class AttachmentReencryptor {
  private readonly dec: AttachmentDecryptor;
  private index = 0;

  constructor(
    oldKey: Uint8Array,
    private readonly newKey: Uint8Array,
    private readonly attachmentId: string,
  ) {
    this.dec = new AttachmentDecryptor(oldKey, attachmentId);
  }

  async push(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>[]> {
    const out: Uint8Array<ArrayBuffer>[] = [];
    for (const plain of await this.dec.push(bytes))
      out.push(await encryptChunk(this.newKey, this.attachmentId, this.index++, false, plain));
    return out;
  }

  async finish(): Promise<Uint8Array<ArrayBuffer>[]> {
    const out: Uint8Array<ArrayBuffer>[] = [];
    for (const plain of await this.dec.finish())
      out.push(await encryptChunk(this.newKey, this.attachmentId, this.index++, true, plain));
    return out;
  }
}
