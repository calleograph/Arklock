import { z } from 'zod';
import { b64url, sealedBox, uuid } from './common.js';

export const corporateRecoveryRecipient = z.object({
  id: uuid,
  publicKey: b64url(87, 87),
  signPublicKey: b64url(87, 87),
  createdAt: z.string().datetime(),
  createdBy: uuid,
  enabled: z.boolean().default(true),
});
export type CorporateRecoveryRecipient = z.infer<typeof corporateRecoveryRecipient>;
export const corporateRecoveryActivate = corporateRecoveryRecipient
  .omit({ createdAt: true, createdBy: true, enabled: true })
  .extend({
    packageSaved: z.literal(true),
    proof: b64url(86, 86),
  })
  .strict();
export const corporateRecoveryEnroll = z
  .object({
    recipientId: uuid,
    keyVersion: z.number().int().min(1),
    sealedKey: sealedBox,
    signature: b64url(86, 86),
  })
  .strict();
export const corporateRecoveryClaim = z
  .object({
    challengeId: uuid,
    nonce: b64url(43, 43),
    sealedKey: sealedBox,
    signature: b64url(86, 86),
    proof: b64url(86, 86),
  })
  .strict();
