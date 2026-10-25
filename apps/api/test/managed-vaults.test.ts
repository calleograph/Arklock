import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { settings, signals } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let emp: TestClient;
let aud: TestClient;
let other: TestClient;
let circleId: string;
const PW = 'managed-password-1234';
const entry = (title: string) => ({
  kind: 'login',
  title,
  username: 'u',
  password: 'pw',
  url: '',
  notes: '',
  totp: '',
  fields: [],
  tags: [],
});

beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'mv-admin@example.com', PW);
  await admin.register();
  await admin.login();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  [emp, aud, other] = ['mv-emp', 'mv-aud', 'mv-other'].map(
    (n) => new TestClient(fixture.app, `${n}@example.com`, PW),
  ) as [TestClient, TestClient, TestClient];
  for (const c of [emp, aud, other]) {
    await c.register();
    await c.login();
  }
  circleId = (await admin.req('POST', '/admin/circles', { name: 'Хранители' })).json().id;
  await admin.req('PATCH', `/admin/circles/${circleId}/members`, { add: [aud.userId] });
});
afterAll(async () => fixture.app.close());

const policy = (body: object) => admin.req('PUT', '/admin/settings', body);

it('is off by default: the employee sees no managed mode and cannot enable it', async () => {
  expect((await emp.req('GET', '/auth/policy')).json()['vaults.managedPersonal']).toBe(false);
  await policy({ 'vaults.creators': 'members' });
  const v = await emp.createSharedVault('Персональный · Сотрудник');
  expect(v.res.statusCode).toBe(201);
  const r = await emp.req('POST', `/vaults/${v.id}/managed`);
  expect(r.statusCode).toBe(409);
  expect(r.json().error.code).toBe('managed_disabled');
});

it('the employee sees the conditions first; the guardians get access only through their group and a key the owner issues', async () => {
  expect(
    (await policy({ 'vaults.managedPersonal': true, 'vaults.managedGuardians': [circleId] }))
      .statusCode,
  ).toBe(200);
  const shown = (await emp.req('GET', '/auth/policy')).json();
  expect(shown['vaults.managedPersonal']).toBe(true);
  expect(shown['vaults.managedGuardians']).toEqual(['Хранители']);
  expect(shown['vaults.managedRole']).toBe('reader');

  const v = await emp.createSharedVault('Персональный · Сотрудник 2');
  expect((await emp.req('POST', `/vaults/${v.id}/managed`)).statusCode).toBe(204);
  // второй такой сейф у того же сотрудника не нужен
  const second = await emp.createSharedVault('Ещё один');
  expect((await emp.req('POST', `/vaults/${second.id}/managed`)).statusCode).toBe(409);
  // чужой сейф сделать «управляемым» нельзя
  expect((await other.req('POST', `/vaults/${v.id}/managed`)).statusCode).toBeGreaterThanOrEqual(
    403,
  );

  const created = await emp.createEntry(entry('Личный пароль'), { vaultId: v.id, vaultKey: v.key });
  expect(created.res.statusCode).toBe(201);
  // хранитель видит сейф, но ключа у него ещё нет: серверная роль ничего не открывает
  const seen = (await aud.vaults()).find((x) => x.id === v.id)!;
  expect(seen).toMatchObject({ managed: true, pendingKey: true });
  const key = await emp.keyFor(aud, v.id, v.key);
  expect(
    (await emp.req('POST', `/vaults/${v.id}/keys`, { keys: [{ userId: aud.userId, ...key }] }))
      .statusCode,
  ).toBe(204);
  const opened = await aud.openVault((await aud.vaults()).find((x) => x.id === v.id)!);
  expect((await aud.readEntry(v.id, created.entryId, opened)).title).toBe('Личный пароль');
  // роль «чтение»: хранитель ничего не меняет
  expect(
    (await aud.createEntry(entry('Чужая'), { vaultId: v.id, vaultKey: opened })).res.statusCode,
  ).toBe(403);
  // владелец не может ни убрать хранителей, ни передать, ни удалить сейф; условия меняет только политика
  const drop = await emp.req('DELETE', `/vaults/${v.id}/circles/${circleId}`);
  expect([drop.statusCode, drop.json().error.code]).toEqual([409, 'managed_guardian']);
  const role = await emp.req('PUT', `/vaults/${v.id}/circles/${circleId}`, { role: 'admin' });
  expect(role.json().error.code).toBe('managed_guardian');
  expect((await emp.req('DELETE', `/vaults/${v.id}`)).json().error.code).toBe('managed_vault');
  expect(
    (await emp.req('POST', `/vaults/${v.id}/transfer-ownership`, { userId: other.userId })).json()
      .error.code,
  ).toBe('managed_vault');

  // политика выравнивает роль у всех таких сейфов
  expect((await policy({ 'vaults.managedRole': 'editor' })).statusCode).toBe(200);
  expect(
    (await aud.createEntry(entry('Правка хранителя'), { vaultId: v.id, vaultKey: opened })).res
      .statusCode,
  ).toBe(201);

  // инвентаризация видит тип, владельца и хранителей, но не содержимое; обычному администратору она недоступна
  const inv = (await admin.req('GET', '/admin/vaults?kind=managed')).json();
  expect(inv.items).toHaveLength(1);
  expect(inv.items[0]).toMatchObject({
    kind: 'managed',
    owner: expect.any(String),
    entries: 2,
    guardians: ['Хранители'],
  });
  expect(JSON.stringify(inv)).not.toContain('Личный пароль');
  expect((await emp.req('GET', '/admin/vaults')).statusCode).toBe(403);

  // хранители сняты из политики: доступ пропадает, по увиденным записям открываются события «смените пароль»
  expect((await policy({ 'vaults.managedGuardians': [] })).statusCode).toBe(200);
  expect((await aud.vaults()).some((x) => x.id === v.id)).toBe(false);
  const open = await fixture.database.db.select().from(signals).where(eq(signals.vaultId, v.id));
  expect(open.length).toBeGreaterThan(0);
});

it('lists corporate and private vaults by type; a private vault has no name or content in the list', async () => {
  const all = (await admin.req('GET', '/admin/vaults')).json();
  expect(all.counts.private).toBeGreaterThanOrEqual(1);
  const priv = (await admin.req('GET', '/admin/vaults?kind=private')).json();
  for (const p of priv.items) expect(p.name).toBeNull();
  const found = (await admin.req('GET', '/admin/vaults?q=Ещё')).json();
  expect(found.items.map((i: { kind: string }) => i.kind)).toEqual(['corporate']);
});

it('an employee creates the managed vault straight away even when only administrators create vaults', async () => {
  expect(
    (
      await policy({
        'vaults.creators': 'admins',
        'vaults.managedGuardians': [circleId],
        'vaults.managedRole': 'reader',
      })
    ).statusCode,
  ).toBe(200);
  // обычный сейф сотрудник создать не может, управляемый — может, и он сразу с хранителями в основном пространстве
  expect((await other.createSharedVault('Обычный')).res.statusCode).toBe(403);
  const mine = await other.createSharedVault('Персональный · Другой', { managed: true });
  expect(mine.res.statusCode).toBe(201);
  const seen = (await aud.vaults()).find((x) => x.id === mine.id)!;
  expect(seen).toMatchObject({ managed: true, role: 'reader' });
  // второй раз — нет
  expect((await other.createSharedVault('Ещё', { managed: true })).res.statusCode).toBe(409);
});
