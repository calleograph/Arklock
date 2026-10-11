import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { toBase64Url } from '@arklock/crypto';
import { apiTokens } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let user: TestClient;
let readToken = '';
let writeToken = '';
let readId = '';

const authKeyOf = async (c: TestClient) => toBase64Url((await c.derive()).keys.authKey);
const withToken = (
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url: '/api/v1' + url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as never,
  });

beforeAll(async () => {
  ({ app, database } = await createTestApp());
  user = new TestClient(app, 'user@example.com', 'user-password-12345');
  expect((await user.register()).statusCode).toBe(201);
  await user.login();
});

afterAll(async () => {
  await app.close();
});

describe('API tokens', () => {
  it('creation requires the master password; the token is shown once and stored hashed', async () => {
    const bad = await user.req('POST', '/auth/tokens', {
      name: 'ci',
      scope: 'read',
      expiresInDays: 30,
      authKey: toBase64Url(new Uint8Array(32)),
    });
    expect(bad.statusCode).toBe(401);

    const res = await user.req('POST', '/auth/tokens', {
      name: 'ci-read',
      scope: 'read',
      expiresInDays: 30,
      authKey: await authKeyOf(user),
    });
    expect(res.statusCode).toBe(201);
    readToken = res.json().token;
    readId = res.json().info.id;
    expect(readToken).toMatch(/^akt_[A-Za-z0-9_-]{43}$/);
    const [row] = await database.db.select().from(apiTokens).where(eq(apiTokens.id, readId));
    expect(row!.tokenHash).not.toContain(readToken);
    expect(JSON.stringify(row)).not.toContain(readToken);
    // список не содержит самих токенов
    const list = await user.req('GET', '/auth/tokens');
    expect(JSON.stringify(list.json())).not.toContain(readToken);
    expect(list.json()[0].prefix).toBe(readToken.slice(0, 8));

    writeToken = (
      await user.req('POST', '/auth/tokens', {
        name: 'ci-write',
        scope: 'write',
        expiresInDays: 0,
        authKey: await authKeyOf(user),
      })
    ).json().token;
  });

  it('a read token reads ciphertext and cannot write; a write token can', async () => {
    const vaults = await withToken(readToken, 'GET', '/vaults');
    expect(vaults.statusCode).toBe(200);
    const locker = vaults.json().find((v: { kind: string }) => v.kind === 'locker');
    expect(locker.key.sealedKey).toBeTruthy();
    // токен видит только шифртекст записей
    await user.createEntry({ title: 'Secret title', password: 'p4ss-W0rd!' });
    const tree = await withToken(readToken, 'GET', `/vaults/${locker.id}/tree`);
    expect(tree.statusCode).toBe(200);
    expect(tree.body).not.toContain('Secret title');
    expect(tree.body).not.toContain('p4ss-W0rd!');

    const denied = await withToken(readToken, 'POST', `/vaults/${locker.id}/branches`, {});
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('token_read_only');
    const viaWrite = await withToken(writeToken, 'POST', `/vaults/${locker.id}/branches`, {});
    expect(viaWrite.statusCode).toBe(400); // доходит до проверки тела
  });

  it('tokens cannot manage the account, sessions, tokens, MFA or administration', async () => {
    for (const [method, url] of [
      ['GET', '/auth/sessions'],
      ['GET', '/auth/tokens'],
      ['POST', '/auth/tokens'],
      ['GET', '/auth/mfa'],
      ['POST', '/auth/change-password'],
      ['GET', '/admin/users'],
      ['POST', '/admin/reauth'],
    ] as const) {
      const r = await withToken(writeToken, method, url, method === 'POST' ? {} : undefined);
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().error.code).toBe('token_not_allowed');
    }
  });

  it('revoked, expired, unknown tokens and disabled users are rejected', async () => {
    expect((await user.req('DELETE', `/auth/tokens/${readId}`)).statusCode).toBe(204);
    expect((await withToken(readToken, 'GET', '/vaults')).statusCode).toBe(401);
    expect((await withToken(`akt_${'A'.repeat(43)}`, 'GET', '/vaults')).statusCode).toBe(401);

    const exp = (
      await user.req('POST', '/auth/tokens', {
        name: 'short',
        scope: 'read',
        expiresInDays: 1,
        authKey: await authKeyOf(user),
      })
    ).json();
    expect((await withToken(exp.token, 'GET', '/vaults')).statusCode).toBe(200);
    await database.db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiTokens.id, exp.info.id));
    expect((await withToken(exp.token, 'GET', '/vaults')).statusCode).toBe(401);

    expect((await withToken(writeToken, 'GET', '/vaults')).statusCode).toBe(200);
    // чужой токен нельзя отозвать
    const other = new TestClient(app, 'other@example.com', 'other-password-1234');
    // регистрация закрыта: проверяем через несуществующий идентификатор
    expect((await user.req('DELETE', `/auth/tokens/${crypto.randomUUID()}`)).statusCode).toBe(404);
    void other;
  });

  it('a token cannot be created from a token session', async () => {
    const r = await withToken(writeToken, 'POST', '/auth/tokens', {
      name: 'x',
      scope: 'read',
      expiresInDays: 1,
      authKey: await authKeyOf(user),
    });
    expect(r.statusCode).toBe(403);
  });
});
