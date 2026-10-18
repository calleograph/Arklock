import { z } from 'zod';
import { uuid } from './common.js';

export const spaceWrite = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).default(''),
  publicToOrg: z.boolean().default(false),
});
export const spaceInfo = spaceWrite.extend({
  id: uuid,
  archived: z.boolean(),
  isDefault: z.boolean(),
  member: z.boolean(),
  canManage: z.boolean(),
});
export type SpaceInfo = z.infer<typeof spaceInfo>;
