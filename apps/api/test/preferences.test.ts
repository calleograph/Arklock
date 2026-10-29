import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { settings, users } from '../src/db/schema.js';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof createTestApp>>['database']['db'];
let user: TestClient;

beforeAll(async () => {
  const fixture = await createTestApp();
  app = fixture.app;
  db = fixture.database.db;
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
    // без настройки администратора и без собственного выбора — «Современный и лёгкий»
    expect((await fresh.req('GET', '/auth/me')).json().user.theme).toBe('glass');
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
    expect((await user.req('PUT', '/auth/preferences', { theme: 'night' })).statusCode).toBe(204);
    expect((await user.req('GET', '/auth/me')).json().user.theme).toBe('night');
    // другое устройство: новый вход возвращает выбранную тему
    const again = await user.loginRaw();
    expect(again.json().user.theme).toBe('night');
  });

  it('unknown and retired themes and anonymous requests are refused', async () => {
    for (const theme of ['neon', 'corporate', 'light', 'dark', 'forest', 'emerald', 'sunset'])
      expect((await user.req('PUT', '/auth/preferences', { theme })).statusCode, theme).toBe(400);
    expect(
      (await user.req('PUT', '/admin/settings', { 'appearance.defaultTheme': 'sunset' }))
        .statusCode,
    ).toBe(400);
    expect((await user.req('PUT', '/auth/preferences', {})).statusCode).toBe(400);
    const r = await app.inject({
      method: 'PUT',
      url: '/api/v1/auth/preferences',
      payload: { theme: 'night' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('the update maps each earlier scheme to one of the four themes and never errors', async () => {
    const expected: Record<string, string> = {
      corporate: 'glass',
      sunset: 'glass',
      light: 'grove',
      emerald: 'grove',
      dark: 'night',
      forest: 'night',
    };
    const legacy = new TestClient(app, 'prefs4@example.com', 'prefs-password-13579');
    expect((await legacy.register()).statusCode).toBe(201);
    await legacy.login();
    const row = async (value: string) => {
      await db.update(users).set({ theme: value }).where(eq(users.email, 'prefs4@example.com'));
      await db
        .insert(settings)
        .values({ key: 'appearance.defaultTheme', value })
        .onConflictDoUpdate({ target: settings.key, set: { value } });
    };
    const migrate = async () => {
      const file = readFileSync(
        new URL('../drizzle/0029_four_themes.sql', import.meta.url),
        'utf8',
      );
      for (const statement of file.split('--> statement-breakpoint'))
        await db.execute(sql.raw(statement));
    };
    for (const [from, to] of Object.entries(expected)) {
      // миграция переносит и личный выбор, и тему организации по умолчанию
      await row(from);
      await migrate();
      expect((await legacy.req('GET', '/auth/me')).json().user.theme, from).toBe(to);
      const [stored] = await db
        .select()
        .from(settings)
        .where(eq(settings.key, 'appearance.defaultTheme'));
      expect(stored!.value, from).toBe(to);
      // даже если значение осталось в базе, сервер отдаёт одну из четырёх
      await db.update(users).set({ theme: from }).where(eq(users.email, 'prefs4@example.com'));
      expect((await legacy.req('GET', '/auth/me')).json().user.theme, `${from} без миграции`).toBe(
        to,
      );
    }
    // неизвестное значение сбрасывается: у сотрудника снова тема по умолчанию
    await row('neon');
    await migrate();
    const [after] = await db.select().from(users).where(eq(users.email, 'prefs4@example.com'));
    expect(after!.theme).toBeNull();
    expect((await legacy.req('GET', '/auth/me')).json().user.theme).toBe('glass');
  });
});
