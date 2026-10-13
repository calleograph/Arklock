import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { sessions, settings } from '../src/db/schema.js';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let admin: TestClient;
let bob: TestClient;

beforeAll(async () => {
  ({ app, database } = await createTestApp());
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  expect((await admin.register()).statusCode).toBe(201);
  await admin.login();
  await database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  bob = new TestClient(app, 'bob@example.com', 'bob-password-12345');
  expect((await bob.register()).statusCode).toBe(201);
  await bob.login();
});

afterAll(async () => {
  await app.close();
});

const setSetting = async (key: string, value: number) =>
  expect((await admin.req('PUT', '/admin/settings', { [key]: value })).statusCode).toBeLessThan(
    300,
  );

/** Сдвигает время последней активности и время входа сеансов пользователя в прошлое. */
async function age(userId: string, lastSeenHours: number, createdHours = lastSeenHours) {
  const now = Date.now();
  await database.db
    .update(sessions)
    .set({
      lastSeenAt: new Date(now - lastSeenHours * 3_600_000),
      createdAt: new Date(now - createdHours * 3_600_000),
    })
    .where(eq(sessions.userId, userId));
}

describe('session lifetime is enforced from the administrator settings', () => {
  it('inactivity beyond the configured idle time ends the session', async () => {
    expect((await bob.req('GET', '/auth/me')).statusCode).toBe(200);
    await setSetting('session.idleHours', 0.25);
    await age(bob.userId, 0.5);
    expect((await bob.req('GET', '/auth/me')).statusCode).toBe(401);
    // после сброса настройки прежний срок возвращается
    await setSetting('session.idleHours', 12);
    await bob.login();
    expect((await bob.req('GET', '/auth/me')).statusCode).toBe(200);
  });

  it('the maximum session length ends the session even when it is active', async () => {
    await setSetting('session.maxHours', 1);
    await bob.login();
    await age(bob.userId, 0, 2);
    expect((await bob.req('GET', '/auth/me')).statusCode).toBe(401);
    // администратор, вошедший недавно, не затронут
    expect((await admin.req('GET', '/auth/me')).statusCode).toBe(200);
    await setSetting('session.maxHours', 0);
    await bob.login();
    await age(bob.userId, 0, 50);
    expect((await bob.req('GET', '/auth/me')).statusCode).toBe(200);
  });
});
