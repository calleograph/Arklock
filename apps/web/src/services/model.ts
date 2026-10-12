/** Модель расшифрованных данных рабочего пространства. Существует только в памяти браузера. */

export type EntryKind = 'login' | 'note' | 'server' | 'apikey' | 'custom';

export const ENTRY_KINDS: EntryKind[] = ['login', 'note', 'server', 'apikey', 'custom'];

export interface CustomField {
  name: string;
  value: string;
  /** Секретное поле: скрывается по умолчанию, значение не показывается без действия пользователя. */
  secret: boolean;
}

export interface EntryData {
  kind: EntryKind;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  /** otpauth://totp/… или Base32-секрет. */
  totp: string;
  fields: CustomField[];
  tags: string[];
  /** Когда пароль менялся последний раз (ISO), для контроля срока. */
  passwordChangedAt?: string;
  /** Срок действия пароля/ключа (ISO-дата). */
  expiresAt?: string;
  /** Связанные записи этого хранилища (идентификаторы). Хранятся внутри зашифрованного содержимого: сервер связей не видит. */
  links?: string[];
}

export const blankEntry = (kind: EntryKind = 'login'): EntryData => ({
  kind,
  title: '',
  username: '',
  password: '',
  url: '',
  notes: '',
  totp: '',
  fields: [],
  tags: [],
});

/** Приведение расшифрованных данных (в том числе старого формата) к актуальной модели. */
export function normalizeEntry(raw: unknown): EntryData {
  const r = (raw ?? {}) as Partial<EntryData>;
  return {
    ...blankEntry(ENTRY_KINDS.includes(r.kind as EntryKind) ? (r.kind as EntryKind) : 'login'),
    ...r,
    fields: Array.isArray(r.fields)
      ? r.fields.map((f) => ({
          name: String(f.name ?? ''),
          value: String(f.value ?? ''),
          secret: !!f.secret,
        }))
      : [],
    tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
    links: Array.isArray(r.links) ? r.links.map(String).slice(0, 50) : [],
  };
}

export interface EntryItem {
  id: string;
  vaultId: string;
  branchId: string | null;
  version: number;
  keyVersion: number;
  access: 'reader' | 'editor' | 'manager';
  pinned: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  data: EntryData;
}

export interface BranchItem {
  id: string;
  parentId: string | null;
  name: string;
  version: number;
  access: 'reader' | 'editor' | 'manager';
  deletedAt: string | null;
}

/** Текст для поиска по записи (секретные поля и пароль в индекс не входят). */
export function searchText(e: EntryData): string {
  return [
    e.title,
    e.username,
    e.url,
    e.notes,
    e.tags.join(' '),
    ...e.fields.filter((f) => !f.secret).flatMap((f) => [f.name, f.value]),
  ]
    .join(' ')
    .toLowerCase();
}
