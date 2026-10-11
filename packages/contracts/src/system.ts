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
