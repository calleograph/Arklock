import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { toBase64Url } from '@arklock/crypto';
import { connect } from '../src/db/connect.js';
import { ledger, settings, users } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let chief: TestClient;
let admin2: TestClient;
let member: TestClient;

const authKey = async (c: TestClient) => toBase64Url((await c.derive()).keys.authKey);
const withReauth = async (c: TestClient, method: 'POST', url: string, payload: unknown) => {
  const token = (await c.req('POST', '/admin/reauth', { authKey: await authKey(c) })).json().token;
  return fixture.app.inject({
    method,
    url: '/api/v1' + url,
    headers: { ...c.authHeader(), 'x-reauth-token': token },
    payload: payload as never,
  });
};

beforeAll(async () => {
  fixture = await createTestApp();
  chief = new TestClient(fixture.app, 'chief@example.com', 'chief-password-1234');
  await chief.register();
  await chief.login();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  admin2 = new TestClient(fixture.app, 'chief-admin2@example.com', 'chief-password-1234');
  member = new TestClient(fixture.app, 'chief-member@example.com', 'chief-password-1234');
  for (const c of [admin2, member]) {
    await c.register();
    await c.login();
  }
});
afterAll(async () => fixture.app.close());

it('the first administrator is the chief; only the chief appoints and removes full administrators', async () => {
  expect((await chief.req('GET', '/admin/chief')).json()).toMatchObject({
    you: true,
    chief: { id: chief.userId },
    offer: null,
  });
  expect(
    (await chief.req('PATCH', `/admin/users/${admin2.userId}`, { role: 'admin' })).statusCode,
  ).toBe(200);
  await admin2.login();
  // второй полный администратор не назначает и не снимает полных администраторов
  const refused = await admin2.req('PATCH', `/admin/users/${member.userId}`, { role: 'admin' });
  expect(refused.json().error.code).toBe('chief_required');
  for (const body of [{ role: 'member' }, { disabled: true }])
    expect(
      (await admin2.req('PATCH', `/admin/users/${chief.userId}`, body)).json().error.code,
    ).toBe('chief_admin');
  expect(
    (
      await admin2.req('POST', '/admin/invitations', {
        email: 'new-admin@example.com',
        role: 'admin',
      })
    ).json().error.code,
  ).toBe('chief_required');
  // и сам главный не может потерять роль, не передав её
  expect(
    (await chief.req('PATCH', `/admin/users/${chief.userId}`, { role: 'member' })).json().error
      .code,
  ).toBe('chief_admin');
  // обычные операции с сотрудниками второму администратору доступны
  expect(
    (await admin2.req('PATCH', `/admin/users/${member.userId}`, { disabled: true })).statusCode,
  ).toBe(200);
  expect(
    (await admin2.req('PATCH', `/admin/users/${member.userId}`, { disabled: false })).statusCode,
  ).toBe(200);
  await member.login();
});

it('the metadata overview is for the chief only and carries no secrets', async () => {
  const vault = await chief.createSharedVault('Overview-Vault');
  await chief.createEntry({ title: 'hidden' }, { vaultId: vault.id, vaultKey: vault.key });
  expect((await admin2.req('GET', '/admin/structure')).json().error.code).toBe('chief_required');
  const res = await chief.req('GET', '/admin/structure');
  const found = res
    .json()
    .flatMap((s: { vaults: { id: string }[] }) => s.vaults)
    .find((v: { id: string }) => v.id === vault.id);
  expect(found).toMatchObject({ name: 'Overview-Vault', entries: 1, members: 1 });
  expect(res.body).not.toMatch(/cipher|sealed|nonce|wrapped/i);
});

