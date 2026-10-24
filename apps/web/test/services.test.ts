import { describe, expect, it } from 'vitest';
import { checkPolicy, policyFrom } from '../src/services/policy';
import { inspect } from '../src/services/inspector';
import {
  decryptExport,
  detectFormat,
  exportCsv,
  exportEncrypted,
  exportJson,
  findDuplicates,
  guessCsvMapping,
  importArklockJson,
  importBitwardenJson,
  importCsv,
  parseCsv,
} from '../src/services/transfer';
import { blankEntry, type EntryItem } from '../src/services/model';

const item = (id: string, over: Partial<EntryItem['data']> = {}): EntryItem => ({
  id,
  vaultId: 'v',
  branchId: null,
  version: 1,
  keyVersion: 1,
  access: 'manager',
  pinned: false,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  data: { ...blankEntry(), title: id, ...over },
});

describe('password policy', () => {
  it('checks length and character classes', () => {
    expect(checkPolicy('abc', { minLength: 8, classes: 0 })).toEqual(['length']);
    expect(checkPolicy('abcdefgh', { minLength: 8, classes: 2 })).toEqual(['classes']);
    expect(checkPolicy('Abcdefg1', { minLength: 8, classes: 3 })).toEqual([]);
    expect(checkPolicy('пароль-С-цифрой1', { minLength: 8, classes: 4 })).toEqual([]);
    expect(checkPolicy('x', { minLength: 0, classes: 0 })).toEqual([]);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(checkPolicy('😀😀😀😀', { minLength: 4, classes: 0 })).toEqual([]);
    expect(checkPolicy('😀😀😀', { minLength: 4, classes: 0 })).toEqual(['length']);
  });

  it('ignores invalid values from the server', () => {
    expect(policyFrom({ 'policy.password.minLength': 'x', 'policy.password.classes': -1 })).toEqual(
      { minLength: 0, classes: 0, maxRepeat: 0 },
    );
    expect(
      policyFrom({ 'policy.password.minLength': 99999, 'policy.password.classes': 9 }),
    ).toEqual({ minLength: 128, classes: 4, maxRepeat: 0 });
  });
});

describe('security inspector', () => {
  const now = new Date('2026-10-12T00:00:00Z');

  it('finds weak, reused, old and expired items and ignores notes', () => {
    const list = [
      item('weak', { password: '123456' }),
      item('a', { password: 'Correct-Horse-Battery-9!' }),
      item('b', { password: 'Correct-Horse-Battery-9!' }),
      item('old', {
        password: 'Another-Strong-One-77#',
        passwordChangedAt: '2025-01-01T00:00:00Z',
      }),
      item('exp', { password: 'Yet-Another-Strong-55$', expiresAt: '2026-01-01' }),
      item('note', { kind: 'note', password: '1' }),
    ];
    const issues = inspect(list, { maxAgeDays: 365, now });
    const has = (id: string, type: string) =>
      issues.some((i) => i.entryId === id && i.type === type);
    expect(has('weak', 'weak')).toBe(true);
    expect(has('a', 'reused') && has('b', 'reused')).toBe(true);
    expect(has('old', 'old')).toBe(true);
    expect(has('exp', 'expired')).toBe(true);
    expect(issues.some((i) => i.entryId === 'note')).toBe(false);
    expect(inspect(list, { maxAgeDays: 0, now }).some((i) => i.type === 'old')).toBe(false);
  });
});

