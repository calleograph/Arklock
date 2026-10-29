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
  // один и тот же сертификат дважды — одна запись
  expect(r.certs).toHaveLength(1);
  expect(r.certs[0]).toMatchObject({ issuer: expect.any(String) });
  expect(r.certs[0].fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  expect(r.certs[0].daysLeft).toBeGreaterThan(300);
  expect(r.ok).toBe(true);
  const bad = (await admin.req('POST', '/admin/ldap/ca-info', { pem: 'not a certificate' })).json();
  expect(bad).toEqual({ ok: false, problem: 'not_certificate' });
  const broken = (
    await admin.req('POST', '/admin/ldap/ca-info', {
      pem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
    })
  ).json();
  expect(broken).toEqual({ ok: false, problem: 'not_certificate' });
});
