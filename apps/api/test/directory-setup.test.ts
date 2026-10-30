import 'reflect-metadata';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindAccount, domainFromBaseDn, normalizeLdapUrl } from '@arklock/contracts';
import { classifyLdapError } from '../src/auth/ldap.js';
import { CertError, parseCertificates } from '../src/net/certs.js';
import { createTestApp, TestClient } from './helpers.js';
import { makeChain } from './pki.js';

const day = 86_400_000;

// ldapjs используется только как тестовый каталог; данные вымышленные
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ldap: any = require('ldapjs');

const BASE = 'dc=example,dc=com';
const SVC = 'cn=svc-ldap,ou=service,dc=example,dc=com';
const SVC_PASSWORD = 'Svc-ldap-Synthetic-1';
/** Так Active Directory отвечает на неверный пароль служебной записи. */
const AD_52E =
  '80090308: LdapErr: DSID-0C090530, comment: AcceptSecurityContext error, data 52e, v4563';

let chain: Awaited<ReturnType<typeof makeChain>>;
let other: Awaited<ReturnType<typeof makeChain>>;

// ---------------------------------------------------------------- тестовый каталог (LDAPS)

let server: ReturnType<typeof ldap.createServer>;
let port = 0;
const svcPassword = SVC_PASSWORD;
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;

function startLdaps(): Promise<void> {
  server = ldap.createServer({ certificate: chain.leaf + chain.mid, key: chain.keyPem });
  server.bind(
    SVC,
    (req: { credentials: string }, res: { end: () => void }, next: (e?: unknown) => void) => {
      if (req.credentials !== svcPassword) return next(new ldap.InvalidCredentialsError(AD_52E));
      res.end();
      return next();
    },
  );
  server.search(
    BASE,
    (
      req: { scope: string },
      res: { send: (e: object) => void; end: () => void },
      next: () => void,
    ) => {
      if (req.scope === 'base') res.send({ dn: BASE, attributes: { objectClass: 'domain' } });
      else
        res.send({
          dn: `cn=Alex Doe,ou=people,${BASE}`,
          attributes: {
            objectClass: 'person',
            sAMAccountName: 'adoe',
            mail: 'alex.doe@example.com',
            cn: 'Alex Doe',
          },
        });
      res.end();
      return next();
    },
  );
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    }),
  );
}

const profile = (extra: object = {}) => ({
  enabled: true,
  access: 'all',
  name: 'Каталог',
  url: `ldaps://127.0.0.1:${port}`,
  caPem: chain.root,
  bindDn: SVC,
  bindPassword: svcPassword,
  baseDn: BASE,
  ...extra,
});

beforeAll(async () => {
  [chain, other] = await Promise.all([makeChain(), makeChain()]);
  await startLdaps();
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'dir-admin@example.com', 'dir-admin-password-1234');
  await admin.register();
  await admin.login();
});
afterAll(async () => {
  await fixture.app.close();
  server.close();
});

// ---------------------------------------------------------------- правила, общие для формы и сервера

describe('directory address', () => {
  it('accepts ldap and ldaps with names, IPv4, IPv6 and ports; one trailing slash is removed', () => {
    const ok = (u: string) => {
      const r = normalizeLdapUrl(u);
      if (!r.ok) throw new Error(`${u}: ${r.problem}`);
      return r.value;
    };
    expect(ok('ldaps://dc01.example.com:636/').url).toBe('ldaps://dc01.example.com:636');
    expect(ok('  LDAPS://DC01.Example.com  ')).toMatchObject({
      url: 'ldaps://dc01.example.com',
      port: 636,
      secure: true,
    });
    expect(ok('ldap://192.0.2.5')).toMatchObject({ port: 389, secure: false });
    expect(ok('ldaps://[2001:db8::5]:3269').port).toBe(3269);
    expect(
      normalizeLdapUrl('ldaps://dc01.example.com:636/').ok &&
        normalizeLdapUrl('ldaps://dc01.example.com:636/'),
    ).toMatchObject({ changed: true });
  });

  it('names the exact problem for wrong addresses', () => {
    const problem = (u: string) => {
      const r = normalizeLdapUrl(u);
      return r.ok ? 'ok' : r.problem;
    };
    expect(problem('')).toBe('empty');
    expect(problem('dc01.example.com:636')).toBe('scheme');
    expect(problem('https://dc01.example.com')).toBe('scheme');
    expect(problem('ldaps://dc01 .example.com')).toBe('spaces');
    expect(problem('ldaps://dc01.example.com:70000')).toBe('port');
    expect(problem('ldaps://dc01.example.com:abc')).toBe('port');
    expect(problem('ldaps://dc01.example.com/dc=example,dc=com')).toBe('path');
    expect(problem('ldaps://dc01.example.com//')).toBe('path');
    expect(problem('ldaps://svc:pw@dc01.example.com')).toBe('credentials');
    expect(problem('ldaps://dc_01.example.com')).toBe('host');
    expect(problem('ldaps://:636')).toBe('host');
  });
});

