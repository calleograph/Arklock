import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat, truncate } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OVERRUN_LIMIT = 1024 * 1024;

export class BlobOffsetError extends Error {
  constructor(public readonly actual: number) {
    super('blob offset mismatch');
  }
}

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

  /**
   * Дописывает часть файла (кадр) в файл незавершённой загрузки. Смещение должно совпадать с текущим размером:
   * повтор уже принятой части и пропуск отвергаются; при сбое файл возвращается к прежнему размеру.
   */
  async appendPart(
    id: string,
    suffix: string,
    input: Readable,
    offset: number,
    maxBytes: number,
  ): Promise<number> {
    const target = `${this.file(id, suffix)}.up`;
    await mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
    const current = await stat(target).then(
      (s) => s.size,
      () => 0,
    );
    if (current !== offset) throw new BlobOffsetError(current);
    let seen = 0;
    // Лишнее отбрасывается без обрыва соединения (клиент получает ответ); заведомо чрезмерная отправка обрывается
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length;
        if (seen > maxBytes + OVERRUN_LIMIT) return cb(new BlobSizeError(seen));
        if (seen > maxBytes) return cb();
        cb(null, chunk);
      },
    });
    try {
      await pipeline(input, counter, createWriteStream(target, { flags: 'a', mode: 0o640 }));
      if (seen > maxBytes) throw new BlobSizeError(seen);
    } catch (e) {
      await truncate(target, current).catch(() => undefined);
      throw e;
    }
    return current + seen;
  }

  async uploadedSize(id: string, suffix: string): Promise<number> {
    return stat(`${this.file(id, suffix)}.up`).then(
      (s) => s.size,
      () => 0,
    );
  }

  /** Завершает ступенчатую загрузку: размер должен совпасть с объявленным. */
  async finalizeUpload(id: string, suffix: string, expected: number): Promise<void> {
    const up = `${this.file(id, suffix)}.up`;
    const size = await stat(up).then(
      (s) => s.size,
      () => -1,
    );
    if (size !== expected) throw new BlobSizeError(size);
    await rename(up, this.file(id, suffix));
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

  /** Publish an isolated rotation upload while the caller holds the vault transaction lock. */
  async promote(id: string, stagedSuffix: string, liveSuffix: string): Promise<void> {
    await copyFile(this.file(id, stagedSuffix), this.file(id, liveSuffix));
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
