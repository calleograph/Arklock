import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createVaultKey,
  ctx,
  fromBase64Url,
  generateAccountKeyPair,
  generateSigningKeyPair,
  openVaultKey,
  rewrapEntry,
  sealVaultKeyFor,
  sign,
  signKeyGrant,
  toBase64Url,
  utf8,
  verifyKeyGrant,
} from '@arklock/crypto';
import {
  corporateRecoveryChallenges,
  corporateRecoveryKeys,
  settings,
  users,
  vaultMembers,
} from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

let app: Awaited<ReturnType<typeof createTestApp>>['app'];
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let owner: TestClient;
let outsider: TestClient;
let encryption: Awaited<ReturnType<typeof generateAccountKeyPair>>;
let signing: Awaited<ReturnType<typeof generateSigningKeyPair>>;
let vaultId: string;
let entryId: string;
let key: Uint8Array;
const recipientId = crypto.randomUUID();

beforeAll(async () => {
  fixture = await createTestApp();
  ({ app } = fixture);
  admin = new TestClient(app, 'admin@example.com', 'admin-password-12345');
  expect((await admin.register()).statusCode).toBe(201);
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  owner = new TestClient(app, 'owner@example.com', 'owner-password-12345');
  outsider = new TestClient(app, 'outsider@example.com', 'outsider-password-12345');
  expect((await owner.register()).statusCode).toBe(201);
  expect((await outsider.register()).statusCode).toBe(201);
  await admin.login();
  await owner.login();
  await outsider.login();
  const created = await admin.createSharedVault('Recoverable company data');
  vaultId = created.id;
  key = created.key;
  const entry = await admin.createEntry(
    { password: 'corporate-secret' },
    { vaultId, vaultKey: key },
  );
  entryId = entry.entryId;
  expect((await admin.addMember(vaultId, owner, 'admin', key)).statusCode).toBe(204);
  expect(
    (await admin.req('POST', `/vaults/${vaultId}/transfer-ownership`, { userId: owner.userId }))
      .statusCode,
  ).toBe(200);
  expect((await owner.req('DELETE', `/vaults/${vaultId}/members/${admin.userId}`)).statusCode).toBe(
    200,
  );
  encryption = await generateAccountKeyPair();
  signing = await generateSigningKeyPair();
});
afterAll(async () => {
  await app.close();
});

async function claim(challenge: {
  encryptedNonce: string;
  message: string;
  challengeId: string;
  rescue: { keyVersion: number; sealedKey: string; signature: string; grantedBySignKey: string };
}) {
  const version = challenge.rescue.keyVersion;
  expect(
    await verifyKeyGrant(
      fromBase64Url(challenge.rescue.grantedBySignKey),
      challenge.rescue.signature,
      vaultId,
      recipientId,
      version,
      challenge.rescue.sealedKey,
    ),
  ).toBe(true);
  const recovered = await openVaultKey(
    challenge.rescue.sealedKey,
    encryption.privateKey,
    encryption.publicKey,
    vaultId,
    recipientId,
    version,
  );
  const nonce = toBase64Url(
    await openVaultKey(
      challenge.encryptedNonce,
      encryption.privateKey,
      encryption.publicKey,
      vaultId,
      recipientId,
      version,
    ),
  );
  const sealedKey = await sealVaultKeyFor(
    recovered,
    admin.publicKey,
    vaultId,
    admin.userId,
    version,
  );
  const signature = await signKeyGrant(
    admin.signPrivateKey,
    vaultId,
    admin.userId,
    version,
    sealedKey,
  );
  const proof = toBase64Url(
    await sign(
      signing.privateKey,
      utf8(ctx('corporate-recovery-recover', challenge.message, nonce, sealedKey, signature)),
    ),
  );
  return { challengeId: challenge.challengeId, nonce, sealedKey, signature, proof };
}

