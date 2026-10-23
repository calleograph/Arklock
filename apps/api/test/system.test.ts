import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { versionResponse } from '@arklock/contracts';
import { loadConfig } from '../src/config.js';
import { connect } from '../src/db/connect.js';
import { buildApp } from '../src/app.js';
import { ledger, settings } from '../src/db/schema.js';

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof connect>>;

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite:memory',
    APP_SECRET: 'test-secret-test-secret-test-secret-123',
    LOG_LEVEL: 'silent',
    APP_VERSION: '1.2.3',
    APP_GIT_COMMIT: 'abc1234',
  });
  database = await connect(config.DATABASE_URL);
  await database.migrate();
  app = await buildApp({ config, database });
});

afterAll(async () => {
  await app.close();
});

describe('system routes', () => {
  it('health is up without touching the database', async () => {
    const res = await app.inject('/api/v1/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('ready reports database state', async () => {
    const res = await app.inject('/api/v1/ready');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok' } });
  });

  it('version matches the contract', async () => {
    const res = await app.inject('/api/v1/version');
    const body = versionResponse.parse(res.json());
    expect(body.version).toBe('1.2.3');
    expect(body.commit).toBe('abc1234');
  });

  it('sets security headers and forbids caching of API responses', async () => {
    const res = await app.inject('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns the unified error format for unknown API paths', async () => {
    const res = await app.inject('/api/v1/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});

describe('database schema', () => {
  it('has migrated tables that accept data', async () => {
    await database.db.insert(settings).values({ key: 'k', value: { a: 1 } });
    await database.db.insert(ledger).values({ actor: 'system', action: 'test' });
    const rows = await database.db.select().from(ledger);
    expect(rows).toHaveLength(1);
  });
});

describe('config', () => {
  it('rejects invalid configuration with a readable message', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/DATABASE_URL/);
    expect(() =>
      loadConfig({
        DATABASE_URL: 'pglite:memory',
        APP_SECRET: 'test-secret-test-secret-test-secret-123',
        PORT: '99999',
      }),
    ).toThrow(/PORT/);
  });
});

describe('static web client', () => {
  it('serves index.html for UI routes but JSON 404 for unknown API paths', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'arklock-web-'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
    const db = await connect('pglite:memory');
    const withWeb = await buildApp({
      config: loadConfig({
        DATABASE_URL: 'pglite:memory',
        APP_SECRET: 'test-secret-test-secret-test-secret-123',
        LOG_LEVEL: 'silent',
        WEB_DIST: dir,
      }),
      database: db,
    });
    try {
      const ui = await withWeb.inject('/vaults/abc');
      expect(ui.statusCode).toBe(200);
      expect(ui.headers['content-type']).toContain('text/html');
      // отсутствующий файл сборки — 404, а не index.html (иначе service worker закэширует HTML вместо скрипта)
      const asset = await withWeb.inject('/assets/index-missing.js');
      expect(asset.statusCode).toBe(404);
      const api = await withWeb.inject('/api/v1/missing');
      expect(api.statusCode).toBe(404);
      expect(api.json().error.code).toBe('not_found');
    } finally {
      await withWeb.close();
    }
  });
});