describe('import and export', () => {
  it('parses CSV with quotes, embedded separators and a byte-order mark', () => {
    const rows = parseCsv('﻿name,url,username,password\n"Site, one",https://a.test,u,"p""w"\n');
    expect(rows[0]![0]).toBe('name');
    expect(rows[1]).toEqual(['Site, one', 'https://a.test', 'u', 'p"w']);
  });

  it('maps columns and imports entries', () => {
    const rows = parseCsv(
      'name,url,username,password,notes\nBank,https://bank.test/login,me,secret,hello\n',
    );
    const res = importCsv(rows, guessCsvMapping(rows[0]!), true);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.data).toMatchObject({
      title: 'Bank',
      username: 'me',
      password: 'secret',
      notes: 'hello',
    });
  });

  it('detects formats and imports Bitwarden and Arklock JSON', () => {
    const bw = JSON.stringify({
      items: [
        {
          type: 1,
          name: 'BW',
          login: { username: 'u', password: 'p', uris: [{ uri: 'https://x.test' }] },
        },
      ],
    });
    expect(detectFormat('export.json', bw)).toBe('bitwarden');
    expect(importBitwardenJson(bw).items[0]!.data).toMatchObject({
      title: 'BW',
      username: 'u',
      password: 'p',
    });
    const json = exportJson([item('one', { password: 'pw' })], []);
    expect(detectFormat('x.json', json)).toBe('arklock');
    expect(importArklockJson(json).items[0]!.data.password).toBe('pw');
  });

  it('finds duplicates of existing entries and inside the file', () => {
    const existing = [item('Bank', { username: 'me', url: 'https://bank.test' })];
    const incoming = importCsv(
      parseCsv(
        'name,url,username,password\nBank,https://bank.test,me,x\nNew,https://new.test,me,y\nNew,https://new.test,me,z\n',
      ),
      ['title', 'url', 'username', 'password'],
      true,
    );
    const { duplicateOfExisting, duplicateInFile } = findDuplicates(incoming.items, existing);
    expect([...duplicateOfExisting]).toEqual([0]);
    expect([...duplicateInFile]).toEqual([2]);
  });

  it('CSV export protects against formula injection', () => {
    const csv = exportCsv([item('x', { title: '=cmd|calc', password: '+1' })], () => '');
    expect(csv).toContain(`"'=cmd|calc"`);
    expect(csv).toContain(`"'+1"`);
  });

  it('the encrypted export round-trips and rejects a wrong passphrase', async () => {
    const json = exportJson([item('one', { password: 'pw-secret-value' })], []);
    const enc = await exportEncrypted(json, 'correct horse battery');
    expect(enc).not.toContain('pw-secret-value');
    expect(await decryptExport(enc, 'correct horse battery')).toBe(json);
    await expect(decryptExport(enc, 'wrong passphrase')).rejects.toBeDefined();
  });
});

describe('Passwork JSON import', () => {
  // структура экспорта Passwork (passwords / vaultName / path / fields / custom), данные — свои
  const passwork = JSON.stringify({
    passwords: [
      {
        id: 'p1',
        fields: {
          name: 'Почта',
          login: 'anna',
          password: 'pw-1',
          url: 'https://mail.example.com',
          note: 'заметка',
        },
        vaultName: 'Офис',
        path: [{ name: 'Почта', parentId: null, id: 'f1' }],
      },
      {
        id: 'p2',
        fields: {
          name: 'Сервер',
          login: 'ops',
          password: 'pw-2',
          custom: [
            { name: 'Доп. логин', value: 'ops-2', type: 'text' },
            { name: 'Доп. пароль', value: 'pw-3', type: 'password' },
            { name: 'Код', value: 'JBSWY3DPEHPK3PXP', type: 'totp' },
          ],
        },
        vaultName: 'Офис',
      },
      { id: 'p3', fields: { name: '', login: 'x' }, vaultName: 'Офис' },
    ],
  });

  it('is detected, maps folders from the vault name, custom fields and TOTP, and reports skipped records', async () => {
    const { detectFormat: detect, importPassworkJson } = await import('../src/services/transfer');
    expect(detect('export.json', passwork)).toBe('passwork');
    const r = importPassworkJson(passwork);
    expect(r.errors).toEqual(['Запись без названия пропущена']);
    expect(r.items).toHaveLength(2);
    const [mail, server] = r.items;
    expect(mail!.path).toEqual(['Офис', 'Почта']);
    expect(mail!.data).toMatchObject({
      title: 'Почта',
      username: 'anna',
      password: 'pw-1',
      url: 'https://mail.example.com',
      notes: 'заметка',
    });
    expect(server!.path).toEqual(['Офис']);
    expect(server!.data.totp).toBe('JBSWY3DPEHPK3PXP');
    expect(server!.data.fields).toEqual([
      { name: 'Доп. логин', value: 'ops-2', secret: false },
      { name: 'Доп. пароль', value: 'pw-3', secret: true },
    ]);
  });

  it('refuses a file without passwords', async () => {
    const { importPassworkJson } = await import('../src/services/transfer');
    expect(() => importPassworkJson('{"items":[]}')).toThrow(/не экспорт Passwork/);
  });
});