it('only full administrators activate an independently signed recipient after offline-package acknowledgement', async () => {
  const publicKey = toBase64Url(encryption.publicKey);
  const signPublicKey = toBase64Url(signing.publicKey);
  const proof = toBase64Url(
    await sign(
      signing.privateKey,
      utf8(ctx('corporate-recovery-activate', recipientId, publicKey, signPublicKey)),
    ),
  );
  const body = { id: recipientId, publicKey, signPublicKey, packageSaved: true, proof };
  expect((await owner.req('POST', '/admin/corporate-recovery', body)).statusCode).toBe(403);
  expect(
    (await admin.req('POST', '/admin/corporate-recovery', { ...body, packageSaved: false }))
      .statusCode,
  ).toBe(400);
  expect(
    (await admin.req('POST', '/admin/corporate-recovery', { ...body, proof: 'A'.repeat(86) }))
      .statusCode,
  ).toBe(400);
  expect((await admin.req('POST', '/admin/corporate-recovery', body)).statusCode).toBe(201);
  expect((await admin.req('POST', '/admin/corporate-recovery', body)).statusCode).toBe(409);
  expect((await owner.req('GET', '/corporate-recovery')).json().recipient).toMatchObject({
    id: recipientId,
    enabled: true,
  });
});

it('requires explicit signed enrollment by a current authorized key holder; missing envelopes cannot recover old data', async () => {
  expect(
    (await admin.req('POST', `/admin/corporate-recovery/${vaultId}/challenge`, {})).statusCode,
  ).toBe(409);
  const sealedKey = await sealVaultKeyFor(key, encryption.publicKey, vaultId, recipientId, 1);
  const signature = await signKeyGrant(owner.signPrivateKey, vaultId, recipientId, 1, sealedKey);
  const body = { recipientId, keyVersion: 1, sealedKey, signature };
  expect((await outsider.req('POST', `/vaults/${vaultId}/recovery`, body)).statusCode).toBe(404);
  expect(
    (await owner.req('POST', `/vaults/${vaultId}/recovery`, { ...body, signature: 'A'.repeat(86) }))
      .statusCode,
  ).toBe(400);
  expect((await owner.req('POST', `/vaults/${vaultId}/recovery`, body)).statusCode).toBe(204);
  expect((await owner.req('GET', `/vaults/${vaultId}/recovery`)).json()).toMatchObject({
    enrolled: true,
    rescue: { recipientId, keyVersion: 1 },
  });
});

it('binds recovery to its session, expires challenges and rejects invalid nonce or modified grants', async () => {
  expect(
    (await outsider.req('POST', `/admin/corporate-recovery/${vaultId}/challenge`, {})).statusCode,
  ).toBe(403);
  const challenge = (
    await admin.req('POST', `/admin/corporate-recovery/${vaultId}/challenge`, {})
  ).json();
  const body = await claim(challenge);
  const base = `/admin/corporate-recovery/${vaultId}/recover`;
  expect((await admin.req('POST', base, { ...body, nonce: 'A'.repeat(43) })).statusCode).toBe(403);
  const forgedKey = await sealVaultKeyFor(
    createVaultKey(),
    admin.publicKey,
    vaultId,
    admin.userId,
    1,
  );
  expect((await admin.req('POST', base, { ...body, sealedKey: forgedKey })).statusCode).toBe(403);
  await admin.login();
  expect((await admin.req('POST', base, body)).statusCode).toBe(409);
  const fresh = (
    await admin.req('POST', `/admin/corporate-recovery/${vaultId}/challenge`, {})
  ).json();
  const expired = await claim(fresh);
  await fixture.database.db
    .update(corporateRecoveryChallenges)
    .set({ expiresAt: new Date(0) })
    .where(eq(corporateRecoveryChallenges.id, fresh.challengeId));
  expect((await admin.req('POST', base, expired)).statusCode).toBe(409);
});

