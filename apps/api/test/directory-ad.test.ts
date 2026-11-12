import 'reflect-metadata';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { settings, users } from '../src/db/schema.js';
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
  /** objectGUID так, как его отдаёт AD: 16 байт, первые три группы в обратном порядке (байты < 0x80: тестовый каталог читает значение фильтра как текст). */
  guid: Buffer;
}
const people: Person[] = [
  // Анна в группе «Team A», которая сама входит в «Staff»: доступ по «Staff» — через вложенность
  {
    dn: `CN=Anna Petrova,OU=Users,${BASE}`,
    sam: 'apetrova',
    password: 'Anna-Synthetic-1',
    mail: 'anna.petrova@example.com',
    name: 'Anna Petrova',
    guid: Buffer.from('33221100554477660811223344556677', 'hex'),
    memberOf: [TEAM],
    nested: [TEAM, STAFF],
  },
  {
    dn: `CN=Boris Ivanov,OU=Users,${BASE}`,
    sam: 'bivanov',
    password: 'Boris-Synthetic-1',
    mail: 'boris.ivanov@example.com',
    name: 'Boris Ivanov',
    guid: Buffer.from('44332211556677780011223344556677', 'hex'),
    memberOf: [],
    nested: [],
  },
  {
    dn: `CN=Clara Sidorova,OU=Users,${BASE}`,
    sam: 'csidorova',
    password: 'Clara-Synthetic-1',
    mail: 'clara.sidorova@example.com',
    name: 'Clara Sidorova',
    guid: Buffer.from('66554433227766550102030405060708', 'hex'),
    memberOf: [],
    nested: [],
  },
  {
    dn: `CN=Old Account,OU=Users,${BASE}`,
    sam: 'oldacc',
    password: 'Old-Synthetic-1',
    mail: 'old.account@example.com',
    name: 'Old Account',
    guid: Buffer.from('55443322667777080102030405060708', 'hex'),
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
/** Для проверки отказов: служебная запись не может читать поиск (как при нехватке прав у OU). */
let denySearch: 'insufficient' | 'base' | null = null;
/** Как настоящий AD при поиске от корня домена: вместе с записями приходят ссылки на другие разделы каталога. */
let withReferrals = false;

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
    objectguid: p.guid,
    title: 'Engineer',
    department: 'Support',
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
      res: {
        send: (e: object) => void;
        end: (code?: number) => void;
        createSearchReference: (uris: string[]) => object;
      },
      next: () => void,
    ) => {
      const base = req.dn.toString().toLowerCase();
      const f = req.filter.toString();
      // ldapjs 3 передаёт область числом: 0 — base
      const isBase = req.scope === 'base' || req.scope === 0;
      // как настоящий каталог: результат insufficientAccessRights (50), а не внутренняя ошибка сервера
      if (denySearch === 'insufficient' && !isBase) {
        res.end(50);
        return next();
      }
      if (denySearch === 'base' && isBase && base !== '') {
        res.end(32);
        return next();
      }
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
      // чтение записи человека по DN (выбор в поле поиска)
      const byDn = people.find((x) => x.dn.toLowerCase() === base);
      if (isBase && byDn) {
        res.send({ dn: byDn.dn, attributes: attrs(byDn) });
        res.end();
        return next();
      }
      // записи с таким DN нет: настоящий каталог отвечает noSuchObject (32)
      if (isBase && /^cn=/i.test(base)) {
        res.end(32);
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
      if (withReferrals)
        res.send(res.createSearchReference([`ldap://example.com/DC=DomainDnsZones,${BASE}`]));
      // поиск по идентификатору объекта: ldapjs отдаёт байты значения текстом, управляющие — как \HH
      const byGuid = /objectGUID=(.*)\)$/i.exec(f)?.[1];
      if (byGuid !== undefined) {
        const bytes: number[] = [];
        for (let i = 0; i < byGuid.length; i++) {
          const esc = /^\\([0-9a-f]{2})/i.exec(byGuid.slice(i, i + 3));
          if (esc) {
            bytes.push(parseInt(esc[1]!, 16));
            i += 2;
          } else bytes.push(byGuid.charCodeAt(i));
        }
        const hex = Buffer.from(bytes).toString('hex');
        for (const p of people)
          if (p.guid.toString('hex') === hex) res.send({ dn: p.dn, attributes: attrs(p) });
        res.end();
        return next();
      }
      // участники группы с учётом вложенности (правило IN_CHAIN со стороны пользователя)
      const ofGroup = /memberOf:1\.2\.840\.113556\.1\.4\.1941:=(.+?)\)\)?$/i.exec(f)?.[1];
      if (ofGroup) {
        const gdn = ofGroup.replace(/\\2c/gi, ',').replace(/\\20/g, ' ').toLowerCase();
        for (const p of people)
          if (!p.disabled && p.nested.some((g) => g.toLowerCase() === gdn))
            res.send({ dn: p.dn, attributes: attrs(p) });
        res.end();
        return next();
      }
      // поиск групп по словам в имени
      if (f.includes('objectClass=group')) {
        const gw = [...f.matchAll(/\(cn=\*([^*)]+)\*\)/gi)].map((m) => m[1]!.toLowerCase());
        for (const g of [STAFF, TEAM]) {
          const gn = /^CN=([^,]+)/i.exec(g)![1]!;
          if (gw.every((w) => gn.toLowerCase().includes(w)))
            res.send({ dn: g, attributes: { objectClass: 'group', cn: gn } });
        }
        res.end();
        return next();
      }
      const activeOnly = f.includes('userAccountControl:1.2.840.113556.1.4.803:=2');
      const value = /\((?:sAMAccountName|samaccountname)=([^)*]+)\)/i.exec(f)?.[1]?.toLowerCase();
      // поиск по словам: каждое слово — отдельная группа (cn=*слово*)
      const words = [...f.matchAll(/\(cn=\*([^*)]+)\*\)/gi)].map((m) => m[1]!.toLowerCase());
      for (const p of people) {
        if (activeOnly && p.disabled) continue;
        if (
          words.length &&
          !words.every((w) => [p.name, p.sam, p.mail].some((x) => x.toLowerCase().includes(w)))
        )
          continue;
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
  confirmInsecure: true,
  bindDn: SVC,
  bindPassword: SVC_PASSWORD,
  baseDn: '',
  userFilter:
    '(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(|(sAMAccountName={u})(userPrincipalName={u})(mail={u})))',
  ...extra,
});

