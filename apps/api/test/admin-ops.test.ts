import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { toBase64Url } from '@arklock/crypto';
import { settings } from '../src/db/schema.js';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let dir: string;
let admin: TestClient;
let bob: TestClient;

const NAME = 'arklock-20261012T010203Z-v0.1.0.bak.gpg';
const reqFile = () => path.join(dir, 'request.txt');
const heartbeat = () =>
  writeFileSync(
    path.join(dir, 'helper.json'),
    JSON.stringify({ ts: Math.floor(Date.now() / 1000) }),
  );
const consume = () => {
  const text = readFileSync(reqFile(), 'utf8');
  rmSync(reqFile());
  return Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((l) => l.split('=') as [string, string]),
  );
};
async function reauth(c: TestClient) {
  const r = await c.req('POST', '/admin/reauth', {
    authKey: toBase64Url((await c.derive()).keys.authKey),
  });
  return { 'x-reauth-token': r.json().token as string };
}
const withHeaders = (
  c: TestClient,
  method: 'GET' | 'POST',
  url: string,
  headers: object,
  payload?: unknown,
) =>
  app.inject({
    method,
    url: '/api/v1' + url,
    headers: { ...c.authHeader(), ...headers },
    payload: payload as never,
  });

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'arklock-ops-'));
  ({ app, database } = await createTestApp({ UPDATER_DIR: dir }));
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  expect((await admin.register()).statusCode).toBe(201);
  await database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  bob = new TestClient(app, 'bob@example.com', 'bob-password-12345');
  expect((await bob.register()).statusCode).toBe(201);
  await admin.login();
  await bob.login();
  heartbeat();
  writeFileSync(
    path.join(dir, 'containers.json'),
    JSON.stringify({
      at: '2026-10-12T01:00:00Z',
      items: [
        {
          service: 'app',
          image: 'arklock:local',
          state: 'running',
          health: 'healthy',
          started_at: '2026-10-12T00:00:00Z',
          restarts: 0,
          cpu: '1.2%',
          memory: '120MiB / 2GiB',
        },
        {
          service: 'db',
          image: 'postgres:16-alpine',
          state: 'running',
          health: 'healthy',
          started_at: '2026-10-12T00:00:00Z',
          restarts: 1,
          cpu: '0.4%',
          memory: '60MiB / 2GiB',
        },
      ],
    }),
  );
  writeFileSync(
    path.join(dir, 'backups.json'),
    JSON.stringify({
      dir: '/var/lib/arklock/backups',
      free_gib: 40,
      items: [
        {
          name: NAME,
          size: 1234,
          created_at: '2026-10-12T01:02:03Z',
          sha256: 'ab'.repeat(32),
          version: '0.1.0',
          migrations: 1,
        },
        {
          name: '../../etc/passwd',
          size: 1,
          created_at: '',
          sha256: '',
          version: '',
          migrations: 0,
        },
      ],
    }),
  );
  writeFileSync(
    path.join(dir, 'schedule.json'),
    JSON.stringify({ enabled: true, hour: 3, keep: 14, last_at: '', last_result: '' }),
  );
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('containers, backups, logs', () => {
  it('only administrators see containers and backups', async () => {
    expect((await bob.req('GET', '/admin/containers')).statusCode).toBe(403);
    expect((await bob.req('GET', '/admin/backups')).statusCode).toBe(403);
    expect((await bob.req('POST', '/admin/backups', { action: 'create' })).statusCode).toBe(403);
    expect((await bob.req('GET', '/admin/logs/system')).statusCode).toBe(403);
  });

  it('lists the containers published by the helper', async () => {
    const j = (await admin.req('GET', '/admin/containers')).json();
    expect(j.helperAlive).toBe(true);
    expect(j.items.map((i: { service: string }) => i.service)).toEqual(['app', 'db']);
    expect(j.items[1].restarts).toBe(1);
  });

  it('lists backups, dropping names that do not match the safe pattern', async () => {
    const j = (await admin.req('GET', '/admin/backups')).json();
    expect(j.backups.items).toHaveLength(1);
    expect(j.backups.items[0].name).toBe(NAME);
    expect(j.schedule).toMatchObject({ enabled: true, hour: 3, keep: 14 });
  });

  it('creating and verifying a backup needs no re-confirmation and queues a strict request', async () => {
    const r = await admin.req('POST', '/admin/backups', { action: 'create', label: 'manual' });
    expect(r.statusCode).toBe(202);
    expect(consume()).toMatchObject({ action: 'backup', label: 'manual' });
    const v = await admin.req('POST', '/admin/backups', { action: 'verify', file: NAME });
    expect(v.statusCode).toBe(202);
    expect(consume()).toMatchObject({ action: 'backup_verify', file: NAME });
  });

  it('delete, export, restore and schedule require the master password again', async () => {
    for (const body of [
      { action: 'delete', file: NAME },
      { action: 'export', file: NAME },
      { action: 'restore', file: NAME, confirm: NAME },
      { action: 'schedule', enabled: true, hour: 2, keep: 7 },
    ]) {
      const r = await admin.req('POST', '/admin/backups', body);
      expect(r.statusCode, body.action).toBe(403);
      expect(r.json().error.code).toBe('reauth_required');
    }
    const h = await reauth(admin);
    expect(
      (
        await withHeaders(admin, 'POST', '/admin/backups', h, {
          action: 'schedule',
          enabled: true,
          hour: 2,
          keep: 7,
        })
      ).statusCode,
    ).toBe(202);
    expect(consume()).toMatchObject({
      action: 'schedule',
      schedule_enabled: '1',
      schedule_hour: '2',
      schedule_keep: '7',
    });
    expect(
      (await withHeaders(admin, 'POST', '/admin/backups', h, { action: 'delete', file: NAME }))
        .statusCode,
    ).toBe(202);
    expect(consume()).toMatchObject({ action: 'backup_delete', file: NAME });
  });

  it('restore needs the backup name typed as confirmation', async () => {
    const h = await reauth(admin);
    const wrong = await withHeaders(admin, 'POST', '/admin/backups', h, {
      action: 'restore',
      file: NAME,
      confirm: 'yes',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('confirmation_mismatch');
    const ok = await withHeaders(admin, 'POST', '/admin/backups', h, {
      action: 'restore',
      file: NAME,
      confirm: NAME,
    });
    expect(ok.statusCode).toBe(202);
    expect(consume()).toMatchObject({ action: 'restore', file: NAME });
  });

  it('rejects path tricks and injections in names, services and line counts', async () => {
    const h = await reauth(admin);
    for (const file of [
      '../etc/passwd',
      'a/b.bak.gpg',
      'x.bak.gpg;id',
      'a..b.bak.gpg',
      'plain.txt',
      '',
    ]) {
      const r = await withHeaders(admin, 'POST', '/admin/backups', h, { action: 'delete', file });
      expect(r.statusCode, file).toBe(400);
    }
    expect(
      (await admin.req('POST', '/admin/logs/system', { service: 'other', lines: 100 })).statusCode,
    ).toBe(400);
    expect(
      (await admin.req('POST', '/admin/logs/system', { service: 'app', lines: 99999 })).statusCode,
    ).toBe(400);
    expect(
      (await admin.req('POST', '/admin/backups', { action: 'create', label: 'a;b' })).statusCode,
    ).toBe(400);
  });

  it('only one operation at a time; no helper means a clear error', async () => {
    expect((await admin.req('POST', '/admin/backups', { action: 'create' })).statusCode).toBe(202);
    const second = await admin.req('POST', '/admin/backups', { action: 'create' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('update_in_progress');
    rmSync(reqFile());
    rmSync(path.join(dir, 'helper.json'));
    const dead = await admin.req('POST', '/admin/backups', { action: 'create' });
    expect(dead.statusCode).toBe(503);
    expect((await admin.req('GET', '/admin/containers')).json().helperAlive).toBe(false);
    heartbeat();
  });

  it('logs: the request is queued and the helper output is returned as published', async () => {
    expect((await admin.req('GET', '/admin/logs/system')).json().log).toBeNull();
    expect(
      (await admin.req('POST', '/admin/logs/system', { service: 'app', lines: 200 })).statusCode,
    ).toBe(202);
    expect(consume()).toMatchObject({ action: 'logs', service: 'app', lines: '200' });
    writeFileSync(path.join(dir, 'logs.txt'), 'line one\nline two\n');
    writeFileSync(path.join(dir, 'logs.service'), 'app\n');
    const j = (await admin.req('GET', '/admin/logs/system')).json();
    expect(j.log.text).toContain('line two');
    expect(j.log.service).toBe('app');
  });

  it('download: needs re-confirmation and a prepared copy; nothing outside the export folder is reachable', async () => {
    const h = await reauth(admin);
    expect((await admin.req('GET', `/admin/backups/${NAME}/download`)).statusCode).toBe(403);
    expect((await withHeaders(admin, 'GET', `/admin/backups/${NAME}/download`, h)).statusCode).toBe(
      404,
    );
    mkdirSync(path.join(dir, 'export'));
    writeFileSync(path.join(dir, 'export', NAME), 'ENCRYPTED-BYTES');
    const ok = await withHeaders(admin, 'GET', `/admin/backups/${NAME}/download`, h);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('ENCRYPTED-BYTES');
    expect(ok.headers['content-disposition']).toContain(NAME);
    expect(
      (await withHeaders(admin, 'GET', '/admin/backups/..%2F..%2Fhelper.json/download', h))
        .statusCode,
    ).toBe(400);
    expect((await withHeaders(bob, 'GET', `/admin/backups/${NAME}/download`, h)).statusCode).toBe(
      403,
    );
  });
});
