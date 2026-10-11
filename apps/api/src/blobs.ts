import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OVERRUN_LIMIT = 1024 * 1024;

export class BlobSizeError extends Error {
  constructor(public readonly got: number) {
    super('blob size mismatch');
  }
}

/**
 * Файловое хранилище зашифрованных вложений. Файлы лежат как <каталог>/<первые 2 символа id>/<id>;
 * сервер видит только шифртекст. Запись идёт во временный файл и атомарно переименовывается.
 */
export class BlobStore {
  constructor(public readonly dir: string) {}

  get enabled(): boolean {
    return this.dir !== '';
  }

  private file(id: string, suffix = ''): string {
    // id приходит из проверенного UUID; повторная проверка исключает выход из каталога при любой ошибке вызывающего
    if (!UUID.test(id)) throw new Error('invalid blob id');
    return path.join(this.dir, id.slice(0, 2).toLowerCase(), id.toLowerCase() + suffix);
  }

  /** Принимает поток ровно `expected` байт. При несовпадении временный файл удаляется. */
  async write(id: string, input: Readable, expected: number, suffix = ''): Promise<void> {
    const target = this.file(id, suffix);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
    const tmp = `${target}.part`;
    let seen = 0;
    // Лишние данные отбрасываются (чтобы ответ об ошибке дошёл до клиента); при заведомо чрезмерной отправке соединение обрывается.
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length;
        if (seen > expected + OVERRUN_LIMIT) return cb(new BlobSizeError(seen));
        if (seen > expected) return cb();
        cb(null, chunk);
      },
    });
    try {
      await pipeline(input, counter, createWriteStream(tmp, { mode: 0o640 }));
      if (seen !== expected) throw new BlobSizeError(seen);
      await rename(tmp, target);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  read(id: string, suffix = ''): Readable {
    return createReadStream(this.file(id, suffix));
  }

  async size(id: string, suffix = ''): Promise<number | null> {
    try {
      return (await stat(this.file(id, suffix))).size;
    } catch {
      return null;
    }
  }

  /** Удаляет одну версию файла (после ротации ключа прежняя версия не нужна). */
  async removeVersion(id: string, suffix: string): Promise<void> {
    if (!this.enabled) return;
    await rm(this.file(id, suffix), { force: true });
    await rm(this.file(id, suffix + '.part'), { force: true });
  }

  /** Удаляет все версии файла вложения. */
  async remove(ids: string[]): Promise<void> {
    if (!this.enabled) return;
    for (const id of ids) {
      const dir = path.dirname(this.file(id));
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const n of names)
        if (n.toLowerCase().startsWith(id.toLowerCase()))
          await rm(path.join(dir, n), { force: true });
    }
  }

  /** Все файлы в хранилище: id, суффикс, размер и возраст (для сверки с базой). */
  async scan(): Promise<{ id: string; suffix: string; size: number; mtimeMs: number }[]> {
    if (!this.enabled) return [];
    const out: { id: string; suffix: string; size: number; mtimeMs: number }[] = [];
    let dirs: string[] = [];
    try {
      dirs = await readdir(this.dir);
    } catch {
      return out;
    }
    for (const d of dirs) {
      let names: string[] = [];
      try {
        names = await readdir(path.join(this.dir, d));
      } catch {
        continue;
      }
      for (const n of names) {
        const m = /^([0-9a-f-]{36})(\..+)?$/i.exec(n);
        if (!m || !UUID.test(m[1]!)) continue;
        const st = await stat(path.join(this.dir, d, n)).catch(() => null);
        if (st?.isFile())
          out.push({
            id: m[1]!.toLowerCase(),
            suffix: m[2] ?? '',
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
      }
    }
    return out;
  }
}
