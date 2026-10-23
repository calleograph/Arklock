import { z } from 'zod';
import { b64url, sealedBox, sealedValue, uuid } from './common.js';
import { corporateRecoveryEnroll } from './corporate-recovery.js';

/** Роли в хранилище (по убыванию полномочий). limited — доступ только по грантам на ветви и записи. */
export const vaultRole = z.enum(['owner', 'admin', 'editor', 'reader', 'limited']);
export type VaultRole = z.infer<typeof vaultRole>;
export const grantRole = z.enum(['none', 'reader', 'editor', 'manager']);
export type GrantRole = z.infer<typeof grantRole>;

const MAX_BLOB = 512 * 1024;
const signature = b64url(80, 100);

export const vaultInfo = z.object({
  id: uuid,
  kind: z.enum(['locker', 'shared']),
  spaceId: uuid.nullable().optional(),
  name: z.string().nullable(),
  /** Текущая версия ключа хранилища. */
  keyVersion: z.number().int(),
  role: vaultRole,
  /** Полномочие управлять участниками: такой участник выдаёт ключи ожидающим участникам (клиентом, у которого открыт ключ). */
  canManageMembers: z.boolean().optional(),
  /** Ключ хранилища, запечатанный для текущего пользователя (последней доступной версии), с подписью выдавшего. */
  key: z
    .object({
      sealedKey: sealedBox,
      keyVersion: z.number().int(),
      grantedBy: uuid,
      grantedBySignKey: z.string(),
      signature,
    })
    .nullable(),
  /** Доступ есть, но ключ ещё не выдан администратором хранилища. */
  pendingKey: z.boolean(),
  /** Эффективные полномочия пользователя в хранилище (без грантов на ветви и записи). */
  permissions: z.array(z.string()),
});
export type VaultInfo = z.infer<typeof vaultInfo>;

export const createVaultRequest = z.object({
  id: uuid,
  spaceId: uuid.optional(),
  name: z.string().trim().min(1).max(100),
  sealedKey: sealedBox,
  signature,
});

export const entryWrite = z.object({
  id: uuid.optional(),
  branchId: uuid.nullable().optional(),
  wrappedEntryKey: sealedValue(512),
  ciphertext: sealedValue(MAX_BLOB),
  keyVersion: z.number().int().min(1),
});
export const entryUpdate = entryWrite.omit({ id: true }).extend({
  /** Версия записи, на которой основано изменение (контроль конфликтов). */
  expectedVersion: z.number().int().min(1),
  /** Пароль в записи сменён — сообщает браузер (сервер содержимого не видит); закрывает «требуется смена пароля». */
  passwordChanged: z.boolean().optional(),
});
export const entryDelete = z.object({ expectedVersion: z.number().int().min(1) });

