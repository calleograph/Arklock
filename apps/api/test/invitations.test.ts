import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { parseTotpInput, totp } from '@arklock/crypto';
import { circleMembers, invitations, users } from '../src/db/schema.js';
import { TestClient, awayFromTotpStepEdge, createTestApp } from './helpers.js';

const PUBLIC = 'https://arklock.example.com';
const mails: { to: string; data: string }[] = [];
let smtp: net.Server;
let smtpPort = 0;

/** Приёмник почты: принимает любые письма без проверки входа. */
function startSmtp(): Promise<void> {
  smtp = net.createServer((sock) => {
    let data = false;
    let buf = '';
    let to = '';
    sock.on('error', () => undefined);
    sock.write('220 test\r\n');
    sock.on('data', (d) => {
      buf += d.toString();
      for (;;) {
        if (data) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          mails.push({ to, data: buf.slice(0, end) });
          buf = buf.slice(end + 5);
          data = false;
          sock.write('250 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^EHLO/i.test(line)) sock.write('250 test\r\n');
        else if (/^MAIL/i.test(line)) sock.write('250 ok\r\n');
        else if (/^RCPT TO:<([^>]*)>/i.test(line)) {
          to = /^RCPT TO:<([^>]*)>/i.exec(line)![1]!;
          sock.write('250 ok\r\n');
        } else if (/^DATA/i.test(line)) {
          data = true;
          sock.write('354 go\r\n');
        } else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else sock.write('500 ?\r\n');
      }
    });
  });
  return new Promise((resolve) =>
    smtp.listen(0, '127.0.0.1', () => {
      smtpPort = (smtp.address() as net.AddressInfo).port;
      resolve();
    }),
  );
}
const decoded = (m: { data: string }) => {
  const [head, body = ''] = m.data.split('\r\n\r\n');
  const text = Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
  const subj = /Subject: =\?UTF-8\?B\?([^?]*)\?=/.exec(head ?? '')?.[1];
  return { subject: subj ? Buffer.from(subj, 'base64').toString('utf8') : '', text };
};
const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let admin: TestClient;
let circleId = '';

beforeAll(async () => {
  await startSmtp();
  ({ app, database } = await createTestApp({ APP_PUBLIC_URL: PUBLIC }));
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  expect((await admin.register()).statusCode).toBe(201);
  await admin.login();
  circleId = (
    await admin.req('POST', '/admin/circles', { name: 'Newcomers', description: '' })
  ).json().id;
});

afterAll(async () => {
  await app.close();
  smtp.close();
});

const tokenOf = (link: string) => new URL(link).searchParams.get('invite')!;

async function registerWith(email: string, token?: string) {
  const c = new TestClient(app, email, 'invited-master-password-12');
  const { payload } = await c.registerBody();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { ...payload, inviteToken: token },
  });
  return { res, c };
}

