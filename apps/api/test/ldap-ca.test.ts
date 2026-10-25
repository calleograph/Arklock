import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;

beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'ca-admin@example.com', 'ldap-ca-password-1234');
  await admin.register();
  await admin.login();
});
afterAll(async () => fixture.app.close());

it('reads a CA certificate file: issuer, validity, fingerprint; unreadable text is reported', async () => {
  const pem = (await admin.req('POST', '/admin/saml/sp-cert')).json().spCert as string;
  const r = (await admin.req('POST', '/admin/ldap/ca-info', { pem: `${pem}\n${pem}` })).json();
  expect(r.certs).toHaveLength(2);
  expect(r.certs[0]).toMatchObject({ ok: true, issuer: expect.any(String) });
  expect(r.certs[0].fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  expect(r.certs[0].daysLeft).toBeGreaterThan(300);
  expect(r.empty).toBe(false);
  const bad = (await admin.req('POST', '/admin/ldap/ca-info', { pem: 'not a certificate' })).json();
  expect(bad).toEqual({ certs: [], empty: true });
  const broken = (
    await admin.req('POST', '/admin/ldap/ca-info', {
      pem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
    })
  ).json();
  expect(broken.certs[0].ok).toBe(false);
});
