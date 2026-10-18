import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from './db/connect.js';
import {
  circleMembers,
  entries,
  handoffs,
  notificationPreferences,
  settings,
  signals,
  userNotifications,
  users,
  vaultKeys,
  vaultMembers,
  vaults,
} from './db/schema.js';
import type { AppContext } from './context.js';
import { loadAccess } from './access.js';
import type { AuditSinkEvent } from './audit.js';

export type NotificationCategory = typeof userNotifications.$inferInsert.category;
export interface NotificationEvent {
  category: NotificationCategory;
  event: string;
  vaultId?: string | null;
  resourceType: string;
  resourceId?: string | null;
}
/** Recipients are selected by actual mutations, never by client supplied notification text. */
async function safelyNotify(db: Db, operation: (tx: Db) => Promise<void>): Promise<boolean> {
  try {
    await db.transaction(operation);
    return true;
  } catch {
    process.emitWarning('A notification could not be persisted', {
      code: 'ARKLOCK_NOTIFICATION_FAILURE',
    });
    return false;
  }
}
export async function notifyUsers(
  db: Db,
  recipients: string[],
  event: NotificationEvent,
): Promise<boolean> {
  if (!recipients.length) return true;
  return safelyNotify(db, async (tx) => {
    db = tx;
    const ids = [...new Set(recipients)];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const eligible = await db
        .select({ id: users.id, preferences: notificationPreferences })
        .from(users)
        .leftJoin(notificationPreferences, eq(notificationPreferences.userId, users.id))
        .where(and(inArray(users.id, ids.slice(offset, offset + 500)), isNull(users.disabledAt)));
      const rows = eligible
        .filter((row) => row.preferences?.[event.category] !== false)
        .map((row) => ({ userId: row.id, ...event }));
      if (rows.length) await db.insert(userNotifications).values(rows);
    }
  });
}

