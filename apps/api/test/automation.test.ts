import { afterAll, beforeAll, expect, it } from 'vitest';
import { settings } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let guard: TestClient;
let bob: TestClient;
let bank: { id: string; key: Uint8Array };
let other: { id: string; key: Uint8Array };
let bankEntry: string;
let otherEntry: string;
let security: string;
let staff: string;

beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'auto-admin@example.com', 'auto-admin-password-1');
  await admin.register();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  guard = new TestClient(fixture.app, 'auto-guard@example.com', 'auto-guard-password-1');
  bob = new TestClient(fixture.app, 'auto-bob@example.com', 'auto-bob-password-12');
  for (const c of [guard, bob]) await c.register();
  for (const c of [admin, guard, bob]) await c.login();
  bank = await admin.createSharedVault('Bank');
  other = await admin.createSharedVault('Other');
  for (const v of [bank, other])
    expect((await admin.addMember(v.id, bob, 'editor', v.key)).statusCode).toBe(204);
  bankEntry = (await admin.createEntry({ p: 1 }, { vaultId: bank.id, vaultKey: bank.key })).entryId;
  otherEntry = (await admin.createEntry({ p: 2 }, { vaultId: other.id, vaultKey: other.key }))
    .entryId;
  const circle = async (name: string, member: TestClient) => {
    const id = (await admin.req('POST', '/admin/circles', { name, description: '' })).json().id;
    expect(
      (await admin.req('PUT', `/admin/circles/${id}/members/${member.userId}`)).statusCode,
    ).toBe(204);
    return id as string;
  };
  security = await circle('Security', guard);
  staff = await circle('Staff', bob);
});
afterAll(async () => fixture.app.close());

const reveal = (vaultId: string, entryId: string) =>
  bob.req('POST', `/vaults/${vaultId}/entries/${entryId}/events`, {
    action: 'reveal',
    field: 'password',
  });
const inbox = async () =>
  (
    (await guard.req('GET', '/notifications')).json().items as {
      event: string;
      vaultId: string | null;
      detail: { rule?: string; action?: string } | null;
    }[]
  ).filter((n) => n.event === 'automation.rule');

it('only administrators with the settings permission manage rules; triggers are validated', async () => {
  expect((await bob.req('GET', '/admin/automation')).statusCode).toBe(403);
  expect(
    (await admin.req('POST', '/admin/automation', { name: 'x', trigger: 'nope' })).statusCode,
  ).toBe(400);
});

it('a rule notifies its recipients when the event matches the vault and the actor group', async () => {
  const made = await admin.req('POST', '/admin/automation', {
    name: 'Показ пароля в банке',
    trigger: 'entry.reveal',
    vaultId: bank.id,
    actorCircleId: staff,
    notifyCircles: [security],
  });
  expect(made.statusCode).toBe(201);
  // в другом сейфе — не срабатывает
  expect((await reveal(other.id, otherEntry)).statusCode).toBe(204);
  expect(await inbox()).toEqual([]);
  // в «Банке» — срабатывает: получатель видит название правила и действие, без секретов
  expect((await reveal(bank.id, bankEntry)).statusCode).toBe(204);
  let got = await inbox();
  expect(got).toHaveLength(1);
  expect(got[0]).toMatchObject({
    vaultId: bank.id,
    detail: { rule: 'Показ пароля в банке', action: 'entry.client.reveal' },
  });
  // повтор того же действия в течение 5 минут не засыпает получателя
  await reveal(bank.id, bankEntry);
  expect(await inbox()).toHaveLength(1);
  const [rule] = (await admin.req('GET', '/admin/automation')).json();
  expect(rule).toMatchObject({ fired: 1 });
  // выключенное правило молчит
  expect(
    (
      await admin.req('PUT', `/admin/automation/${rule.id}`, {
        name: rule.name,
        trigger: 'entry.reveal',
        enabled: false,
        vaultId: bank.id,
        notifyCircles: [security],
      })
    ).statusCode,
  ).toBe(200);
  await admin.req('POST', `/vaults/${bank.id}/entries/${bankEntry}/events`, {
    action: 'reveal',
    field: 'password',
  });
  got = await inbox();
  expect(got).toHaveLength(1);
  expect((await admin.req('DELETE', `/admin/automation/${rule.id}`)).statusCode).toBe(204);
});

