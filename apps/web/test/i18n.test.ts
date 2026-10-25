import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_STATES } from '@arklock/contracts';
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
      k.startsWith('files.') ||
      k.startsWith('offsite.') ||
      k === 'admin.tab.storage' ||
      k === 'admin.group.storage' ||
      k.startsWith('guides.');
    const hits = Object.entries(ru).filter(([k, v]) => /хранилищ/i.test(v) && !ok(k));
    expect(hits).toEqual([]);
  });

  it('в английском тексте сейф — vault, без «locker» и «circle»', () => {
    expect(Object.entries(en).filter(([, v]) => /locker|circle/i.test(v))).toEqual([]);
  });

  it('каждый ключ, написанный в коде буквально, есть в словаре', () => {
    const src = path.resolve(__dirname, '../src');
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) =>
      /\.(vue|ts)$/.test(f),
    );
    const missing = new Set<string>();
    for (const f of files) {
      const code = readFileSync(path.join(src, f), 'utf8');
      // у компонента может быть свой словарь (useScope: 'local'): его разделы проверяет сам компонент
      const local = code.includes("useScope: 'local'")
        ? new Set([...code.matchAll(/^ {6}(\w+): \{/gm)].map((m) => m[1]))
        : new Set<string>();
      for (const m of code.matchAll(/\bt\(\s*'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g))
        if (!(m[1]! in ru) && !local.has(m[1]!.split('.')[0])) missing.add(`${f}: ${m[1]}`);
    }
    expect([...missing]).toEqual([]);
  });

  it('у каждого состояния диагностики есть заголовок и описание на обоих языках', () => {
    for (const state of DIAGNOSTIC_STATES) {
      const key = state.replace(/-/g, '_');
      for (const dict of [ru, en]) {
        expect(dict[`diag.${key.split('.')[0]}.title`], state).toBeTruthy();
        expect(dict[`diag.${key}.detail`], state).toBeTruthy();
        // у проблем — причина и что делать
        if (!state.endsWith('.ok')) {
          expect(dict[`diag.${key}.cause`], state).toBeTruthy();
          expect(dict[`diag.${key}.fix`], state).toBeTruthy();
        }
      }
    }
  });

  it('у каждого раздела администрирования есть название', () => {
    const view = readFileSync(path.resolve(__dirname, '../src/views/AdminView.vue'), 'utf8');
    const list = view.match(/const ALL_TABS: Tab\[\] = \[([^\]]+)\]/)![1]!;
    const tabs = [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]!);
    expect(tabs.length).toBeGreaterThan(10);
    expect(tabs.filter((x) => !(`admin.tab.${x}` in ru))).toEqual([]);
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
