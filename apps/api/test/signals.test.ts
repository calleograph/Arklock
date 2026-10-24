import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { encryptEntry } from '@arklock/crypto';
import { settings, signals, users } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let bob: TestClient;
let vaultId: string;
let vaultKey: Uint8Array;
let open: string;
let hidden: string;

beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'sig-admin@example.com', 'sig-admin-password-1');
  await admin.register();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  bob = new TestClient(fixture.app, 'sig-bob@example.com', 'sig-bob-password-12');
  await bob.register();
  await admin.login();
  await bob.login();
  const vault = await admin.createSharedVault('Signals');
  vaultId = vault.id;
  vaultKey = vault.key;
  expect((await admin.addMember(vaultId, bob, 'editor', vaultKey)).statusCode).toBe(204);
  open = (await admin.createEntry({ password: 'a' }, { vaultId, vaultKey })).entryId;
  hidden = (await admin.createEntry({ password: 'b' }, { vaultId, vaultKey })).entryId;
});
afterAll(async () => fixture.app.close());

type Signal = {
  id: string;
  entryId: string;
  type: string;
  status: string;
  cause: { id: string; name: string | null } | null;
};
const rotation = async (who: TestClient) =>
  (await who.req('GET', `/admin/users/${bob.userId}/profile`)).json().rotation;
const list = async () => (await admin.req('GET', `/vaults/${vaultId}/signals`)).json() as Signal[];
const history = async (id: string) =>
  (await admin.req('GET', `/vaults/${vaultId}/signals/${id}/history`)).json() as {
    action: string;
    status: string | null;
    assignedName: string | null;
    auto: boolean;
    clientReported: boolean;
    reason: string | null;
  }[];
const report = (items: { entryId: string; type: string }[]) =>
  admin.req('POST', `/vaults/${vaultId}/signals`, { items, checkedTypes: ['weak'] });

it('a solved problem reopens when it returns; an ignored one stays ignored; the history tells the story', async () => {
  expect((await report([{ entryId: open, type: 'weak' }])).json().created).toBe(1);
  const s = (await list()).find((x) => x.entryId === open && x.type === 'weak')!;
  expect(
    (
      await admin.req('PATCH', `/vaults/${vaultId}/signals/${s.id}`, {
        status: 'in_progress',
        assignedTo: admin.userId,
      })
    ).statusCode,
  ).toBe(200);
  expect((await report([])).json().resolved).toBe(1);
  await report([{ entryId: open, type: 'weak' }]);
  expect((await list()).find((x) => x.id === s.id)!.status).toBe('open');
  await admin.req('PATCH', `/vaults/${vaultId}/signals/${s.id}`, { status: 'dismissed' });
  await report([]);
  await report([{ entryId: open, type: 'weak' }]);
  expect((await list()).find((x) => x.id === s.id)!.status).toBe('dismissed');

  const h = await history(s.id);
  expect(h.map((x) => x.action)).toEqual([
    'signal.create',
    'signal.update',
    'signal.resolve',
    'signal.reopen',
    'signal.update',
  ]);
  expect(h[1]).toMatchObject({ status: 'in_progress', assignedName: expect.any(String) });
  expect(h[2]!.auto).toBe(true);
  // история закрыта для участника без прав администратора сейфа
  expect((await bob.req('GET', `/vaults/${vaultId}/signals/${s.id}/history`)).statusCode).toBe(403);
});

it('offboarding opens «change the password» for entries the person could see, and a reported change closes it', async () => {
  expect(
    (
      await admin.req('PUT', `/vaults/${vaultId}/grants`, {
        targetType: 'entry',
        targetId: hidden,
        subjectType: 'user',
        subjectId: bob.userId,
        role: 'none',
      })
    ).statusCode,
  ).toBe(200);
  const off = await admin.req('POST', `/admin/users/${bob.userId}/offboard`, {});
  expect(off.statusCode).toBe(200);
  expect(off.json().rotateEntries).toBe(1);
  const rotate = (await list()).filter((x) => x.type === 'rotate');
  expect(rotate.map((x) => x.entryId)).toEqual([open]);
  expect((await history(rotate[0]!.id))[0]).toMatchObject({
    action: 'signal.create',
    reason: 'offboarding',
  });
  // общее событие увольнения: всего, открыто, доступно просматривающему — по сейфам
  expect(rotate[0]!.cause).toEqual({ id: bob.userId, name: expect.any(String) });
  expect(await rotation(admin)).toEqual({
    total: 1,
    open: 1,
    available: 1,
    vaults: [{ id: vaultId, name: 'Signals', total: 1, open: 1, available: 1 }],
  });
  // администратор организации без доступа к сейфу видит масштаб, но разобрать события не может
  const carol = new TestClient(fixture.app, 'sig-carol@example.com', 'sig-carol-password-1');
  await carol.register();
  await fixture.database.db.update(users).set({ role: 'admin' }).where(eq(users.id, carol.userId));
  await carol.login();
  expect(await rotation(carol)).toMatchObject({ total: 1, open: 1, available: 0 });
  // миграция 0018 восстанавливает причину у событий, созданных до неё, по журналу
  await fixture.database.db.update(signals).set({ causeUserId: null });
  const backfill = readFileSync(
    new URL('../drizzle/0018_signal_cause.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .find((s) => s.includes('UPDATE "signals"'))!;
  await fixture.database.db.execute(sql.raw(backfill));
  expect((await list()).find((x) => x.id === rotate[0]!.id)!.cause?.id).toBe(bob.userId);

  const save = async (version: number, passwordChanged?: boolean) => {
    const enc = await encryptEntry({ password: `new-${version}` }, vaultKey, vaultId, open, 1);
    return admin.req('PUT', `/vaults/${vaultId}/entries/${open}`, {
      ...enc,
      expectedVersion: version,
      ...(passwordChanged === undefined ? {} : { passwordChanged }),
    });
  };
  // изменение без смены пароля событие не закрывает
  expect((await save(1)).statusCode).toBe(200);
  expect((await list()).find((x) => x.id === rotate[0]!.id)!.status).toBe('open');
  expect((await save(2, true)).statusCode).toBe(200);
  expect((await list()).find((x) => x.id === rotate[0]!.id)!.status).toBe('resolved');
  expect(await rotation(admin)).toMatchObject({ total: 1, open: 0 });
  expect((await history(rotate[0]!.id)).at(-1)).toMatchObject({
    action: 'signal.resolve',
    clientReported: true,
  });
});

it('active events come before closed ones (the list is limited, the archive must not push them out)', async () => {
  await report([{ entryId: hidden, type: 'weak' }]);
  const rows = (await list()) as (Signal & { updatedAt: string })[];
  const closed = (s: string) => s === 'resolved' || s === 'dismissed';
  expect(rows.some((r) => closed(r.status))).toBe(true);
  expect(rows.some((r) => !closed(r.status))).toBe(true);
  const firstClosed = rows.findIndex((r) => closed(r.status));
  expect(rows.slice(firstClosed).every((r) => closed(r.status))).toBe(true);
  expect(rows.every((r) => typeof r.updatedAt === 'string')).toBe(true);
});