beforeAll(async () => {
  await startAd();
  fixture = await createTestApp({ LDAP_LOGIN_TESTS_PER_10MIN: '500' });
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

describe('every refusal names its stage and reason (not a generic message)', () => {
  const login = (username: string, password: string) =>
    admin.req('POST', '/admin/ldap/login-test?profileId=ad', { username, password });

  it('no read access for the service account: the search stage says so', async () => {
    denySearch = 'insufficient';
    try {
      const r = (await login('apetrova', 'Anna-Synthetic-1')).json();
      expect(r).toMatchObject({ ok: false, stage: 'search', reason: 'insufficient_access' });
      expect(r.credentials.ok).toBe(false);
    } finally {
      denySearch = null;
    }
  });

  it('referrals to other directory partitions (as real AD sends from the domain root) do not break the search', async () => {
    withReferrals = true;
    try {
      const r = (await login('apetrova', 'Anna-Synthetic-1')).json();
      expect(r).toMatchObject({
        ok: true,
        reason: 'ok',
        user: { email: 'anna.petrova@example.com' },
      });
      expect((await login('nobody', 'x')).json()).toMatchObject({
        ok: false,
        stage: 'search',
        reason: 'user_not_found',
      });
    } finally {
      withReferrals = false;
    }
  });

  it('wrong service password: the service stage, not a sign-in of the employee', async () => {
    const { eq } = await import('drizzle-orm');
    const [row] = await fixture.database.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'ldap.profiles'));
    const profiles = row!.value as { id: string; bindPasswordCipher: string }[];
    // подменяем служебный пароль на неверный: шифрованная запись нужна другая, поэтому сохраняем через API
    const ad = (await admin.req('GET', '/admin/ldap/profiles'))
      .json()
      .profiles.find((p: { id: string }) => p.id === 'ad');
    const {
      id: _i,
      bindPasswordCipher: _c,
      ...body
    } = { ...ad, id: 'ad' } as Record<string, unknown>;
    void _i;
    void _c;
    void profiles;
    await admin.req('PUT', '/admin/ldap/profiles/ad', {
      ...body,
      bindPassword: 'Wrong-Service-1',
      confirmInsecure: true,
    });
    const r = (await login('apetrova', 'Anna-Synthetic-1')).json();
    expect(r).toMatchObject({ ok: false, stage: 'service' });
    expect(r.reason).not.toMatch(/^service_/);
    await admin.req('PUT', '/admin/ldap/profiles/ad', {
      ...body,
      bindPassword: SVC_PASSWORD,
      confirmInsecure: true,
    });
    expect((await login('apetrova', 'Anna-Synthetic-1')).json()).toMatchObject({
      ok: true,
      stage: 'done',
    });
  });

  it('the three results are separate: credentials ok, policy refused, local account not created yet', async () => {
    const r = (await login('bivanov', 'Boris-Synthetic-1')).json();
    expect(r.credentials.ok).toBe(true);
    // в этом профиле вход открыт всем действующим учётным записям: правило его не отсекает
    expect(r.policy.allowed).toBe(true);
    expect(r).toMatchObject({ ok: true, stage: 'done' });
  });
});

