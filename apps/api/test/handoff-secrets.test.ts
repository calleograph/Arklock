import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createHandoff, openHandoff } from '@arklock/crypto';
import { handoffClaims, handoffKeys, handoffs, ledger } from '../src/db/schema.js';
import { sweepHandoffs } from '../src/handoff-store.js';
import { createTestApp, TestClient } from './helpers.js';

// Передача секрета по ссылке: запечатывание сервером, гонки, квиток получателя, уничтожение содержимого.
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
const SECRET = { title: 'Почта нового сотрудника', password: 'Synthetic-Pass-4417!', fields: [] };

beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'admin@example.com', 'admin-password-123');
  await admin.register();
  await admin.login();
});
afterAll(async () => fixture.app.close());

const db = () => fixture.database.db;
const row = async (id: string) =>
  (await db().select().from(handoffs).where(eq(handoffs.id, id)))[0]!;
const keyRows = (id: string) =>
  db().select().from(handoffKeys).where(eq(handoffKeys.handoffId, id));
const claim = () => randomBytes(32).toString('base64url');

async function create(opts: { minutes?: number; views?: number; passphrase?: string } = {}) {
  const id = crypto.randomUUID();
  const pkg = await createHandoff(id, SECRET, opts.passphrase);
  const res = await admin.req('POST', '/handoffs', {
    id,
    label: 'Почта: выдача пароля',
    ciphertext: pkg.ciphertext,
    hasPassphrase: !!opts.passphrase,
    expiresInMinutes: opts.minutes ?? 30,
    maxViews: opts.views ?? 1,
    kind: 'secret',
  });
  expect(res.statusCode).toBe(201);
  return { id, fragment: pkg.fragment, client: pkg.ciphertext };
}
const open = (id: string, c?: string) =>
  fixture.app.inject({
    method: 'POST',
    url: `/api/v1/handoffs/${id}/open`,
    payload: c ? { claim: c } : {},
  });
const ack = (id: string, c: string) =>
  fixture.app.inject({ method: 'POST', url: `/api/v1/handoffs/${id}/ack`, payload: { claim: c } });

