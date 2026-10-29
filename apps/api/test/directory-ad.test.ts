import 'reflect-metadata';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settings } from '../src/db/schema.js';
import { cheapCaptcha, createTestApp, postSolving, TestClient } from './helpers.js';

// Тестовый каталог, отвечающий как Active Directory; все имена и пароли вымышленные
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ldap: any = require('ldapjs');

const BASE = 'DC=example,DC=com';
const SVC = 'CN=svc-ldap,OU=Service,DC=example,DC=com';
const SVC_PASSWORD = 'Svc-ldap-Synthetic-1';
const STAFF = 'CN=Staff,OU=Groups,DC=example,DC=com';
const TEAM = 'CN=Team A,OU=Groups,DC=example,DC=com';
const AD_52E =
  '80090308: LdapErr: DSID-0C090530, comment: AcceptSecurityContext error, data 52e, v4563';

interface Person {
  dn: string;
  sam: string;
  password: string;
  mail: string;
  name: string;
  /** Прямые группы (memberOf). */
  memberOf: string[];
  /** Группы с учётом вложенности (что вернёт правило IN_CHAIN). */
  nested: string[];
  disabled?: boolean;
}
const people: Person[] = [
  // Анна в группе «Team A», которая сама входит в «Staff»: доступ по «Staff» — через вложенность
  {
    dn: `CN=Anna Petrova,OU=Users,${BASE}`,
    sam: 'apetrova',
    password: 'Anna-Synthetic-1',
    mail: 'anna.petrova@example.com',
    name: 'Anna Petrova',
    memberOf: [TEAM],
    nested: [TEAM, STAFF],
  },
  {
    dn: `CN=Boris Ivanov,OU=Users,${BASE}`,
    sam: 'bivanov',
    password: 'Boris-Synthetic-1',
    mail: 'boris.ivanov@example.com',
    name: 'Boris Ivanov',
    memberOf: [],
    nested: [],
  },
  {
    dn: `CN=Old Account,OU=Users,${BASE}`,
    sam: 'oldacc',
    password: 'Old-Synthetic-1',
    mail: 'old.account@example.com',
    name: 'Old Account',
    memberOf: [STAFF],
    nested: [STAFF],
    disabled: true,
  },
];

let server: ReturnType<typeof ldap.createServer>;
let port = 0;
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
const inChainQueries: string[] = [];

function attrs(p: Person) {
  return {
    objectClass: ['top', 'person', 'organizationalPerson', 'user'],
    objectCategory: 'person',
    // ldapjs отдаёт атрибуты по запрошенным именам в нижнем регистре
    samaccountname: p.sam,
    userprincipalname: `${p.sam}@example.com`,
    mail: p.mail,
    cn: p.name,
    memberof: p.memberOf,
    useraccountcontrol: p.disabled ? '514' : '512',
  };
}

function startAd(): Promise<void> {
  server = ldap.createServer();
  const bindHandler =
    (accept: (dn: string, pw: string) => boolean) =>
    (
      req: { dn: { toString: () => string }; credentials: string },
      res: { end: () => void },
      next: (e?: unknown) => void,
    ) => {
      if (!accept(req.dn.toString().toLowerCase(), req.credentials))
        return next(new ldap.InvalidCredentialsError(AD_52E));
      res.end();
      return next();
    };
  server.bind(
    BASE,
    bindHandler((dn, pw) => {
      if (dn === SVC.toLowerCase()) return pw === SVC_PASSWORD;
      const p = people.find((x) => x.dn.toLowerCase() === dn);
      return !!p && p.password === pw;
    }),
  );
  server.search(
    '',
    (
      req: {
        dn: { toString: () => string };
        scope: string | number;
        filter: { toString: () => string };
      },
      res: { send: (e: object) => void; end: () => void },
      next: () => void,
    ) => {
      const base = req.dn.toString().toLowerCase();
      const f = req.filter.toString();
      // ldapjs 3 передаёт область числом: 0 — base
      const isBase = req.scope === 'base' || req.scope === 0;
      if (base === '' && isBase) {
        res.send({
          dn: '',
          attributes: {
            // имена — как запрошены: ldapjs отдаёт значения только при совпадении регистра
            defaultNamingContext: BASE,
            rootDomainNamingContext: BASE,
            dnsHostName: 'dc01.example.com',
            supportedCapabilities: ['1.2.840.113556.1.4.800'],
          },
        });
        res.end();
        return next();
      }
      if (isBase) {
        res.send({ dn: req.dn.toString(), attributes: { objectClass: 'top' } });
        res.end();
        return next();
      }
      // вложенные группы: (member:1.2.840.113556.1.4.1941:=<DN>)
      const chain = /member:1\.2\.840\.113556\.1\.4\.1941:=(.+?)\)\)?$/.exec(f);
      if (chain) {
        inChainQueries.push(f);
        const dn = chain[1]!.replace(/\\2c/gi, ',').replace(/\\20/g, ' ').toLowerCase();
        const p = people.find((x) => x.dn.toLowerCase() === dn);
        for (const g of p?.nested ?? []) res.send({ dn: g, attributes: { objectClass: 'group' } });
        res.end();
        return next();
      }
      const activeOnly = f.includes('userAccountControl:1.2.840.113556.1.4.803:=2');
      const value = /\((?:sAMAccountName|samaccountname)=([^)*]+)\)/i.exec(f)?.[1]?.toLowerCase();
      for (const p of people) {
        if (activeOnly && p.disabled) continue;
        if (value && ![p.sam, `${p.sam}@example.com`, p.mail].includes(value)) continue;
        res.send({ dn: p.dn, attributes: attrs(p) });
      }
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