describe('the server only returns reasons the interface can explain', () => {
  it('every code the directory mapping can produce is in the shared reason list', async () => {
    const { AD_BIND_DATA, LDAP_RESULT, NET_ERRORS } = await import('../src/auth/ldap.js');
    const { DIRECTORY_REASONS } = await import('@arklock/contracts');
    const known = new Set<string>(DIRECTORY_REASONS);
    const produced = [
      ...Object.values(AD_BIND_DATA),
      ...Object.values(LDAP_RESULT),
      ...Object.values(NET_ERRORS).map(([, reason]) => reason),
    ];
    expect(produced.filter((r) => !known.has(r))).toEqual([]);
  });
});

describe('certificate names are readable', () => {
  it('a certificate without a CN still exposes its DNS names (SAN); the diagnostics fallback is not unit-tested', async () => {
    const { parseCertificates } = await import('../src/net/certs.js');
    const { webcrypto } = await import('node:crypto');
    const x509m = await import('@peculiar/x509');
    const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
    const keys = (await webcrypto.subtle.generateKey(alg, true, [
      'sign',
      'verify',
    ])) as unknown as CryptoKeyPair;
    const cert = await x509m.X509CertificateGenerator.createSelfSigned({
      serialNumber: '5d',
      name: 'O=Example',
      notBefore: new Date(Date.now() - 86_400_000),
      notAfter: new Date(Date.now() + 86_400_000 * 30),
      signingAlgorithm: alg,
      keys,
      extensions: [
        new x509m.SubjectAlternativeNameExtension([{ type: 'dns', value: 'dc01.example.com' }]),
      ],
    });
    // имя из SAN видно и в разборе сертификата, и в диагностике (запасной вариант — когда CN пуст)
    expect(parseCertificates(Buffer.from(cert.toString('pem'))).certs[0]!.subject).toContain(
      'O=Example',
    );
    const { X509Certificate } = await import('node:crypto');
    expect(new X509Certificate(cert.toString('pem')).subjectAltName).toContain('dc01.example.com');
  });
});

