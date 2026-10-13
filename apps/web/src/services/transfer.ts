import {
  decrypt,
  encrypt,
  fromBase64Url,
  generateSalt,
  toBase64Url,
  utf8,
  fromUtf8,
  DEFAULT_KDF,
} from '@arklock/crypto';
import { blankEntry, type BranchItem, type EntryData, type EntryItem } from './model';
import { deriveKeys } from './kdf';

/** Импорт и экспорт. Обработка целиком на клиенте: открытые данные не покидают браузер. */

export interface ImportItem {
  data: EntryData;
  /** Путь папок (от корня). */
  path: string[];
}

export interface ImportResult {
  items: ImportItem[];
  errors: string[];
}

// ------------------------------------------------------------------ CSV

/** Разбор CSV (RFC 4180): кавычки, экранирование "", переводы строк внутри полей, BOM, разделители , ; и табуляция. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t']
    .map((d) => ({ d, n: first.split(d).length }))
    .sort((a, b) => b.n - a.n)[0]!.d;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export type CsvField =
  'title' | 'username' | 'password' | 'url' | 'notes' | 'totp' | 'folder' | 'tags' | 'ignore';
export const CSV_FIELDS: CsvField[] = [
  'title',
  'username',
  'password',
  'url',
  'notes',
  'totp',
  'folder',
  'tags',
  'ignore',
];

const HEADER_HINTS: Record<Exclude<CsvField, 'ignore'>, RegExp> = {
  title: /^(title|name|название|имя|заголовок|account|entry)$/i,
  username: /^(user(name)?|login|логин|e-?mail|пользователь)$/i,
  password: /^(pass(word)?|пароль|secret)$/i,
  url: /^(url|uri|website|site|адрес|web ?site|login_uri)$/i,
  notes: /^(notes?|comments?|заметк[аи]|описание|extra)$/i,
  totp: /^(totp|otp|2fa|login_totp|authenticator)$/i,
  folder: /^(folder|group|path|папка|группа|grouping)$/i,
  tags: /^(tags?|labels?|метки|теги)$/i,
};

export function guessCsvMapping(headers: string[]): CsvField[] {
  return headers.map(
    (h) =>
      (Object.entries(HEADER_HINTS).find(([, re]) => re.test(h.trim()))?.[0] as
        CsvField | undefined) ?? 'ignore',
  );
}

export function importCsv(rows: string[][], mapping: CsvField[], hasHeader = true): ImportResult {
  const items: ImportItem[] = [];
  const errors: string[] = [];
  rows.slice(hasHeader ? 1 : 0).forEach((r, idx) => {
    const line = idx + (hasHeader ? 2 : 1);
    const d = blankEntry('login');
    let folder = '';
    mapping.forEach((f, i) => {
      const v = (r[i] ?? '').trim();
      if (!v || f === 'ignore') return;
      if (f === 'folder') folder = v;
      else if (f === 'tags')
        d.tags = v
          .split(/[;,|]/)
          .map((t) => t.trim())
          .filter(Boolean);
      else d[f] = v;
    });
    if (!d.title && !d.username && !d.password && !d.url) {
      errors.push(`Строка ${line}: пустая запись пропущена`);
      return;
    }
    if (!d.title) d.title = hostOf(d.url) || d.username || 'Без названия';
    items.push({
      data: d,
      path: folder
        ? folder
            .split(/[\\/]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    });
  });
  return { items, errors };
}

export function hostOf(url: string): string {
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(
      /^www\./,
      '',
    );
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------ Bitwarden JSON, KeePass XML, JSON Arklock

export function importBitwardenJson(text: string): ImportResult {
  const errors: string[] = [];
  const items: ImportItem[] = [];
  const doc = JSON.parse(text) as {
    encrypted?: boolean;
    folders?: { id: string; name: string }[];
    items?: Record<string, unknown>[];
  };
  if (doc.encrypted)
    throw new Error(
      'Зашифрованный экспорт этого формата не поддерживается: выгрузите данные без шифрования.',
    );
  const folders = new Map((doc.folders ?? []).map((f) => [f.id, f.name]));
  for (const it of doc.items ?? []) {
    const d = blankEntry('login');
    d.title = String(it.name ?? '');
    d.notes = String(it.notes ?? '');
    const login = (it.login ?? {}) as {
      username?: string;
      password?: string;
      totp?: string;
      uris?: { uri?: string }[];
    };
    if (it.type === 2) d.kind = 'note';
    d.username = login.username ?? '';
    d.password = login.password ?? '';
    d.totp = login.totp ?? '';
    d.url = login.uris?.[0]?.uri ?? '';
    const fields = (it.fields ?? []) as { name?: string; value?: string; type?: number }[];
    d.fields = fields
      .filter((f) => f.name)
      .map((f) => ({ name: f.name!, value: f.value ?? '', secret: f.type === 1 }));
    if (!d.title) {
      errors.push('Запись без названия пропущена');
      continue;
    }
    const folder = folders.get(String(it.folderId ?? ''));
    items.push({ data: d, path: folder ? folder.split('/').filter(Boolean) : [] });
  }
  return { items, errors };
}

// ------------------------------------------------------------------ Passwork JSON

interface PassworkRecord {
  vaultName?: string;
  path?: { name?: string }[];
  fields?: {
    name?: string;
    login?: string;
    password?: string;
    url?: string;
    note?: string;
    custom?: { type?: string; name?: string; value?: string }[];
  };
}

/**
 * Экспорт Passwork: { passwords: [...] }. Имя сейфа Passwork становится верхней папкой, цепочка папок — путём.
 * Дополнительные поля: text → обычное поле, password и totp → скрытое поле; первый TOTP переносится в поле TOTP записи.
 */
