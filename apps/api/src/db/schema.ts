import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
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

/**
 * Лёгкая история ресурсов сервера для графиков в панели: одна строка в несколько минут, хранится 14 дней.
 * Это не система мониторинга: только нагрузка, память, самый заполненный диск и размер базы.
 */
export const metricSamples = pgTable('metric_samples', {
  at: ts('at').primaryKey(),
  cpuPct: integer('cpu_pct').notNull(),
  memPct: integer('mem_pct').notNull(),
  diskPct: integer('disk_pct').notNull(),
  dbBytes: bigint('db_bytes', { mode: 'number' }).notNull(),
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
  // журнал объекта выбирает события по target: без индекса — полный просмотр журнала
  (t) => [index('ledger_at_idx').on(t.at), index('ledger_target_idx').on(t.target, t.id)],
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
    /** Открытый ключ шифрования (ECDH P-256) и ключ подписи (ECDSA P-256). */
    publicKey: text('public_key').notNull(),
    signPublicKey: text('sign_public_key').notNull(),
    wrappedPrivateKey: text('wrapped_private_key').notNull(),
    wrappedSignPrivateKey: text('wrapped_sign_private_key').notNull(),
    /** Административная роль (делегирование разделов панели) вместо полного доступа. */
    adminRoleId: uuid('admin_role_id'),
    /** Главный администратор: назначает и снимает полных администраторов; роль только передаётся, не теряется. */
    chief: boolean('chief').notNull().default(false),
    /** Когда назначен главным администратором (null у не главных). */
    chiefSince: ts('chief_since'),
    /** Карточка сотрудника. Сведения справочные: доступ по ним не выдаётся. */
    title: text('title'),
    department: text('department'),
    phone: text('phone'),
    /** Откуда поле карточки: ldap — из каталога (в панели не меняется), иначе задано вручную. */
    profileSource: jsonb('profile_source').$type<Record<string, 'ldap'>>().notNull().default({}),
    /** Цветовая тема интерфейса (личная настройка; к шифруемым данным не относится). */
    theme: text('theme'),
    // пространство, которое открывается при входе: uuid пространства или 'personal'; пусто — по умолчанию организации
    homeSpace: text('home_space'),
    /** Закрытые сотрудником информационные уведомления (идентификаторы), чтобы они не появлялись снова. */
    dismissedNotices: jsonb('dismissed_notices').notNull().default([]),
    /** Откуда учётная запись: local — мастер-пароль на сервере Arklock, ldap/oidc/saml — вход через корпоративный каталог или провайдера идентификации. */
    authSource: text('auth_source', { enum: ['local', 'ldap', 'oidc', 'saml'] })
      .notNull()
      .default('local'),
    externalId: text('external_id'),
    recoverySalt: text('recovery_salt').notNull(),
    recoveryHash: text('recovery_hash').notNull(),
    recoveryWrappedPrivateKey: text('recovery_wrapped_private_key').notNull(),
    recoveryWrappedSignPrivateKey: text('recovery_wrapped_sign_private_key').notNull(),
    disabledAt: ts('disabled_at'),
    /** Почему отключён: вручную, каталогом, при увольнении; null — причина не записана (до 1.41) или активен. */
    disabledReason: text('disabled_reason', {
      enum: ['manual', 'directory', 'offboarding', 'expired'],
    }),
    /** Срок действия учётной записи: после него она отключается (временные сотрудники, подрядчики). */
    accessUntil: ts('access_until'),
    /** Пояснение администратора к ручному отключению (видят только администраторы). */
    disabledNote: text('disabled_note'),
    disabledBy: uuid('disabled_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

/** Журнал привязки открытых ключей к идентичности (хэш-цепочка). */
export const keyLog = pgTable(
  'key_log',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').notNull(),
    encPublic: text('enc_public').notNull(),
    signPublic: text('sign_public').notNull(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('key_log_user_idx').on(t.userId)],
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
    /**
     * Половина ключа «разблокировки после обновления страницы»: вторая (шифртекст ключей) живёт только во вкладке.
     * Запечатана ключом приложения; стирается при блокировке и выходе, бесполезна после отзыва или истечения сеанса.
     */
    reloadShare: text('reload_share'),
  },
  (t) => [
    uniqueIndex('sessions_token_idx').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

/** Membership in a space scopes vault access but never grants vault keys. */
export const spaces = pgTable('spaces', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  archived: boolean('archived').notNull().default(false),
  publicToOrg: boolean('public_to_org').notNull().default(false),
  isDefault: boolean('is_default').notNull().default(false),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Хранилища: личный сейф (locker) и общие (shared). */
export const vaults = pgTable('vaults', {
  id: uuid('id').primaryKey(),
  kind: text('kind', { enum: ['locker', 'shared'] }).notNull(),
  spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'restrict' }),
  /** Название общего хранилища (открытый текст — решение зафиксировано в docs/security). У сейфа пусто. */
  name: text('name'),
  keyVersion: integer('key_version').notNull().default(1),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  /** Последний отчёт инспектора о сейфе: без него «0 проблем» нельзя отличить от «не проверялся». */
  signalsReportedAt: ts('signals_reported_at'),
  /**
   * Персональный корпоративный сейф сотрудника: открыто объявленная политика, по которой группы-хранители организации
   * (vault_circles.managed) тоже имеют доступ. Личный приватный сейф (kind = locker) этого признака не имеет.
   */
  managedFor: uuid('managed_for').references(() => users.id, { onDelete: 'set null' }),
});

/** Прямое членство и роль в хранилище. Ключ хранилища выдаётся отдельно (vault_keys). */
export const vaultMembers = pgTable(
  'vault_members',
  {
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'editor', 'reader', 'limited'] }).notNull(),
    /** Пользовательская роль вместо встроенной (тогда role = limited). */
    customRoleId: uuid('custom_role_id'),
    /** Временный доступ: после этого срока участие не действует. */
    expiresAt: ts('expires_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.vaultId, t.userId] }),
    index('vault_members_user_idx').on(t.userId),
  ],
);

/** Ключ хранилища, запечатанный для пользователя; подписан выдавшим администратором. */
export const vaultKeys = pgTable(
  'vault_keys',
  {
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    keyVersion: integer('key_version').notNull(),
    sealedKey: text('sealed_key').notNull(),
    grantedBy: uuid('granted_by').notNull(),
    signature: text('signature').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.userId, t.keyVersion] })],
);