describe('a later failure does not erase a step that already passed', () => {
  it('after a verified password, a failed policy keeps the password step; a failed search keeps the earlier steps', async () => {
    const login = (username: string, password: string) =>
      admin.req('POST', '/admin/ldap/login-test?profileId=ad', { username, password });
    const status = async () =>
      (await admin.req('GET', '/admin/ldap/profiles'))
        .json()
        .profiles.find((p: { id: string }) => p.id === 'ad').status.login.steps as Record<
        string,
        boolean
      >;
    await login('apetrova', 'Anna-Synthetic-1');
    expect(await status()).toMatchObject({
      service: true,
      user: true,
      credentials: true,
      policy: true,
      account: true,
    });
    // пароль верный, но правило входа закрыто (только выбранные группы): пароль по-прежнему подтверждён
    await admin.req('PUT', '/admin/ldap/profiles/ad', {
      ...(await admin.req('GET', '/admin/ldap/profiles'))
        .json()
        .profiles.find((p: { id: string }) => p.id === 'ad'),
      bindPassword: undefined,
      access: 'groups',
      allowedGroups: ['CN=Nobody,OU=Groups,DC=example,DC=com'],
      confirmInsecure: true,
    });
    expect((await login('bivanov', 'Boris-Synthetic-1')).json()).toMatchObject({
      ok: false,
      stage: 'policy',
    });
    expect(await status()).toMatchObject({ credentials: true, policy: false });
    // поиск не нашёл сотрудника: пароль этого сотрудника не проверялся, прежний результат пароля сохраняется
    await login('nobody-here', 'x');
    expect(await status()).toMatchObject({ user: false, credentials: true });
  });
});