export function importPassworkJson(text: string): ImportResult {
  const errors: string[] = [];
  const items: ImportItem[] = [];
  const doc = JSON.parse(text) as { passwords?: PassworkRecord[] };
  if (!Array.isArray(doc.passwords))
    throw new Error('В файле не найдены пароли: это не экспорт Passwork.');
  for (const p of doc.passwords) {
    const f = p.fields ?? {};
    const d = blankEntry('login');
    d.title = String(f.name ?? '').trim();
    if (!d.title) {
      errors.push('Запись без названия пропущена');
      continue;
    }
    d.username = f.login ?? '';
    d.password = f.password ?? '';
    d.url = f.url ?? '';
    d.notes = f.note ?? '';
    const fields: { name: string; value: string; secret: boolean }[] = [];
    for (const c of f.custom ?? []) {
      if (!c.name || !c.value) continue;
      if (c.type === 'totp' && !d.totp) {
        d.totp = c.value;
        continue;
      }
      fields.push({
        name: c.name,
        value: c.value,
        secret: c.type === 'password' || c.type === 'totp',
      });
    }
    d.fields = fields;
    const path = [p.vaultName || 'Passwork', ...(p.path ?? []).map((x) => x.name ?? '')];
    items.push({ data: d, path: path.filter(Boolean) });
  }
  return { items, errors };
}

export function importKeepassXml(text: string): ImportResult {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Файл XML повреждён');
  const items: ImportItem[] = [];
  const errors: string[] = [];
  const walk = (group: Element, path: string[]) => {
    for (const child of Array.from(group.children)) {
      if (child.tagName === 'Group') {
        const name = child.querySelector(':scope > Name')?.textContent ?? '';
        const skip = name === 'Recycle Bin';
        if (!skip)
          walk(
            child,
            name && path.length + 1 > 1 ? [...path, name] : name ? [...path, name] : path,
          );
      } else if (child.tagName === 'Entry') {
        const str: Record<string, string> = {};
        for (const s of Array.from(child.querySelectorAll(':scope > String'))) {
          str[s.querySelector('Key')?.textContent ?? ''] =
            s.querySelector('Value')?.textContent ?? '';
        }
        const d = blankEntry('login');
        d.title = str.Title ?? '';
        d.username = str.UserName ?? '';
        d.password = str.Password ?? '';
        d.url = str.URL ?? '';
        d.notes = str.Notes ?? '';
        d.fields = Object.entries(str)
          .filter(([k, v]) => !['Title', 'UserName', 'Password', 'URL', 'Notes'].includes(k) && v)
          .map(([name, value]) => ({ name, value, secret: false }));
        if (!d.title && !d.username && !d.password) errors.push('Пустая запись пропущена');
        else items.push({ data: d, path: path.slice(1) });
      }
    }
  };
  const root = doc.querySelector('KeePassFile > Root');
  if (!root) throw new Error('Это не экспорт KeePass 2 (XML)');
  walk(root, []);
  return { items, errors };
}

export interface ArklockExport {
  format: 'arklock-export';
  version: 1;
  exportedAt: string;
  branches: { id: string; parentId: string | null; name: string }[];
  entries: (EntryData & { branchId: string | null })[];
}