/** Подключение так, как его заполняет форма: адрес, служебная запись, пароль; остальное — по умолчанию. */
const connection = (extra: object = {}) => ({
  name: 'Active Directory',
  enabled: false,
  directoryType: 'ad',
  url: `ldap://127.0.0.1:${port}`,
  allowPlaintext: true,
  bindDn: SVC,
  bindPassword: SVC_PASSWORD,
  baseDn: '',
  userFilter:
    '(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(|(sAMAccountName={u})(userPrincipalName={u})(mail={u})))',
  ...extra,
});

beforeAll(async () => {
  await startAd();
  fixture = await createTestApp();
  await cheapCaptcha(fixture.app, fixture.database);
  admin = new TestClient(fixture.app, 'ad-admin@example.com', 'ad-admin-password-1234');
  expect((await admin.register()).statusCode).toBe(201);
  await admin.login();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'closed' });
});
afterAll(async () => {
  await fixture.app.close();
  server.close();
});

const put = (body: object, id = 'ad') => admin.reqStep('PUT', `/admin/ldap/profiles/${id}`, body);
const loginTest = (username: string, password: string, id = 'ad') =>
  admin.req('POST', `/admin/ldap/login-test?profileId=${id}`, { username, password });

describe('step 1: connection', () => {
  it('the check finds the Base DN by itself (RootDSE)', async () => {
    const r = (await admin.reqStep('POST', '/admin/ldap/test?profileId=ad', connection())).json();
    expect(r.detected).toMatchObject({ baseDn: BASE, host: 'dc01.example.com', isAd: true });
    expect(r.stages.find((s: { stage: string }) => s.stage === 'bind')).toMatchObject({ ok: true });
    expect(r.ok).toBe(true);
  });

  it('a connection is saved without choosing who signs in while sign-in is off; the saved check records "connection verified"', async () => {
    expect((await put(connection({ baseDn: BASE }))).statusCode).toBe(200);
    const p0 = (await admin.req('GET', '/admin/ldap/profiles'))
      .json()
      .profiles.find((x: { id: string }) => x.id === 'ad');
    expect(p0.status).toEqual({});
    const r = (await admin.req('POST', '/admin/ldap/test?profileId=ad')).json();
    expect(r.ok).toBe(true);
    const p1 = (await admin.req('GET', '/admin/ldap/profiles'))
      .json()
      .profiles.find((x: { id: string }) => x.id === 'ad');
    expect(p1.status.connection).toMatchObject({ ok: true });
    // выключенный вход — не «каталог не настроен», а понятная причина
    const preview = await admin.req('POST', '/admin/ldap/sync/preview?profileId=ad');
    expect(preview.json().error.code).toBe('ldap_disabled');
    expect(
      (await admin.req('POST', '/admin/ldap/sync/preview?profileId=missing')).json().error.code,
    ).toBe('ldap_not_saved');
  });
});