describe('domain people: search, profile without sign-in, first sign-in fills the same profile', () => {
  const ANNA_GUID = '00112233-4455-6677-0811-223344556677';
  const find = (q: string) =>
    admin.req('GET', `/admin/people/directory?q=${encodeURIComponent(q)}&profileId=ppl`);
  const provision = (dn: string, profileId = 'ppl') =>
    admin.req('POST', '/admin/people/directory/provision', { profileId, dn });

  it('searches the directory by words (name, login, mail) and needs at least two letters', async () => {
    expect(
      (await put(connection({ baseDn: BASE, enabled: true, access: 'all' }), 'ppl')).statusCode,
    ).toBe(200);
    expect((await find('a')).json()).toMatchObject({ configured: true, items: [] });
    const r = (await find('petrova anna')).json();
    expect(r.problems).toEqual([]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      name: 'Anna Petrova',
      email: 'anna.petrova@example.com',
      login: 'apetrova',
      guid: ANNA_GUID,
      title: 'Engineer',
      existing: null,
    });
    // отключённых учётных записей в поиске нет
    expect((await find('old')).json().items).toEqual([]);
  });

  it('creates a profile without the person signing in; choosing again returns the same profile', async () => {
    const dn = `CN=Anna Petrova,OU=Users,${BASE}`;
    const first = await provision(dn);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      email: 'anna.petrova@example.com',
      pending: true,
      created: true,
      authSource: 'ldap',
    });
    const again = await provision(dn);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: first.json().id, created: false });
    const rows = await fixture.database.db
      .select()
      .from(users)
      .where(eq(users.email, 'anna.petrova@example.com'));
    expect(rows).toHaveLength(1);
    // идентичность — по идентификатору объекта, не по DN; ключей нет
    expect(rows[0]).toMatchObject({
      pendingActivation: true,
      publicKey: '',
      externalId: JSON.stringify(['ppl', `guid:${ANNA_GUID}`]),
    });
    // в поиске она теперь «уже есть», в общем списке людей — с отметкой «ожидает первого входа»
    expect((await find('petrova')).json().items[0].existing).toEqual({
      id: first.json().id,
      state: 'pending',
    });
    const people = (await admin.req('GET', '/admin/people?q=petrova')).json();
    expect(people.items[0]).toMatchObject({ id: first.json().id, pending: true });
    // сводка для шагов «что дальше»: один профиль ждёт первого входа, никто из каталога ещё не входил
    expect((await admin.req('GET', '/admin/people/summary')).json()).toEqual({
      waiting: 1,
      signedIn: 0,
    });
  });

  it('refuses people the sign-in rule does not allow, outside the Base DN, and unknown entries', async () => {
    expect(
      (
        await put(
          connection({
            baseDn: BASE,
            enabled: true,
            access: 'groups',
            allowedGroups: [STAFF],
          }),
          'ppl',
        )
      ).statusCode,
    ).toBe(200);
    // Борис не состоит в разрешённой группе
    const boris = await provision(`CN=Boris Ivanov,OU=Users,${BASE}`);
    expect(boris.statusCode).toBe(409);
    expect(boris.json().error.code).toBe('directory_not_allowed');
    expect((await provision('CN=Anna Petrova,OU=Users,DC=other,DC=org')).json().error.code).toBe(
      'dn_outside_base',
    );
    expect((await provision(`CN=Nobody,OU=Users,${BASE}`)).json().error.code).toBe(
      'directory_person_not_found',
    );
    expect((await provision(`CN=Old Account,OU=Users,${BASE}`)).json().error.code).toBe(
      'directory_account_disabled',
    );
  });

  it('the profile cannot sign in with a password and does not appear as a key holder', async () => {
    const login = await postSolving(fixture.app, '/api/v1/auth/login', {
      email: 'anna.petrova@example.com',
      authKey: 'A'.repeat(43),
    });
    expect(login.statusCode).toBe(401);
    const recovery = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/start',
      payload: { email: 'anna.petrova@example.com' },
    });
    expect(recovery.json().recoveryWrappedPrivateKey).toMatch(/^ak1\./);
    // роль главного администратора принимается мастер-паролем, которого у такого профиля ещё нет
    const [stub] = await fixture.database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'anna.petrova@example.com'));
    const appoint = await admin.reqStep('POST', '/admin/chief/appoint', { userId: stub!.id });
    expect(appoint.statusCode).toBe(409);
    expect(appoint.json().error.code).toBe('account_pending');
    // в поиске для выдачи доступа он есть, но без ключей: роль назначить можно, ключ выдастся после его входа
    const found = (await admin.req('GET', '/directory/users?q=petrova')).json();
    expect(found).toEqual([expect.objectContaining({ pending: true, publicKey: '' })]);
  });

  it('the first sign-in fills the same profile; the account moved to another unit stays linked', async () => {
    const stub = (
      await fixture.database.db
        .select()
        .from(users)
        .where(eq(users.email, 'anna.petrova@example.com'))
    )[0]!;
    // учётная запись перенесена в другое подразделение: DN изменился, идентификатор прежний
    const anna = people.find((p) => p.sam === 'apetrova')!;
    const oldDn = anna.dn;
    anna.dn = `CN=Anna Petrova,OU=Moved,${BASE}`;
    try {
      await put(connection({ baseDn: BASE, enabled: true, access: 'all' }), 'ppl');
      const first = await postSolving(fixture.app, '/api/v1/auth/ldap/login', {
        username: 'apetrova',
        password: 'Anna-Synthetic-1',
        profileId: 'ppl',
      });
      expect(first.statusCode).toBe(200);
      // сервер возвращает идентификатор созданного профиля: ключи создаются именно для него
      expect(first.json()).toMatchObject({ enroll: true, userId: stub.id });
      const client = new TestClient(fixture.app, 'anna.petrova@example.com', 'anna-master-pass-12');
      const { payload } = await client.registerBody(undefined, undefined, stub.id);
      const { email: _e, displayName: _d, setupToken: _s, ...rest } = payload;
      void _e;
      void _d;
      void _s;
      // чужой идентификатор вместо созданного профиля не принимается
      const other = await client.registerBody();
      const wrong = await fixture.app.inject({
        method: 'POST',
        url: '/api/v1/auth/external/enroll',
        payload: { ...other.payload, enrollToken: first.json().enrollToken },
      });
      expect(wrong.statusCode).toBe(409);
      const second = await postSolving(fixture.app, '/api/v1/auth/ldap/login', {
        username: 'apetrova',
        password: 'Anna-Synthetic-1',
        profileId: 'ppl',
      });
      const done = await fixture.app.inject({
        method: 'POST',
        url: '/api/v1/auth/external/enroll',
        payload: { ...rest, enrollToken: second.json().enrollToken },
      });
      expect(done.statusCode).toBe(201);
      expect(done.json().user.id).toBe(stub.id);
      const rows = await fixture.database.db
        .select()
        .from(users)
        .where(eq(users.email, 'anna.petrova@example.com'));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ pendingActivation: false, id: stub.id });
      expect(rows[0]!.publicKey).not.toBe('');
      // следующий вход — обычный, с новой записью DN привязка не теряется
      const next = await postSolving(fixture.app, '/api/v1/auth/ldap/login', {
        username: 'apetrova',
        password: 'Anna-Synthetic-1',
        profileId: 'ppl',
      });
      expect(next.statusCode).toBe(200);
      expect(next.json().enroll).toBeUndefined();
    } finally {
      anna.dn = oldDn;
    }
  });

  it('a vault role goes to a person who has not signed in yet; the key follows after the first sign-in', async () => {
    const borisDn = `CN=Boris Ivanov,OU=Users,${BASE}`;
    const made = await provision(borisDn);
    expect(made.statusCode).toBe(201);
    const borisId = made.json().id as string;
    const { id: vaultId } = await admin.createSharedVault('People without a sign-in');
    const role = await admin.req('PUT', `/vaults/${vaultId}/members/${borisId}`, {
      role: 'reader',
    });
    expect(role.statusCode).toBe(204);
    // без ключа он не держатель ключа: ни в списке участников с ключами, ни в списке «ждут ключ»
    const members = (await admin.req('GET', `/vaults/${vaultId}/members`)).json();
    expect(members.members.some((m: { userId: string }) => m.userId === borisId)).toBe(false);
    const waiting = () =>
      admin
        .req('GET', `/vaults/${vaultId}/pending-keys`)
        .then((r) => r.json().users as { userId: string }[]);
    expect((await waiting()).some((u) => u.userId === borisId)).toBe(false);
    // первый вход заполняет профиль ключами: теперь ему можно выдать ключ сейфа
    const first = await postSolving(fixture.app, '/api/v1/auth/ldap/login', {
      username: 'bivanov',
      password: 'Boris-Synthetic-1',
      profileId: 'ppl',
    });
    expect(first.json()).toMatchObject({ enroll: true, userId: borisId });
    const client = new TestClient(fixture.app, 'boris.ivanov@example.com', 'boris-master-pass-12');
    const { payload } = await client.registerBody(undefined, undefined, borisId);
    const { email: _e, displayName: _d, setupToken: _s, ...rest } = payload;
    void _e;
    void _d;
    void _s;
    const done = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/external/enroll',
      payload: { ...rest, enrollToken: first.json().enrollToken },
    });
    expect(done.statusCode).toBe(201);
    expect((await waiting()).some((u) => u.userId === borisId)).toBe(true);
  });

  it('a link made by DN (before identifiers existed) moves to the identifier; a moved account is not disabled by the sync', async () => {
    const boris = people.find((p) => p.sam === 'bivanov')!;
    const row = async () =>
      (
        await fixture.database.db
          .select()
          .from(users)
          .where(eq(users.email, 'boris.ivanov@example.com'))
      )[0]!;
    // привязка по DN, как было до идентификаторов объекта
    await fixture.database.db
      .update(users)
      .set({ externalId: JSON.stringify(['ppl', boris.dn]) })
      .where(eq(users.email, 'boris.ivanov@example.com'));
    const sync = () => admin.req('POST', '/admin/ldap/sync?profileId=ppl');
    const first = (await sync()).json();
    expect(first).toMatchObject({ disabled: 0 });
    // байты objectGUID в порядке AD приводятся к привычному виду: первые три группы читаются наоборот
    expect((await row()).externalId).toBe(
      JSON.stringify(['ppl', 'guid:11223344-6655-7877-0011-223344556677']),
    );
    // у человека сменилась почта: по прежней его не найти, но идентификатор прежний — сверка его не отключает
    const oldMail = boris.mail;
    boris.mail = 'boris.renamed@example.com';
    try {
      expect((await sync()).json()).toMatchObject({ disabled: 0 });
      expect((await row()).disabledAt).toBeNull();
    } finally {
      boris.mail = oldMail;
    }
    // учётную запись перенесли в другое подразделение: DN изменился, человек тот же
    const oldDn = boris.dn;
    boris.dn = `CN=Boris Ivanov,OU=Moved,${BASE}`;
    try {
      expect((await sync()).json()).toMatchObject({ disabled: 0 });
      expect((await row()).disabledAt).toBeNull();
    } finally {
      boris.dn = oldDn;
    }
  });
});

