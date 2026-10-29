import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ledger, mailQueue, settings } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';
import { fakeSmtp, makePki } from './smtp-fake.js';

// Синтетические учётные данные; серверы — управляемые стенды на loopback (в рабочем режиме loopback закрыт).
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let pki: Awaited<ReturnType<typeof makePki>>;
let otherPki: Awaited<ReturnType<typeof makePki>>;
const servers: { close: () => Promise<void> }[] = [];
const PASSWORD = 'synthetic-Smtp-pass-1';

const profile = (port: number, extra: Record<string, unknown> = {}) => ({
  name: 'Test relay',
  host: '127.0.0.1',
  port,
  security: 'starttls',
  auth: 'none',
  from: 'arklock@example.com',
  ...extra,
});
const create = async (body: Record<string, unknown>, step = false) => {
  const r = step
    ? await admin.reqStep('POST', '/admin/smtp/profiles', body)
    : await admin.req('POST', '/admin/smtp/profiles', body);
  return { r, id: (r.json() as { id?: string }).id! };
};
const start = async (opts: Parameters<typeof fakeSmtp>[0] = {}) => {
  const s = await fakeSmtp(opts);
  servers.push(s);
  return s;
};
const check = async (id: string) =>
  (await admin.req('POST', `/admin/smtp/profiles/${id}/check`)).json();
const stagesOf = (c: { stages: { stage: string; ok: boolean; skipped?: boolean }[] }) =>
  Object.fromEntries(c.stages.map((s) => [s.stage, s]));
const enc = encodeURIComponent;
const queue = async (query = '') => (await admin.req('GET', `/admin/smtp/queue${query}`)).json();
const waitFor = async <T>(fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 250));
  }
};

beforeAll(async () => {
  fixture = await createTestApp({ SMTP_TEST_MAILS_PER_10MIN: '500', SMTP_CHECKS_PER_10MIN: '500' });
  admin = new TestClient(fixture.app, 'mail-admin@example.com', 'mail-admin-password-1');
  expect((await admin.register()).statusCode).toBe(201);
  await admin.login();
  pki = await makePki('localhost');
  otherPki = await makePki('mail.other.example');
});
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await fixture.app.close();
});

describe('profiles', () => {
  it('stores the password sealed, never returns it, and keeps it out of the log and the audit trail', async () => {
    const s = await start({
      authBefore: [],
      auth: ['PLAIN'],
      user: 'mailer',
      password: PASSWORD,
      tls: { mode: 'starttls', key: pki.keyPem, cert: pki.certPem },
    });
    const { r, id } = await create(
      profile(s.port, { auth: 'password', user: 'mailer', password: PASSWORD, verifyCert: false }),
      true,
    );
    expect(r.statusCode).toBe(201);
    const list = (await admin.req('GET', '/admin/smtp/profiles')).json();
    expect(JSON.stringify(list)).not.toContain(PASSWORD);
    expect(list.profiles.find((p: { id: string }) => p.id === id)).toMatchObject({
      auth: 'password',
      user: 'mailer',
      hasPassword: true,
      verifyCert: false,
      fromName: '',
      timeoutSec: 15,
    });
    const [row] = await fixture.database.db
      .select()
      .from(settings)
      .where(eq(settings.key, `smtp.profile.${id}`));
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    const ok = await check(id);
    expect(ok.ok).toBe(true);
    const audits = await fixture.database.db.select().from(ledger);
    expect(JSON.stringify(audits)).not.toContain(PASSWORD);
    // изменение профиля без нового пароля оставляет прежний
    const put = await admin.reqStep(
      'PUT',
      `/admin/smtp/profiles/${id}`,
      profile(s.port, { auth: 'password', user: 'mailer', verifyCert: false, name: 'Renamed' }),
    );
    expect(put.statusCode).toBe(200);
    expect((await check(id)).ok).toBe(true);
  });

  it('refuses unsafe or inconsistent settings with a reason', async () => {
    const post = (b: Record<string, unknown>) => admin.req('POST', '/admin/smtp/profiles', b);
    expect(
      (
        await post(
          profile(2525, { auth: 'ntlm', user: 'CORP\\svc', password: 'x', security: 'none' }),
        )
      ).statusCode,
    ).toBe(400);
    expect((await post(profile(2525, { auth: 'password', user: '' }))).json().error.code).toBe(
      'smtp_account_required',
    );
    expect((await post(profile(22))).statusCode).toBe(400); // порт SSH
    expect(
      (await post(profile(2525, { host: ['169', '254', '169', '254'].join('.') }))).json().error
        .code,
    ).toBe('smtp_target_forbidden');
    expect((await post(profile(2525, { caId: crypto.randomUUID() }))).json().error.code).toBe(
      'smtp_ca_unknown',
    );
    expect((await post(profile(2525, { timeoutSec: 1 }))).statusCode).toBe(400);
  });

  it('plaintext and switched-off certificate checks need the chief administrator, the master password and leave an audit record', async () => {
    const s = await start();
    const bad = await admin.req(
      'POST',
      '/admin/smtp/profiles',
      profile(s.port, { security: 'none' }),
    );
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe('reauth_required');
    const off = await admin.req(
      'POST',
      '/admin/smtp/profiles',
      profile(s.port, { verifyCert: false }),
    );
    expect(off.json().error.code).toBe('reauth_required');
    const { r, id } = await create(profile(s.port, { security: 'none' }), true);
    expect(r.statusCode).toBe(201);
    const trail = await fixture.database.db.select().from(ledger);
    const insecure = trail.filter(
      (e) => e.action === 'admin.smtp.insecure' && e.target === `smtp:${id}`,
    );
    expect(insecure).toHaveLength(1);
    expect(insecure[0]!.actor).toBe(`user:${admin.userId}`);
    // небезопасный режим не включается сам: ошибка соединения его не меняет
    const saved = (await admin.req('GET', '/admin/smtp/profiles'))
      .json()
      .profiles.find((p: { id: string }) => p.id === id);
    expect(saved.security).toBe('none');
  });
});