/** Observe confirmed local helper state without starting an update check or copying its logs into notifications. */
export async function observeUpdaterNotifications(ctx: AppContext): Promise<void> {
  if (!ctx.updater.configured) return;
  try {
    const overview = await ctx.updater.overview({
      version: ctx.config.APP_VERSION,
      commit: ctx.config.APP_GIT_COMMIT,
      builtAt: ctx.config.APP_BUILT_AT,
      channel: ctx.config.UPDATE_CHANNEL,
    });
    const checked = Date.parse(overview.remote?.checkedAt ?? '');
    const available =
      overview.remote?.status === 'available' &&
      overview.remote.latest &&
      overview.remote.latest !== ctx.config.APP_VERSION &&
      Number.isFinite(checked) &&
      checked <= Date.now() &&
      Date.now() - checked <= 86_400_000
        ? overview.remote.latest
        : null;
    const failure =
      overview.status.state === 'failed' &&
      idOf(overview.status.requestId) &&
      Number.isFinite(Date.parse(overview.status.finishedAt ?? ''))
        ? overview.status.requestId
        : null;
    if (!available && !failure) return;
    await safelyNotify(ctx.db, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(7004)`);
      const key = 'notifications.updater.observed';
      const [row] = await tx.select().from(settings).where(eq(settings.key, key));
      const previous = (row?.value ?? {}) as { available?: string; failure?: string };
      const recipients = (
        await tx.select({ id: users.id }).from(users).where(eq(users.role, 'admin'))
      ).map((row) => row.id);
      const next = { ...previous };
      if (available && available !== previous.available) {
        if (
          !(await notifyUsers(tx, recipients, {
            category: 'system',
            event: 'system.update_available',
            resourceType: 'updates',
          }))
        )
          return;
        next.available = available;
      }
      if (failure && failure !== previous.failure) {
        if (
          !(await notifyUsers(tx, recipients, {
            category: 'system',
            event: 'system.operation_failed',
            resourceType: 'updates',
          }))
        )
          return;
        next.failure = failure;
      }
      await tx
        .insert(settings)
        .values({ key, value: next })
        .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } });
    });
  } catch {
    process.emitWarning('The updater notification state could not be read', {
      code: 'ARKLOCK_NOTIFICATION_FAILURE',
    });
  }
}
const idOf = (value: unknown): string | null =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
const circleRecipients = async (db: Db, circleId: string) =>
  (
    await db
      .select({ id: circleMembers.userId })
      .from(circleMembers)
      .where(eq(circleMembers.circleId, circleId))
  ).map((row) => row.id);

/** Only whitelisted audit actions are projected; arbitrary details and labels never enter the inbox. */
export async function notifyAudit(db: Db, audit: AuditSinkEvent): Promise<void> {
  // A savepoint isolates optional inbox work even when audit() itself runs inside a mutation transaction.
  await safelyNotify(db, (tx) => notifyAuditRaw(tx, audit));
}
async function notifyAuditRaw(db: Db, audit: AuditSinkEvent): Promise<void> {
  const { action, detail } = audit;
  const [resourceType = 'system', targetId] = (audit.target ?? '').split(':');
  const resourceId = idOf(targetId);
  const actorId = idOf(audit.actor.startsWith('user:') ? audit.actor.slice(5) : null);
  const vaultId = resourceType === 'vault' ? resourceId : idOf(detail?.vault);
  let recipients: string[] = [];
  let category: NotificationCategory = 'access';
  let event = action;
  if (action === 'vault.member.put' || action === 'vault.member.remove') {
    const member = idOf(detail?.member);
    if (member) recipients = [member];
  } else if (action === 'grant.put' || action === 'grant.delete') {
    const subject = idOf(detail?.subject);
    if (subject)
      recipients =
        detail?.subjectType === 'circle' ? await circleRecipients(db, subject) : [subject];
    if (action === 'grant.put' && detail?.role === 'none') event = 'grant.deny';
  } else if (action === 'vault.circle.put' || action === 'vault.circle.remove') {
    const circle = idOf(detail?.circle);
    if (circle) recipients = await circleRecipients(db, circle);
  } else if (action === 'admin.circle.member.add' || action === 'admin.circle.member.remove') {
    if (detail?.changed === false) return;
    const member = idOf(detail?.member);
    if (member) recipients = [member];
  } else if (action === 'vault.owner.transfer') {
    const next = idOf(detail?.to);
    if (next) recipients = [next];
  } else if (
    action.startsWith('handoff.') &&
    resourceId &&
    ['handoff.create', 'handoff.open', 'handoff.revoke'].includes(action)
  ) {
    category = 'sharing';
    const [link] = await db
      .select({ owner: handoffs.createdBy })
      .from(handoffs)
      .where(eq(handoffs.id, resourceId));
    if (link) recipients = [link.owner];
  } else if ((action === 'signal.create' || action === 'signal.update') && resourceId) {
    category = 'security';
    const [signal] = await db.select().from(signals).where(eq(signals.id, resourceId));
    if (!signal) return;
    const [entry] = await db
      .select({ branchId: entries.branchId })
      .from(entries)
      .where(eq(entries.id, signal.entryId));
    if (!entry) return;
    const custodians = await db
      .select({ id: vaultMembers.userId })
      .from(vaultMembers)
      .where(
        and(
          eq(vaultMembers.vaultId, signal.vaultId),
          inArray(vaultMembers.role, ['owner', 'admin']),
        ),
      );
    for (const id of new Set([
      ...custodians.map((c) => c.id),
      signal.reportedBy,
      ...(signal.assignedTo ? [signal.assignedTo] : []),
    ]))
      if ((await loadAccess(db, signal.vaultId, id)).entry(signal.entryId, entry.branchId))
        recipients.push(id);
    await notifyUsers(db, recipients, {
      category,
      event,
      vaultId: signal.vaultId,
      resourceType: 'entry',
      resourceId: signal.entryId,
    });
    return;
  } else if (
    [
      'auth.password.change',
      'auth.recovery.complete',
      'auth.mfa.enable',
      'auth.mfa.disable',
      'auth.webauthn.add',
      'auth.webauthn.remove',
      'auth.token.create',
      'auth.token.revoke',
      'auth.session.revoke-others',
    ].includes(action)
  ) {
    category = 'security';
    if (actorId) recipients = [actorId];
  } else if (action === 'admin.user.update' || action === 'admin.user.revoke-sessions') {
    category = 'security';
    if (resourceId) recipients = [resourceId];
  } else if (
    action === 'admin.ldap.sync.failed' ||
    (['admin.smtp.test', 'admin.smtp.send-test'].includes(action) && detail?.ok === false)
  ) {
    category = 'system';
    event = 'system.failure';
    recipients = (await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'))).map(
      (row) => row.id,
    );
  } else return;
  await notifyUsers(db, recipients, {
    category,
    event,
    vaultId,
    resourceType:
      category === 'security' ? 'account' : category === 'system' ? 'system' : resourceType,
    resourceId: category === 'security' || category === 'system' ? null : resourceId,
  });
  if (action === 'vault.member.put' && vaultId && recipients.length) {
    const [vault] = await db
      .select({ version: vaults.keyVersion })
      .from(vaults)
      .where(eq(vaults.id, vaultId));
    if (!vault) return;
    const issued = await db
      .select({ id: vaultKeys.userId })
      .from(vaultKeys)
      .where(
        and(
          eq(vaultKeys.vaultId, vaultId),
          eq(vaultKeys.keyVersion, vault.version),
          inArray(vaultKeys.userId, recipients),
        ),
      );
    const haveKey = new Set(issued.map((row) => row.id));
    await notifyUsers(
      db,
      recipients.filter((id) => !haveKey.has(id)),
      {
        category: 'access',
        event: 'vault.key.pending',
        vaultId,
        resourceType: 'vault',
        resourceId: vaultId,
      },
    );
  }
}