describe('domain groups: search, preview, link and unlink', () => {
  let circleId = '';
  const groups = (q: string) =>
    admin.req('GET', `/admin/directory/groups?q=${encodeURIComponent(q)}&profileId=ppl`);
  const preview = (action: 'link' | 'unlink') =>
    admin.req('POST', '/admin/directory/groups/preview', {
      profileId: 'ppl',
      dn: STAFF,
      circleId,
      action,
    });
  const links = () => admin.req('GET', `/admin/circles/${circleId}/directory-links`);
  const change = (action: 'link' | 'unlink', keepMembers = true) =>
    admin.req('PUT', `/admin/circles/${circleId}/directory-links`, {
      profileId: 'ppl',
      dn: STAFF,
      action,
      keepMembers,
    });
  const membersOf = async () =>
    (await admin.req('GET', `/admin/circles/${circleId}/members`)).json() as { email: string }[];

  it('finds domain groups and shows which Arklock group they are linked to', async () => {
    expect((await groups('s')).json().items).toEqual([]);
    const r = (await groups('staff')).json();
    expect(r.items).toEqual([
      expect.objectContaining({ dn: STAFF, name: 'Staff', profileId: 'ppl', linked: [] }),
    ]);
    circleId = (
      await admin.req('POST', '/admin/circles', { name: 'Support team', description: '' })
    ).json().id;
    expect(circleId).toBeTruthy();
  });

  it('the preview says who joins and what the group gives, without changing anything', async () => {
    const r = (await preview('link')).json();
    expect(r).toMatchObject({
      action: 'link',
      group: 'Staff',
      domainMembers: 1,
      withProfile: 1,
      withoutProfile: 0,
      willJoin: 1,
      alreadyMembers: 0,
      adminRole: null,
    });
    expect(await membersOf()).toEqual([]);
    expect((await links()).json().links).toEqual([]);
  });

  it('linking brings in people who already have a profile and is visible and repeatable', async () => {
    const r = (await change('link')).json();
    expect(r).toMatchObject({ ok: true, added: 1 });
    expect((await membersOf()).map((m) => m.email)).toEqual(['anna.petrova@example.com']);
    expect((await links()).json().links).toEqual([
      expect.objectContaining({ profileId: 'ppl', dn: STAFF, name: 'Staff' }),
    ]);
    // повтор не создаёт вторую привязку и не дублирует участника
    expect((await change('link')).json()).toMatchObject({ ok: true, added: 0 });
    expect((await links()).json().links).toHaveLength(1);
    expect((await groups('staff')).json().items[0].linked).toEqual([
      { circleId, circleName: 'Support team' },
    ]);
  });

  it('unlinking keeps members by default; removing them is a separate explicit choice', async () => {
    const p = (await preview('unlink')).json();
    expect(p).toMatchObject({ action: 'unlink', directoryMembers: 1, stillMapped: false });
    expect((await change('unlink')).json()).toMatchObject({ ok: true, removed: 0 });
    expect((await links()).json().links).toEqual([]);
    expect(await membersOf()).toHaveLength(1);
    await change('link');
    expect((await change('unlink', false)).json()).toMatchObject({ ok: true, removed: 1 });
    expect(await membersOf()).toEqual([]);
    // привязки уже нет — повторная отвязка сообщает об этом
    expect((await change('unlink')).statusCode).toBe(404);
  });

  it('"add a domain group" creates a linked Arklock group once and reuses it afterwards', async () => {
    const use = () =>
      admin.req('POST', '/admin/directory/groups/use', { profileId: 'ppl', dn: TEAM });
    const first = await use();
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ created: true, added: 1, circle: { name: 'Team A' } });
    const again = await use();
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, circle: { id: first.json().circle.id } });
    expect(
      (await admin.req('GET', `/admin/circles/${first.json().circle.id}/members`)).json(),
    ).toHaveLength(1);
    // DN вне Base DN не принимается
    const bad = await admin.req('POST', '/admin/directory/groups/use', {
      profileId: 'ppl',
      dn: 'CN=Team,DC=other,DC=org',
    });
    expect(bad.json().error.code).toBe('dn_outside_base');
  });

  it('the departments list shows each department with its head, members and vaults', async () => {
    const name = 'Support department';
    const cid = (await admin.req('POST', '/admin/circles', { name, description: '' })).json().id;
    const space = (
      await admin.req('POST', '/spaces', { name, publicToOrg: false, description: '' })
    ).json();
    expect(
      (await admin.req('PUT', `/spaces/${space.id}/circles/${cid}`, { role: 'member' })).statusCode,
    ).toBe(204);
    const boris = (await admin.req('GET', '/admin/people?q=boris')).json().items[0] as {
      id: string;
    };
    expect(
      (await admin.req('PATCH', `/admin/circles/${cid}/members`, { add: [boris.id] })).statusCode,
    ).toBe(200);
    expect(
      (await admin.req('PUT', `/spaces/${space.id}/users/${boris.id}`, { role: 'admin' }))
        .statusCode,
    ).toBe(204);
    const r = (await admin.req('GET', '/admin/departments?q=support dep')).json();
    expect(r.items).toEqual([
      expect.objectContaining({
        name,
        circleId: cid,
        members: 1,
        waiting: 0,
        vaults: 0,
        // руководители — администраторы пространства: и создавший его, и назначенный
        heads: expect.arrayContaining([expect.objectContaining({ id: boris.id })]),
      }),
    ]);
    // обычная группа без пространства подразделением не считается
    expect((await admin.req('GET', '/admin/departments?q=Support team')).json().items).toEqual([]);
  });
});

