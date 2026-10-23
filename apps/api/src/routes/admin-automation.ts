import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { automationRuleWrite, uuid } from '@arklock/contracts';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { automationRules } from '../db/schema.js';
import { notFound, parse } from '../errors.js';

/** Правила автоматизации: событие журнала с условиями → уведомление получателям. Раздел настроек безопасности. */
export const registerAdminAutomationRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', (req) => adminGate(ctx, req));
  const idParam = z.object({ id: uuid });

  app.get('/admin/automation', async () =>
    db.select().from(automationRules).orderBy(asc(automationRules.createdAt)),
  );

  app.post('/admin/automation', async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(automationRuleWrite, req.body);
    const id = crypto.randomUUID();
    await db.insert(automationRules).values({ id, ...body, createdBy: user.id });
    await audit(db, `user:${user.id}`, 'admin.automation.create', `rule:${id}`, {
      trigger: body.trigger,
    });
    return reply.status(201).send({ id });
  });

  app.put('/admin/automation/:id', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(automationRuleWrite, req.body);
    const rows = await db
      .update(automationRules)
      .set(body)
      .where(eq(automationRules.id, id))
      .returning({ id: automationRules.id });
    if (!rows.length) throw notFound();
    await audit(db, `user:${user.id}`, 'admin.automation.update', `rule:${id}`, {
      trigger: body.trigger,
      enabled: body.enabled,
    });
    return { id };
  });

  app.delete('/admin/automation/:id', async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(idParam, req.params);
    const rows = await db
      .delete(automationRules)
      .where(eq(automationRules.id, id))
      .returning({ id: automationRules.id });
    if (!rows.length) throw notFound();
    await audit(db, `user:${user.id}`, 'admin.automation.delete', `rule:${id}`);
    return reply.status(204).send();
  });
};
