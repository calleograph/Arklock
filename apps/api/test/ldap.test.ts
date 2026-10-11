import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildUserFilter, escapeFilter, DEFAULT_USER_FILTER } from '../src/auth/ldap.js';
import { settings, users, circleMembers } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { TestClient, createTestApp } from './helpers.js';

// ldapjs используется только как тестовый каталог
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ldap: any = require('ldapjs');

const BASE = 'dc=example,dc=com';
const SVC = 'cn=svc,dc=example,dc=com';
const DEVS = 'cn=devs,ou=groups,dc=example,dc=com';

interface Person {
  dn: string;
  uid: string;
  password: string;
  mail: string;
  cn: string;
  memberOf: string[];
  uac?: string;
}
const directory: Person[] = [
  {
    dn: `uid=alice,ou=people,${BASE}`,
    uid: 'alice',
    password: 'alice-ldap-pass',
    mail: 'alice@example.com',
    cn: 'Alice A',
    memberOf: [DEVS],
  },
  {
    dn: `uid=bob,ou=people,${BASE}`,
    uid: 'bob',
    password: 'bob-ldap-pass',
    mail: 'bob@example.com',
    cn: 'Bob B',
    memberOf: [],
  },
  {
    dn: `uid=carol,ou=people,${BASE}`,
    uid: 'carol',
    password: 'carol-ldap-pass',
    mail: 'carol@example.com',
    cn: 'Carol C',
    memberOf: [],
    uac: '514',
  },
  {
    dn: `uid=local,ou=people,${BASE}`,
    uid: 'local',
    password: 'local-ldap-pass',
    mail: 'local@example.com',
    cn: 'Local L',
    memberOf: [],
  },
];
const anonymousBinds: string[] = [];

let server: {
  listen: (p: number, h: string, cb: () => void) => void;
  close: () => void;
  address: () => { port: number };
  bind: (...a: any[]) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  search: (...a: any[]) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
};
let port = 0;
let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let admin: TestClient;
let circleId = '';