/** Explicit rescue envelopes: recipient is an offline recovery identity, never an ordinary account. */
export const corporateRecoveryKeys = pgTable(
  'corporate_recovery_keys',
  {
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    recipientId: uuid('recipient_id').notNull(),
    keyVersion: integer('key_version').notNull(),
    sealedKey: text('sealed_key').notNull(),
    signature: text('signature').notNull(),
    grantedBy: uuid('granted_by').notNull(),
    grantedBySignKey: text('granted_by_sign_key').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.recipientId, t.keyVersion] })],
);

/** Persisted one-use recovery proofs remain safe across process restarts and multiple API instances. */
export const corporateRecoveryChallenges = pgTable(
  'corporate_recovery_challenges',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    recipientId: uuid('recipient_id').notNull(),
    keyVersion: integer('key_version').notNull(),
    nonceHash: text('nonce_hash').notNull(),
    message: text('message').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [index('corporate_recovery_challenges_expiry_idx').on(t.expiresAt)],
);

/** Круги (группы пользователей). */
export const circles = pgTable(
  'circles',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Административная роль, которую получают все участники группы (в том числе доменной). */
    adminRoleId: uuid('admin_role_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('circles_name_idx').on(t.name)],
);

export const circleMembers = pgTable(
  'circle_members',
  {
    circleId: uuid('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.circleId, t.userId] }),
    index('circle_members_user_idx').on(t.userId),
  ],
);

/** Роль круга в хранилище: участники круга получают её (наибольшая из прямой и круговых ролей). */
export const vaultCircles = pgTable(
  'vault_circles',
  {
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    circleId: uuid('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['admin', 'editor', 'reader', 'limited'] }).notNull(),
    customRoleId: uuid('custom_role_id'),
    expiresAt: ts('expires_at'),
    /** Группа-хранитель персонального корпоративного сейфа: ставится политикой организации, владелец её не меняет. */
    managed: boolean('managed').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.circleId] })],
);

