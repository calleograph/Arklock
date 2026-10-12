import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { settings } from '../src/db/schema.js';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let admin: TestClient;
let member: TestClient;

beforeAll(async () => {
  const t = await createTestApp();
  app = t.app;
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  expect((await admin.register()).statusCode).toBe(201);
  await t.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  member = new TestClient(app, 'member@example.com', 'member-password-1234');
  expect((await member.register()).statusCode).toBe(201);
  await admin.login();
  await member.login();
});

afterAll(async () => {
  await app.close();
});

describe('organisation password policy settings', () => {
  it('default to no requirements and are visible to every signed-in user', async () => {
    const p = (await member.req('GET', '/auth/policy')).json();
    expect(p['policy.password.minLength']).toBe(0);
    expect(p['policy.password.classes']).toBe(0);
  });

  it('only administrators change them; the values are validated', async () => {
    expect(
      (await member.req('PUT', '/admin/settings', { 'policy.password.minLength': 16 })).statusCode,
    ).toBe(403);
    expect(
      (
        await admin.req('PUT', '/admin/settings', {
          'policy.password.minLength': 16,
          'policy.password.classes': 3,
        })
      ).statusCode,
    ).toBe(200);
    const p = (await member.req('GET', '/auth/policy')).json();
    expect(p['policy.password.minLength']).toBe(16);
    expect(p['policy.password.classes']).toBe(3);
    for (const bad of [
      { 'policy.password.minLength': -1 },
      { 'policy.password.minLength': 500 },
      { 'policy.password.classes': 5 },
      { 'policy.password.classes': 'many' },
    ]) {
      expect((await admin.req('PUT', '/admin/settings', bad)).statusCode, JSON.stringify(bad)).toBe(
        400,
      );
    }
  });
});
