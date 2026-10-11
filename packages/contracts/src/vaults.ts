import { z } from 'zod';
import { sealedBox, sealedValue, uuid } from './common.js';

export const vaultRole = z.enum(['owner', 'admin', 'editor', 'reader']);
export type VaultRole = z.infer<typeof vaultRole>;

export const vaultInfo = z.object({
  id: uuid,
  kind: z.enum(['locker', 'shared']),
  name: z.string().nullable(),
  /** Текущая версия ключа хранилища. */
  keyVersion: z.number().int(),
  role: vaultRole,
  /** Ключ хранилища, запечатанный для текущего пользователя, и версия, для которой он запечатан. */
  sealedKey: sealedBox,
  sealedKeyVersion: z.number().int(),
});
export type VaultInfo = z.infer<typeof vaultInfo>;

const MAX_BLOB = 512 * 1024;

export const entryWrite = z.object({
  id: uuid.optional(),
  wrappedEntryKey: sealedValue(512),
  ciphertext: sealedValue(MAX_BLOB),
  keyVersion: z.number().int().min(1),
});
export const entryUpdate = entryWrite.omit({ id: true }).extend({
  /** Версия записи, на которой основано изменение (контроль конфликтов). */
  expectedVersion: z.number().int().min(1),
});
export const entryDelete = z.object({ expectedVersion: z.number().int().min(1) });

export const entryRecord = z.object({
  id: uuid,
  vaultId: uuid,
  wrappedEntryKey: z.string(),
  ciphertext: z.string(),
  keyVersion: z.number().int(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EntryRecord = z.infer<typeof entryRecord>;