describe('service account formats', () => {
  it('DN, user@domain and DOMAIN\\user are used as given; a short name gets the domain from Base DN', () => {
    expect(bindAccount('CN=svc-ldap,OU=Service,DC=example,DC=com', '')).toMatchObject({
      ok: true,
      kind: 'dn',
    });
    expect(bindAccount('svc-ldap@example.com', '')).toMatchObject({
      ok: true,
      kind: 'upn',
      value: 'svc-ldap@example.com',
    });
    expect(bindAccount('EXAMPLE\\svc-ldap', '')).toMatchObject({ ok: true, kind: 'netbios' });
    expect(bindAccount('svc-ldap', 'OU=Staff,DC=corp,DC=example,DC=com')).toEqual({
      ok: true,
      kind: 'short',
      value: 'svc-ldap@corp.example.com',
      derived: true,
    });
    expect(bindAccount('svc-ldap', 'O=Example')).toEqual({ ok: false, problem: 'short_no_domain' });
    expect(bindAccount('svc ldap', BASE)).toEqual({ ok: false, problem: 'format' });
    expect(bindAccount('', BASE)).toMatchObject({ ok: true, kind: 'none' });
    expect(domainFromBaseDn('dc=Example, DC=com')).toBe('example.com');
  });

  it('Active Directory bind codes become precise reasons; the server text stays in details', () => {
    const reason = (data: string) =>
      classifyLdapError(Object.assign(new Error(AD_52E.replace('52e', data)), { code: 49 }), 'bind')
        .reason;
    expect(reason('52e')).toBe('invalid_credentials');
    expect(reason('525')).toBe('account_not_found');
    expect(reason('775')).toBe('account_locked');
    expect(reason('533')).toBe('account_disabled');
    expect(reason('532')).toBe('password_expired');
    expect(reason('773')).toBe('password_must_change');
    expect(reason('701')).toBe('account_expired');
    expect(
      classifyLdapError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 'bind'),
    ).toMatchObject({
      code: 'connect',
      reason: 'refused',
    });
    expect(
      classifyLdapError(
        Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
        'bind',
      ).reason,
    ).toBe('cert_name');
    expect(
      classifyLdapError(Object.assign(new Error(AD_52E), { code: 49 }), 'bind').detail,
    ).toContain('data 52e');
  });
});