describe('значки папок и записей', () => {
  it('в данные проходят только известный значок, цвет и PNG; остальное отбрасывается', async () => {
    const { cleanIcon } = await import('../src/services/objectIcons');
    expect(cleanIcon({ name: 'bank', color: 'green' })).toEqual({ name: 'bank', color: 'green' });
    expect(cleanIcon({ name: 'nope', color: 'purple' })).toBeUndefined();
    expect(cleanIcon({ image: 'data:image/svg+xml;base64,PHN2Zz4=' })).toBeUndefined();
    expect(cleanIcon({ image: 'javascript:alert(1)' })).toBeUndefined();
    expect(cleanIcon({ image: 'data:image/png;base64,iVBORw0KGgo=' })).toEqual({
      image: 'data:image/png;base64,iVBORw0KGgo=',
    });
    expect(cleanIcon({ image: 'data:image/png;base64,' + 'A'.repeat(20_000) })).toBeUndefined();
    expect(cleanIcon('bank')).toBeUndefined();
  });

  it('значки записей и папок переживают выгрузку и загрузку Arklock', () => {
    const json = exportJson(
      [item('one', { icon: { name: 'server', color: 'blue' } })],
      [
        {
          id: 'b1',
          parentId: null,
          name: 'Банки',
          version: 1,
          access: 'manager',
          deletedAt: null,
          icon: { name: 'bank', color: 'green' },
        },
      ],
    );
    const back = importArklockJson(json);
    expect(back.items[0]!.data.icon).toEqual({ name: 'server', color: 'blue' });
    expect(back.folderIcons).toEqual({ Банки: { name: 'bank', color: 'green' } });
  });
});

describe('password policy: identical characters in a row', () => {
  it('counts runs by Unicode characters and reports only above the limit', async () => {
    const { checkPolicy, policyFrom } = await import('../src/services/policy');
    const p = { minLength: 0, classes: 0, maxRepeat: 2 };
    expect(checkPolicy('aab', p)).toEqual([]);
    expect(checkPolicy('aaab', p)).toEqual(['repeat']);
    expect(checkPolicy('👍👍👍', p)).toEqual(['repeat']); // суррогатные пары — один символ
    expect(checkPolicy('aaaa', { ...p, maxRepeat: 0 })).toEqual([]);
    expect(policyFrom({ 'policy.password.maxRepeat': 99 }).maxRepeat).toBe(20);
  });
});

describe('виды дополнительных полей', () => {
  it('сохраняет известный вид, отбрасывает чужой, поле TOTP всегда секретное', async () => {
    const { normalizeEntry } = await import('../src/services/model');
    const d = normalizeEntry({
      fields: [
        { name: 'a', value: '1\n2', secret: false, type: 'multiline' },
        { name: 'b', value: 'JBSWY3DPEHPK3PXP', secret: false, type: 'totp' },
        { name: 'c', value: 'x', secret: true, type: 'script' },
        { name: 'd', value: 'y' },
      ],
    });
    expect(d.fields).toEqual([
      { name: 'a', value: '1\n2', secret: false, type: 'multiline' },
      { name: 'b', value: 'JBSWY3DPEHPK3PXP', secret: true, type: 'totp' },
      { name: 'c', value: 'x', secret: true },
      { name: 'd', value: 'y', secret: false },
    ]);
  });
});

describe('генератор организации', () => {
  it('берёт допустимые значения, отбрасывает непечатные символы, без классов включает все', async () => {
    const { generatorFrom } = await import('../src/services/policy');
    expect(generatorFrom({})).toEqual({
      length: 20,
      lower: true,
      upper: true,
      digits: true,
      symbols: true,
      exclude: '',
    });
    expect(
      generatorFrom({
        'generator.length': 32,
        'generator.symbols': false,
        'generator.exclude': 'O0 l1\n',
      }),
    ).toMatchObject({ length: 32, symbols: false, exclude: 'O0l1' });
    expect(generatorFrom({ 'generator.length': 4 }).length).toBe(20);
    const none = generatorFrom({
      'generator.lower': false,
      'generator.upper': false,
      'generator.digits': false,
      'generator.symbols': false,
    });
    expect([none.lower, none.upper, none.digits, none.symbols]).toEqual([true, true, true, true]);
  });
});