it('restores a key and unique ownership after the last ordinary custodian is unavailable; challenge replay fails', async () => {
  await fixture.database.db
    .update(users)
    .set({ disabledAt: new Date() })
    .where(eq(users.id, owner.userId));
  expect((await admin.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(404);
  const challenge = (
    await admin.req('POST', `/admin/corporate-recovery/${vaultId}/challenge`, {})
  ).json();
  const body = await claim(challenge);
  expect(
    (await admin.req('POST', `/admin/corporate-recovery/${vaultId}/recover`, body)).json(),
  ).toMatchObject({ vaultId, keyVersion: 1, role: 'owner' });
  expect(
    (await admin.req('POST', `/admin/corporate-recovery/${vaultId}/recover`, body)).statusCode,
  ).toBe(409);
  const recovered = await admin.openVault(
    (await admin.vaults()).find((vault) => vault.id === vaultId)!,
  );
  expect(Buffer.from(recovered).equals(Buffer.from(key))).toBe(true);
  expect(await admin.readEntry(vaultId, entryId, recovered)).toEqual({
    password: 'corporate-secret',
  });
  const owners = await fixture.database.db
    .select()
    .from(vaultMembers)
    .where(eq(vaultMembers.vaultId, vaultId));
  expect(owners.filter((member) => member.role === 'owner').map((member) => member.userId)).toEqual(
    [admin.userId],
  );
});

it('disables online recovery, revokes outstanding challenges and preserves rescue blobs for re-enabling', async () => {
  const challenge = (
    await admin.req('POST', `/admin/corporate-recovery/${vaultId}/challenge`, {})
  ).json();
  const body = await claim(challenge);
  expect(
    (await admin.req('PATCH', '/admin/corporate-recovery', { enabled: false })).statusCode,
  ).toBe(200);
  expect(
    (await admin.req('POST', `/admin/corporate-recovery/${vaultId}/challenge`, {})).json().error
      .code,
  ).toBe('recovery_disabled');
  expect(await fixture.database.db.select().from(corporateRecoveryKeys)).toHaveLength(1);
  expect(
    (await admin.req('PATCH', '/admin/corporate-recovery', { enabled: true })).statusCode,
  ).toBe(200);
  expect(
    (await admin.req('POST', `/admin/corporate-recovery/${vaultId}/recover`, body)).statusCode,
  ).toBe(409);
});

it('preserves preconfigured recovery atomically through vault-key rotation', async () => {
  const newKey = createVaultKey();
  const current = (await admin.req('GET', `/vaults/${vaultId}/entries/${entryId}`)).json();
  const rewrapped = await rewrapEntry(current, key, newKey, vaultId, entryId, 2);
  const body = {
    newKeyVersion: 2,
    entries: [
      {
        id: entryId,
        expectedVersion: current.version,
        wrappedEntryKey: rewrapped.wrappedEntryKey,
        ciphertext: rewrapped.ciphertext,
      },
    ],
    revisions: [],
    branches: [],
    keys: [{ userId: admin.userId, ...(await admin.keyFor(admin, vaultId, newKey, 2)) }],
  };
  expect((await admin.req('POST', `/vaults/${vaultId}/rotate`, body)).json().error.code).toBe(
    'recovery_key_required',
  );
  const sealedKey = await sealVaultKeyFor(newKey, encryption.publicKey, vaultId, recipientId, 2);
  const signature = await signKeyGrant(admin.signPrivateKey, vaultId, recipientId, 2, sealedKey);
  const rotated = await admin.req('POST', `/vaults/${vaultId}/rotate`, {
    ...body,
    recoveryKey: { recipientId, keyVersion: 2, sealedKey, signature },
  });
  expect(rotated.statusCode, rotated.body).toBe(200);
  const challenge = (
    await admin.req('POST', `/admin/corporate-recovery/${vaultId}/challenge`, {})
  ).json();
  const recovered = await openVaultKey(
    challenge.rescue.sealedKey,
    encryption.privateKey,
    encryption.publicKey,
    vaultId,
    recipientId,
    2,
  );
  expect(await admin.readEntry(vaultId, entryId, recovered)).toEqual({
    password: 'corporate-secret',
  });
});