export function importArklockJson(text: string): ImportResult {
  const doc = JSON.parse(text) as ArklockExport;
  if (doc.format !== 'arklock-export' || doc.version !== 1)
    throw new Error('Неизвестный формат файла');
  const byId = new Map(doc.branches.map((b) => [b.id, b]));
  const pathOf = (id: string | null): string[] => {
    const out: string[] = [];
    let cur = id;
    const seen = new Set<string>();
    while (cur && byId.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      out.unshift(byId.get(cur)!.name);
      cur = byId.get(cur)!.parentId;
    }
    return out;
  };
  return {
    items: doc.entries.map(({ branchId, ...data }) => ({
      data: { ...blankEntry(data.kind), ...data },
      path: pathOf(branchId),
    })),
    errors: [],
  };
}

export type ImportFormat = 'csv' | 'bitwarden' | 'keepass' | 'passwork' | 'arklock' | 'encrypted';

export function detectFormat(name: string, text: string): ImportFormat {
  const t = text.trimStart();
  if (t.startsWith('{')) {
    if (/"format"\s*:\s*"arklock-encrypted"/.test(t.slice(0, 200))) return 'encrypted';
    if (/"format"\s*:\s*"arklock-export"/.test(t.slice(0, 200))) return 'arklock';
    // экспорт Passwork начинается с массива passwords (структура соответствует экспорту этого формата)
    if (/"passwords"\s*:\s*\[/.test(t.slice(0, 2000))) return 'passwork';
    return 'bitwarden';
  }
  if (t.startsWith('<')) return 'keepass';
  void name;
  return 'csv';
}

// ------------------------------------------------------------------ дубликаты

export const dupKey = (d: EntryData): string =>
  `${d.title.trim().toLowerCase()}|${d.username.trim().toLowerCase()}|${hostOf(d.url)}`;

export function findDuplicates(
  items: ImportItem[],
  existing: EntryItem[],
): { duplicateOfExisting: Set<number>; duplicateInFile: Set<number> } {
  const have = new Set(existing.map((e) => dupKey(e.data)));
  const seen = new Set<string>();
  const ex = new Set<number>();
  const inFile = new Set<number>();
  items.forEach((it, i) => {
    const k = dupKey(it.data);
    if (have.has(k)) ex.add(i);
    if (seen.has(k)) inFile.add(i);
    seen.add(k);
  });
  return { duplicateOfExisting: ex, duplicateInFile: inFile };
}

// ------------------------------------------------------------------ экспорт

const cell = (v: string): string => {
  // Защита от внедрения формул при открытии в табличных редакторах
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function exportCsv(entries: EntryItem[], pathOf: (b: string | null) => string): string {
  const header = ['title', 'username', 'password', 'url', 'notes', 'totp', 'folder', 'tags'];
  const lines = entries.map((e) =>
    [
      e.data.title,
      e.data.username,
      e.data.password,
      e.data.url,
      e.data.notes,
      e.data.totp,
      pathOf(e.branchId),
      e.data.tags.join(';'),
    ]
      .map(cell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\r\n');
}

export function exportJson(entries: EntryItem[], branches: BranchItem[]): string {
  const doc: ArklockExport = {
    format: 'arklock-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    branches: branches.map((b) => ({ id: b.id, parentId: b.parentId, name: b.name })),
    entries: entries.map((e) => ({ ...e.data, branchId: e.branchId })),
  };
  return JSON.stringify(doc, null, 2);
}

/** Зашифрованный экспорт для переноса данных: ключ выводится из парольной фразы Argon2id, формат версионирован. */
export async function exportEncrypted(json: string, passphrase: string): Promise<string> {
  const salt = generateSalt();
  const keys = await deriveKeys(passphrase, salt, 'arklock-export', DEFAULT_KDF);
  const data = await encrypt(keys.wrapKey, utf8(json), 'arklock-export-v1');
  keys.wrapKey.fill(0);
  keys.authKey.fill(0);
  return JSON.stringify({
    format: 'arklock-encrypted',
    version: 1,
    kdf: DEFAULT_KDF,
    salt: toBase64Url(salt),
    data,
  });
}

export async function decryptExport(text: string, passphrase: string): Promise<string> {
  const doc = JSON.parse(text) as {
    format: string;
    version: number;
    kdf: typeof DEFAULT_KDF;
    salt: string;
    data: string;
  };
  if (doc.format !== 'arklock-encrypted' || doc.version !== 1)
    throw new Error('Неизвестный формат файла');
  const keys = await deriveKeys(passphrase, fromBase64Url(doc.salt), 'arklock-export', doc.kdf);
  try {
    return fromUtf8(await decrypt(keys.wrapKey, doc.data, 'arklock-export-v1'));
  } finally {
    keys.wrapKey.fill(0);
    keys.authKey.fill(0);
  }
}