it('the chief role passes only when the successor confirms; old sessions end', async () => {
  // без повторного подтверждения мастер-паролем передача не начинается
  expect(
    (await chief.req('POST', '/admin/chief/transfer', { userId: member.userId })).json().error.code,
  ).toBe('reauth_required');
  expect(
    (await withReauth(admin2, 'POST', '/admin/chief/transfer', { userId: member.userId })).json()
      .error.code,
  ).toBe('chief_required');
  expect(
    (await withReauth(chief, 'POST', '/admin/chief/transfer', { userId: member.userId }))
      .statusCode,
  ).toBe(200);
  expect((await member.req('GET', '/auth/chief-offer')).json().offer.from.id).toBe(chief.userId);
  expect((await admin2.req('GET', '/auth/chief-offer')).json().offer).toBeNull();
  // отказ снимает предложение; повторное — снова
  expect((await member.req('POST', '/auth/chief-offer/decline')).statusCode).toBe(204);
  expect((await member.req('GET', '/auth/chief-offer')).json().offer).toBeNull();
  await withReauth(chief, 'POST', '/admin/chief/transfer', { userId: member.userId });
  // принять может только адресат и только со своим мастер-паролем
  expect(
    (await admin2.req('POST', '/auth/chief-offer/accept', { authKey: await authKey(admin2) }))
      .statusCode,
  ).toBe(404);
  expect(
    (await member.req('POST', '/auth/chief-offer/accept', { authKey: await authKey(admin2) }))
      .statusCode,
  ).toBe(401);
  expect(
    (await member.req('POST', '/auth/chief-offer/accept', { authKey: await authKey(member) }))
      .statusCode,
  ).toBe(200);

  const rows = await fixture.database.db
    .select({ id: users.id, chief: users.chief, role: users.role })
    .from(users);
  expect(rows.filter((r) => r.chief).map((r) => r.id)).toEqual([member.userId]);
  expect(rows.find((r) => r.id === member.userId)?.role).toBe('admin');
  // прежний главный остаётся полным администратором, но его сеансы завершены
  expect(rows.find((r) => r.id === chief.userId)?.role).toBe('admin');
  expect((await chief.req('GET', '/auth/me')).statusCode).toBe(401);
  expect((await member.req('GET', '/admin/chief')).json().you).toBe(true);
  const actions = (await fixture.database.db.select().from(ledger)).map((r) => r.action);
  for (const a of ['admin.chief.offer', 'admin.chief.decline', 'admin.chief.accept'])
    expect(actions).toContain(a);
  // второго главного администратора база не допускает
  await expect(
    fixture.database.db.update(users).set({ chief: true }).where(eq(users.id, admin2.userId)),
  ).rejects.toThrow();
});

it('on upgrade the earliest active full administrator becomes the chief', async () => {
  const database = await connect('pglite:memory');
  const directory = new URL('../drizzle/', import.meta.url);
  const run = async (filter: (name: string) => boolean) => {
    const names = (await readdir(directory)).filter((n) => /^\d+.*\.sql$/.test(n)).sort();
    for (const name of names.filter(filter))
      for (const statement of (await readFile(new URL(name, directory), 'utf8')).split(
        '--> statement-breakpoint',
      ))
        if (statement.trim()) await database.db.execute(sql.raw(statement));
  };
  try {
    await run((n) => n < '0009');
    const insert = (id: string, email: string, role: string, at: string, disabled: boolean) =>
      database.db.execute(
        sql`insert into users (id,email,display_name,role,kdf,kdf_salt,auth_salt,auth_hash,public_key,sign_public_key,wrapped_private_key,wrapped_sign_private_key,recovery_salt,recovery_hash,recovery_wrapped_private_key,recovery_wrapped_sign_private_key,created_at,disabled_at) values (${id},${email},'Legacy',${role},'{}','o','o','o','o','o','o','o','o','o','o','o',${at},${disabled ? at : null})`,
      );
    const [gone, first, second, early] = [1, 2, 3, 4].map(() => crypto.randomUUID());
    await insert(early!, 'early-member@example.com', 'member', '2025-01-01T00:00:00Z', false);
    await insert(gone!, 'gone@example.com', 'admin', '2025-02-01T00:00:00Z', true);
    await insert(first!, 'first@example.com', 'admin', '2025-03-01T00:00:00Z', false);
    await insert(second!, 'second@example.com', 'admin', '2025-04-01T00:00:00Z', false);
    await run((n) => n >= '0009');
    const chiefs = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.chief, true));
    expect(chiefs).toEqual([{ id: first }]);
  } finally {
    await database.close();
  }
});