/** Ветви (папки). Название шифруется ключом хранилища. */
export const branches = pgTable(
  'branches',
  {
    id: uuid('id').primaryKey(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    nameCipher: text('name_cipher').notNull(),
    /** Оформление (значок, цвет, своё изображение), зашифрованное ключом хранилища; нет — значок по умолчанию. */
    metaCipher: text('meta_cipher'),
    keyVersion: integer('key_version').notNull(),
    version: integer('version').notNull().default(1),
    /** Элементы, удалённые вместе, имеют общую группу корзины и восстанавливаются вместе. */
    trashGroup: uuid('trash_group'),
    deletedAt: ts('deleted_at'),
    createdBy: uuid('created_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('branches_vault_idx').on(t.vaultId)],
);

/** Записи: только шифртекст. Заголовок, логин, пароль, URL, теги — внутри шифртекста. */
export const entries = pgTable(
  'entries',
  {
    id: uuid('id').primaryKey(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id'),
    wrappedEntryKey: text('wrapped_entry_key').notNull(),
    ciphertext: text('ciphertext').notNull(),
    keyVersion: integer('key_version').notNull(),
    /** Счётчик изменений для контроля конфликтов при параллельном редактировании. */
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    updatedBy: uuid('updated_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    trashGroup: uuid('trash_group'),
    deletedAt: ts('deleted_at'),
    /**
     * Короткий адрес записи для ссылки «/e/…»: 12 знаков из случайного идентификатора. Сам по себе доступа не даёт —
     * сервер проверяет права того, кто открывает ссылку.
     */
    shortId: text('short_id').generatedAlwaysAs(sql`substr(replace(id::text, '-', ''), 1, 12)`),
  },
  (t) => [
    index('entries_vault_idx').on(t.vaultId),
    index('entries_branch_idx').on(t.branchId),
    index('entries_short_idx').on(t.shortId),
  ],
);

/** Ревизии: предыдущие состояния записи (append-only, хранятся ограниченное число). */
export const entryRevisions = pgTable(
  'entry_revisions',
  {
    id: uuid('id').primaryKey(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    vaultId: uuid('vault_id').notNull(),
    version: integer('version').notNull(),
    wrappedEntryKey: text('wrapped_entry_key').notNull(),
    ciphertext: text('ciphertext').notNull(),
    keyVersion: integer('key_version').notNull(),
    savedBy: uuid('saved_by'),
    savedAt: ts('saved_at').notNull(),
  },
  (t) => [index('entry_revisions_entry_idx').on(t.entryId, t.version)],
);

/** Закреплённые (избранные) записи пользователя. */
/** Избранные папки сотрудника — как `pins` для записей; удаляются вместе с папкой или учётной записью. */
export const branchPins = pgTable(
  'branch_pins',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.branchId] })],
);

export const pins = pgTable(
  'pins',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.entryId] })],
);