describe('any employee finds domain people to share with, within the policy', () => {
  let eve: TestClient;
  const search = (c: TestClient, q: string) =>
    c.req('GET', `/directory/people?q=${encodeURIComponent(q)}&profileId=ppl`);

  it('searches from three letters and creates a profile only when the directory allows it', async () => {
    await admin.req('PUT', '/admin/settings', { 'registration.mode': 'open' });
    eve = new TestClient(fixture.app, 'eve-employee@example.com', 'eve-employee-password-1234');
    expect((await eve.register()).statusCode).toBe(201);
    await eve.login();
    expect((await search(eve, 'cl')).json().items).toEqual([]);
    const found = (await search(eve, 'sidorova')).json();
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({ email: 'clara.sidorova@example.com', existing: null });
    // профиль создаёт и обычный сотрудник (подключение разрешает создание при первом входе)
    const made = await eve.req('POST', '/directory/people/provision', {
      profileId: 'ppl',
      dn: found.items[0].dn,
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ email: 'clara.sidorova@example.com', pending: true });
    // повтор не создаёт дубль
    const again = await eve.req('POST', '/directory/people/provision', {
      profileId: 'ppl',
      dn: found.items[0].dn,
    });
    expect(again.json()).toMatchObject({ id: made.json().id, created: false });
  });

  it('with the sharing policy "nobody" the directory stays closed for employees but not for administrators', async () => {
    await admin.req('PUT', '/admin/settings', { 'sharing.outside': 'off' });
    expect((await search(eve, 'sidorova')).json()).toMatchObject({ configured: false, items: [] });
    const denied = await eve.req('POST', '/directory/people/provision', {
      profileId: 'ppl',
      dn: `CN=Anna Petrova,OU=Users,${BASE}`,
    });
    expect(denied.statusCode).toBe(403);
    expect((await search(admin, 'sidorova')).json().items).toHaveLength(1);
    await admin.req('PUT', '/admin/settings', { 'sharing.outside': 'owners' });
  });
});
