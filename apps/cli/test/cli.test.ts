import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generateTotpSecret, toBase64Url } from '@arklock/crypto';
import { TestClient, createTestApp } from '../../api/test/helpers.js';
import { run, type Config, type Io } from '../src/commands.js';

const PASSWORD = 'cli-master-password-123';
let app: FastifyInstance;
let server = '';
let user: TestClient;
let readToken = '';
let writeToken = '';
let totpSecret = '';
let config: Config = {};
const sentBodies: string[] = [];

const recordingFetch: typeof fetch = async (input, init) => {
  if (typeof init?.body === 'string') sentBodies.push(init.body);
  return fetch(input, init);
};

async function cli(argv: string[], env: Record<string, string> = {}) {
  let out = '';
  let err = '';
  const io: Io = {
    out: (s) => (out += s),
    err: (s) => (err += s),
    env: { ARKLOCK_PASSWORD: PASSWORD, ...env },
    loadConfig: () => config,
    saveConfig: (c) => (config = c),
    fetchFn: recordingFetch,
    kdfFloor: { memoryKiB: 8, iterations: 1, parallelism: 1 },
  };
  const code = await run(argv, io);
  return { code, out, err };
}

async function makeToken(scope: 'read' | 'write') {
  const authKey = toBase64Url((await user.derive()).keys.authKey);
  const r = await user.req('POST', '/auth/tokens', {
    name: scope,
    scope,
    expiresInDays: 1,
    authKey,
  });
  return r.json().token as string;
}

beforeAll(async () => {
  const t = await createTestApp();
  app = t.app;
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  server = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  user = new TestClient(app, 'cli@example.com', PASSWORD);
  expect((await user.register()).statusCode).toBe(201);
  await user.login();
  totpSecret = generateTotpSecret();
  const { locker, key } = await user.lockerKey();
  const folder = await user.createBranch(locker.id, key, 'Servers', null, locker.keyVersion);
  await user.createEntry(
    {
      kind: 'login',
      title: 'Prod database',
      username: 'dba',
      password: 'Sup3r-Secret-Pass!',
      url: 'https://db.example.com',
      notes: '',
      totp: totpSecret,
      fields: [{ name: 'host', value: '203.0.113.5', secret: false }],
      tags: ['prod'],
    },
    { branchId: folder.id },
  );
  await user.createEntry({ kind: 'login', title: 'Other thing', username: 'x', password: 'zzz' });
  readToken = await makeToken('read');
  writeToken = await makeToken('write');
});

afterAll(async () => {
  await app.close();
});

describe('command-line client', () => {
  it('prints help and rejects unknown commands', async () => {
    expect((await cli(['help'])).out).toContain('Arklock');
    const bad = await cli(['nope']);
    expect(bad.code).toBe(2);
  });

  it('config validates the token format and the address', async () => {
    expect((await cli(['config', '--server', server, '--token', 'oops'])).code).toBe(1);
    expect((await cli(['config', '--server', 'ftp://x', '--token', readToken])).code).toBe(1);
    expect((await cli(['config', '--server', server, '--token', readToken])).code).toBe(0);
    expect(config.server).toBe(server);
  });

  it('lists and finds entries; secrets are decrypted only on this side', async () => {
    const list = await cli(['list']);
    expect(list.code).toBe(0);
    expect(list.out).toContain('Prod database');
    expect(list.out).toContain('Servers');
    expect(list.out).not.toContain('Sup3r-Secret-Pass!');
    const filtered = await cli(['list', '-q', 'other', '--json']);
    expect(JSON.parse(filtered.out)).toHaveLength(1);

    const pw = await cli(['get', 'prod database', '--field', 'password']);
    expect(pw.out.trim()).toBe('Sup3r-Secret-Pass!');
    expect((await cli(['get', 'Prod', '--field', 'host'])).out.trim()).toBe('203.0.113.5');
    expect((await cli(['get', 'nothing-here'])).code).toBe(1);
    const code = await cli(['totp', 'Prod database']);
    expect(code.out.trim()).toMatch(/^\d{6}$/);
  });

  it('the password and decrypted data never travel to the server', async () => {
    await cli(['get', 'Prod database', '--field', 'password']);
    const wire = sentBodies.join('\n');
    expect(wire).not.toContain(PASSWORD);
    expect(wire).not.toContain('Sup3r-Secret-Pass!');
  });

  it('a wrong master password fails without detail leaks', async () => {
    const r = await cli(['list'], { ARKLOCK_PASSWORD: 'wrong-password-123456' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('Wrong master password');
  });

  it('a read-only token cannot add; a write token can, and the web side reads it', async () => {
    const denied = await cli(['add', '--title', 'New', '--generate']);
    expect(denied.code).toBe(1);
    expect(denied.err).toContain('read-only');

    config = { ...config, token: writeToken };
    const added = await cli([
      'add',
      '--title',
      'From CLI',
      '--username',
      'robot',
      '--generate',
      '--folder',
      'Servers',
    ]);
    expect(added.code).toBe(0);
    const id = added.out.trim();
    const { locker, key } = await user.lockerKey();
    const back = await user.readEntry(locker.id, id, key);
    expect(back).toMatchObject({ title: 'From CLI', username: 'robot' });
    expect((back as { password: string }).password.length).toBe(20);
    const ls = await cli(['list', '-q', 'from cli']);
    expect(ls.out).toContain('Servers');
  });

  it('refuses a key log that no longer matches the pinned state', async () => {
    config = { ...config, pin: { seq: config.pin?.seq ?? 1, hash: 'tampered-hash' } };
    const r = await cli(['list']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('key log');
  });

  it('generates passwords and phrases', async () => {
    expect((await cli(['generate', '--length', '30'])).out.trim()).toHaveLength(30);
    expect(
      (await cli(['generate', '--phrase'])).out.trim().split('-').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('login with the password completes the second factor when it is enabled', async () => {
    const setup = (await user.req('POST', '/auth/mfa/setup')).json();
    const { totp, parseTotpInput } = await import('@arklock/crypto');
    await user.req('POST', '/auth/mfa/enable', {
      code: await totp(parseTotpInput(setup.secret), Date.now() - 30_000),
    });
    config = {};
    // один и тот же код для обоих входов: на границе шага времени новый код был бы принят
    const code = await totp(parseTotpInput(setup.secret));
    const ok = await cli(['login', '--server', server, '--email', 'cli@example.com'], {
      ARKLOCK_MFA_CODE: code,
    });
    expect(ok.code).toBe(0);
    expect(config.token).toMatch(/^aks_/);
    expect((await cli(['list'])).out).toContain('Prod database');
    // тот же код повторно не принимается
    config = {};
    const replay = await cli(['login', '--server', server, '--email', 'cli@example.com'], {
      ARKLOCK_MFA_CODE: code,
    });
    expect(replay.code).toBe(1);
  });
});