/** Гранты на ветвь или запись для пользователя или круга (наследуются вниз по дереву, могут иметь срок). */
export const grants = pgTable(
  'grants',
  {
    id: uuid('id').primaryKey(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    targetType: text('target_type', { enum: ['branch', 'entry'] }).notNull(),
    targetId: uuid('target_id').notNull(),
    subjectType: text('subject_type', { enum: ['user', 'circle'] }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    // structure — только для ветвей: видеть папки и создавать в них, не читая записей
    role: text('role', { enum: ['none', 'reader', 'editor', 'manager', 'structure'] }).notNull(),
    expiresAt: ts('expires_at'),
    createdBy: uuid('created_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('grants_vault_idx').on(t.vaultId),
    uniqueIndex('grants_unique_idx').on(t.targetType, t.targetId, t.subjectType, t.subjectId),
  ],
);

/** Одноразовые и временные ссылки передачи секрета (Handoff). Ключ ссылки сервер не знает. */
export const handoffs = pgTable(
  'handoffs',
  {
    id: uuid('id').primaryKey(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull().default(''),
    ciphertext: text('ciphertext').notNull(),
    hasPassphrase: boolean('has_passphrase').notNull().default(false),
    expiresAt: ts('expires_at').notNull(),
    maxViews: integer('max_views').notNull(),
    views: integer('views').notNull().default(0),
    /** Окно после первого открытия, минут: после него ссылка закрывается, даже если просмотры остались. */
    openWindowMinutes: integer('open_window_minutes'),
    firstOpenedAt: ts('first_opened_at'),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('handoffs_user_idx').on(t.createdBy)],
);

/** События безопасности по записям (слабый/повторяющийся/скомпрометированный/просроченный пароль). Секретов не содержат. */
export const signals = pgTable(
  'signals',
  {
    id: uuid('id').primaryKey(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    // rotate — «требуется смена пароля» после увольнения сотрудника с доступом; создаёт только сервер
    type: text('type', { enum: ['weak', 'reused', 'compromised', 'expired', 'rotate'] }).notNull(),
    status: text('status', { enum: ['open', 'in_progress', 'resolved', 'dismissed'] })
      .notNull()
      .default('open'),
    assignedTo: uuid('assigned_to'),
    reportedBy: uuid('reported_by').notNull(),
    // для rotate — уволенный сотрудник, из-за которого пароль стоит сменить (последний, если их несколько)
    causeUserId: uuid('cause_user_id').references(() => users.id, { onDelete: 'set null' }),
    // почему пароль стоит сменить: увольнение или отзыв доступа к сейфу
    causeReason: text('cause_reason', { enum: ['offboarding', 'revoked'] }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('signals_vault_idx').on(t.vaultId),
    uniqueIndex('signals_entry_type_idx').on(t.entryId, t.type),
  ],
);

/** Вложения записей. Содержимое — зашифрованный файл в хранилище блобов; здесь только шифртекст метаданных и обёрнутый ключ. */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    /** Ключ вложения под ключом хранилища. */
    wrappedKey: text('wrapped_key').notNull(),
    /** Имя, тип и размер открытого файла под ключом вложения. */
    metaCipher: text('meta_cipher').notNull(),
    keyVersion: integer('key_version').notNull(),
    /** Размер зашифрованного файла в байтах (по нему считаются квоты). */
    size: bigint('size', { mode: 'number' }).notNull(),
    status: text('status', { enum: ['pending', 'ready'] })
      .notNull()
      .default('pending'),
    createdBy: uuid('created_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('attachments_entry_idx').on(t.entryId),
    index('attachments_vault_idx').on(t.vaultId),
  ],
);

/** Второй фактор (TOTP). Секрет нужен серверу для проверки кода, поэтому хранится зашифрованным ключом из секрета приложения. */
export const mfaFactors = pgTable('mfa_factors', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secretCipher: text('secret_cipher').notNull(),
  /** null — настройка начата, но не подтверждена кодом. */
  enabledAt: ts('enabled_at'),
  /** Последний принятый шаг времени: тот же код нельзя использовать дважды. */
  lastStep: bigint('last_step', { mode: 'number' }).notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Резервные коды: хранится только HMAC; код действует один раз. */
export const mfaBackupCodes = pgTable(
  'mfa_backup_codes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [index('mfa_backup_user_idx').on(t.userId)],
);

/** Персональные токены доступа к API (автоматизация, CLI). Хранится только SHA-256; сами токены не открывают данные — ключей у них нет. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** Первые символы для опознания в списке. */
    prefix: text('prefix').notNull(),
    scope: text('scope', { enum: ['read', 'write'] }).notNull(),
    expiresAt: ts('expires_at'),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('api_tokens_user_idx').on(t.userId)],
);

/** Ключи доступа (WebAuthn / passkeys) как второй фактор. Хранятся только открытый ключ и счётчик. */
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    /** Идентификатор учётных данных (base64url), выдаётся аутентификатором. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    publicKey: text('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: jsonb('transports'),
    backedUp: boolean('backed_up').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [index('webauthn_user_idx').on(t.userId)],
);

/** Приглашения: одноразовая ссылка на регистрацию по закрытому режиму; хранится только SHA-256 токена. */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** Круги, в которые пользователь будет добавлен при регистрации. */
    circleIds: jsonb('circle_ids').notNull().default([]),
    /** Имя, указанное администратором (пользователь подтверждает его при активации). */
    displayName: text('display_name'),
    /** Роль, с которой создаётся учётная запись при активации. */
    role: text('role', { enum: ['admin', 'member'] })
      .notNull()
      .default('member'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('invitations_email_idx').on(t.email)],
);

/** Пользовательские роли: наборы разрешений и явных запретов с наследованием. */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** vault — роль в хранилище, admin — набор административных полномочий. */
    scope: text('scope', { enum: ['vault', 'admin'] }).notNull(),
    allow: jsonb('allow').notNull().default([]),
    deny: jsonb('deny').notNull().default([]),
    parents: jsonb('parents').notNull().default([]),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('roles_name_scope_idx').on(t.name, t.scope)],
);

/**
 * Устройства с быстрой разблокировкой PIN-кодом. Сервер хранит проверочный хэш PIN и запечатанную долю ключа;
 * доля выдаётся только после верного PIN и не более пяти неудачных попыток подряд, затем устройство удаляется.
 */
export const pinDevices = pgTable(
  'pin_devices',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    verifierSalt: text('verifier_salt').notNull(),
    verifierHash: text('verifier_hash').notNull(),
    shareSealed: text('share_sealed').notNull(),
    failures: integer('failures').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [index('pin_devices_user_idx').on(t.userId)],
);

/** Outgoing mail payloads are encrypted; delivery logs contain only address, template and safe result codes. */
export const mailQueue = pgTable(
  'mail_queue',
  {
    id: uuid('id').primaryKey(),
    profileId: text('profile_id').notNull(),
    to: text('recipient').notNull(),
    type: text('type', { enum: ['invitation', 'security', 'test'] }).notNull(),
    status: text('status', { enum: ['queued', 'sending', 'sent', 'failed'] })
      .notNull()
      .default('queued'),
    payloadCipher: text('payload_cipher').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    lockedAt: ts('locked_at'),
    lockToken: uuid('lock_token'),
    lastCode: text('last_code'),
    lastSmtpStatus: integer('last_smtp_status'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deliveredAt: ts('delivered_at'),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    index('mail_queue_due_idx').on(t.status, t.nextAttemptAt),
    index('mail_queue_created_idx').on(t.createdAt),
  ],
);

/** Notifications contain event codes and object IDs only; never audit details, secrets or shared-link URLs. */
export const userNotifications = pgTable(
  'user_notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    category: text('category', { enum: ['access', 'security', 'sharing', 'system'] }).notNull(),
    event: text('event').notNull(),
    vaultId: uuid('vault_id'),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id'),
    /** Несекретные подробности для текста уведомления (например, название сработавшего правила). */
    detail: jsonb('detail'),
    createdAt: ts('created_at').notNull().defaultNow(),
    readAt: ts('read_at'),
    archivedAt: ts('archived_at'),
  },
  (t) => [index('notifications_user_id_idx').on(t.userId, t.id)],
);

/** Правила автоматизации: событие журнала (с условиями) — уведомить получателей. */
export const automationRules = pgTable('automation_rules', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  /** Триггер из списка AUTOMATION_TRIGGERS (contracts). */
  trigger: text('trigger').notNull(),
  /** notify — уведомить после события; deny — запретить действие до него (только AUTOMATION_DENYABLE). */
  effect: text('effect', { enum: ['notify', 'deny'] })
    .notNull()
    .default('notify'),
  vaultId: uuid('vault_id').references(() => vaults.id, { onDelete: 'cascade' }),
  actorCircleId: uuid('actor_circle_id').references(() => circles.id, { onDelete: 'cascade' }),
  notifyCircles: jsonb('notify_circles').$type<string[]>().notNull().default([]),
  notifyAdmins: boolean('notify_admins').notNull().default(false),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  firedAt: ts('fired_at'),
  fired: integer('fired').notNull().default(0),
});

export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  access: boolean('access').notNull().default(true),
  security: boolean('security').notNull().default(true),
  sharing: boolean('sharing').notNull().default(true),
  system: boolean('system').notNull().default(true),
});

export const spaceMembers = pgTable(
  'space_members',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['member', 'admin'] })
      .notNull()
      .default('member'),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.userId] })],
);

export const spaceCircles = pgTable(
  'space_circles',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    circleId: uuid('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['member', 'admin'] })
      .notNull()
      .default('member'),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.circleId] })],
);
