import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { uuid } from '@arklock/contracts';
import { adminGate } from '../auth/adminperm.js';
import { requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { corporateAccessRisks, corporateContinuity } from '../corporate-continuity.js';
import { parse } from '../errors.js';

export const registerContinuityRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', (req) => adminGate(ctx, req));
  app.get('/admin/continuity', () => corporateContinuity(ctx.db));
  app.get('/admin/users/:id/access-risks', (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return corporateAccessRisks(ctx.db, id);
  });
};