function startDirectory(): Promise<void> {
  server = ldap.createServer();
  server.bind(
    SVC,
    (req: { credentials: string }, res: { end: () => void }, next: (e?: unknown) => void) => {
      if (req.credentials !== 'svc-password') return next(new ldap.InvalidCredentialsError());
      res.end();
      return next();
    },
  );
  server.bind(
    `ou=people,${BASE}`,
    (
      req: { dn: { toString: () => string }; credentials: string },
      res: { end: () => void },
      next: (e?: unknown) => void,
    ) => {
      const dn = req.dn.toString().toLowerCase();
      if (!req.credentials) anonymousBinds.push(dn);
      const p = directory.find((x) => x.dn.toLowerCase() === dn);
      if (!p || p.password !== req.credentials) return next(new ldap.InvalidCredentialsError());
      res.end();
      return next();
    },
  );
  server.search(
    BASE,
    (
      req: {
        filter: { matches: (o: object) => boolean; toString: () => string };
        scope: string;
        dn: { toString: () => string };
      },
      res: { send: (e: object) => void; end: () => void },
      next: () => void,
    ) => {
      if (req.scope === 'base') {
        res.send({ dn: BASE, attributes: { objectClass: 'domain' } });
        res.end();
        return next();
      }
      for (const p of directory) {
        const attrs: Record<string, unknown> = {
          objectClass: 'person',
          uid: p.uid,
          mail: p.mail,
          cn: p.cn,
          memberof: p.memberOf,
          userPrincipalName: `${p.uid}@example.com`,
          ...(p.uac ? { useraccountcontrol: p.uac } : {}),
        };
        if (req.filter.matches(attrs)) res.send({ dn: p.dn, attributes: attrs });
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

const cfg = (extra: object = {}) => ({
  enabled: true,
  url: `ldap://127.0.0.1:${port}`,
  allowPlaintext: true,
  bindDn: SVC,
  bindPassword: 'svc-password',
  baseDn: BASE,
  groups: [{ dn: DEVS, circleId }],
  ...extra,
});

const ldapLogin = (username: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/ldap/login', payload: { username, password } });

beforeAll(async () => {
  await startDirectory();
  ({ app, database } = await createTestApp());
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  expect((await admin.register()).statusCode).toBe(201);
  await admin.login();
  circleId = (
    await admin.req('POST', '/admin/circles', { name: 'Developers', description: '' })
  ).json().id;
  // регистрация закрыта: пользователь каталога создаётся только через вход
  await database.db.insert(settings).values({ key: 'registration.mode', value: 'closed' });
});

afterAll(async () => {
  await app.close();
  server.close();
});

describe('LDAP filter safety', () => {
  it('escapes metacharacters so a user name cannot add conditions', () => {
    expect(escapeFilter('a*)(uid=*')).toBe('a\\2a\\29\\28uid=\\2a');
    expect(buildUserFilter(DEFAULT_USER_FILTER, 'x)(objectClass=*')).not.toContain(
      'x)(objectClass=*',
    );
    expect(() => buildUserFilter('(uid=x)', 'a')).toThrow();
  });
});

describe('LDAP administration', () => {
  it('only administrators configure LDAP; cleartext is refused unless accepted', async () => {
    const plain = new TestClient(app, 'plain@example.com', 'plain-password-1234');
    await database.db
      .insert(settings)
      .values({ key: 'registration.mode', value: 'open' })
      .onConflictDoUpdate({ target: settings.key, set: { value: 'open' } });
    expect((await plain.register()).statusCode).toBe(201);
    await plain.login();
    expect((await plain.req('GET', '/admin/ldap')).statusCode).toBe(403);
    expect((await plain.req('PUT', '/admin/ldap', cfg())).statusCode).toBe(403);
    await database.db
      .update(settings)
      .set({ value: 'closed' })
      .where(eq(settings.key, 'registration.mode'));

    expect((await admin.req('GET', '/admin/ldap')).json()).toEqual({ configured: false });
    const refused = await admin.req('PUT', '/admin/ldap', cfg({ allowPlaintext: false }));
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('insecure_ldap');
    expect((await admin.req('PUT', '/admin/ldap', cfg())).statusCode).toBe(200);
    const got = (await admin.req('GET', '/admin/ldap')).json();
    expect(got).toMatchObject({ configured: true, hasBindPassword: true, baseDn: BASE });
    expect(JSON.stringify(got)).not.toContain('svc-password');
    // пароль в базе не хранится открыто
    const [row] = await database.db.select().from(settings).where(eq(settings.key, 'ldap.config'));
    expect(JSON.stringify(row)).not.toContain('svc-password');
  });

  it('test connection, wrong service password and user lookup', async () => {
    expect((await admin.req('POST', '/admin/ldap/test')).json().ok).toBe(true);
    const found = (await admin.req('POST', '/admin/ldap/lookup', { username: 'alice' })).json();
    expect(found.found).toBe(true);
    expect(found.user).toMatchObject({ email: 'alice@example.com', name: 'Alice A' });
    expect(found.user.groups).toEqual([DEVS]);
    expect(JSON.stringify(found)).not.toContain('alice-ldap-pass');
    expect(
      (await admin.req('POST', '/admin/ldap/lookup', { username: 'nobody' })).json().found,
    ).toBe(false);
    // внедрение условий через имя не находит всех подряд
    expect((await admin.req('POST', '/admin/ldap/lookup', { username: '*' })).json().found).toBe(
      false,
    );
    expect(
      (await admin.req('POST', '/admin/ldap/lookup', { username: 'x)(uid=*' })).json().found,
    ).toBe(false);

    await admin.req('PUT', '/admin/ldap', cfg({ bindPassword: 'wrong' }));
    const bad = (await admin.req('POST', '/admin/ldap/test')).json();
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('bind');
    await admin.req('PUT', '/admin/ldap', cfg({ bindPassword: 'svc-password' }));
  });
});

describe('sign-in through the directory', () => {
  let alice: TestClient;
  let enrollToken = '';

  it('the login page learns whether LDAP is available', async () => {
    expect((await app.inject({ url: '/api/v1/auth/ldap' })).json()).toEqual({
      enabled: true,
      autoProvision: true,
    });
  });

  it('a wrong password, an unknown user and an empty password are refused alike', async () => {
    const a = await ldapLogin('alice', 'nope');
    const b = await ldapLogin('ghost', 'whatever');
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().error.code).toBe(b.json().error.code);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/ldap/login',
          payload: { username: 'alice', password: '' },
        })
      ).statusCode,
    ).toBe(400);
    expect(anonymousBinds).toEqual([]);
  });

  it('a disabled directory account cannot sign in', async () => {
    expect((await ldapLogin('carol', 'carol-ldap-pass')).statusCode).toBe(401);
  });

  it('the first successful sign-in asks for a master password; the account is created with client-made keys', async () => {
    const first = await ldapLogin('alice', 'alice-ldap-pass');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      enroll: true,
      email: 'alice@example.com',
      name: 'Alice A',
    });
    enrollToken = first.json().enrollToken;
    expect(first.json().token).toBeUndefined();

    alice = new TestClient(app, 'alice@example.com', 'alice-master-password-1');
    const { payload, userId } = await alice.registerBody();
    const { email: _e, displayName: _d, setupToken: _s, ...rest } = payload;
    void _e;
    void _d;
    void _s;
    // токен действует один раз и привязан к идентичности из каталога, а не к присланному адресу
    const wrongToken = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/ldap/enroll',
      payload: { ...rest, enrollToken: 'ae_not-a-real-token-value' },
    });
    expect(wrongToken.statusCode).toBe(401);
    const done = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/ldap/enroll',
      payload: { ...rest, email: 'evil@example.com', enrollToken },
    });
    expect(done.statusCode).toBe(201);
    expect(done.json().user.email).toBe('alice@example.com');
    expect(done.json().user.id).toBe(userId);
    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/ldap/enroll',
      payload: { ...rest, enrollToken },
    });
    expect(reuse.statusCode).toBe(401);
    await alice.adopt(done.json());
    expect((await alice.req('GET', '/vaults')).statusCode).toBe(200);
    const [row] = await database.db.select().from(users).where(eq(users.id, userId));
    expect(row).toMatchObject({
      authSource: 'ldap',
      externalId: `uid=alice,ou=people,${BASE}`,
      role: 'member',
    });
  });

  it('group membership becomes circle membership', async () => {
    const members = await database.db
      .select()
      .from(circleMembers)
      .where(eq(circleMembers.circleId, circleId));
    expect(members.map((m) => m.userId)).toEqual([alice.userId]);
  });

  it('later sign-ins return the session; the master password alone no longer signs in', async () => {
    const again = await ldapLogin('alice', 'alice-ldap-pass');
    expect(again.statusCode).toBe(200);
    expect(again.json().token).toMatch(/^aks_/);
    expect(again.json().user.wrappedPrivateKey).toBeTruthy();
    // вход по почте — тоже
    expect((await ldapLogin('alice@example.com', 'alice-ldap-pass')).json().token).toMatch(/^aks_/);
    const viaMaster = await alice.loginRaw();
    expect(viaMaster.statusCode).toBe(403);
    expect(viaMaster.json().error.code).toBe('external_login_required');
    // чужой мастер-пароль по-прежнему даёт тот же отказ, что и раньше (без раскрытия)
    expect((await alice.loginRaw('some-other-password-123')).statusCode).toBe(401);
  });

  it('an existing local account with the same e-mail is never taken over', async () => {
    const local = new TestClient(app, 'local@example.com', 'local-master-password-1');
    await database.db
      .update(settings)
      .set({ value: 'open' })
      .where(eq(settings.key, 'registration.mode'));
    expect((await local.register()).statusCode).toBe(201);
    await database.db
      .update(settings)
      .set({ value: 'closed' })
      .where(eq(settings.key, 'registration.mode'));
    const r = await ldapLogin('local', 'local-ldap-pass');
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('account_exists_local');
  });

  it('repeated failures are throttled', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await ldapLogin('bob', `wrong-${i}`)).statusCode;
    expect(last).toBe(429);
  });

  it('synchronisation blocks accounts that were disabled in the directory and revokes their sessions', async () => {
    const tok = (await ldapLogin('alice', 'alice-ldap-pass')).json().token as string;
    expect(
      (await app.inject({ url: '/api/v1/vaults', headers: { authorization: `Bearer ${tok}` } }))
        .statusCode,
    ).toBe(200);
    directory[0]!.uac = '514';
    try {
      const r = (await admin.req('POST', '/admin/ldap/sync')).json();
      expect(r).toMatchObject({ total: 1, disabled: 1 });
      expect(
        (await app.inject({ url: '/api/v1/vaults', headers: { authorization: `Bearer ${tok}` } }))
          .statusCode,
      ).toBe(401);
      expect((await ldapLogin('alice', 'alice-ldap-pass')).statusCode).toBe(401);
    } finally {
      delete directory[0]!.uac;
    }
  });

  it('the second factor still applies to directory accounts', async () => {
    // восстановим учётную запись и включим MFA
    await database.db.update(users).set({ disabledAt: null }).where(eq(users.id, alice.userId));
    const tok = (await ldapLogin('alice', 'alice-ldap-pass')).json().token as string;
    alice.token = tok;
    const setup = (await alice.req('POST', '/auth/mfa/setup')).json();
    const { totp, parseTotpInput } = await import('@arklock/crypto');
    expect(
      (
        await alice.req('POST', '/auth/mfa/enable', {
          code: await totp(parseTotpInput(setup.secret), Date.now() - 30_000),
        })
      ).statusCode,
    ).toBe(200);
    const next = await ldapLogin('alice', 'alice-ldap-pass');
    expect(next.json()).toMatchObject({ mfaRequired: true });
    expect(next.json().token).toBeUndefined();
  });
});