describe('certificate upload', () => {
  it('reads PEM, DER (.cer) and headerless base64 by content; shows kind, validity and the chain', () => {
    const bundle = parseCertificates(Buffer.from(chain.leaf + chain.mid + chain.root));
    expect(bundle.certs.map((c) => c.kind)).toEqual(['leaf', 'intermediate', 'root']);
    expect(bundle.certs.every((c) => c.chainToRoot)).toBe(true);
    expect(bundle.certs[0]!.issuedBy).toBe(bundle.certs[1]!.fingerprint256);
    expect(bundle.certs[2]).toMatchObject({ selfSigned: true, isCa: true, expired: false });
    expect(bundle.pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(3);

    const der = parseCertificates(chain.der(chain.root));
    expect(der.certs).toHaveLength(1);
    expect(der.certs[0]).toMatchObject({
      kind: 'root',
      subject: expect.stringContaining('Example Root CA'),
    });
    expect(der.pem).toContain('-----BEGIN CERTIFICATE-----');
    const bare = parseCertificates(Buffer.from(chain.der(chain.root).toString('base64')));
    expect(bare.certs[0]!.fingerprint256).toBe(der.certs[0]!.fingerprint256);

    // промежуточный без корневого: цепочка неполная, это видно
    const midOnly = parseCertificates(Buffer.from(chain.mid));
    expect(midOnly.certs[0]).toMatchObject({
      kind: 'intermediate',
      chainToRoot: false,
      issuedBy: null,
    });
  });

  it('refuses private keys, PKCS#12, other files, expired-only sets and a server certificate where a CA is required', () => {
    const problem = (data: Buffer, requireCa = false) => {
      try {
        parseCertificates(data, { requireCa });
        return 'ok';
      } catch (e) {
        return (e as CertError).problem;
      }
    };
    expect(problem(Buffer.from(chain.leaf + chain.keyPem))).toBe('private_key');
    // PKCS#12: SEQUENCE { INTEGER 3, … }
    expect(problem(Buffer.from([0x30, 0x82, 0x01, 0x00, 0x02, 0x01, 0x03, 0x30, 0x00]))).toBe(
      'private_key',
    );
    expect(problem(Buffer.from('just text, not a certificate'))).toBe('not_certificate');
    expect(problem(Buffer.from(''))).toBe('empty');
    expect(problem(Buffer.from(chain.leaf), true)).toBe('not_ca');
    expect(problem(Buffer.from(chain.root), true)).toBe('ok');
    expect(problem(Buffer.from(chain.root), false)).toBe('ok');
    expect(
      (() => {
        try {
          parseCertificates(Buffer.from(chain.root), { now: Date.now() + 4000 * day });
          return 'ok';
        } catch (e) {
          return (e as CertError).problem;
        }
      })(),
    ).toBe('all_expired');
  });

  it('the upload endpoint takes a .cer file as base64 and answers with details and normalised PEM', async () => {
    const r = (
      await admin.req('POST', '/admin/ldap/ca-info', {
        data: chain.der(chain.root).toString('base64'),
      })
    ).json();
    expect(r.ok).toBe(true);
    expect(r.certs[0]).toMatchObject({
      kind: 'root',
      fingerprint256: expect.stringMatching(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/),
    });
    expect(r.pem).toContain('BEGIN CERTIFICATE');
    const bad = (
      await admin.req('POST', '/admin/ldap/ca-info', {
        data: Buffer.from(chain.keyPem).toString('base64'),
      })
    ).json();
    expect(bad).toEqual({ ok: false, problem: 'private_key' });
  });
});

// ---------------------------------------------------------------- сохранение и проверка подключения

describe('saving a directory connection', () => {
  it('lists every wrong field at once with its reason', async () => {
    const r = await admin.req('PUT', '/admin/ldap/profiles/default', {
      ...profile(),
      url: 'ldaps://dc01.example.com/dc=example,dc=com',
      bindDn: 'svc ldap',
      baseDn: '',
      userFilter: '(uid=fixed)',
      caPem: 'not a certificate',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toEqual(
      expect.arrayContaining([
        { path: 'url', code: 'url_path' },
        { path: 'bindDn', code: 'bind_format' },
        { path: 'baseDn', code: 'required' },
        { path: 'userFilter', code: 'filter_placeholder' },
        { path: 'caPem', code: 'cert_not_certificate' },
      ]),
    );
    const starttls = await admin.req('PUT', '/admin/ldap/profiles/default', {
      ...profile(),
      startTls: true,
    });
    expect(starttls.json().error.details).toEqual([
      { path: 'startTls', code: 'starttls_with_ldaps' },
    ]);
  });

  it('stores the normalised address and a DER certificate as PEM; reopening returns the same values', async () => {
    const r = await admin.req('PUT', '/admin/ldap/profiles/default', {
      ...profile(),
      url: ` LDAPS://127.0.0.1:${port}/ `,
      caPem: chain.root,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().url).toBe(`ldaps://127.0.0.1:${port}`);
    const p = (await admin.req('GET', '/admin/ldap/profiles')).json().profiles[0];
    expect(p).toMatchObject({
      url: `ldaps://127.0.0.1:${port}`,
      hasBindPassword: true,
      bindDn: SVC,
      baseDn: BASE,
    });
    expect(p.caPem).toContain('BEGIN CERTIFICATE');
    expect(JSON.stringify(p)).not.toContain(SVC_PASSWORD);
  });

  it('a saved service password is kept when other fields change, and is never sent to a different server', async () => {
    const keep = await admin.req('PUT', '/admin/ldap/profiles/default', {
      ...profile(),
      bindPassword: undefined,
      name: 'Каталог (основной)',
      userFilter: '(&(objectClass=person)(sAMAccountName={u}))',
    });
    expect(keep.statusCode).toBe(200);
    expect((await admin.req('POST', '/admin/ldap/test')).json().ok).toBe(true);
    const moved = await admin.req('PUT', '/admin/ldap/profiles/default', {
      ...profile(),
      bindPassword: undefined,
      url: 'ldaps://dc02.example.com',
    });
    expect(moved.json().error.details).toEqual([
      { path: 'bindPassword', code: 'password_reentry' },
    ]);
    // проверка черновика тоже не отдаёт сохранённый пароль другому серверу
    const draft = await admin.req('POST', '/admin/ldap/test', {
      ...profile(),
      bindPassword: undefined,
      url: 'ldaps://dc02.example.com',
    });
    expect(draft.json().error.details).toEqual([
      { path: 'bindPassword', code: 'password_reentry' },
    ]);
  });

  it('disabling certificate checks needs the chief administrator and an explicit confirmation, and is recorded', async () => {
    const plain = await admin.req('PUT', '/admin/ldap/profiles/default', {
      ...profile(),
      insecureTls: true,
    });
    expect(plain.json().error.details).toEqual([
      { path: 'confirmInsecure', code: 'insecure_confirm' },
    ]);
    expect(
      (
        await admin.req('PUT', '/admin/ldap/profiles/default', {
          ...profile(),
          insecureTls: true,
          confirmInsecure: true,
        })
      ).statusCode,
    ).toBe(200);
    const ledger = (await admin.req('GET', '/admin/ledger?q=admin.ldap.insecure')).json();
    expect(JSON.stringify(ledger)).toContain('admin.ldap.insecure');
    expect((await admin.req('PUT', '/admin/ldap/profiles/default', profile())).statusCode).toBe(
      200,
    );
  });
});

describe('step-by-step connection check over LDAPS', () => {
  const stages = async (body?: object) => {
    const r = await admin.req('POST', '/admin/ldap/test', body);
    return r.json() as {
      ok: boolean;
      stages: {
        stage: string;
        ok: boolean;
        code: string;
        skipped?: boolean;
        detail?: string;
        params?: Record<string, unknown>;
      }[];
    };
  };

  it('a working connection passes every stage; the unsaved form can be checked before saving', async () => {
    const r = await stages(profile());
    expect(r.ok).toBe(true);
    expect(r.stages.map((s) => s.stage)).toEqual([
      'config',
      'dns',
      'tcp',
      'tls',
      'bind',
      'base',
      'filter',
      'users',
      'groups',
    ]);
    const tls = r.stages.find((s) => s.stage === 'tls')!;
    expect(tls.params).toMatchObject({ subject: 'localhost', issuer: 'Example Issuing CA' });
    expect(JSON.stringify(r)).not.toContain(SVC_PASSWORD);
  });

  it('a wrong service password stops at sign-in with the Active Directory reason and the server text in details', async () => {
    const r = await stages(profile({ bindPassword: 'Wrong-Synthetic-1' }));
    expect(r.ok).toBe(false);
    expect(r.stages.at(-1)).toMatchObject({
      stage: 'bind',
      ok: false,
      code: 'invalid_credentials',
    });
    // текст ответа сервера (у Active Directory — «… data 52e …») остаётся в подробностях
    expect(r.stages.at(-1)!.detail).toMatch(/0x31/);
    expect(JSON.stringify(r)).not.toContain('Wrong-Synthetic-1');
  });

  it('an untrusted certificate, a name mismatch and an unreachable port stop at the right stage', async () => {
    const untrusted = await stages(profile({ caPem: other.root }));
    expect(untrusted.stages.at(-1)).toMatchObject({
      stage: 'tls',
      ok: false,
      code: 'cert_untrusted',
    });
    const named = await stages(profile({ url: `ldaps://localhost:${port}` }));
    expect(named.ok).toBe(true);
    // сертификат выпущен для localhost и 127.0.0.1: другое имя не совпадает
    const mismatch = await stages(profile({ url: `ldaps://127.0.0.2:${port}` }));
    expect(mismatch.stages.at(-1)!.stage).toMatch(/tls|tcp/);
    const closed = await stages(profile({ url: 'ldaps://127.0.0.1:1' }));
    expect(closed.stages.at(-1)).toMatchObject({ stage: 'tcp', ok: false, code: 'refused' });
    const dnsFail = await stages(profile({ url: 'ldaps://no-such-host.invalid' }));
    expect(dnsFail.stages.at(-1)).toMatchObject({ stage: 'dns', ok: false });
  });
});
