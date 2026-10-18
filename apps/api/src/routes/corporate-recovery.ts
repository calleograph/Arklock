import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  corporateRecoveryActivate,
  corporateRecoveryClaim,
  corporateRecoveryEnroll,
  corporateRecoveryRecipient,
  uuid,
} from '@arklock/contracts';
import {
  ctx as cryptoContext,
  fromBase64Url,
  sealVaultKeyFor,
  toBase64Url,
  utf8,
  verify,
  verifyKeyGrant,
} from '@arklock/crypto';
import { requireVault } from '../access.js';
import { audit } from '../audit.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db/connect.js';
import {
  CORPORATE_RECOVERY_KEY,
  CORPORATE_RECOVERY_PENDING_KEY,
  corporateRecoveryRecipientOf,
} from '../corporate-recovery.js';
import {
  corporateRecoveryChallenges,
  corporateRecoveryKeys,
  settings,
  users,
  vaultKeys,
  vaultMembers,
  vaults,
} from '../db/schema.js';
import { AppError, forbidden, notFound, parse } from '../errors.js';
import { sha256Hex } from '../security.js';
import { ensureRecoveredSpaceMember } from '../spaces.js';

export const registerCorporateRecoveryRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  const vaultParams = z.object({ vaultId: uuid });
  app.addHook('preHandler', requireAuth(ctx));

  function human(req: FastifyRequest) {
    const auth = authOf(req);
    if (auth.viaToken) throw forbidden();
    return auth;
  }
  function fullAdmin(req: FastifyRequest) {
    const auth = human(req);
    if (auth.user.role !== 'admin') throw forbidden();
    return auth;
  }
  /** Новый получатель, подготовленный для замены: действующим становится только после переподключения всех сейфов. */
  async function pendingRecipient(connection: Db = db) {
    const [row] = await connection
      .select()
      .from(settings)
      .where(eq(settings.key, CORPORATE_RECOVERY_PENDING_KEY));
    const parsed = corporateRecoveryRecipient.safeParse(row?.value);
    return parsed.success ? parsed.data : null;
  }
  async function recipientRequired(connection: Db = db) {
    const recipient = await corporateRecoveryRecipientOf(connection);
    if (!recipient)
      throw new AppError(
        409,
        'recovery_not_configured',
        'Configure an offline corporate recovery recipient first',
      );
    if (!recipient.enabled)
      throw new AppError(409, 'recovery_disabled', 'Corporate recovery is disabled');
    return recipient;
  }
  async function validateNewRecipient(body: z.infer<typeof corporateRecoveryActivate>) {
    const [account] = await db.select({ id: users.id }).from(users).where(eq(users.id, body.id));
    if (account)
      throw new AppError(
        400,
        'recovery_recipient_invalid',
        'The recovery identity must be separate from user accounts',
      );
    const message = cryptoContext(
      'corporate-recovery-activate',
      body.id,
      body.publicKey,
      body.signPublicKey,
    );
    const valid = await verify(
      fromBase64Url(body.signPublicKey),
      fromBase64Url(body.proof),
      utf8(message),
    ).catch(() => false);
    if (!valid)
      throw new AppError(400, 'recovery_proof_invalid', 'Invalid recovery identity proof');
    try {
      await globalThis.crypto.subtle.importKey(
        'raw',
        fromBase64Url(body.publicKey),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      );
    } catch {
      throw new AppError(
        400,
        'recovery_recipient_invalid',
        'Invalid recovery encryption public key',
      );
    }
  }
  async function sharedVault(vaultId: string) {
    const [vault] = await db.select().from(vaults).where(eq(vaults.id, vaultId));
    if (!vault || vault.kind !== 'shared') throw notFound();
    return vault;
  }
  async function rescueOf(vaultId: string, recipientId: string, keyVersion: number) {
    const [rescue] = await db
      .select()
      .from(corporateRecoveryKeys)
      .where(
        and(
          eq(corporateRecoveryKeys.vaultId, vaultId),
          eq(corporateRecoveryKeys.recipientId, recipientId),
          eq(corporateRecoveryKeys.keyVersion, keyVersion),
        ),
      );
    return rescue ?? null;
  }

  app.get('/corporate-recovery', async (req) => {
    human(req);
    return { recipient: await corporateRecoveryRecipientOf(db) };
  });

  app.get('/admin/corporate-recovery', async (req) => {
    fullAdmin(req);
    const recipient = await corporateRecoveryRecipientOf(db);
    const [shared, rescues] = await Promise.all([
      db.select().from(vaults).where(eq(vaults.kind, 'shared')),
      db
        .select({
          vaultId: corporateRecoveryKeys.vaultId,
          recipientId: corporateRecoveryKeys.recipientId,
          keyVersion: corporateRecoveryKeys.keyVersion,
        })
        .from(corporateRecoveryKeys),
    ]);
    const pending = await pendingRecipient();
    return {
      recipient,
      pending,
      vaults: shared.map((vault) => ({
        id: vault.id,
        name: vault.name ?? '',
        keyVersion: vault.keyVersion,
        pendingEnrolled:
          !!pending &&
          rescues.some(
            (rescue) =>
              rescue.vaultId === vault.id &&
              rescue.recipientId === pending.id &&
              rescue.keyVersion === vault.keyVersion,
          ),
        enrolled:
          !!recipient &&
          rescues.some(
            (rescue) =>
              rescue.vaultId === vault.id &&
              rescue.recipientId === recipient.id &&
              rescue.keyVersion === vault.keyVersion,
          ),
      })),
    };
  });

  app.post('/admin/corporate-recovery', async (req, reply) => {
    const { user } = fullAdmin(req);
    const body = parse(corporateRecoveryActivate, req.body);
    await validateNewRecipient(body);
    const recipient = {
      id: body.id,
      publicKey: body.publicKey,
      signPublicKey: body.signPublicKey,
      createdAt: new Date().toISOString(),
      createdBy: user.id,
      enabled: true,
    };
    // An initial recipient cannot be silently replaced: old envelopes require the original offline package.
    const inserted = await db
      .insert(settings)
      .values({ key: CORPORATE_RECOVERY_KEY, value: recipient, updatedBy: user.id })
      .onConflictDoNothing()
      .returning({ key: settings.key });
    if (!inserted.length)
      throw new AppError(
        409,
        'recovery_already_configured',
        'The existing recovery recipient cannot be replaced',
      );
    await audit(db, `user:${user.id}`, 'corporate.recovery.activate', `recovery:${body.id}`, {
      packageSaved: true,
    });
    return reply.status(201).send({ recipient });
  });

  /** Замена получателя: подготовка нового получателя; прежний продолжает действовать до переподключения всех сейфов. */
  app.post('/admin/corporate-recovery/replacement', async (req, reply) => {
    const { user } = fullAdmin(req);
    const body = parse(corporateRecoveryActivate, req.body);
    const active = await recipientRequired();
    if (body.id === active.id)
      throw new AppError(400, 'recovery_recipient_invalid', 'Create a new offline package');
    await validateNewRecipient(body);
    const recipient = {
      id: body.id,
      publicKey: body.publicKey,
      signPublicKey: body.signPublicKey,
      createdAt: new Date().toISOString(),
      createdBy: user.id,
      enabled: true,
    };
    const inserted = await db
      .insert(settings)
      .values({ key: CORPORATE_RECOVERY_PENDING_KEY, value: recipient, updatedBy: user.id })
      .onConflictDoNothing()
      .returning({ key: settings.key });
    if (!inserted.length)
      throw new AppError(409, 'recovery_replacement_pending', 'A replacement is already prepared');
    await audit(db, `user:${user.id}`, 'corporate.recovery.replace.start', `recovery:${body.id}`);
    return reply.status(201).send({ pending: recipient });
  });

  app.delete('/admin/corporate-recovery/replacement', async (req, reply) => {
    const { user } = fullAdmin(req);
    await db.transaction(async (tx) => {
      const pending = await pendingRecipient(tx);
      if (!pending) throw notFound();
      await tx
        .delete(corporateRecoveryKeys)
        .where(eq(corporateRecoveryKeys.recipientId, pending.id));
      await tx.delete(settings).where(eq(settings.key, CORPORATE_RECOVERY_PENDING_KEY));
      await audit(
        tx,
        `user:${user.id}`,
        'corporate.recovery.replace.cancel',
        `recovery:${pending.id}`,
      );
    });
    return reply.status(204).send();
  });

  app.post('/admin/corporate-recovery/replacement/complete', async (req) => {
    const { user } = fullAdmin(req);
    return db.transaction(async (tx) => {
      await tx
        .select({ key: settings.key })
        .from(settings)
        .where(eq(settings.key, CORPORATE_RECOVERY_KEY))
        .for('update');
      const active = await recipientRequired(tx);
      const pending = await pendingRecipient(tx);
      if (!pending) throw notFound();
      const [shared, rescues] = await Promise.all([
        tx.select().from(vaults).where(eq(vaults.kind, 'shared')),
        tx.select().from(corporateRecoveryKeys),
      ]);
      // сейф, защищённый прежним получателем, обязан быть защищён и новым: иначе замена оставила бы его без восстановления
      const missing = shared.filter(
        (v) =>
          rescues.some((r) => r.vaultId === v.id && r.recipientId === active.id) &&
          !rescues.some(
            (r) =>
              r.vaultId === v.id && r.recipientId === pending.id && r.keyVersion === v.keyVersion,
          ),
      );
      if (missing.length)
        throw new AppError(
          409,
          'recovery_replacement_incomplete',
          'Connect these vaults to the new recipient first',
          { vaults: missing.map((v) => ({ id: v.id, name: v.name ?? '' })) },
        );
      await tx
        .update(settings)
        .set({
          value: { ...pending, enabled: active.enabled },
          updatedBy: user.id,
          updatedAt: new Date(),
        })
        .where(eq(settings.key, CORPORATE_RECOVERY_KEY));
      await tx
        .delete(corporateRecoveryKeys)
        .where(eq(corporateRecoveryKeys.recipientId, active.id));
      await tx.delete(corporateRecoveryChallenges);
      await tx.delete(settings).where(eq(settings.key, CORPORATE_RECOVERY_PENDING_KEY));
      await audit(
        tx,
        `user:${user.id}`,
        'corporate.recovery.replace.complete',
        `recovery:${pending.id}`,
        {
          previous: active.id,
        },
      );
      return { recipient: { ...pending, enabled: active.enabled } };
    });
  });

  app.patch('/admin/corporate-recovery', async (req) => {
    const { user } = fullAdmin(req);
    const body = parse(z.object({ enabled: z.boolean() }).strict(), req.body);
    const recipient = await corporateRecoveryRecipientOf(db);
    if (!recipient)
      throw new AppError(
        409,
        'recovery_not_configured',
        'Configure an offline corporate recovery recipient first',
      );
    const updated = { ...recipient, enabled: body.enabled };
    await db.transaction(async (tx) => {
      await tx
        .update(settings)
        .set({ value: updated, updatedBy: user.id, updatedAt: new Date() })
        .where(eq(settings.key, CORPORATE_RECOVERY_KEY));
      if (!body.enabled) await tx.delete(corporateRecoveryChallenges);
      await audit(
        tx,
        `user:${user.id}`,
        body.enabled ? 'corporate.recovery.enable' : 'corporate.recovery.disable',
        `recovery:${recipient.id}`,
      );
    });
    return { recipient: updated };
  });

  app.get('/vaults/:vaultId/recovery', async (req) => {
    const { user } = human(req);
    const { vaultId } = parse(vaultParams, req.params);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.isAdmin && !access.can('vault.rotate')) throw forbidden();
    const vault = await sharedVault(vaultId);
    const recipient = await corporateRecoveryRecipientOf(db);
    const historical = recipient
      ? await db
          .select({ vaultId: corporateRecoveryKeys.vaultId })
          .from(corporateRecoveryKeys)
          .where(
            and(
              eq(corporateRecoveryKeys.vaultId, vaultId),
              eq(corporateRecoveryKeys.recipientId, recipient.id),
            ),
          )
          .limit(1)
      : [];
    const pending = await pendingRecipient();
    return {
      recipient,
      rescue: recipient ? await rescueOf(vaultId, recipient.id, vault.keyVersion) : null,
      enrolled: historical.length > 0,
      pending,
      pendingEnrolled: pending ? !!(await rescueOf(vaultId, pending.id, vault.keyVersion)) : false,
    };
  });

  app.post('/vaults/:vaultId/recovery', async (req, reply) => {
    const { user } = human(req);
    const { vaultId } = parse(vaultParams, req.params);
    const body = parse(corporateRecoveryEnroll, req.body);
    const access = await requireVault(db, vaultId, user.id);
    if (!access.isAdmin) throw forbidden();
    const active = await recipientRequired();
    const pending = await pendingRecipient();
    const recipient =
      body.recipientId === active.id
        ? active
        : pending && body.recipientId === pending.id
          ? pending
          : null;
    if (!recipient)
      throw new AppError(409, 'recovery_recipient_changed', 'The recovery identity does not match');
    const valid = await verifyKeyGrant(
      fromBase64Url(user.signPublicKey),
      body.signature,
      vaultId,
      recipient.id,
      body.keyVersion,
      body.sealedKey,
    ).catch(() => false);
    if (!valid) throw new AppError(400, 'bad_signature', 'Invalid recovery envelope signature');
    await db.transaction(async (tx) => {
      await tx
        .select({ key: settings.key })
        .from(settings)
        .where(eq(settings.key, CORPORATE_RECOVERY_KEY))
        .for('update');
      await recipientRequired(tx);
      if (recipient.id !== active.id && (await pendingRecipient(tx))?.id !== recipient.id)
        throw new AppError(409, 'recovery_recipient_changed', 'The replacement was cancelled');
      const [vault] = await tx.select().from(vaults).where(eq(vaults.id, vaultId)).for('update');
      if (!vault || vault.kind !== 'shared') throw notFound();
      if (vault.keyVersion !== body.keyVersion)
        throw new AppError(409, 'stale_key_version', 'Enroll the current vault key version');
      const [held] = await tx
        .select({ userId: vaultKeys.userId })
        .from(vaultKeys)
        .where(
          and(
            eq(vaultKeys.vaultId, vaultId),
            eq(vaultKeys.userId, user.id),
            eq(vaultKeys.keyVersion, body.keyVersion),
          ),
        );
      if (!held)
        throw new AppError(
          409,
          'key_missing',
          'A current vault key is required for recovery enrollment',
        );
      const values = {
        vaultId,
        recipientId: recipient.id,
        keyVersion: body.keyVersion,
        sealedKey: body.sealedKey,
        signature: body.signature,
        grantedBy: user.id,
        grantedBySignKey: user.signPublicKey,
      };
      await tx
        .insert(corporateRecoveryKeys)
        .values(values)
        .onConflictDoUpdate({
          target: [
            corporateRecoveryKeys.vaultId,
            corporateRecoveryKeys.recipientId,
            corporateRecoveryKeys.keyVersion,
          ],
          set: { ...values, createdAt: new Date() },
        });
      await audit(tx, `user:${user.id}`, 'corporate.recovery.enroll', `vault:${vaultId}`, {
        recipient: recipient.id,
        keyVersion: body.keyVersion,
      });
    });
    return reply.status(204).send();
  });

  app.post('/admin/corporate-recovery/:vaultId/challenge', async (req) => {
    const { user, session } = fullAdmin(req);
    const { vaultId } = parse(vaultParams, req.params);
    const recipient = await recipientRequired();
    const vault = await sharedVault(vaultId);
    const rescue = await rescueOf(vaultId, recipient.id, vault.keyVersion);
    if (!rescue)
      throw new AppError(
        409,
        'recovery_key_missing',
        'This vault has no recovery envelope for its current key version',
      );
    const nonce = randomBytes(32);
    const encryptedNonce = await sealVaultKeyFor(
      nonce,
      fromBase64Url(recipient.publicKey),
      vaultId,
      recipient.id,
      vault.keyVersion,
    );
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const message = cryptoContext(
      'corporate-recovery-challenge',
      id,
      user.id,
      session.id,
      vaultId,
      recipient.id,
      vault.keyVersion,
      encryptedNonce,
      expiresAt.toISOString(),
      user.publicKey,
      user.signPublicKey,
    );
    await db.transaction(async (tx) => {
      await tx
        .select({ key: settings.key })
        .from(settings)
        .where(eq(settings.key, CORPORATE_RECOVERY_KEY))
        .for('update');
      await recipientRequired(tx);
      await tx
        .delete(corporateRecoveryChallenges)
        .where(
          or(
            lt(corporateRecoveryChallenges.expiresAt, new Date()),
            and(
              eq(corporateRecoveryChallenges.sessionId, session.id),
              eq(corporateRecoveryChallenges.vaultId, vaultId),
            ),
          ),
        );
      await tx.insert(corporateRecoveryChallenges).values({
        id,
        userId: user.id,
        sessionId: session.id,
        vaultId,
        recipientId: recipient.id,
        keyVersion: vault.keyVersion,
        nonceHash: sha256Hex(toBase64Url(nonce)),
        message,
        expiresAt,
      });
      await audit(tx, `user:${user.id}`, 'corporate.recovery.challenge', `vault:${vaultId}`, {
        recipient: recipient.id,
        keyVersion: vault.keyVersion,
      });
    });
    return {
      challengeId: id,
      encryptedNonce,
      expiresAt: expiresAt.toISOString(),
      message,
      rescue,
      recipient,
      target: { userId: user.id, publicKey: user.publicKey, signPublicKey: user.signPublicKey },
    };
  });

  app.post('/admin/corporate-recovery/:vaultId/recover', async (req) => {
    const { user, session } = fullAdmin(req);
    const { vaultId } = parse(vaultParams, req.params);
    const body = parse(corporateRecoveryClaim, req.body);
    const [challenge] = await db
      .select()
      .from(corporateRecoveryChallenges)
      .where(
        and(
          eq(corporateRecoveryChallenges.id, body.challengeId),
          eq(corporateRecoveryChallenges.userId, user.id),
          eq(corporateRecoveryChallenges.sessionId, session.id),
          eq(corporateRecoveryChallenges.vaultId, vaultId),
          isNull(corporateRecoveryChallenges.usedAt),
          gt(corporateRecoveryChallenges.expiresAt, new Date()),
        ),
      );
    if (!challenge)
      throw new AppError(
        409,
        'recovery_challenge_expired',
        'Request a new one-use recovery challenge',
      );
    const recipient = await recipientRequired();
    const proofMessage = cryptoContext(
      'corporate-recovery-recover',
      challenge.message,
      body.nonce,
      body.sealedKey,
      body.signature,
    );
    const [recoveryProof, selfSignature] = await Promise.all([
      verify(
        fromBase64Url(recipient.signPublicKey),
        fromBase64Url(body.proof),
        utf8(proofMessage),
      ).catch(() => false),
      verifyKeyGrant(
        fromBase64Url(user.signPublicKey),
        body.signature,
        vaultId,
        user.id,
        challenge.keyVersion,
        body.sealedKey,
      ).catch(() => false),
    ]);
    if (
      recipient.id !== challenge.recipientId ||
      sha256Hex(body.nonce) !== challenge.nonceHash ||
      !recoveryProof ||
      !selfSignature
    ) {
      await audit(db, `user:${user.id}`, 'corporate.recovery.failed', `vault:${vaultId}`, {
        reason: 'invalid_proof',
      });
      throw new AppError(403, 'recovery_proof_invalid', 'The recovery proof is invalid');
    }
    await db.transaction(async (tx) => {
      await tx
        .select({ key: settings.key })
        .from(settings)
        .where(eq(settings.key, CORPORATE_RECOVERY_KEY))
        .for('update');
      await recipientRequired(tx);
      const [vault] = await tx.select().from(vaults).where(eq(vaults.id, vaultId)).for('update');
      if (!vault || vault.kind !== 'shared') throw notFound();
      if (vault.keyVersion !== challenge.keyVersion)
        throw new AppError(
          409,
          'stale_key_version',
          'The vault key version changed; request a new challenge',
        );
      const [rescue] = await tx
        .select({ vaultId: corporateRecoveryKeys.vaultId })
        .from(corporateRecoveryKeys)
        .where(
          and(
            eq(corporateRecoveryKeys.vaultId, vaultId),
            eq(corporateRecoveryKeys.recipientId, recipient.id),
            eq(corporateRecoveryKeys.keyVersion, challenge.keyVersion),
          ),
        );
      if (!rescue)
        throw new AppError(
          409,
          'recovery_key_missing',
          'The vault has no current recovery envelope',
        );
      const consumed = await tx
        .update(corporateRecoveryChallenges)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(corporateRecoveryChallenges.id, challenge.id),
            isNull(corporateRecoveryChallenges.usedAt),
            gt(corporateRecoveryChallenges.expiresAt, new Date()),
          ),
        )
        .returning({ id: corporateRecoveryChallenges.id });
      if (!consumed.length)
        throw new AppError(
          409,
          'recovery_challenge_expired',
          'This recovery challenge has already been used or expired',
        );
      const spaceMembershipAdded = await ensureRecoveredSpaceMember(tx, vault.spaceId, user.id);
      await tx
        .update(vaultMembers)
        .set({ role: 'admin' })
        .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.role, 'owner')));
      await tx
        .insert(vaultMembers)
        .values({ vaultId, userId: user.id, role: 'owner' })
        .onConflictDoUpdate({
          target: [vaultMembers.vaultId, vaultMembers.userId],
          set: { role: 'owner', customRoleId: null, expiresAt: null },
        });
      await tx
        .insert(vaultKeys)
        .values({
          vaultId,
          userId: user.id,
          keyVersion: challenge.keyVersion,
          sealedKey: body.sealedKey,
          signature: body.signature,
          grantedBy: user.id,
        })
        .onConflictDoUpdate({
          target: [vaultKeys.vaultId, vaultKeys.userId, vaultKeys.keyVersion],
          set: { sealedKey: body.sealedKey, signature: body.signature, grantedBy: user.id },
        });
      await audit(tx, `user:${user.id}`, 'corporate.recovery.complete', `vault:${vaultId}`, {
        recipient: recipient.id,
        keyVersion: challenge.keyVersion,
        ownershipTransferred: true,
        spaceMembershipAdded,
      });
    });
    return {
      vaultId,
      keyVersion: challenge.keyVersion,
      role: 'owner',
      objectDenialsPreserved: true,
    };
  });
};