it('an actor outside the group does not trigger the rule; admins can be notified directly', async () => {
  await admin.req('POST', '/admin/automation', {
    name: 'Ссылки сотрудников',
    trigger: 'link.create',
    actorCircleId: staff,
    notifyAdmins: true,
  });
  const link = (c: TestClient) =>
    c.req('POST', '/handoffs', {
      id: crypto.randomUUID(),
      ciphertext: 'ak1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAA',
      expiresInMinutes: 60,
      maxViews: 1,
    });
  const adminInbox = async () =>
    ((await admin.req('GET', '/notifications')).json().items as { event: string }[]).filter(
      (n) => n.event === 'automation.rule',
    );
  const before = (await adminInbox()).length;
  expect((await link(guard)).statusCode).toBe(201); // не в группе «Staff»
  expect((await adminInbox()).length).toBe(before);
  expect((await link(bob)).statusCode).toBe(201);
  expect((await adminInbox()).length).toBe(before + 1);
});

it('a deny rule stops the action before it happens, logs the attempt and tells the recipients', async () => {
  // «показ пароля» запретить нельзя: расшифровка идёт в браузере
  expect(
    (
      await admin.req('POST', '/admin/automation', {
        name: 'x',
        trigger: 'entry.reveal',
        effect: 'deny',
      })
    ).statusCode,
  ).toBe(400);
  const rule = await admin.req('POST', '/admin/automation', {
    name: 'Ничего не удалять в банке',
    trigger: 'entry.delete',
    effect: 'deny',
    vaultId: bank.id,
    actorCircleId: staff,
    notifyCircles: [security],
  });
  expect(rule.statusCode).toBe(201);
  const victim = (await admin.createEntry({ p: 3 }, { vaultId: bank.id, vaultKey: bank.key }))
    .entryId;
  const del = (c: TestClient, entryId: string) =>
    c.req('DELETE', `/vaults/${bank.id}/entries/${entryId}?expectedVersion=1`);
  const refused = await del(bob, victim);
  expect(refused.statusCode).toBe(403);
  expect(refused.json().error).toMatchObject({
    code: 'denied_by_rule',
    details: { rule: 'Ничего не удалять в банке' },
  });
  // массовое удаление — тоже
  expect(
    (
      await bob.req('POST', `/vaults/${bank.id}/entries/bulk`, {
        ids: [victim],
        action: 'trash',
      })
    ).statusCode,
  ).toBe(403);
  // запись на месте; получатель знает о попытке
  expect((await admin.req('GET', `/vaults/${bank.id}/entries/${victim}`)).statusCode).toBe(200);
  const denied = (
    (await guard.req('GET', '/notifications')).json().items as {
      event: string;
      detail: { rule?: string } | null;
    }[]
  ).filter((n) => n.event === 'automation.denied');
  expect(denied[0]?.detail?.rule).toBe('Ничего не удалять в банке');
  // условие «группа автора»: администратор вне группы удаляет
  expect((await del(admin, victim)).statusCode).toBe(204);
});

it('a deny rule without conditions blocks everyone until it is switched off', async () => {
  const made = (
    await admin.req('POST', '/admin/automation', {
      name: 'Без внешних ссылок',
      trigger: 'link.create',
      effect: 'deny',
    })
  ).json();
  const link = () =>
    admin.req('POST', '/handoffs', {
      id: crypto.randomUUID(),
      ciphertext: 'ak1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAA',
      expiresInMinutes: 60,
      maxViews: 1,
    });
  expect((await link()).statusCode).toBe(403);
  expect(
    (
      await admin.req('PUT', `/admin/automation/${made.id}`, {
        name: 'Без внешних ссылок',
        trigger: 'link.create',
        effect: 'deny',
        enabled: false,
      })
    ).statusCode,
  ).toBe(200);
  expect((await link()).statusCode).toBe(201);
});