describe('step 2: who may sign in and a real sign-in check', () => {
  it('turning sign-in on asks who may sign in; "groups" needs at least one group', async () => {
    const r = await put(connection({ baseDn: BASE, enabled: true }));
    expect(r.json().error.details).toEqual([{ path: 'access', code: 'access_required' }]);
    const g = await put(connection({ baseDn: BASE, enabled: true, access: 'groups' }));
    expect(g.json().error.details).toEqual([{ path: 'allowedGroups', code: 'groups_required' }]);
    expect(
      (
        await put(
          connection({ baseDn: BASE, enabled: true, access: 'groups', allowedGroups: [STAFF] }),
        )
      ).statusCode,
    ).toBe(200);
  });

  it('checks a real employee sign-in: nested group allowed, DOMAIN\\user accepted, precise reasons otherwise', async () => {
    const ok = (await loginTest('EXAMPLE\\apetrova', 'Anna-Synthetic-1')).json();
    expect(ok).toMatchObject({
      ok: true,
      reason: 'ok',
      account: 'new',
      user: { email: 'anna.petrova@example.com' },
    });
    expect(inChainQueries.length).toBeGreaterThan(0);
    expect(JSON.stringify(ok)).not.toContain('Anna-Synthetic-1');
    expect((await loginTest('bivanov', 'Boris-Synthetic-1')).json()).toMatchObject({
      ok: false,
      reason: 'not_allowed',
    });
    const wrong = (await loginTest('apetrova@example.com', 'Wrong-Synthetic-1')).json();
    expect(wrong).toMatchObject({ ok: false, reason: 'invalid_credentials' });
    expect(wrong.detail).toMatch(/0x31|52e/);
    expect((await loginTest('oldacc', 'Old-Synthetic-1')).json()).toMatchObject({
      ok: false,
      reason: 'user_not_found',
    });
    expect((await loginTest('nobody', 'x')).json()).toMatchObject({
      ok: false,
      reason: 'user_not_found',
    });
    const p = (await admin.req('GET', '/admin/ldap/profiles'))
      .json()
      .profiles.find((x: { id: string }) => x.id === 'ad');
    expect(p.status.login).toMatchObject({ ok: false, reason: 'user_not_found' });
    await loginTest('apetrova', 'Anna-Synthetic-1');
    const p2 = (await admin.req('GET', '/admin/ldap/profiles'))
      .json()
      .profiles.find((x: { id: string }) => x.id === 'ad');
    expect(p2.status.login).toMatchObject({ ok: true });
  });

  it('the employee signs in for real: allowed one gets the first-sign-in step, the others are refused', async () => {
    const anna = await postSolving(fixture.app, '/api/v1/auth/ldap/login', {
      username: 'apetrova',
      password: 'Anna-Synthetic-1',
      profileId: 'ad',
    });
    expect(anna.statusCode).toBe(200);
    expect(anna.json()).toMatchObject({ enroll: true, email: 'anna.petrova@example.com' });
    const boris = await postSolving(fixture.app, '/api/v1/auth/ldap/login', {
      username: 'bivanov',
      password: 'Boris-Synthetic-1',
      profileId: 'ad',
    });
    expect(boris.statusCode).toBe(403);
    expect(boris.json().error.code).toBe('ldap_not_allowed');
    // «все действующие» — Борис тоже проходит; изменение сбрасывает прежнюю отметку «вход проверен»
    expect(
      (
        await put(
          connection({ baseDn: BASE, enabled: true, access: 'all', bindPassword: undefined }),
        )
      ).statusCode,
    ).toBe(200);
    const p = (await admin.req('GET', '/admin/ldap/profiles'))
      .json()
      .profiles.find((x: { id: string }) => x.id === 'ad');
    expect(p.status).toEqual({});
    expect(
      (
        await postSolving(fixture.app, '/api/v1/auth/ldap/login', {
          username: 'bivanov',
          password: 'Boris-Synthetic-1',
          profileId: 'ad',
        })
      ).statusCode,
    ).toBe(200);
  });

  it('a connection that already worked before this version keeps its behaviour (everyone found by the filter)', async () => {
    const { eq } = await import('drizzle-orm');
    const [row] = await fixture.database.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'ldap.profiles'));
    const stored = row!.value as Record<string, unknown>[];
    const ad = stored.find((p) => p.id === 'ad')!;
    // так выглядело включённое подключение до 1.87.0: без «кто может входить» и без вида каталога
    const {
      access: _a,
      directoryType: _d,
      allowedGroups: _g,
      ...legacy
    } = { ...ad, id: 'legacy', name: 'Legacy' };
    void [_a, _d, _g];
    await fixture.database.db
      .update(settings)
      .set({ value: [...stored, legacy] })
      .where(eq(settings.key, 'ldap.profiles'));
    const listed = (await admin.req('GET', '/admin/ldap/profiles')).json().profiles;
    expect(listed.find((x: { id: string }) => x.id === 'legacy').access).toBe('all');
    // сохранение без выбора не требует его и не меняет поведение
    const { id: _i, bindPasswordCipher: _c, ...body } = legacy as Record<string, unknown>;
    void [_i, _c];
    // пароль шифруется для каждого подключения отдельно: у скопированной записи его нужно задать
    const r = await admin.req('PUT', '/admin/ldap/profiles/legacy', {
      ...body,
      bindPassword: SVC_PASSWORD,
    });
    expect(r.statusCode).toBe(200);
    expect(
      (
        await postSolving(fixture.app, '/api/v1/auth/ldap/login', {
          username: 'bivanov',
          password: 'Boris-Synthetic-1',
          profileId: 'legacy',
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('advanced: browsing shows active people by default, in pages', () => {
  it('disabled and non-person objects are hidden unless asked for; results are bounded', async () => {
    const active = (
      await admin.req('POST', '/admin/ldap/browse?profileId=ad', { kind: 'users', limit: 1 })
    ).json();
    expect(active, JSON.stringify(active)).toMatchObject({ ok: true });
    expect(active.entries).toHaveLength(1);
    expect(active.truncated).toBe(true);
    const next = (
      await admin.req('POST', '/admin/ldap/browse?profileId=ad', {
        kind: 'users',
        limit: 1,
        offset: 1,
      })
    ).json();
    expect(next.entries[0].dn).not.toBe(active.entries[0].dn);
    const all = (
      await admin.req('POST', '/admin/ldap/browse?profileId=ad', {
        kind: 'users',
        limit: 50,
        activeOnly: false,
      })
    ).json();
    expect(all.entries.some((e: { disabled: boolean }) => e.disabled)).toBe(true);
  });
});

describe('trusting the domain controller certificate', () => {
  /** Самоподписанный сертификат контроллера на внутреннее имя: подключение по 127.0.0.1 имени не совпадает. */
  async function selfSigned() {
    const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
    const keys = (await webcrypto.subtle.generateKey(alg, true, [
      'sign',
      'verify',
    ])) as unknown as CryptoKeyPair;
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: '4c',
      name: 'CN=dc01',
      notBefore: new Date(Date.now() - 86_400_000),
      notAfter: new Date(Date.now() + 365 * 86_400_000),
      signingAlgorithm: alg,
      keys,
      extensions: [new x509.BasicConstraintsExtension(false)],
    });
    const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
    const label = ['PRIVATE', 'KEY'].join(' ');
    return {
      cert: cert.toString('pem'),
      key: `-----BEGIN ${label}-----\n${der.toString('base64')}\n-----END ${label}-----\n`,
    };
  }

  it('the check shows the presented certificate; trusting it by fingerprint makes LDAPS pass; another fingerprint does not', async () => {
    const own = await selfSigned();
    const tlsServer = ldap.createServer({ certificate: own.cert, key: own.key });
    tlsServer.bind(
      SVC,
      (req: { credentials: string }, res: { end: () => void }, next: (e?: unknown) => void) => {
        if (req.credentials !== SVC_PASSWORD) return next(new ldap.InvalidCredentialsError(AD_52E));
        res.end();
        return next();
      },
    );
    tlsServer.search(
      '',
      (_req: unknown, res: { send: (e: object) => void; end: () => void }, next: () => void) => {
        res.send({ dn: BASE, attributes: { objectClass: 'domain', defaultNamingContext: BASE } });
        res.end();
        return next();
      },
    );
    const tlsPort: number = await new Promise((r) =>
      tlsServer.listen(0, '127.0.0.1', () => r(tlsServer.address().port)),
    );
    try {
      const draft = connection({
        url: `ldaps://127.0.0.1:${tlsPort}`,
        allowPlaintext: false,
        bindDn: SVC,
        baseDn: BASE,
      });
      const first = (await admin.req('POST', '/admin/ldap/test?profileId=tls', draft)).json();
      const tlsStage = first.stages.at(-1);
      expect(tlsStage).toMatchObject({ stage: 'tls', ok: false });
      expect(tlsStage.params.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
      expect(tlsStage.params.pem).toContain('BEGIN CERTIFICATE');
      const pinned = {
        ...draft,
        pinnedPem: tlsStage.params.pem,
        pinnedFingerprint: tlsStage.params.fingerprint256,
      };
      const second = (await admin.req('POST', '/admin/ldap/test?profileId=tls', pinned)).json();
      expect(second.stages.find((s: { stage: string }) => s.stage === 'tls')).toMatchObject({
        ok: true,
        code: 'pinned',
      });
      expect(second.stages.find((s: { stage: string }) => s.stage === 'bind')).toMatchObject({
        ok: true,
      });
      // отпечаток не от этого сертификата — сохранение отклоняется
      const bad = await admin.req('PUT', '/admin/ldap/profiles/tls', {
        ...pinned,
        pinnedFingerprint: Array(32).fill('AB').join(':'),
      });
      expect(bad.json().error.details).toEqual([{ path: 'pinnedPem', code: 'pin_mismatch' }]);
      expect((await admin.req('PUT', '/admin/ldap/profiles/tls', pinned)).statusCode).toBe(200);
      expect((await admin.req('POST', '/admin/ldap/test?profileId=tls')).json().ok).toBe(true);
    } finally {
      tlsServer.close();
    }
  });
});