describe('connection check', () => {
  it('walks the stages for a plain relay and skips what the settings do not need', async () => {
    const s = await start();
    const { id } = await create(profile(s.port, { security: 'none' }), true);
    const c = await check(id);
    expect(c.ok).toBe(true);
    const st = stagesOf(c);
    expect(st.dns!.ok && st.tcp!.ok && st.greeting!.ok && st.ehlo!.ok).toBe(true);
    expect(st.tls!.skipped).toBe(true);
    expect(st.certificate!.skipped).toBe(true);
    expect(st.auth!.skipped).toBe(true);
    expect(s.received).toHaveLength(0); // проверка письма не отправляет
    const status = (await admin.req('GET', '/admin/smtp/profiles'))
      .json()
      .profiles.find((p: { id: string }) => p.id === id).status;
    expect(status).toMatchObject({ ok: true });
    expect(status.lastSuccessAt).toBeTruthy();
  });

  it('STARTTLS: an untrusted certificate stops at the certificate stage and shows what the server presented; the trusted CA fixes it', async () => {
    const s = await start({ tls: { mode: 'starttls', key: pki.keyPem, cert: pki.certPem } });
    const { id } = await create(profile(s.port, { host: 'localhost' }));
    const c = await check(id);
    expect(c.ok).toBe(false);
    expect(c.code).toBe('certificate');
    const st = stagesOf(c);
    expect(st.certificate!.ok).toBe(false);
    expect((st.certificate as { info?: Record<string, unknown> }).info).toMatchObject({
      reason: 'untrusted',
      issuer: 'Arklock Test CA',
    });
    expect(
      ((st.certificate as { info?: Record<string, string> }).info ?? {}).fingerprint256,
    ).toBeTruthy();
    // загрузка CA и выбор его для профиля
    const added = await admin.req('POST', '/admin/smtp/cas', { name: 'Test CA', pem: pki.caPem });
    expect(added.statusCode).toBe(201);
    const caId = added.json().ids[0];
    const cas = (await admin.req('GET', '/admin/smtp/cas')).json();
    expect(cas[0]).not.toHaveProperty('pem');
    expect(
      (
        await admin.req(
          'PUT',
          `/admin/smtp/profiles/${id}`,
          profile(s.port, { host: 'localhost', caId }),
        )
      ).statusCode,
    ).toBe(200);
    const fixed = await check(id);
    expect(fixed.ok).toBe(true);
    expect(stagesOf(fixed).certificate).toMatchObject({
      ok: true,
      info: { verified: true, issuer: 'Arklock Test CA' },
    });
    expect(stagesOf(fixed).tls!.ok).toBe(true);
    // CA нельзя удалить, пока он выбран в профиле
    expect((await admin.req('DELETE', `/admin/smtp/cas/${caId}`)).statusCode).toBe(409);
  });

  it('implicit TLS and a server name that does not match the certificate', async () => {
    const s = await start({ tls: { mode: 'tls', key: otherPki.keyPem, cert: otherPki.certPem } });
    const cas = (
      await admin.req('POST', '/admin/smtp/cas', { name: 'Other CA', pem: otherPki.caPem })
    ).json().ids[0];
    const good = await create(
      profile(s.port, { security: 'tls', host: '127.0.0.1', caId: cas }),
    ).then((x) => x.id);
    expect((await check(good)).ok).toBe(true); // адрес входит в SAN
    const named = await create(
      profile(s.port, { security: 'tls', host: 'localhost', caId: cas }),
    ).then((x) => x.id);
    const c = await check(named);
    expect(c.ok).toBe(false);
    expect(c.code).toBe('certificate');
    expect((stagesOf(c).certificate as { info?: Record<string, unknown> }).info?.reason).toBe(
      'hostname',
    );
    // отключённая проверка проходит, но отмечена как небезопасная
    const off = await create(
      profile(s.port, { security: 'tls', host: 'localhost', verifyCert: false }),
      true,
    ).then((x) => x.id);
    const c2 = await check(off);
    expect(c2.ok).toBe(true);
    expect(stagesOf(c2).certificate).toMatchObject({ ok: true, warn: true });
  });

  it('shows the sign-in methods announced before and after STARTTLS and picks one that works', async () => {
    const s = await start({
      authBefore: ['NTLM'],
      auth: ['NTLM', 'LOGIN'],
      user: 'mailer',
      password: PASSWORD,
      tls: { mode: 'starttls', key: pki.keyPem, cert: pki.certPem },
    });
    const { id } = await create(
      profile(s.port, { auth: 'password', user: 'mailer', password: PASSWORD, verifyCert: false }),
      true,
    );
    const c = await check(id);
    expect(c.ok).toBe(true);
    expect(c.methods).toEqual({ before: ['NTLM'], after: ['NTLM', 'LOGIN'] });
    const bad = await create(
      profile(s.port, {
        auth: 'password',
        user: 'mailer',
        password: 'wrong-pass-9',
        verifyCert: false,
      }),
      true,
    );
    const cb = await check(bad.id);
    expect(cb.ok).toBe(false);
    expect(cb.code).toBe('auth_failed');
    expect(cb.stage).toBe('auth');
    expect(cb.smtpStatus).toBe(535);
    expect(cb.text).toContain('Authentication failed');
    expect(JSON.stringify(cb)).not.toContain('wrong-pass-9');
  });

  it('a password is never sent unencrypted by accident: explicit consent, confirmation only when protection is lowered', async () => {
    const s = await start({ auth: ['PLAIN'], user: 'mailer', password: 'right-password-1' });
    const body = profile(s.port, {
      security: 'none',
      auth: 'password',
      user: 'mailer',
      password: 'right-password-1',
    });
    const refused = await create(body, true);
    expect(refused.r.statusCode).toBe(400);
    expect(refused.r.json().error.details).toEqual([
      { path: 'plainAuth', code: 'plain_auth_consent' },
    ]);
    // согласие есть, но защита снижается — без подтверждения паролем нельзя
    expect((await create({ ...body, plainAuth: true })).r.json().error.code).toBe(
      'reauth_required',
    );
    const { id } = await create({ ...body, plainAuth: true }, true);
    expect((await check(id)).ok).toBe(true);
    // повторное сохранение принятого решения (другое имя отправителя) не требует подтверждения
    const resave = await admin.req('PUT', `/admin/smtp/profiles/${id}`, {
      ...body,
      plainAuth: true,
      fromName: 'Arklock (почта)',
    });
    expect(resave.statusCode).toBe(200);
  });

  it('a password echoed back by the server never reaches the response or the stored log text', async () => {
    const s = await start({
      auth: ['PLAIN'],
      user: 'mailer',
      password: 'right-password-1',
      echoPassword: true,
    });
    const { id } = await create(
      profile(s.port, {
        security: 'none',
        auth: 'password',
        user: 'mailer',
        password: 'echoed-secret-77',
        plainAuth: true,
      }),
      true,
    );
    const c = await check(id);
    expect(c.ok).toBe(false);
    expect(JSON.stringify(c)).not.toContain('echoed-secret-77');
    expect(c.text).toContain('***');
  });

  it('reports a closed port, a missing name and a forbidden port at the right stage', async () => {
    const closed = await start();
    const port = closed.port;
    await closed.close();
    servers.pop();
    const { id } = await create(profile(port, { security: 'none' }), true);
    const c = await check(id);
    expect(c).toMatchObject({ ok: false, code: 'connect', stage: 'tcp' });
    const missing = await create(
      profile(2525, { host: 'no-such-host.invalid', security: 'none' }),
      true,
    );
    expect(await check(missing.id)).toMatchObject({ ok: false, code: 'dns', stage: 'dns' });
  });

  it('refuses a second check of the same profile while one is running and throttles floods', async () => {
    const slow = await start({ greetingDelay: 800 });
    const { id } = await create(profile(slow.port, { security: 'none' }), true);
    const [a, b] = await Promise.all([
      admin.req('POST', `/admin/smtp/profiles/${id}/check`),
      admin.req('POST', `/admin/smtp/profiles/${id}/check`),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });
});

describe('Windows NTLM', () => {
  const ntlmProfile = (port: number, account: string, password = 'N7lm-Synthetic-pw') =>
    profile(port, { auth: 'ntlm', user: account, password, verifyCert: false });
  const tlsOpt = () => ({ tls: { mode: 'starttls' as const, key: pki.keyPem, cert: pki.certPem } });

  it('signs in with DOMAIN\\user, including the message integrity check when the server sends a timestamp', async () => {
    const s = await start({
      ...tlsOpt(),
      authBefore: [],
      auth: ['NTLM'],
      ntlm: {
        user: 'svc-mail',
        domain: 'CORP',
        password: 'N7lm-Synthetic-pw',
        withTimestamp: true,
      },
    });
    const { id } = await create(ntlmProfile(s.port, 'CORP\\svc-mail'), true);
    const c = await check(id);
    expect(c.ok).toBe(true);
    expect(s.stats.ntlmV2).toBe(1);
    expect(s.stats.micChecked).toBe(1);
    expect(s.log.join('\n')).not.toContain('N7lm-Synthetic-pw');
  });

  it('works without a timestamp (LMv2 response) and with a user@domain account', async () => {
    const s = await start({
      ...tlsOpt(),
      authBefore: [],
      auth: ['NTLM'],
      ntlm: {
        user: 'svc-mail@corp.example',
        domain: '',
        password: 'N7lm-Synthetic-pw',
        withTimestamp: false,
      },
    });
    const { id } = await create(ntlmProfile(s.port, 'svc-mail@corp.example'), true);
    expect((await check(id)).ok).toBe(true);
    expect(s.stats.micChecked).toBe(0);
  });

  it('a wrong password is an authentication failure that is never retried', async () => {
    const s = await start({
      ...tlsOpt(),
      authBefore: [],
      auth: ['NTLM'],
      ntlm: {
        user: 'svc-mail',
        domain: 'CORP',
        password: 'N7lm-Synthetic-pw',
        withTimestamp: true,
      },
    });
    const { id } = await create(ntlmProfile(s.port, 'CORP\\svc-mail', 'wrong-Ntlm-pw-3'), true);
    const c = await check(id);
    expect(c).toMatchObject({ ok: false, code: 'auth_failed', stage: 'auth', smtpStatus: 535 });
    const sent = (
      await admin.req('POST', `/admin/smtp/profiles/${id}/send-test`, { to: 'boss@example.com' })
    ).json();
    expect(sent.ok).toBe(false);
    expect(sent.code).toBe('auth_failed');
    const row = (await queue(`?recipient=${enc('boss@example.com')}&status=failed`)).items.find(
      (i: { id: string }) => i.id === sent.id,
    );
    expect(row).toMatchObject({ attempts: 1, status: 'failed' }); // повтор неверного пароля заблокировал бы учётную запись
  });

  it('says what the server offers when NTLM is not among the methods', async () => {
    const s = await start({
      ...tlsOpt(),
      authBefore: [],
      auth: ['PLAIN', 'LOGIN'],
      user: 'mailer',
      password: 'x1y2z3w4',
    });
    const { id } = await create(ntlmProfile(s.port, 'CORP\\svc-mail'), true);
    const c = await check(id);
    expect(c).toMatchObject({ ok: false, code: 'auth_unsupported', stage: 'methods' });
    expect((stagesOf(c).methods as unknown as { info: { after: string[] } }).info.after).toEqual([
      'PLAIN',
      'LOGIN',
    ]);
  });
});

describe('test mail and the delivery log', () => {
  it('reports "accepted by the server" with its identifiers and never claims inbox delivery', async () => {
    const s = await start();
    const { id } = await create(
      profile(s.port, { security: 'none', fromName: 'Arklock Почта' }),
      true,
    );
    const r = (
      await admin.req('POST', `/admin/smtp/profiles/${id}/send-test`, { to: 'boss@example.com' })
    ).json();
    expect(r).toMatchObject({
      ok: true,
      accepted: true,
      deliveryConfirmed: false,
      smtpRef: 'FAKE123',
    });
    expect(r.messageId).toMatch(/^[0-9a-f-]{36}@example\.com$/);
    expect(s.received[0]!.data).toContain('From: =?UTF-8?B?');
    expect(s.received[0]!.messageId).toBe(r.messageId);
    const log = await queue(`?recipient=${enc('boss@example.com')}`);
    expect(log.items[0]).toMatchObject({
      status: 'accepted',
      attempts: 1,
      type: 'test',
      profileId: id,
      messageId: r.messageId,
      smtpRef: 'FAKE123',
      profileName: 'Test relay',
    });
    const [row] = await fixture.database.db.select().from(mailQueue).where(eq(mailQueue.id, r.id));
    expect(row!.payloadCipher).toBe(''); // содержимое письма стёрто после приёма
  });

  it('a temporary refusal is retried with a pause and then accepted; a permanent one is not retried', async () => {
    const s = await start({ rcpt: (n) => (n === 1 ? '451 4.7.1 Try again later' : null) });
    const { id } = await create(profile(s.port, { security: 'none' }), true);
    // тест через очередь, как настоящие письма (приглашение, оповещение)
    const first = (
      await admin.req('POST', `/admin/smtp/profiles/${id}/send-test`, { to: 'retry@example.com' })
    ).json();
    expect(first).toMatchObject({
      ok: false,
      queued: true,
      code: 'temporary',
      stage: 'recipient',
      smtpStatus: 451,
    });
    let row = (await queue(`?recipient=${enc('retry@example.com')}`)).items[0];
    expect(row).toMatchObject({ status: 'retry', attempts: 1 });
    expect(new Date(row.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    // срок повтора наступил: фоновая доставка принимает письмо без участия человека
    await fixture.database.db
      .update(mailQueue)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(mailQueue.id, first.id));
    row = await waitFor(async () => {
      const r = (await queue(`?recipient=${enc('retry@example.com')}`)).items[0];
      return r.status === 'accepted' ? r : false;
    });
    expect(row.attempts).toBe(2);

    const perm = await start({ rcpt: () => '550 5.1.1 <nobody@example.com> User unknown' });
    const p2 = await create(profile(perm.port, { security: 'none' }), true);
    const f = (
      await admin.req('POST', `/admin/smtp/profiles/${p2.id}/send-test`, {
        to: 'nobody@example.com',
      })
    ).json();
    expect(f).toMatchObject({
      ok: false,
      code: 'recipient_rejected',
      stage: 'recipient',
      smtpStatus: 550,
    });
    expect(f.queued).toBe(false);
    expect(f.text).toContain('User unknown');
    expect(perm.stats.rcpt).toBe(1);
  });

  it('manual retry works while the message is still valid, refuses an expired one, and queued mail can be cancelled', async () => {
    let refuse = true;
    const s = await start({ rcpt: () => (refuse ? '550 5.7.1 Unable to relay' : null) });
    const { id } = await create(profile(s.port, { security: 'none' }), true);
    const sent = (
      await admin.req('POST', `/admin/smtp/profiles/${id}/send-test`, { to: 'manual@example.com' })
    ).json();
    expect(sent).toMatchObject({ ok: false, code: 'relay_denied' });
    refuse = false;
    const again = await admin.req('POST', `/admin/smtp/queue/${sent.id}/retry`);
    expect(again.statusCode).toBe(200);
    await waitFor(
      async () =>
        (await queue(`?recipient=${enc('manual@example.com')}`)).items[0].status === 'accepted',
    );
    // просроченное не отправляется
    refuse = true;
    const old = (
      await admin.req('POST', `/admin/smtp/profiles/${id}/send-test`, { to: 'expired@example.com' })
    ).json();
    await fixture.database.db
      .update(mailQueue)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mailQueue.id, old.id));
    const r = await admin.req('POST', `/admin/smtp/queue/${old.id}/retry`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('mail_not_retryable');
    // отмена того, что ждёт в очереди
    const [waiting] = await fixture.database.db
      .insert(mailQueue)
      .values({
        id: crypto.randomUUID(),
        profileId: id,
        to: 'cancel@example.com',
        type: 'test',
        payloadCipher: 'x',
        expiresAt: new Date(Date.now() + 3_600_000),
        nextAttemptAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    expect((await admin.req('POST', `/admin/smtp/queue/${waiting!.id}/cancel`)).statusCode).toBe(
      200,
    );
    expect((await queue('?status=cancelled')).items.map((i: { id: string }) => i.id)).toContain(
      waiting!.id,
    );
    expect((await admin.req('POST', `/admin/smtp/queue/${waiting!.id}/cancel`)).statusCode).toBe(
      409,
    );
  });

  it('mail survives a restart: a message left "sending" by a crashed process is delivered when its lease ends', async () => {
    const s = await start();
    const { id } = await create(profile(s.port, { security: 'none' }), true);
    const sent = (
      await admin.req('POST', `/admin/smtp/profiles/${id}/send-test`, { to: 'x@example.com' })
    ).json();
    expect(sent.ok).toBe(true);
    const stuck = crypto.randomUUID();
    await fixture.database.db.insert(mailQueue).values({
      id: stuck,
      profileId: id,
      to: 'restart@example.com',
      type: 'test',
      status: 'sending',
      attempts: 1,
      lockToken: crypto.randomUUID(),
      lockedAt: new Date(Date.now() - 10 * 60_000),
      payloadCipher: '',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    // без содержимого письмо не отправить: оно завершается ошибкой, но не теряется и не застревает в «отправляется»
    const row = await waitFor(async () => {
      const r = (await queue(`?recipient=${enc('restart@example.com')}`)).items[0];
      return r && r.status !== 'sending' ? r : false;
    });
    expect(row.status).toBe('failed');
  });

  it('routes mail types to their profile and falls back to a backup profile when the main server is down', async () => {
    const main = await start();
    const alt = await start();
    const backup = await start();
    const a = await create(profile(main.port, { security: 'none', name: 'Main' }), true);
    await admin.req('PUT', '/admin/smtp/active', { id: a.id });
    const routed = await create(
      profile(alt.port, { security: 'none', name: 'Invitations', purposes: ['invitation'] }),
      true,
    );
    const invite = (email: string) =>
      admin.req('POST', '/admin/invitations', { email, sendEmail: true });
    expect((await invite('routed@example.com')).json().emailed).toBe(true);
    expect(alt.received.map((m) => m.to)).toEqual(['routed@example.com']);
    expect(main.received.some((m) => m.to === 'routed@example.com')).toBe(false);
    expect((await queue(`?recipient=${enc('routed@example.com')}`)).items[0]).toMatchObject({
      profileId: routed.id,
      type: 'invitation',
      category: 'invitation',
      status: 'accepted',
    });

    // профиль приглашений недоступен по соединению: письмо принимает резервный, журнал называет его
    await admin.req('DELETE', `/admin/smtp/profiles/${routed.id}`);
    const dead = await start();
    const deadPort = dead.port;
    await dead.close();
    servers.pop();
    const broken = await create(
      profile(deadPort, { security: 'none', name: 'Broken', purposes: ['invitation'] }),
      true,
    );
    const spare = await create(
      profile(backup.port, { security: 'none', name: 'Spare', fallback: true }),
      true,
    );
    expect((await invite('fallback@example.com')).json().emailed).toBe(true);
    expect(backup.received.map((m) => m.to)).toEqual(['fallback@example.com']);
    expect((await queue(`?recipient=${enc('fallback@example.com')}`)).items[0]).toMatchObject({
      profileId: spare.id,
      profileName: 'Spare',
      status: 'accepted',
    });
    const statuses = (await admin.req('GET', '/admin/smtp/profiles')).json().profiles as {
      id: string;
      status: { ok: boolean | null; code: string | null };
    }[];
    expect(statuses.find((p) => p.id === broken.id)!.status).toMatchObject({
      ok: false,
      code: 'connect',
    });
    expect(statuses.find((p) => p.id === spare.id)!.status.ok).toBe(true);
  });
});

describe('the delivery log', () => {
  it('filters by status, recipient, profile, type and period, searches, and pages on the server', async () => {
    const s = await start({ rcpt: (n) => (n % 2 === 0 ? '550 5.1.1 User unknown' : null) });
    const { id } = await create(profile(s.port, { security: 'none', name: 'Log profile' }), true);
    for (let i = 0; i < 4; i++)
      await admin.req('POST', `/admin/smtp/profiles/${id}/send-test`, {
        to: `log${i}@example.com`,
      });
    const all = await queue(`?profile=${id}&limit=3`);
    expect(all.items).toHaveLength(3);
    expect(all.total).toBe(4);
    const page2 = await queue(`?profile=${id}&limit=3&offset=3`);
    expect(page2.items).toHaveLength(1);
    expect(new Set([...all.items, ...page2.items].map((i: { id: string }) => i.id)).size).toBe(4);
    expect((await queue(`?profile=${id}&status=accepted`)).total).toBe(2);
    expect((await queue(`?profile=${id}&status=sent`)).total).toBe(2); // прежнее имя статуса
    expect((await queue(`?profile=${id}&status=failed`)).total).toBe(2);
    expect((await queue(`?profile=${id}&errors=1`)).total).toBe(2);
    expect((await queue(`?profile=${id}&recipient=log1`)).total).toBe(1);
    expect((await queue(`?profile=${id}&q=Log%20profile`)).total).toBe(4);
    expect((await queue(`?profile=${id}&q=user%20unknown`)).total).toBe(2);
    expect((await queue(`?profile=${id}&type=invitation`)).total).toBe(0);
    expect(
      (await queue(`?profile=${id}&from=${new Date(Date.now() + 3_600_000).toISOString()}`)).total,
    ).toBe(0);
    expect(
      (await queue(`?profile=${id}&to=${new Date(Date.now() + 3_600_000).toISOString()}`)).total,
    ).toBe(4);
    // подстановочные знаки в поиске — обычные символы
    expect((await queue(`?profile=${id}&recipient=%25`)).total).toBe(0);
    const totals = (await queue(`?profile=${id}`)).totals as { status: string; count: number }[];
    expect(totals.find((t) => t.status === 'accepted')?.count).toBeGreaterThanOrEqual(2);
  });

  it('log rows hold neither passwords nor message bodies', async () => {
    const rows = await fixture.database.db.select().from(mailQueue);
    expect(rows.length).toBeGreaterThan(5);
    const dump = JSON.stringify(rows);
    for (const secret of [PASSWORD, 'N7lm-Synthetic-pw', 'wrong-Ntlm-pw-3', 'echoed-secret-77'])
      expect(dump).not.toContain(secret);
    for (const r of rows.filter((r) => r.status === 'sent')) expect(r.payloadCipher).toBe('');
  });
});

describe('access', () => {
  it('only an administrator reaches mail settings', async () => {
    const member = new TestClient(fixture.app, 'mail-member@example.com', 'mail-member-password-1');
    await fixture.database.db
      .insert(settings)
      .values({ key: 'registration.mode', value: 'open' })
      .onConflictDoNothing();
    expect((await member.register()).statusCode).toBe(201);
    await member.login();
    for (const [m, u] of [
      ['GET', '/admin/smtp/profiles'],
      ['GET', '/admin/smtp/queue'],
      ['GET', '/admin/smtp/cas'],
      ['POST', '/admin/smtp/profiles/default/check'],
    ] as const)
      expect((await member.req(m, u)).statusCode, u).toBe(403);
  });
});

describe('trusting the certificate the server presents', () => {
  /** Самоподписанный сертификат сервера, выданный на внутреннее имя (не на то, по которому идёт подключение). */
  async function selfSigned(cn: string) {
    const { webcrypto } = await import('node:crypto');
    const x509 = await import('@peculiar/x509');
    const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
    const keys = (await webcrypto.subtle.generateKey(alg, true, [
      'sign',
      'verify',
    ])) as unknown as CryptoKeyPair;
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: '2a',
      name: `CN=${cn}`,
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
  const certStage = (c: {
    stages: { stage: string; ok: boolean; info?: Record<string, unknown> }[];
  }) => c.stages.find((s) => s.stage === 'certificate');

  it('the presented certificate is pinned by fingerprint; only it is accepted; changing the server or untrusting removes the trust', async () => {
    const own = await selfSigned('mail01');
    const s = await start({ tls: { mode: 'starttls', ...own } });
    const { id } = await create(profile(s.port, { security: 'starttls', auth: 'none' }));
    const before = await check(id);
    expect(before.ok).toBe(false);
    const seenStage = certStage(before)!;
    expect(seenStage).toMatchObject({ ok: false, info: { reason: 'self_signed' } });
    const { info: seenInfo } = seenStage;
    const fingerprint = seenInfo!.fingerprint256 as string;
    expect(fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

    // отпечаток не тот, что предъявляет сервер, — отказ (сертификат подменили или сменили)
    const wrong = await admin.req('POST', `/admin/smtp/profiles/${id}/trust-certificate`, {
      fingerprint256: fingerprint.replace(/^../, fingerprint.startsWith('00') ? '11' : '00'),
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe('smtp_cert_changed');

    const trusted = await admin.req('POST', `/admin/smtp/profiles/${id}/trust-certificate`, {
      fingerprint256: fingerprint,
    });
    expect(trusted.statusCode).toBe(200);
    expect(trusted.json().pinnedCert).toMatchObject({
      fingerprint256: fingerprint,
      subject: 'mail01',
    });
    const listed = (await admin.req('GET', '/admin/smtp/profiles'))
      .json()
      .profiles.find((p: { id: string }) => p.id === id);
    expect(listed.pinnedCert.fingerprint256).toBe(fingerprint);

    const after = await check(id);
    expect(after.ok).toBe(true);
    expect(certStage(after)).toMatchObject({ ok: true, info: { pinned: true, verified: true } });
    const ledger = JSON.stringify(
      (await admin.req('GET', '/admin/ledger?q=admin.smtp.cert.trust')).json(),
    );
    expect(ledger).toContain('admin.smtp.cert.trust');

    // другой сервер с другим сертификатом: доверие не переносится
    const other = await selfSigned('mail02');
    const s2 = await start({ tls: { mode: 'starttls', ...other } });
    expect(
      (
        await admin.req(
          'PUT',
          `/admin/smtp/profiles/${id}`,
          profile(s2.port, { security: 'starttls', auth: 'none' }),
        )
      ).statusCode,
    ).toBe(200);
    expect((await check(id)).ok).toBe(false);
    expect(
      (
        await admin.req(
          'PUT',
          `/admin/smtp/profiles/${id}`,
          profile(s.port, { security: 'starttls', auth: 'none' }),
        )
      ).statusCode,
    ).toBe(200);
    expect((await check(id)).ok).toBe(false);

    // снова доверяем и снимаем доверие
    await admin.req('POST', `/admin/smtp/profiles/${id}/trust-certificate`, {
      fingerprint256: fingerprint,
    });
    expect((await check(id)).ok).toBe(true);
    expect(
      (await admin.req('DELETE', `/admin/smtp/profiles/${id}/trust-certificate`)).statusCode,
    ).toBe(204);
    expect((await check(id)).ok).toBe(false);
  });

  it('a pinned fingerprint does not let a different certificate through', async () => {
    const { smtpSession } = await import('../src/mail/smtp.js');
    const own = await selfSigned('mail01');
    const s = await start({ tls: { mode: 'starttls', ...own } });
    const err = await smtpSession(
      {
        host: '127.0.0.1',
        port: s.port,
        security: 'starttls',
        auth: 'none',
        user: '',
        password: '',
        from: 'arklock@example.com',
        allowLoopback: true,
        pinnedFingerprint: Array(32).fill('AB').join(':'),
      },
      null,
    ).catch((e: unknown) => e as { code: string; detail?: { reason?: string } });
    expect(err).toMatchObject({ code: 'certificate', detail: { reason: 'pin_mismatch' } });
  });
});
