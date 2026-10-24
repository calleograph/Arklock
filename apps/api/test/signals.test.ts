import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { encryptEntry } from '@arklock/crypto';
import {
  circleMembers,
  circles,
  ledger,
  settings,
  signals,
  users,
  vaultCircles,
  vaultMembers,
} from '../src/db/schema.js';
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
  cause: { id: string; name: string | null; reason?: string } | null;
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
  // запрет на «hidden» в начале теста уже отнял у сотрудника эту запись — событие с причиной «отзыв доступа»;
  // увольнение открывает событие по остальному, что он видел
  const all = (await list()).filter((x) => x.type === 'rotate');
  expect(all.find((x) => x.entryId === hidden)?.cause?.reason).toBe('revoked');
  const rotate = all.filter((x) => x.cause?.reason === 'offboarding');
  expect(rotate.map((x) => x.entryId)).toEqual([open]);
  expect((await history(rotate[0]!.id))[0]).toMatchObject({
    action: 'signal.create',
    reason: 'offboarding',
  });
  // общее событие увольнения: всего, открыто, доступно просматривающему — по сейфам
  expect(rotate[0]!.cause).toEqual({
    id: bob.userId,
    name: expect.any(String),
    reason: 'offboarding',
  });
  expect(await rotation(admin)).toEqual({
    // и запрет, и увольнение: обе записи, которые сотрудник видел
    total: 2,
    open: 2,
    available: 2,
    vaults: [{ id: vaultId, name: 'Signals', total: 2, open: 2, available: 2 }],
  });
  // администратор организации без доступа к сейфу видит масштаб, но разобрать события не может
  const carol = new TestClient(fixture.app, 'sig-carol@example.com', 'sig-carol-password-1');
  await carol.register();
  await fixture.database.db.update(users).set({ role: 'admin' }).where(eq(users.id, carol.userId));
  await carol.login();
  expect(await rotation(carol)).toMatchObject({ total: 2, open: 2, available: 0 });
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
  // проверка миграции 0018 выше вернула причину только событию увольнения (событий «отзыв доступа» до 1.45 не было)
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

it('a weekly password-health report tells vault administrators how many events are open, once a week', async () => {
  const { runMaintenance } = await import('../src/maintenance.js');
  const openNow = (await list()).filter((s) => s.status === 'open' || s.status === 'in_progress');
  expect(openNow.length).toBeGreaterThan(0);
  expect((await runMaintenance(fixture.database.db)).digest).toBeGreaterThanOrEqual(1);
  const inbox = (await admin.req('GET', '/notifications?view=inbox')).json().items as {
    id: string;
    event: string;
    vaultId: string;
    detail: Record<string, string>;
  }[];
  const report = inbox.find((n) => n.event === 'signals.digest' && n.vaultId === vaultId)!;
  expect(report.detail.open).toBe(String(openNow.length));
  expect((await admin.req('GET', `/notifications/${report.id}/destination`)).json()).toEqual({
    path: `/vault/${vaultId}/settings`,
    vaultId,
  });
  // не чаще раза в неделю
  expect((await runMaintenance(fixture.database.db)).digest).toBe(0);
  const later = new Date(Date.now() + 8 * 86_400_000);
  expect((await runMaintenance(fixture.database.db, later)).digest).toBeGreaterThanOrEqual(1);
});

it('removing a member opens «change the password» for what they lost; access kept through a group does not', async () => {
  const db = fixture.database.db;
  const dan = new TestClient(fixture.app, 'sig-dan@example.com', 'sig-dan-password-12');
  await dan.register();
  await dan.login();
  // доступ и напрямую, и через группу: снятие прямого участия ничего не отнимает
  const circleId = crypto.randomUUID();
  await db.insert(circles).values({ id: circleId, name: 'Signals readers' });
  await db.insert(circleMembers).values({ circleId, userId: dan.userId });
  await db.insert(vaultCircles).values({ vaultId, circleId, role: 'reader' });
  expect((await admin.addMember(vaultId, dan, 'reader', vaultKey)).statusCode).toBe(204);
  const kept = await admin.req('DELETE', `/vaults/${vaultId}/members/${dan.userId}`);
  expect(kept.json().rotateEntries).toBe(0);

  // без группы — все записи, которые он видел, получают событие с причиной «отзыв доступа»
  await db.delete(vaultCircles).where(eq(vaultCircles.circleId, circleId));
  expect((await admin.addMember(vaultId, dan, 'reader', vaultKey)).statusCode).toBe(204);
  const removed = await admin.req('DELETE', `/vaults/${vaultId}/members/${dan.userId}`);
  expect(removed.json().rotateEntries).toBe(2);
  const rows = (await list()).filter((x) => x.type === 'rotate' && x.cause?.id === dan.userId);
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.status === 'open')).toBe(true);
  expect(rows.map((r) => r.cause?.reason)).toEqual(['revoked', 'revoked']);
});

