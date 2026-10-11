import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true });

/** Настройки системы, изменяемые из админки. Секретные значения хранятся только зашифрованными. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

/** Ledger — журнал действий. Только добавление; секреты и ключи в него не попадают. */
export const ledger = pgTable(
  'ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull().defaultNow(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    detail: jsonb('detail'),
  },
  (t) => [index('ledger_at_idx').on(t.at)],
);

/**
 * Учётные записи. Идентификатор создаёт клиент (он входит в контекст шифрования ключей).
 * Сервер хранит только производные проверочные значения и зашифрованные ключи.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role', { enum: ['admin', 'member'] }).notNull(),
    kdf: jsonb('kdf')
      .$type<{ memoryKiB: number; iterations: number; parallelism: number }>()
      .notNull(),
    kdfSalt: text('kdf_salt').notNull(),
    authSalt: text('auth_salt').notNull(),
    authHash: text('auth_hash').notNull(),
    publicKey: text('public_key').notNull(),
    wrappedPrivateKey: text('wrapped_private_key').notNull(),
    recoverySalt: text('recovery_salt').notNull(),
    recoveryHash: text('recovery_hash').notNull(),
    recoveryWrappedPrivateKey: text('recovery_wrapped_private_key').notNull(),
    disabledAt: ts('disabled_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

/** Сессии. В БД хранится только SHA-256 токена. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    uniqueIndex('sessions_token_idx').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

/** Хранилища: личный сейф (locker) и общие (shared). */
export const vaults = pgTable('vaults', {
  id: uuid('id').primaryKey(),
  kind: text('kind', { enum: ['locker', 'shared'] }).notNull(),
  /** Название общего хранилища (открытый текст — решение зафиксировано в docs/security). У сейфа пусто. */
  name: text('name'),
  keyVersion: integer('key_version').notNull().default(1),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const vaultMembers = pgTable(
  'vault_members',
  {
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'editor', 'reader'] }).notNull(),
    sealedKey: text('sealed_key').notNull(),
    sealedKeyVersion: integer('sealed_key_version').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.vaultId, t.userId] }),
    index('vault_members_user_idx').on(t.userId),
  ],
);

/** Записи: только шифртекст. Заголовок, логин, пароль, URL — внутри шифртекста. */
export const entries = pgTable(
  'entries',
  {
    id: uuid('id').primaryKey(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    wrappedEntryKey: text('wrapped_entry_key').notNull(),
    ciphertext: text('ciphertext').notNull(),
    keyVersion: integer('key_version').notNull(),
    /** Счётчик изменений для контроля конфликтов при параллельном редактировании. */
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('entries_vault_idx').on(t.vaultId)],
);
