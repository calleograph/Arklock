import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  assertSafeUrl,
  isForbiddenAddress,
  safeGet,
  UnsafeUrlError,
} from '../src/net/safeFetch.js';
import { validateRangeUrl } from '../src/routes/security.js';
import { TestClient, createTestApp } from './helpers.js';

describe('SSRF protection', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '2001:db8::1',
  ])('forbids %s', (a) => expect(isForbiddenAddress(a)).toBe(true));

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.0.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
  ])('allows public address %s', (a) => expect(isForbiddenAddress(a)).toBe(false));

  it('accepts only HTTPS without credentials', () => {
    expect(() => assertSafeUrl('https://api.example.com/range/')).not.toThrow();
    expect(() => assertSafeUrl('http://api.example.com/range/')).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl('https://user:pw@api.example.com/')).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl('not a url')).toThrow(UnsafeUrlError);
    expect(() => validateRangeUrl('https://api.example.com/range')).toThrow(/slash/);
  });

  it('refuses internal targets before connecting (literal and resolved names)', async () => {
    await expect(safeGet('https://127.0.0.1/')).rejects.toThrow(/not allowed/);
    await expect(safeGet('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /not allowed/,
    );
    await expect(safeGet('https://localhost/')).rejects.toThrow(/not allowed/);
    await expect(safeGet('https://[::1]/')).rejects.toThrow(/not allowed/);
  });
});

describe('breach-check range service', () => {
  let app: FastifyInstance;
  let server: http.Server;
  let port: number;
  let admin: TestClient;
  let user: TestClient;
  let mode: 'ok' | 'redirect' | 'huge' | 'error' = 'ok';
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(`${req.url}|${req.headers['add-padding'] ?? ''}`);
      if (mode === 'redirect')
        return void res.writeHead(302, { Location: 'http://127.0.0.1:1/' }).end();
      if (mode === 'error') return void res.writeHead(503).end('x');
      if (mode === 'huge') return void res.writeHead(200).end('A'.repeat(3 * 1024 * 1024));
      const lines = Array.from(
        { length: 150 },
        (_, i) => `${i.toString(16).toUpperCase().padStart(35, '0')}:${i + 1}`,
      );
      res.writeHead(200, { 'content-type': 'text/plain' }).end(lines.join('\r\n'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    ({ app } = await createTestApp());
    admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
    await admin.register();
    await admin.login();
    user = new TestClient(app, 'u@example.com', 'user-password-12345');
  });
  afterAll(async () => {
    await app.close();
    server.close();
  });

  it('only administrators read or change the address; the default is the public service', async () => {
    const cfg = (await admin.req('GET', '/admin/security/range')).json();
    expect(cfg.url).toBe('https://api.pwnedpasswords.com/range/');
    expect((await user.req('GET', '/admin/security/range')).statusCode).toBe(401);
  });

  it('tests a candidate address before saving; bad formats and refusals are reported, not applied', async () => {
    const url = `http://127.0.0.1:${port}/range/`;
    mode = 'ok';
    expect((await admin.req('POST', '/admin/security/range/test', { url })).json()).toMatchObject({
      ok: true,
    });
    mode = 'error';
    expect((await admin.req('POST', '/admin/security/range/test', { url })).json()).toMatchObject({
      ok: false,
    });
    mode = 'redirect';
    expect((await admin.req('POST', '/admin/security/range/test', { url })).json()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/redirect/),
    });
    mode = 'huge';
    expect((await admin.req('POST', '/admin/security/range/test', { url })).json().ok).toBe(false);
    expect(
      (await admin.req('POST', '/admin/security/range/test', { url: 'ftp://x/' })).json().ok,
    ).toBe(false);
  });

  it('saves a validated address, audits the change, and proxies only the 5-character prefix with padding', async () => {
    mode = 'ok';
    const url = `http://127.0.0.1:${port}/range/`;
    expect(
      (await admin.req('PUT', '/admin/security/range', { url: 'http://127.0.0.1/no-slash' }))
        .statusCode,
    ).toBe(400);
    expect((await admin.req('PUT', '/admin/security/range', { url })).statusCode).toBe(200);
    hits.length = 0;
    const res = await admin.req('GET', '/security/range/5baa6');
    expect(res.statusCode).toBe(200);
    expect(res.body.split('\r\n').length).toBe(150);
    expect(hits).toEqual(['/range/5BAA6|true']);
    expect((await admin.req('GET', '/security/range/5BAA')).statusCode).toBe(400);
    expect((await admin.req('GET', '/security/range/5BAA61')).statusCode).toBe(400);
    const log = (await admin.req('GET', '/admin/ledger?action=admin.setting')).json();
    expect(JSON.stringify(log)).toContain('security.rangeUrl');
  });

  it('several providers are merged with summed counts; one failing provider fails the whole check', async () => {
    mode = 'ok';
    const a = `http://127.0.0.1:${port}/range/`;
    const b = `http://127.0.0.1:${port}/other/`;
    expect(
      (await admin.req('PUT', '/admin/security/range', { urls: [a, b, a] })).json().urls,
    ).toEqual([a, b]);
    const res = await admin.req('GET', '/security/range/5BAA6');
    expect(res.statusCode).toBe(200);
    const lines = res.body.split('\r\n');
    expect(lines).toHaveLength(150);
    expect(lines[1]).toMatch(/:4$/); // 2 + 2
    mode = 'error';
    expect((await admin.req('GET', '/security/range/5BAA6')).statusCode).toBe(502);
    mode = 'ok';
    expect((await admin.req('PUT', '/admin/security/range', { urls: [] })).statusCode).toBe(400);
    await admin.req('PUT', '/admin/security/range', { urls: [a] });
  });

  it('an unavailable service yields an explicit error, never a false "safe"', async () => {
    mode = 'error';
    const res = await admin.req('GET', '/security/range/5BAA6');
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('range_unavailable');
    mode = 'ok';
  });
});
