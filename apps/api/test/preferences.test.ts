import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let user: TestClient;

beforeAll(async () => {
  ({ app } = await createTestApp());
  user = new TestClient(app, 'prefs@example.com', 'prefs-password-12345');
  expect((await user.register()).statusCode).toBe(201);
  await user.login();
});
afterAll(async () => {
  await app.close();
});

describe('personal preferences', () => {
  it('the colour theme is stored in the profile and returned after sign-in', async () => {
    expect((await user.req('GET', '/auth/me')).json().user.theme ?? null).toBeNull();
    expect((await user.req('PUT', '/auth/preferences', { theme: 'forest' })).statusCode).toBe(204);
    expect((await user.req('GET', '/auth/me')).json().user.theme).toBe('forest');
    // другое устройство: новый вход возвращает выбранную тему
    const again = await user.loginRaw();
    expect(again.json().user.theme).toBe('forest');
  });

  it('unknown themes and anonymous requests are refused', async () => {
    expect((await user.req('PUT', '/auth/preferences', { theme: 'neon' })).statusCode).toBe(400);
    expect((await user.req('PUT', '/auth/preferences', {})).statusCode).toBe(400);
    const r = await app.inject({
      method: 'PUT',
      url: '/api/v1/auth/preferences',
      payload: { theme: 'dark' },
    });
    expect(r.statusCode).toBe(401);
  });
});
