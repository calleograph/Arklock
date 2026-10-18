import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { i18n } from '../src/i18n';
import { ApiError } from '../src/services/api';
import { errorMessage } from '../src/services/helpers';

type Tree = { [k: string]: string | Tree };
function flat(t: Tree, p = '', o: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(t)) {
    if (typeof v === 'string') o[p + k] = v;
    else flat(v, p + k + '.', o);
  }
  return o;
}
const ru = flat(i18n.global.getLocaleMessage('ru') as unknown as Tree);
const en = flat(i18n.global.getLocaleMessage('en') as unknown as Tree);

describe('единый словарь терминов', () => {
  it('русский и английский словари содержат одни и те же ключи', () => {
    expect(Object.keys(en).filter((k) => !(k in ru))).toEqual([]);
    expect(Object.keys(ru).filter((k) => !(k in en))).toEqual([]);
  });

  it('в русском тексте нет запрещённых слов и внутренних имён параметров', () => {
    const banned = /круг|грант|ротаци|допуск|locker|APP_[A-Z_]+|SESSION_[A-Z_]+/i;
    const hits = Object.entries(ru).filter(([, v]) => banned.test(v));
    expect(hits).toEqual([]);
  });

  it('«хранилище» в русском тексте означает только хранилище файлов или копий, а сейф называется сейфом', () => {
    const ok = (k: string) =>
      k.startsWith('files.') || k.startsWith('offsite.') || k === 'admin.tab.storage';
    const hits = Object.entries(ru).filter(([k, v]) => /хранилищ/i.test(v) && !ok(k));
    expect(hits).toEqual([]);
  });

  it('в английском тексте сейф — vault, без «locker» и «circle»', () => {
    expect(Object.entries(en).filter(([, v]) => /locker|circle/i.test(v))).toEqual([]);
  });

  it('страница помощи ссылается только на существующие файлы документации', () => {
    const docs = Object.entries(ru).filter(([k]) => /^help\.docs\..+\.file$/.test(k));
    expect(docs.length).toBeGreaterThan(5);
    for (const [, file] of docs) {
      expect(existsSync(path.resolve(__dirname, '../../../docs', file)), file).toBe(true);
    }
  });
});

describe('сообщения об ошибках', () => {
  const t = (key: string) => key;
  it('отказ в правах объясняется, а не «что-то пошло не так»', () => {
    expect(errorMessage(new ApiError(403, 'forbidden', 'x'), t)).toBe('error.forbidden');
    expect(errorMessage(new ApiError(404, 'not_found', 'x'), t)).toBe('error.notFound');
  });
  it('неизвестный код разбирается по статусу', () => {
    expect(errorMessage(new ApiError(403, 'something_new', 'x'), t)).toBe('error.forbidden');
    expect(errorMessage(new ApiError(500, 'oops', 'x'), t)).toBe('error.server');
    expect(errorMessage(new ApiError(429, 'oops', 'x'), t)).toBe('auth.locked');
  });
  it('ключ сейфа ещё не передан — объясняется отдельным текстом', () => {
    expect(errorMessage(new ApiError(409, 'key_missing', 'x'), t)).toBe('error.keyMissing');
  });
});
