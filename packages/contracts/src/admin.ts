import { z } from 'zod';

/** Версия релиза: только вида vX.Y.Z. */
export const releaseTag = z.string().regex(/^v\d+\.\d+\.\d+$/);

export const reauthRequest = z.object({ authKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const reauthResponse = z.object({ token: z.string(), expiresAt: z.string() });

export const updateAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('check') }),
  z.object({ action: z.literal('update'), version: releaseTag }),
  z.object({ action: z.literal('rollback'), withRestore: z.boolean().default(false) }),
]);
export type UpdateAction = z.infer<typeof updateAction>;

export const updateStatus = z.object({
  state: z.enum(['idle', 'running', 'success', 'failed']),
  action: z.string().nullable(),
  requestId: z.string().nullable(),
  stepNo: z.number(),
  stepTotal: z.number(),
  stepName: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  result: z.string().nullable(),
  message: z.string().nullable(),
  versionFrom: z.string().nullable(),
  versionTo: z.string().nullable(),
});
export type UpdateStatus = z.infer<typeof updateStatus>;

export const updatesOverview = z.object({
  installed: z.object({
    version: z.string(),
    commit: z.string(),
    builtAt: z.string(),
    channel: z.string(),
  }),
  helper: z.object({
    configured: z.boolean(),
    alive: z.boolean(),
    lastSeenAt: z.string().nullable(),
  }),
  remote: z
    .object({
      checkedAt: z.string().nullable(),
      status: z.enum(['available', 'up_to_date', 'unreachable', 'unknown']),
      latest: z.string().nullable(),
      changelog: z.string(),
      migrations: z.number().nullable(),
    })
    .nullable(),
  status: updateStatus,
  /** Журнал этапов обновления: последние строки вывода помощника (ошибки и предупреждения — как есть, секреты маскируются). */
  updateLog: z.string(),
  history: z.array(
    z.object({
      at: z.string(),
      action: z.string(),
      result: z.string(),
      versionFrom: z.string().nullable(),
      versionTo: z.string().nullable(),
      message: z.string().nullable(),
    }),
  ),
  pending: z.boolean(),
});
export type UpdatesOverview = z.infer<typeof updatesOverview>;