describe('one-time secret transfer', () => {
  it('the server keeps only a sealed copy; the recipient decrypts it with the link key', async () => {
    const h = await create();
    const stored = await row(h.id);
    expect(stored.kind).toBe('secret');
    expect(stored.wrapped).toBe(true);
    expect(stored.ciphertext.startsWith('srv1.')).toBe(true);
    expect(stored.ciphertext).not.toContain(h.client);
    expect(await keyRows(h.id)).toHaveLength(1);
    const res = await open(h.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await openHandoff(h.id, res.json().ciphertext, h.fragment)).toEqual(SECRET);
    // последнее открытие без квитка: содержимое и ключ сервера уничтожены сразу
    expect((await row(h.id)).ciphertext).toBe('');
    expect(await keyRows(h.id)).toHaveLength(0);
    expect((await open(h.id)).statusCode).toBe(404);
    const mine = (await admin.req('GET', '/handoffs')).json();
    expect(mine.find((x: { id: string }) => x.id === h.id)).toMatchObject({
      status: 'used',
      destroyed: true,
      kind: 'secret',
    });
  });

  it('a passphrase is needed on top of the link', async () => {
    const h = await create({ passphrase: 'код из звонка' });
    const res = await open(h.id);
    await expect(openHandoff(h.id, res.json().ciphertext, h.fragment)).rejects.toThrow();
    expect(await openHandoff(h.id, res.json().ciphertext, h.fragment, 'код из звонка')).toEqual(
      SECRET,
    );
  });

  it('every lifetime option sets the expiry; every open-count option allows exactly that many opens', async () => {
    for (const minutes of [30, 60, 240, 720, 1440, 4320]) {
      const before = Date.now();
      const h = await create({ minutes });
      const exp = (await row(h.id)).expiresAt.getTime();
      expect(exp - before).toBeGreaterThanOrEqual(minutes * 60_000 - 1000);
      expect(exp - before).toBeLessThanOrEqual(minutes * 60_000 + 5000);
    }
    for (const views of [1, 2, 3, 5]) {
      const h = await create({ views });
      const codes = [];
      for (let i = 0; i < views + 2; i++) codes.push((await open(h.id)).statusCode);
      expect(codes.filter((c) => c === 200)).toHaveLength(views);
      expect((await row(h.id)).ciphertext).toBe('');
    }
  });

  it('simultaneous opens of a one-time link give exactly one success', async () => {
    const h = await create();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => open(h.id, i % 2 ? claim() : undefined)),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const two = await create({ views: 2 });
    const pair = await Promise.all(Array.from({ length: 8 }, () => open(two.id)));
    expect(pair.filter((r) => r.statusCode === 200)).toHaveLength(2);
  });

  it('the same browser can repeat a lost response with its claim; nobody else can, and the claim ends', async () => {
    const h = await create();
    const mine = claim();
    expect((await open(h.id, mine)).statusCode).toBe(200);
    // ответ «потерялся»: тот же браузер повторяет — открытие не расходуется, содержимое то же
    const again = await open(h.id, mine);
    expect(again.statusCode).toBe(200);
    expect(again.json().resumed).toBe(true);
    expect(await openHandoff(h.id, again.json().ciphertext, h.fragment)).toEqual(SECRET);
    expect((await row(h.id)).views).toBe(1);
    // другой получатель — нет
    expect((await open(h.id, claim())).statusCode).toBe(404);
    expect((await open(h.id)).statusCode).toBe(404);
    // получено: квиток погашен, содержимое уничтожено
    expect((await ack(h.id, mine)).statusCode).toBe(204);
    expect((await row(h.id)).ciphertext).toBe('');
    expect(await keyRows(h.id)).toHaveLength(0);
    expect((await open(h.id, mine)).statusCode).toBe(404);

    // квиток без подтверждения живёт недолго: после него всё уничтожается проходом очистки
    const late = await create();
    const c = claim();
    expect((await open(late.id, c)).statusCode).toBe(200);
    await db()
      .update(handoffClaims)
      .set({ until: new Date(Date.now() - 1000) })
      .where(eq(handoffClaims.handoffId, late.id));
    await sweepHandoffs(db());
    expect((await row(late.id)).ciphertext).toBe('');
    expect((await open(late.id, c)).statusCode).toBe(404);
  });

  it('expiry and revocation destroy the content; failures look the same as an unknown link', async () => {
    const exp = await create({ views: 3 });
    await db()
      .update(handoffs)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(handoffs.id, exp.id));
    expect((await open(exp.id)).statusCode).toBe(404);
    await sweepHandoffs(db());
    expect((await row(exp.id)).ciphertext).toBe('');
    expect(await keyRows(exp.id)).toHaveLength(0);

    const rev = await create({ views: 3 });
    expect((await admin.req('DELETE', `/handoffs/${rev.id}`)).statusCode).toBe(204);
    expect((await row(rev.id)).ciphertext).toBe('');
    expect(await keyRows(rev.id)).toHaveLength(0);
    const gone = await open(rev.id);
    const never = await open(crypto.randomUUID());
    expect(gone.json().error).toEqual({
      ...never.json().error,
      requestId: gone.json().error.requestId,
    });
    expect(
      (await admin.req('GET', '/handoffs')).json().find((x: { id: string }) => x.id === rev.id)
        .status,
    ).toBe('revoked');
  });

  it('a database copy without the server keys does not open a link (restore from backup)', async () => {
    const h = await create({ views: 3 });
    // копия базы не содержит handoff_keys (scripts/backup.sh): моделируем восстановление
    await db().delete(handoffKeys).where(eq(handoffKeys.handoffId, h.id));
    expect((await open(h.id)).statusCode).toBe(404);
    expect((await row(h.id)).ciphertext).toBe('');
  });

  it('links made before sealing (an update with active links) still open once', async () => {
    const id = crypto.randomUUID();
    const pkg = await createHandoff(id, SECRET);
    await db()
      .insert(handoffs)
      .values({
        id,
        createdBy: admin.userId,
        label: 'старая ссылка',
        ciphertext: pkg.ciphertext,
        expiresAt: new Date(Date.now() + 60_000),
        maxViews: 1,
      });
    const res = await open(id);
    expect(await openHandoff(id, res.json().ciphertext, pkg.fragment)).toEqual(SECRET);
    expect((await row(id)).ciphertext).toBe('');
  });

  it('the journal keeps who and when, never the content', async () => {
    const h = await create();
    await open(h.id);
    const events = await db().select().from(ledger);
    const text = JSON.stringify(events);
    expect(
      events.some((e) => e.action === 'handoff.create' && e.target === `handoff:${h.id}`),
    ).toBe(true);
    expect(events.some((e) => e.action === 'handoff.open' && e.target === `handoff:${h.id}`)).toBe(
      true,
    );
    expect(text).not.toContain(h.client.slice(0, 40));
    expect(text).not.toContain('srv1.');
    expect(text).not.toContain(SECRET.password);
  });

  it('meta and open are separate: looking at the link does not use it up', async () => {
    const h = await create();
    for (let i = 0; i < 3; i++)
      expect((await fixture.app.inject(`/api/v1/handoffs/${h.id}/meta`)).statusCode).toBe(200);
    // GET на адрес получения (как делает почтовый сканер) ничего не открывает
    expect((await fixture.app.inject(`/api/v1/handoffs/${h.id}/open`)).statusCode).toBe(404);
    expect((await row(h.id)).views).toBe(0);
    expect(
      (await fixture.app.inject(`/api/v1/handoffs/${h.id}/meta`)).json().expiresAt,
    ).toBeTruthy();
  });
});
