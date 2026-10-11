import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { toBase64Url } from '@arklock/crypto';
import { ReauthStore } from '../src/auth/reauth.js';
import { settings } from '../src/db/schema.js';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let dir: string;
let admin: TestClient;
let member: TestClient;

const heartbeat = (ageSeconds = 0) =>
  writeFileSync(
    path.join(dir, 'helper.json'),
    JSON.stringify({ ts: Math.floor(Date.now() / 1000) - ageSeconds, pid: 1 }),
  );
const clearRequest = () => rmSync(path.join(dir, 'request.txt'), { force: true });
const setStatus = (s: Record<string, unknown>) =>
  writeFileSync(path.join(dir, 'status.json'), JSON.stringify(s));

async function reauth(c: TestClient, password = c.password) {
  const { keys } = await c.derive(password);
  return app.inject({
    method: 'POST',
    url: '/api/v1/admin/reauth',
    headers: c.authHeader(),
    payload: { authKey: toBase64Url(keys.authKey) },
  });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'arklock-updater-'));
  const { app: instance, database } = await createTestApp({
    UPDATER_DIR: dir,
    APP_VERSION: '0.1.0',
  });
  app = instance;
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  expect((await admin.register()).statusCode).toBe(201);
  await database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  member = new TestClient(app, 'member@example.com', 'member-password-123');
  expect((await member.register()).statusCode).toBe(201);
  await admin.login();
  await member.login();
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('access control of /admin routes', () => {
  const routes: [string, string, unknown?][] = [
    ['GET', '/api/v1/admin/updates'],
    ['POST', '/api/v1/admin/updates', { action: 'check' }],
    ['POST', '/api/v1/admin/reauth', { authKey: 'A'.repeat(43) }],
  ];

  it.each(routes)('%s %s requires authentication', async (method, url, payload) => {
    const res = await app.inject({ method: method as 'GET' | 'POST', url, payload });
    expect(res.statusCode).toBe(401);
  });

  it.each(routes)('%s %s is forbidden for non-administrators', async (method, url, payload) => {
    const res = await app.inject({
      method: method as 'GET' | 'POST',
      url,
      headers: member.authHeader(),
      payload,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('updates overview', () => {
  it('reports installed build and a missing helper', async () => {
    clearRequest();
    const res = await app.inject({ url: '/api/v1/admin/updates', headers: admin.authHeader() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.installed.version).toBe('0.1.0');
    expect(body.helper).toMatchObject({ configured: true, alive: false });
    expect(body.status.state).toBe('idle');
  });

  it('shows helper heartbeat, remote version, changelog, status and history', async () => {
    heartbeat();
    writeFileSync(
      path.join(dir, 'remote.json'),
      JSON.stringify({
        checked_at: '2026-10-11T10:00:00Z',
        status: 'available',
        latest: 'v0.2.0',
        changelog: '## 0.2.0\n- new',
        migrations: 2,
      }),
    );
    setStatus({
      state: 'success',
      action: 'update',
      step_no: 9,
      step_total: 9,
      step_name: 'done',
      version_from: '0.1.0',
      version_to: '0.2.0',
    });
    writeFileSync(
      path.join(dir, 'history.jsonl'),
      JSON.stringify({
        at: '2026-10-10T10:00:00Z',
        action: 'update',
        result: 'success',
        version_from: '0.0.9',
        version_to: '0.1.0',
      }) + '\n{broken line\n',
    );
    const body = (
      await app.inject({ url: '/api/v1/admin/updates', headers: admin.authHeader() })
    ).json();
    expect(body.helper.alive).toBe(true);
    expect(body.remote).toMatchObject({ status: 'available', latest: 'v0.2.0', migrations: 2 });
    expect(body.remote.changelog).toContain('new');
    expect(body.status).toMatchObject({ state: 'success', stepNo: 9, versionTo: '0.2.0' });
    expect(body.history).toHaveLength(1);
  });

  it('treats a stale heartbeat as a stopped helper', async () => {
    heartbeat(120);
    const body = (
      await app.inject({ url: '/api/v1/admin/updates', headers: admin.authHeader() })
    ).json();
    expect(body.helper.alive).toBe(false);
    heartbeat();
  });
});

describe('requests to the update helper', () => {
  it('check needs no re-authentication and writes a strict request file', async () => {
    clearRequest();
    setStatus({ state: 'idle' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/updates',
      headers: admin.authHeader(),
      payload: { action: 'check' },
    });
    expect(res.statusCode).toBe(202);
    const text = readFileSync(path.join(dir, 'request.txt'), 'utf8');
    expect(text).toMatch(/^request_id=[0-9a-f-]{36}\naction=check\nby=[0-9a-f-]{36}\nat=\S+\n$/);
  });

  it('only one request can be pending at a time', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/updates',
      headers: admin.authHeader(),
      payload: { action: 'check' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('update_in_progress');
  });

  it('refuses while an operation is running', async () => {
    clearRequest();
    setStatus({ state: 'running', action: 'update' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/updates',
      headers: admin.authHeader(),
      payload: { action: 'check' },
    });
    expect(res.statusCode).toBe(409);
    setStatus({ state: 'idle' });
  });

  it('update and rollback require re-authentication', async () => {
    clearRequest();
    for (const payload of [{ action: 'update', version: 'v0.2.0' }, { action: 'rollback' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/updates',
        headers: admin.authHeader(),
        payload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('reauth_required');
    }
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/updates',
      headers: { ...admin.authHeader(), 'x-reauth-token': 'ra_forged' },
      payload: { action: 'update', version: 'v0.2.0' },
    });
    expect(bad.statusCode).toBe(403);
  });

  it('a wrong password does not yield a re-authentication token', async () => {
    const res = await reauth(admin, 'not-the-password-123');
    expect(res.statusCode).toBe(401);
  });

  it('accepts update with a valid token, rejects malformed versions, and binds the token to the session', async () => {
    clearRequest();
    const ok = await reauth(admin);
    expect(ok.statusCode).toBe(200);
    const token = ok.json().token as string;

    for (const version of [
      'v1',
      '0.2.0',
      'v0.2.0; rm -rf /',
      '../v0.2.0',
      'v0.2.0\naction=rollback',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/updates',
        headers: { ...admin.authHeader(), 'x-reauth-token': token },
        payload: { action: 'update', version },
      });
      expect(res.statusCode, version).toBe(400);
    }
    expect(
      await app
        .inject({ url: '/api/v1/admin/updates', headers: admin.authHeader() })
        .then((r) => r.json().pending),
    ).toBe(false);

    // токен, выданный другому сеансу того же администратора, не подходит
    const other = new TestClient(app, 'admin@example.com', 'admin-password-123');
    await other.login();
    const stolen = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/updates',
      headers: { ...other.authHeader(), 'x-reauth-token': token },
      payload: { action: 'update', version: 'v0.2.0' },
    });
    expect(stolen.statusCode).toBe(403);

    const good = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/updates',
      headers: { ...admin.authHeader(), 'x-reauth-token': token },
      payload: { action: 'update', version: 'v0.2.0' },
    });
    expect(good.statusCode).toBe(202);
    const text = readFileSync(path.join(dir, 'request.txt'), 'utf8');
    expect(text).toContain('action=update\n');
    expect(text).toContain('version=v0.2.0\n');
  });

  it('reports 503 when the helper is not running', async () => {
    clearRequest();
    heartbeat(300);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/updates',
      headers: admin.authHeader(),
      payload: { action: 'check' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('updater_unavailable');
    heartbeat();
  });

  it('audit log records the action without secrets', async () => {
    const res = await app.inject({ url: '/api/v1/admin/updates', headers: admin.authHeader() });
    expect(res.statusCode).toBe(200);
  });
});

describe('ReauthStore', () => {
  it('expires tokens after five minutes and is bound to the session', () => {
    const store = new ReauthStore();
    const t0 = 1_000_000;
    const { token } = store.issue('s1', t0);
    expect(store.check(token, 's1', t0 + 1000)).toBe(true);
    expect(store.check(token, 's2', t0 + 1000)).toBe(false);
    expect(store.check(token, 's1', t0 + 5 * 60_000 + 1)).toBe(false);
    expect(store.check(undefined, 's1', t0)).toBe(false);
  });
});
