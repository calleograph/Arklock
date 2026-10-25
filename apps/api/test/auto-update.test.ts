import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { toBase64Url } from '@arklock/crypto';
import { autoUpdateTick } from '../src/auto-update.js';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { createTestApp, TestClient, APP_SECRET } from './helpers.js';

let dir: string;
let app: Awaited<ReturnType<typeof createTestApp>>['app'];
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let admin: TestClient;
let ctx: ReturnType<typeof createContext>;

const heartbeat = () =>
  writeFileSync(
    path.join(dir, 'helper.json'),
    JSON.stringify({ ts: Math.floor(Date.now() / 1000), pid: 1 }),
  );
const remote = (over: Record<string, unknown> = {}) =>
  writeFileSync(
    path.join(dir, 'remote.json'),
    JSON.stringify({
      checked_at: new Date().toISOString(),
      status: 'available',
      latest: 'v0.2.0',
      changelog: '',
      migrations: 0,
      ...over,
    }),
  );
const request = () => path.join(dir, 'request.txt');
const consume = () => rmSync(request(), { force: true });

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'arklock-auto-'));
  const env = { UPDATER_DIR: dir, APP_VERSION: '0.1.0' };
  ({ app, database } = await createTestApp(env));
  ctx = createContext(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite:memory',
      LOG_LEVEL: 'silent',
      APP_SECRET,
      ...env,
    }),
    database,
  );
  admin = new TestClient(app, 'au-admin@example.com', 'auto-update-pass-1234');
  await admin.register();
  await admin.login();
  heartbeat();
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const at = (h: number, m: number, day = 25) => new Date(2026, 9, day, h, m, 0);

it('checks for a new version every 30 minutes by default and never installs on its own', async () => {
  remote({ checked_at: at(10, 0).toISOString() });
  expect(await autoUpdateTick(ctx, at(10, 10))).toBe('idle'); // проверялось 10 минут назад
  expect(await autoUpdateTick(ctx, at(10, 31))).toBe('check');
  expect(readFileSync(request(), 'utf8')).toContain('action=check');
  consume();
  // установка выключена: пора, версия есть, но ничего не запускается
  remote({ checked_at: at(0, 10).toISOString() });
  expect(await autoUpdateTick(ctx, at(0, 20))).toBe('idle');
  expect(existsSync(request())).toBe(false);
});

it('installs a stable version once a day at the chosen time, only after the password confirmation', async () => {
  const unauthorised = await admin.req('PUT', '/admin/updates/auto', {
    check: true,
    install: true,
    at: '00:00',
  });
  expect(unauthorised.statusCode).toBeGreaterThanOrEqual(400);
  const { keys } = await admin.derive();
  const token = (
    await admin.req('POST', '/admin/reauth', { authKey: toBase64Url(keys.authKey) })
  ).json().token;
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/updates/auto',
    headers: { ...admin.authHeader(), 'x-reauth-token': token },
    payload: { check: true, install: true, at: '00:00' },
  });
  expect(saved.json()).toMatchObject({ install: true, at: '00:00', check: true });
  expect((await admin.req('GET', '/admin/updates')).json().auto).toMatchObject({ install: true });

  // до заданного времени ничего не происходит
  const policy = (await admin.req('GET', '/admin/updates')).json().auto;
  expect(policy.lastDay).toBeNull();
  remote({ checked_at: at(0, 5, 26).toISOString() });
  expect(await autoUpdateTick(ctx, at(0, 10, 26))).toBe('update');
  expect(readFileSync(request(), 'utf8')).toMatch(
    /action=update\nby=00000000-0000-0000-0000-000000000000[\s\S]*version=v0\.2\.0/,
  );
  consume();
  // в тот же день повтора нет, даже если обновление не удалось
  remote({ checked_at: at(4, 50, 26).toISOString() });
  expect(await autoUpdateTick(ctx, at(5, 0, 26))).toBe('idle');
  // предварительная версия не ставится
  remote({ checked_at: at(0, 50, 27).toISOString(), latest: 'v0.3.0-rc1' });
  expect(await autoUpdateTick(ctx, at(1, 0, 27))).toBe('idle');
  expect(existsSync(request())).toBe(false);
});

it('does nothing while the helper is down or another operation is running', async () => {
  writeFileSync(path.join(dir, 'helper.json'), JSON.stringify({ ts: 1, pid: 1 }));
  remote({ checked_at: at(1, 50, 28).toISOString() });
  expect(await autoUpdateTick(ctx, at(2, 0, 28))).toBe('idle');
  heartbeat();
  writeFileSync(
    path.join(dir, 'status.json'),
    JSON.stringify({ state: 'running', action: 'update' }),
  );
  expect(await autoUpdateTick(ctx, at(2, 0, 28))).toBe('idle');
});