export const entryRecord = z.object({
  id: uuid,
  vaultId: uuid,
  branchId: uuid.nullable(),
  wrappedEntryKey: z.string(),
  ciphertext: z.string(),
  keyVersion: z.number().int(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  pinned: z.boolean(),
  /** Эффективное право текущего пользователя на запись. */
  access: z.enum(['reader', 'editor', 'manager']),
});
export type EntryRecord = z.infer<typeof entryRecord>;

/** Оформление ветви: значок и цвет или небольшое изображение (PNG до 64×64), зашифрованные клиентом. */
const branchMeta = sealedValue(24_576);
export const branchWrite = z.object({
  id: uuid,
  parentId: uuid.nullable(),
  nameCipher: sealedValue(2048),
  metaCipher: branchMeta.nullable().optional(),
  keyVersion: z.number().int().min(1),
});
export const branchPatch = z
  .object({
    parentId: uuid.nullable().optional(),
    nameCipher: sealedValue(2048).optional(),
    /** null — вернуть значок по умолчанию. */
    metaCipher: branchMeta.nullable().optional(),
    keyVersion: z.number().int().min(1).optional(),
  })
  .refine(
    (body) => (body.nameCipher === undefined && !body.metaCipher) || body.keyVersion !== undefined,
    { message: 'A key version is required for encrypted branch names and appearance' },
  );
export const branchRecord = z.object({
  id: uuid,
  vaultId: uuid,
  parentId: uuid.nullable(),
  nameCipher: z.string(),
  metaCipher: z.string().nullable(),
  keyVersion: z.number().int(),
  version: z.number().int(),
  deletedAt: z.string().nullable(),
  access: z.enum(['reader', 'editor', 'manager']),
  /** папка в избранном у запросившего; есть в ответе дерева */
  pinned: z.boolean().optional(),
});
export type BranchRecord = z.infer<typeof branchRecord>;

export const bulkRequest = z.object({
  ids: z.array(uuid).min(1).max(500),
  action: z.enum(['move', 'trash', 'restore', 'purge']),
  branchId: uuid.nullable().optional(),
});

export const revisionRecord = z.object({
  id: uuid,
  version: z.number().int(),
  wrappedEntryKey: z.string(),
  ciphertext: z.string(),
  keyVersion: z.number().int(),
  savedAt: z.string(),
  savedBy: uuid.nullable(),
});
export type RevisionRecord = z.infer<typeof revisionRecord>;

export const memberPut = z.object({
  /** Встроенная роль; при пользовательской роли не указывается. */
  role: vaultRole.exclude(['owner']).optional(),
  /** Пользовательская роль (набор полномочий). */
  customRoleId: uuid.optional(),
  /** Временный доступ: после этого момента участие не действует. */
  expiresAt: z.string().datetime().nullable().optional(),
  /** Ключ хранилища для нового участника (если у администратора есть ключ). */
  key: z
    .object({ keyVersion: z.number().int().min(1), sealedKey: sealedBox, signature })
    .optional(),
});
export const circleRolePut = z.object({
  role: z.enum(['admin', 'editor', 'reader', 'limited']).optional(),
  customRoleId: uuid.optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});
export const keysPost = z.object({
  keys: z
    .array(
      z.object({
        userId: uuid,
        keyVersion: z.number().int().min(1),
        sealedKey: sealedBox,
        signature,
      }),
    )
    .min(1)
    .max(500),
});

export const rotatePost = z
  .object({
    newKeyVersion: z.number().int().min(2),
    rotationId: uuid.optional(),
    recoveryKey: corporateRecoveryEnroll.optional(),
    keys: z
      .array(z.object({ userId: uuid, sealedKey: sealedBox, signature }))
      .min(1)
      .max(1000),
    entries: z
      .array(
        z.object({
          id: uuid,
          expectedVersion: z.number().int().min(1),
          wrappedEntryKey: sealedValue(512),
          ciphertext: sealedValue(MAX_BLOB),
        }),
      )
      .max(20000),
    revisions: z
      .array(
        z.object({
          id: uuid,
          wrappedEntryKey: sealedValue(512),
          ciphertext: sealedValue(MAX_BLOB),
        }),
      )
      .max(100000),
    branches: z
      .array(
        z.object({
          id: uuid,
          expectedVersion: z.number().int().min(1),
          nameCipher: sealedValue(2048),
          /** Перешифрованное оформление; не передано — оформление сбрасывается (старым ключом его уже не прочитать). */
          metaCipher: branchMeta.nullable().optional(),
        }),
      )
      .max(20000),
    /** Вложения: перешифрованные ключи; содержимое заранее загружено в область подготовки (PUT …/rotation). */
    attachments: z
      .array(z.object({ id: uuid, wrappedKey: sealedValue(512), metaCipher: sealedValue(4096) }))
      .max(100000)
      .default([]),
  })
  .refine((body) => body.attachments.length === 0 || !!body.rotationId, {
    message: 'A rotation operation ID is required for attachment staging',
  });

export const grantPut = z.object({
  targetType: z.enum(['branch', 'entry']),
  targetId: uuid,
  subjectType: z.enum(['user', 'circle']),
  subjectId: uuid,
  role: grantRole,
  expiresAt: z.string().datetime().nullable().optional(),
});

export const objectPasswordPolicy = z
  .object({
    minLength: z.number().int().min(0).max(128).optional(),
    classes: z.number().int().min(0).max(4).optional(),
    maxAgeDays: z.number().int().min(0).max(3650).optional(),
  })
  .strict();
export const objectPolicyPatch = z.object({ policy: objectPasswordPolicy.nullable() }).strict();
export const entryClientEvent = z
  .object({
    action: z.enum(['reveal', 'copy', 'open']),
    /** Для открытия карточки поле не указывается. */
    field: z.enum(['password', 'username', 'totp', 'custom']).optional(),
  })
  .strict();

export const handoffCreate = z.object({
  id: uuid,
  label: z.string().trim().max(100).default(''),
  ciphertext: sealedValue(64 * 1024),
  hasPassphrase: z.boolean().default(false),
  expiresInMinutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 30),
  maxViews: z.number().int().min(1).max(100),
});

export const signalsPost = z.object({
  items: z
    .array(
      z.object({
        entryId: uuid,
        type: z.enum(['weak', 'reused', 'compromised', 'expired']),
      }),
    )
    .max(2000),
  /** Типы, по которым выполнялась проверка: сигналы этих типов вне списка закрываются как устранённые. */
  checkedTypes: z.array(z.enum(['weak', 'reused', 'compromised', 'expired'])).max(4),
});
export const signalPatch = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'dismissed']).optional(),
  assignedTo: uuid.nullable().optional(),
});

export const circleWrite = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(''),
});

/** Вложения: метаданные и обёрнутый ключ создаются до загрузки содержимого. */
export const attachmentCreate = z.object({
  id: uuid,
  wrappedKey: sealedValue(512),
  metaCipher: sealedValue(4096),
  keyVersion: z.number().int().min(1),
  /** Размер зашифрованного файла в байтах: сервер принимает ровно столько. */
  size: z.number().int().min(1).max(2_147_483_647),
});

export interface AttachmentRecord {
  id: string;
  entryId: string;
  wrappedKey: string;
  metaCipher: string;
  keyVersion: number;
  size: number;
  createdAt: string;
}
