import { z } from 'zod';

export const healthResponse = z.object({ status: z.literal('ok') });
export type HealthResponse = z.infer<typeof healthResponse>;

export const readyResponse = z.object({
  status: z.enum(['ready', 'degraded']),
  checks: z.object({ database: z.enum(['ok', 'fail']) }),
});
export type ReadyResponse = z.infer<typeof readyResponse>;

export const versionResponse = z.object({
  name: z.literal('arklock'),
  version: z.string(),
  commit: z.string(),
  builtAt: z.string(),
  channel: z.enum(['stable', 'edge']),
});
export type VersionResponse = z.infer<typeof versionResponse>;

/**
 * Состояния проверок диагностики: «проверка.состояние». Сервер передаёт код и параметры,
 * тексты на языке пользователя — в словаре интерфейса (тест словаря требует перевод для каждого).
 */
export const DIAGNOSTIC_STATES = [
  'database.ok',
  'database.unreadable',
  'disk.ok',
  'disk.low',
  'blobs.ok',
  'blobs.off',
  'blobs.readonly',
  'blobs-consistency.ok',
  'blobs-consistency.missing',
  'blobs-consistency.orphans',
  'public-url.ok',
  'public-url.unset',
  'public-url.http',
  'helper.ok',
  'helper.none',
  'helper.down',
  'smtp.ok',
  'smtp.none',
  'mfa-policy.ok',
  'mfa-policy.off',
  'integrations.ok',
  'backups.ok',
  'backups.none',
  'backups.old',
  'dns.ok',
  'dns.fail',
  'cert.ok',
  'cert.soon',
  'cert.expired',
  'cert.untrusted',
  'cert.unreachable',
  'static.ok',
  'static.missing',
] as const;
export type DiagnosticState = (typeof DIAGNOSTIC_STATES)[number];
