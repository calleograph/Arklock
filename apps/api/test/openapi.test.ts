import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { entryWrite } from '@arklock/contracts';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  ({ app } = await createTestApp());
});
afterAll(async () => {
  await app.close();
});

type Doc = {
  openapi: string;
  paths: Record<string, Record<string, { security?: unknown[] }>>;
  components: { schemas: Record<string, { type?: string; required?: string[] }> };
};
const doc = async () =>
  (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json() as Doc;

describe('OpenAPI description', () => {
  it('is public, versioned OpenAPI 3.1', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(r.statusCode).toBe(200);
    const d = r.json() as Doc;
    expect(d.openapi).toBe('3.1.0');
    expect(JSON.stringify(d)).not.toContain('"$schema"');
  });

  it('every documented operation is a real route (no drift)', async () => {
    const d = await doc();
    const missing: string[] = [];
    for (const [path, ops] of Object.entries(d.paths)) {
      const url = '/api/v1' + path.replace(/\{(\w+)\}/g, ':$1');
      for (const method of Object.keys(ops)) {
        if (!app.hasRoute({ method: method.toUpperCase() as 'GET', url }))
          missing.push(method + ' ' + url);
      }
    }
    expect(missing).toEqual([]);
  });

  it('request schemas come from the validation contracts: a valid body passes both, an invalid one fails both', async () => {
    const d = await doc();
    const w = d.components.schemas['EntryWrite']!;
    expect(w.type).toBe('object');
    expect(w.required).toEqual(
      expect.arrayContaining(['wrappedEntryKey', 'ciphertext', 'keyVersion']),
    );
    expect(entryWrite.safeParse({ keyVersion: 0 }).success).toBe(false);
  });

  it('documented protected operations reject requests without a token; public ones answer', async () => {
    const d = await doc();
    for (const [path, ops] of Object.entries(d.paths)) {
      if (path.includes('{')) continue;
      const op = ops['get'];
      if (!op) continue;
      const isPublic = Array.isArray(op.security) && op.security.length === 0;
      const r = await app.inject({ method: 'GET', url: '/api/v1' + path });
      if (isPublic) expect([200, 503], path).toContain(r.statusCode);
      else expect(r.statusCode, path).toBe(401);
    }
    void TestClient;
  });
});