it('a deny rule, leaving a group and a group leaving the vault also open «change the password» for what is lost', async () => {
  const db = fixture.database.db;
  const openedFor = async (userId: string) =>
    (await db.select().from(ledger).where(eq(ledger.action, 'signal.create'))).filter(
      (r) =>
        (r.detail as { user?: string; reason?: string } | null)?.user === userId &&
        (r.detail as { reason?: string }).reason === 'revoked',
    ).length;
  const person = async (name: string) => {
    const c = new TestClient(fixture.app, `sig-${name}@example.com`, `sig-${name}-password-12`);
    await c.register();
    await c.login();
    return c;
  };

  // запрет на одну запись — одно событие
  const eve = await person('eve');
  expect((await admin.addMember(vaultId, eve, 'reader', vaultKey)).statusCode).toBe(204);
  const deny = await admin.req('PUT', `/vaults/${vaultId}/grants`, {
    targetType: 'entry',
    targetId: open,
    subjectType: 'user',
    subjectId: eve.userId,
    role: 'none',
  });
  expect(deny.statusCode).toBe(200);
  expect(await openedFor(eve.userId)).toBe(1);

  // исключение из группы, через которую был доступ, — обе записи
  const fay = await person('fay');
  const team = crypto.randomUUID();
  await db.insert(circles).values({ id: team, name: 'Signals team' });
  await db.insert(circleMembers).values({ circleId: team, userId: fay.userId });
  await db.insert(vaultCircles).values({ vaultId, circleId: team, role: 'reader' });
  expect(
    (await admin.req('DELETE', `/admin/circles/${team}/members/${fay.userId}`)).statusCode,
  ).toBe(204);
  expect(await openedFor(fay.userId)).toBe(2);

  // группа уходит из сейфа — её участники теряют записи
  const gus = await person('gus');
  await db.insert(circleMembers).values({ circleId: team, userId: gus.userId });
  expect((await admin.req('DELETE', `/vaults/${vaultId}/circles/${team}`)).statusCode).toBe(200);
  expect(await openedFor(gus.userId)).toBe(2);
});

it('expired access and a directory that drops a group member open «change the password» too', async () => {
  const db = fixture.database.db;
  const { runMaintenance } = await import('../src/maintenance.js');
  const { syncCirclesFor } = await import('../src/auth/ldap-sync.js');
  const openedFor = async (userId: string) =>
    (await db.select().from(ledger).where(eq(ledger.action, 'signal.create'))).filter(
      (r) => (r.detail as { user?: string } | null)?.user === userId,
    ).length;
  const person = async (name: string) => {
    const c = new TestClient(fixture.app, `sig-${name}@example.com`, `sig-${name}-password-12`);
    await c.register();
    await c.login();
    return c;
  };

  // прямое участие со сроком: истекло после прошлой проверки — обслуживание открывает события
  // (обслуживание «через 8 дней» в тесте отчёта запомнило свою проверку — начинаем с чистой)
  await db.delete(settings).where(eq(settings.key, 'access.expirySweptAt'));
  const hal = await person('hal');
  expect((await admin.addMember(vaultId, hal, 'reader', vaultKey)).statusCode).toBe(204);
  const soon = new Date(Date.now() + 1000);
  await db
    .update(vaultMembers)
    .set({ expiresAt: soon })
    .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, hal.userId)));
  // запись, созданная после истечения, не считается увиденной
  await new Promise((r) => setTimeout(r, 1100));
  await admin.createEntry({ password: 'late' }, { vaultId, vaultKey });
  const later = new Date(Date.now() + 60_000);
  expect((await runMaintenance(db, later)).lapsed).toBe(2);
  expect(await openedFor(hal.userId)).toBe(2);
  // повторная проверка то же истечение не считает
  expect((await runMaintenance(db, new Date(later.getTime() + 1000))).lapsed).toBe(0);

  // каталог больше не видит сотрудника в группе — он выходит из неё и теряет её доступ
  const ivy = await person('ivy');
  const crew = crypto.randomUUID();
  await db.insert(circles).values({ id: crew, name: 'Directory crew' });
  await db.insert(circleMembers).values({ circleId: crew, userId: ivy.userId });
  await db.insert(vaultCircles).values({ vaultId, circleId: crew, role: 'reader' });
  const cfg = { groups: [{ dn: 'cn=crew,dc=example,dc=com', circleId: crew }] };
  await syncCirclesFor(db, ivy.userId, cfg as never, ['cn=crew,dc=example,dc=com']);
  expect(await openedFor(ivy.userId)).toBe(0);
  await syncCirclesFor(db, ivy.userId, cfg as never, []);
  // в сейфе уже три записи (третья создана выше) — все они через группу были видны
  expect(await openedFor(ivy.userId)).toBe(3);
});
