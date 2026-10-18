import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  ctx,
  generateAccountKeyPair,
  generateSigningKeyPair,
  sealVaultKeyFor,
  sign,
  signKeyGrant,
  toBase64Url,
  utf8,
} from '@arklock/crypto';
import { corporateRecoveryKeys, settings } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let member: TestClient;
let vaultId: string;
let vaultKey: Uint8Array;

async function identity() {
  const enc = await generateAccountKeyPair();
  const sig = await generateSigningKeyPair();
  const id = crypto.randomUUID();
  const publicKey = toBase64Url(enc.publicKey);
  const signPublicKey = toBase64Url(sig.publicKey);
  const proof = toBase64Url(
    await sign(
      sig.privateKey,
      utf8(ctx('corporate-recovery-activate', id, publicKey, signPublicKey)),
    ),
  );
  return { id, enc, body: { id, publicKey, signPublicKey, packageSaved: true, proof } };
}
async function enroll(who: TestClient, r: Awaited<ReturnType<typeof identity>>) {
  const sealedKey = await sealVaultKeyFor(vaultKey, r.enc.publicKey, vaultId, r.id, 1);
  const signature = await signKeyGrant(who.signPrivateKey, vaultId, r.id, 1, sealedKey);
  return who.req('POST', `/vaults/${vaultId}/recovery`, {
    recipientId: r.id,
    keyVersion: 1,
    sealedKey,
    signature,
  });
}

beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'admin@example.com', 'admin-password-12345');
  await admin.register();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  member = new TestClient(fixture.app, 'member@example.com', 'member-password-12345');
  await member.register();
  await admin.login();
  await member.login();
  const created = await admin.createSharedVault('Finance');
  vaultId = created.id;
  vaultKey = created.key;
});
afterAll(async () => fixture.app.close());

it('replaces the offline recipient only after every protected vault is reconnected to the new one', async () => {
  const a = await identity();
  const b = await identity();
  expect(
    (await admin.req('POST', '/admin/corporate-recovery/replacement', b.body)).statusCode,
  ).toBe(409); // ещё нет действующего
  expect((await admin.req('POST', '/admin/corporate-recovery', a.body)).statusCode).toBe(201);
  expect((await enroll(admin, a)).statusCode).toBe(204);

  // только полный администратор; тот же получатель не принимается
  expect(
    (await member.req('POST', '/admin/corporate-recovery/replacement', b.body)).statusCode,
  ).toBe(403);
  expect(
    (await admin.req('POST', '/admin/corporate-recovery/replacement', a.body)).statusCode,
  ).toBe(400);
  expect(
    (
      await admin.req('POST', '/admin/corporate-recovery/replacement', {
        ...b.body,
        proof: 'A'.repeat(86),
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await admin.req('POST', '/admin/corporate-recovery/replacement', b.body)).statusCode,
  ).toBe(201);
  expect(
    (await admin.req('POST', '/admin/corporate-recovery/replacement', (await identity()).body))
      .statusCode,
  ).toBe(409);

  // пока сейф не подключён к новому получателю, завершить замену нельзя; прежний продолжает действовать
  const early = await admin.req('POST', '/admin/corporate-recovery/replacement/complete');
  expect(early.statusCode).toBe(409);
  expect(early.json().error.code).toBe('recovery_replacement_incomplete');
  expect((await admin.req('GET', '/admin/corporate-recovery')).json().recipient.id).toBe(a.id);

  expect((await enroll(admin, b)).statusCode).toBe(204);
  const view = (await admin.req('GET', `/vaults/${vaultId}/recovery`)).json();
  expect(view).toMatchObject({ pending: { id: b.id }, pendingEnrolled: true });

  const done = await admin.req('POST', '/admin/corporate-recovery/replacement/complete');
  expect(done.statusCode).toBe(200);
  const state = (await admin.req('GET', '/admin/corporate-recovery')).json();
  expect(state.recipient.id).toBe(b.id);
  expect(state.pending).toBeNull();
  expect(state.vaults[0].enrolled).toBe(true);
  // конверты прежнего получателя удалены; подключение к удалённому получателю отвергается
  const rows = await fixture.database.db.select().from(corporateRecoveryKeys);
  expect(rows.map((r) => r.recipientId)).toEqual([b.id]);
  expect((await enroll(admin, a)).statusCode).toBe(409);
});

it('a prepared replacement can be cancelled and leaves the active recipient untouched', async () => {
  const c = await identity();
  expect(
    (await admin.req('POST', '/admin/corporate-recovery/replacement', c.body)).statusCode,
  ).toBe(201);
  expect((await enroll(admin, c)).statusCode).toBe(204);
  expect((await admin.req('DELETE', '/admin/corporate-recovery/replacement')).statusCode).toBe(204);
  expect((await admin.req('DELETE', '/admin/corporate-recovery/replacement')).statusCode).toBe(404);
  expect((await fixture.database.db.select().from(corporateRecoveryKeys)).length).toBe(1);
  expect((await enroll(admin, c)).statusCode).toBe(409);
});
