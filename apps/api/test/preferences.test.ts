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

const NEW_THEMES = ['glass', 'night', 'grove', 'aurora'];

describe('personal preferences', () => {
  it('the four glass themes are accepted and stored per user', async () => {
    expect(
      (await user.req('PUT', '/admin/settings', { 'registration.mode': 'open' })).statusCode,
    ).toBe(200);
    const other = new TestClient(app, 'prefs2@example.com', 'prefs-password-67890');
    expect((await other.register()).statusCode).toBe(201);
    await other.login();
    for (const id of NEW_THEMES) {
      expect((await user.req('PUT', '/auth/preferences', { theme: id })).statusCode).toBe(204);
      expect((await user.req('GET', '/auth/me')).json().user.theme).toBe(id);
    }
    // выбор одного сотрудника не затрагивает другого
    expect((await user.req('PUT', '/auth/preferences', { theme: 'night' })).statusCode).toBe(204);
    expect((await other.req('PUT', '/auth/preferences', { theme: 'aurora' })).statusCode).toBe(204);
    expect((await user.req('GET', '/auth/me')).json().user.theme).toBe('night');
    expect((await other.req('GET', '/auth/me')).json().user.theme).toBe('aurora');
  });

  it('the administrator default applies only until the user picks a theme', async () => {
    const fresh = new TestClient(app, 'prefs3@example.com', 'prefs-password-24680');
    expect((await fresh.register()).statusCode).toBe(201);
    await fresh.login();
    // без настройки администратора и без собственного выбора — прежняя корпоративная тема
    expect((await fresh.req('GET', '/auth/me')).json().user.theme).toBe('corporate');
    expect(
      (await user.req('PUT', '/admin/settings', { 'appearance.defaultTheme': 'grove' })).statusCode,
    ).toBe(200);
    expect((await fresh.req('GET', '/auth/me')).json().user.theme).toBe('grove');
    // выбор сотрудника сильнее настройки администратора
    expect((await fresh.req('PUT', '/auth/preferences', { theme: 'glass' })).statusCode).toBe(204);
    await user.req('PUT', '/admin/settings', { 'appearance.defaultTheme': 'aurora' });
    expect((await fresh.req('GET', '/auth/me')).json().user.theme).toBe('glass');
    expect(
      (await user.req('PUT', '/admin/settings', { 'appearance.defaultTheme': 'neon' })).statusCode,
    ).toBe(400);
  });

  it('the colour theme is stored in the profile and returned after sign-in', async () => {
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
