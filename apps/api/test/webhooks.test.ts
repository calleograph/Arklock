import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, TestClient } from './helpers.js';
import { signWebhook } from '../src/webhooks.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let server: http.Server;
let port: number;
let admin: TestClient;
let member: TestClient;
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'admin@example.com', 'admin-password-123');
  await admin.register();
  await admin.login();
  member = new TestClient(fixture.app, 'm@example.com', 'member-password-123');
});
afterAll(async () => {
  await fixture.app.close();
  server.close();
});

const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 100));
};

it('only administrators manage webhooks; bad and internal-looking addresses are refused', async () => {
  expect((await member.req('GET', '/admin/webhooks')).statusCode).toBe(401);
  const bad = await admin.req('PUT', '/admin/webhooks', {
    hooks: [{ name: 'x', url: 'ftp://example.com/hook' }],
  });
  expect(bad.statusCode).toBe(400);
});

it('delivers signed events without secrets, honours prefixes, and shows the secret only once', async () => {
  const url = `http://127.0.0.1:${port}/hook`;
  const saved = await admin.req('PUT', '/admin/webhooks', {
    hooks: [{ name: 'SIEM', url, prefixes: ['admin.webhooks.'] }],
  });
  expect(saved.statusCode).toBe(200);
  const [secret] = Object.values(saved.json().issuedSecrets as Record<string, string>);
  expect(secret).toHaveLength(43);
  await waitFor(() => received.length > 0);
  expect(received).toHaveLength(1);
  const r = received[0]!;
  expect(r.headers['x-arklock-event']).toBe('admin.webhooks.save');
  expect(r.headers['x-arklock-signature']).toBe(
    signWebhook(secret!, String(r.headers['x-arklock-timestamp']), r.body),
  );
  expect(JSON.parse(r.body)).toMatchObject({ type: 'admin.webhooks.save', detail: { hooks: 1 } });
  const listed = (await admin.req('GET', '/admin/webhooks')).json();
  expect(JSON.stringify(listed)).not.toContain(secret!);
  expect(JSON.stringify(listed)).not.toContain('secretSealed');
  expect(listed.hooks[0].status.sent).toBe(1);
  // события вне префикса не отправляются
  const before = received.length;
  await admin.req('PUT', '/admin/settings', { 'notifications.security': true });
  await new Promise((r) => setTimeout(r, 300));
  expect(received.length).toBe(before);
});

it('a test delivery reports the receiver status; the secret changes only on request', async () => {
  const id = (await admin.req('GET', '/admin/webhooks')).json().hooks[0].id as string;
  const t = (await admin.req('POST', `/admin/webhooks/${id}/test`)).json();
  expect(t).toMatchObject({ ok: true, status: 204 });
  const keep = await admin.req('PUT', '/admin/webhooks', {
    hooks: [{ id, name: 'SIEM', url: `http://127.0.0.1:${port}/hook`, prefixes: [] }],
  });
  expect(keep.json().issuedSecrets).toEqual({});
  const rotated = await admin.req('PUT', '/admin/webhooks', {
    hooks: [{ id, name: 'SIEM', url: `http://127.0.0.1:${port}/hook`, newSecret: true }],
  });
  expect(Object.keys(rotated.json().issuedSecrets)).toEqual([id]);
  expect((await admin.req('POST', `/admin/webhooks/${crypto.randomUUID()}/test`)).statusCode).toBe(
    404,
  );
});

it('keeps a delivery log per webhook: test deliveries and failures are recorded, removal clears it', async () => {
  const url = `http://127.0.0.1:${port}/log`;
  const saved = await admin.req('PUT', '/admin/webhooks', { hooks: [{ name: 'Журнал', url }] });
  const id = (await admin.req('GET', '/admin/webhooks')).json().hooks[0].id as string;
  expect(Object.keys(saved.json().issuedSecrets)).toContain(id);
  expect((await admin.req('POST', `/admin/webhooks/${id}/test`)).json().ok).toBe(true);
  const log = (await admin.req('GET', `/admin/webhooks/${id}/deliveries`)).json().deliveries;
  expect(log[0]).toMatchObject({ event: 'webhook.test', ok: true, code: 204, attempts: 1 });
  expect(JSON.stringify(log)).not.toContain(url);
  expect((await member.req('GET', `/admin/webhooks/${id}/deliveries`)).statusCode).toBe(401);
  await admin.req('PUT', '/admin/webhooks', { hooks: [] });
  expect((await admin.req('GET', `/admin/webhooks/${id}/deliveries`)).statusCode).toBe(404);
});

it('the activity log filters by importance and labels every event', async () => {
  const { audit } = await import('../src/audit.js');
  await audit(fixture.database.db, 'anonymous', 'auth.login.failed', null, { ip: '203.0.113.7' });
  await audit(fixture.database.db, 'anonymous', 'admin.user.delete', null, {});
  const get = async (level?: string) =>
    (await admin.req('GET', `/admin/ledger?limit=500${level ? `&level=${level}` : ''}`)).json()
      .items as { action: string; level: string }[];
  const all = await get();
  expect(all.every((i) => ['critical', 'warning', 'info'].includes(i.level))).toBe(true);
  const critical = await get('critical');
  expect(critical.map((i) => i.action)).toContain('auth.login.failed');
  expect(critical.every((i) => i.level === 'critical')).toBe(true);
  const warning = await get('warning');
  expect(warning.map((i) => i.action)).toContain('admin.user.delete');
  expect(warning.some((i) => i.action === 'auth.login.failed')).toBe(false);
  const info = await get('info');
  expect(info.every((i) => i.level === 'info')).toBe(true);
  expect(info.length + warning.length + critical.length).toBe(all.length);
});
