import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createHandoff, openHandoff } from '@arklock/crypto';
import { handoffs, ledger, mailQueue } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';
import { fakeSmtp } from './smtp-fake.js';

// Ссылка на секрет письмом от сервиса. Синтетические адреса; почтовый сервер — стенд на loopback.
const PUBLIC = 'https://arklock.example.com';
const SECRET = { title: 'Почта нового сотрудника', password: 'Synthetic-Mail-7731!', fields: [] };
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let other: TestClient;
let smtp: Awaited<ReturnType<typeof fakeSmtp>>;

beforeAll(async () => {
  smtp = await fakeSmtp();
  fixture = await createTestApp({ APP_PUBLIC_URL: PUBLIC });
  admin = new TestClient(fixture.app, 'admin@example.com', 'admin-password-123');
  await admin.register();
  await admin.login();
  await admin.req('PUT', '/admin/settings', { 'registration.mode': 'open' });
  other = new TestClient(fixture.app, 'other@example.com', 'other-password-123');
  await other.register();
  await other.login();
});
afterAll(async () => {
  await fixture.app.close();
  await smtp.close();
});

async function create(passphrase?: string) {
  const id = crypto.randomUUID();
  const pkg = await createHandoff(id, SECRET, passphrase);
  const res = await admin.req('POST', '/handoffs', {
    id,
    label: 'Выдача пароля: внутренняя метка',
    ciphertext: pkg.ciphertext,
    hasPassphrase: !!passphrase,
    expiresInMinutes: 240,
    maxViews: 2,
    kind: 'secret',
  });
  expect(res.statusCode).toBe(201);
  return { id, key: pkg.fragment };
}
const body = (data: string) => {
  const [, raw = ''] = data.split('\r\n\r\n');
  return Buffer.from(raw.replace(/\r\n/g, ''), 'base64').toString('utf8');
};
const policy = async () => (await admin.req('GET', '/auth/policy')).json()['links.mail'];

describe('the link by mail from the service', () => {
  it('is offered only when mail is set up', async () => {
    expect(await policy()).toBe(false);
    const h = await create();
    const r = await admin.req('POST', `/handoffs/${h.id}/mail`, {
      to: 'r@example.com',
      key: h.key,
    });
    expect(r.json().sent).toBe(false);
    await admin.reqStep('PUT', '/admin/smtp', {
      host: '127.0.0.1',
      port: smtp.port,
      security: 'none',
      from: 'arklock@example.com',
      confirmInsecure: true,
    });
    expect(await policy()).toBe(true);
  });

  it('the recipient gets a working link; the message has neither the secret nor the purpose; nothing is kept', async () => {
    const h = await create();
    const r = await admin.req('POST', `/handoffs/${h.id}/mail`, {
      to: 'Recipient@Example.com',
      key: h.key,
    });
    expect(r.json()).toEqual({ sent: true });
    const m = smtp.received.find((x) => x.to === 'recipient@example.com')!;
    const text = body(m.data);
    const link = `${PUBLIC}/h/${h.id}#${h.key}`;
    expect(text).toContain(link);
    expect(text).toContain('4 ч');
    expect(text).not.toContain('Выдача пароля');
    expect(text).not.toContain(SECRET.password);
    expect(text).not.toContain('код');
    // ссылка из письма открывается
    const open = await fixture.app.inject({ method: 'POST', url: `/api/v1/handoffs/${h.id}/open` });
    expect(await openHandoff(h.id, open.json().ciphertext, h.key)).toEqual(SECRET);
    // тело письма в очереди стёрто, в журнале — кому, но не ключ
    const queued = await fixture.database.db.select().from(mailQueue);
    expect(queued.every((q) => q.payloadCipher === '')).toBe(true);
    const events = await fixture.database.db.select().from(ledger);
    const mailEvent = events.find(
      (e) => e.action === 'handoff.mail' && e.target === `handoff:${h.id}`,
    )!;
    expect(mailEvent.detail).toMatchObject({ to: 'recipient@example.com', sent: true });
    expect(JSON.stringify(events)).not.toContain(h.key);
    const row = (
      await fixture.database.db.select().from(handoffs).where(eq(handoffs.id, h.id))
    )[0]!;
    expect(row.mailedTo).toBe('recipient@example.com');
    const mine = (await admin.req('GET', '/handoffs')).json();
    expect(mine.find((x: { id: string }) => x.id === h.id).mailedTo).toBe('recipient@example.com');
  });

  it('a link with a code says the code comes separately', async () => {
    const h = await create('код из звонка');
    await admin.req('POST', `/handoffs/${h.id}/mail`, { to: 'coded@example.com', key: h.key });
    const text = body(smtp.received.find((x) => x.to === 'coded@example.com')!.data);
    expect(text).toContain('нужен код');
    expect(text).not.toContain('код из звонка');
  });

  it('only for your own active link and a well-formed key', async () => {
    const h = await create();
    const to = 'x@example.com';
    expect((await other.req('POST', `/handoffs/${h.id}/mail`, { to, key: h.key })).statusCode).toBe(
      404,
    );
    expect(
      (await admin.req('POST', `/handoffs/${h.id}/mail`, { to, key: 'short' })).statusCode,
    ).toBe(400);
    expect(
      (await admin.req('POST', `/handoffs/${h.id}/mail`, { to: 'not-mail', key: h.key }))
        .statusCode,
    ).toBe(400);
    await admin.req('DELETE', `/handoffs/${h.id}`);
    expect((await admin.req('POST', `/handoffs/${h.id}/mail`, { to, key: h.key })).statusCode).toBe(
      404,
    );
    expect(smtp.received.some((x) => x.to === to)).toBe(false);
  });
});