describe('invitations', () => {
  it('activates and signs in with a local username without email delivery', async () => {
    const refused = await admin.req('POST', '/admin/invitations', {
      email: 'operator.one',
      sendEmail: true,
    });
    expect(refused.statusCode).toBe(400);
    const invited = await admin.req('POST', '/admin/invitations', {
      email: 'Operator.One',
      displayName: 'Operator',
      sendEmail: false,
    });
    expect(invited.statusCode).toBe(201);
    const { res, c } = await registerWith('operator.one', tokenOf(invited.json().link));
    expect(res.statusCode).toBe(201);
    expect((await c.login()).user.email).toBe('operator.one');
  });

  it('registration is closed without an invitation', async () => {
    expect((await registerWith('nobody@example.com')).res.statusCode).toBe(403);
  });

  it('only administrators invite; the link is shown once and stored hashed', async () => {
    const m = new TestClient(app, 'plain@example.com', 'plain-password-1234');
    expect((await m.register(undefined)).statusCode).toBe(403); // закрыто
    const r = await admin.req('POST', '/admin/invitations', {
      email: 'Newbie@Example.com',
      circleIds: [circleId],
      expiresInDays: 3,
    });
    expect(r.statusCode).toBe(201);
    const { link, emailed } = r.json();
    expect(emailed).toBe(false);
    expect(link).toMatch(/^https:\/\/arklock\.example\.com\/login\?invite=[A-Z2-9-]{27}$/);
    const [row] = await database.db
      .select()
      .from(invitations)
      .where(eq(invitations.email, 'newbie@example.com'));
    expect(row!.email).toBe('newbie@example.com');
    expect(JSON.stringify(row)).not.toContain(tokenOf(link));
    const list = (await admin.req('GET', '/admin/invitations')).json();
    expect(list[0]).toMatchObject({ email: 'newbie@example.com', status: 'pending' });
    expect(JSON.stringify(list)).not.toContain('inv_');
    expect((await app.inject({ url: '/api/v1/admin/invitations' })).statusCode).toBe(401);
  });

  it('the link opens the form for exactly the invited address; other addresses are refused', async () => {
    const link = (
      await admin.req('POST', '/admin/invitations', {
        email: 'newbie@example.com',
        circleIds: [circleId],
      })
    ).json().link;
    const token = tokenOf(link);
    expect((await app.inject({ url: `/api/v1/auth/invitation?token=${token}` })).json()).toEqual({
      email: 'newbie@example.com',
      displayName: null,
      role: 'member',
    });
    expect(
      (await app.inject({ url: '/api/v1/auth/invitation?token=inv_unknown-token-value' }))
        .statusCode,
    ).toBe(404);
    expect((await registerWith('someone.else@example.com', token)).res.statusCode).toBe(403);
    expect(
      (await registerWith('newbie@example.com', 'inv_wrong-token-value-1234')).res.statusCode,
    ).toBe(403);

    const ok = await registerWith('newbie@example.com', token);
    expect(ok.res.statusCode).toBe(201);
    // членство в круге применено, приглашение использовано и повторно не действует
    const [u] = await database.db.select().from(users).where(eq(users.email, 'newbie@example.com'));
    const members = await database.db
      .select()
      .from(circleMembers)
      .where(eq(circleMembers.circleId, circleId));
    expect(members.map((m) => m.userId)).toContain(u!.id);
    expect((await registerWith('newbie2@example.com', token)).res.statusCode).toBe(403);
    expect((await app.inject({ url: `/api/v1/auth/invitation?token=${token}` })).statusCode).toBe(
      404,
    );
    expect(u!.role).toBe('member');
  });

  it('a new invitation revokes the previous one; revoked and expired links stop working', async () => {
    const first = tokenOf(
      (await admin.req('POST', '/admin/invitations', { email: 'again@example.com' })).json().link,
    );
    const second = tokenOf(
      (await admin.req('POST', '/admin/invitations', { email: 'again@example.com' })).json().link,
    );
    expect((await registerWith('again@example.com', first)).res.statusCode).toBe(403);
    const list = (await admin.req('GET', '/admin/invitations')).json() as {
      id: string;
      email: string;
      status: string;
    }[];
    const pending = list.find((i) => i.email === 'again@example.com' && i.status === 'pending')!;
    expect((await admin.req('DELETE', `/admin/invitations/${pending.id}`)).statusCode).toBe(204);
    expect((await registerWith('again@example.com', second)).res.statusCode).toBe(403);

    const third = tokenOf(
      (await admin.req('POST', '/admin/invitations', { email: 'late@example.com' })).json().link,
    );
    await database.db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.email, 'late@example.com'));
    expect((await registerWith('late@example.com', third)).res.statusCode).toBe(403);
  });

  it('an administrator creates an account with a name and role; the one-time code is typed loosely and never stored', async () => {
    const r = await admin.req('POST', '/admin/invitations', {
      email: 'activate@example.com',
      displayName: 'Анна Смирнова',
      role: 'admin',
      circleIds: [circleId],
    });
    expect(r.statusCode).toBe(201);
    const { code } = r.json() as { code: string };
    expect(code).toMatch(/^[A-Z2-9]{6}(-[A-Z2-9]{6}){3}$/);
    // код хранится только хэшем: ни сам код, ни его части в базе не встречаются
    const rows = JSON.stringify(await database.db.select().from(invitations));
    expect(rows).not.toContain(code);
    expect(rows).not.toContain(code.replace(/-/g, ''));
    // список администратора тоже не раскрывает код
    expect(JSON.stringify((await admin.req('GET', '/admin/invitations')).json())).not.toContain(
      code.slice(0, 6),
    );

    // пользователь вводит код с другим регистром и пробелами вместо дефисов
    const typed = ` ${code.toLowerCase().replace(/-/g, '  ')} `;
    const info = await app.inject({
      url: `/api/v1/auth/invitation?token=${encodeURIComponent(typed)}`,
    });
    expect(info.json()).toEqual({
      email: 'activate@example.com',
      displayName: 'Анна Смирнова',
      role: 'admin',
    });
    // активация: имя и роль берутся из приглашения, а не из формы пользователя
    const { res } = await registerWith('activate@example.com', typed);
    expect(res.statusCode).toBe(201);
    const [u] = await database.db
      .select()
      .from(users)
      .where(eq(users.email, 'activate@example.com'));
    expect(u).toMatchObject({ displayName: 'Анна Смирнова', role: 'admin' });
    // код одноразовый
    expect((await app.inject({ url: `/api/v1/auth/invitation?token=${code}` })).statusCode).toBe(
      404,
    );
  });

  it('existing users cannot be invited; unknown circles are rejected', async () => {
    expect(
      (await admin.req('POST', '/admin/invitations', { email: 'admin@example.com' })).statusCode,
    ).toBe(409);
    expect(
      (
        await admin.req('POST', '/admin/invitations', {
          email: 'x@example.com',
          circleIds: [crypto.randomUUID()],
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('mail: invitation delivery and security notices', () => {
  it('without configured mail, sending reports false; with mail, the link arrives', async () => {
    const r = await admin.req('POST', '/admin/invitations', {
      email: 'mailed@example.com',
      sendEmail: true,
    });
    expect(r.json().emailed).toBe(false);
    await admin.reqStep('PUT', '/admin/smtp', {
      host: '127.0.0.1',
      port: smtpPort,
      security: 'none',
      from: 'arklock@example.com',
    });
    const r2 = await admin.req('POST', '/admin/invitations', {
      email: 'mailed@example.com',
      sendEmail: true,
    });
    expect(r2.json().emailed).toBe(true);
    const m = mails.find((x) => x.to === 'mailed@example.com')!;
    expect(decoded(m).text).toContain(r2.json().link);
  });

  it('security events notify the account owner; the switch turns it off; no secrets in the message', async () => {
    mails.length = 0;
    const setup = (await admin.req('POST', '/auth/mfa/setup')).json();
    await awayFromTotpStepEdge();
    expect(
      (
        await admin.req('POST', '/auth/mfa/enable', {
          code: await totp(parseTotpInput(setup.secret), Date.now() - 30_000),
        })
      ).statusCode,
    ).toBe(200);
    expect(await until(() => mails.some((m) => m.to === 'admin@example.com'))).toBe(true);
    const n = decoded(mails.find((m) => m.to === 'admin@example.com')!);
    expect(n.subject).toContain('двухфакторная');
    expect(n.text).not.toContain(setup.secret);
    expect(n.text).not.toContain('admin-password-123');

    mails.length = 0;
    await admin.req('PUT', '/admin/settings', { 'notifications.security': false });
    // ключ входа выводится долго — код берётся после него, у самого запроса
    const authKey = (await import('@arklock/crypto')).toBase64Url(
      (await admin.derive()).keys.authKey,
    );
    await awayFromTotpStepEdge();
    const next = await admin.req('POST', '/auth/mfa/backup-codes', {
      authKey,
      code: await totp(parseTotpInput(setup.secret), Date.now() + 30_000),
    });
    expect(next.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 400));
    expect(mails.some((m) => m.to === 'admin@example.com')).toBe(false);
  });
});
