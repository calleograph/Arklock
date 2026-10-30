import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { email, uuid } from '@arklock/contracts';
import { audit } from '../audit.js';
import { adminGate } from '../auth/adminperm.js';
import { authOf, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { mailQueue, settings } from '../db/schema.js';
import { AppError, notFound, parse } from '../errors.js';
import { sealSetting } from '../secretbox.js';
import {
  activeSmtpId,
  authOf as authMethodOf,
  loadSmtpProfile,
  loadStoredSmtp,
  loadTrustedCas,
  loopbackAllowed,
  publicSmtp,
  recordSmtpStatus,
  SMTP_ACTIVE_KEY,
  SMTP_CA_KEY,
  smtpPasswordPurpose,
  smtpProfileId,
  pinnedCert,
  smtpProfileKey,
  smtpProfiles,
  smtpPut,
  toSmtpConfig,
  type StoredSmtp,
} from '../mail/profiles.js';
import { enqueueMail, mailFailure, sendQueuedMail } from '../mail/send.js';
import { probeCertificate, serverText, smtpSession, type StageResult } from '../mail/smtp.js';
import { isForbiddenSmtpAddress, resolveSmtpTarget, TargetError } from '../mail/target.js';
import net from 'node:net';
import {
  loadMailTemplates,
  MAIL_NOTIFICATIONS_KEY,
  MAIL_TEMPLATES_KEY,
  mailNotificationPreferences,
  mailType,
  notificationWrite,
  previewTemplate,
  renderMail,
  templateVariables,
  templateWrite,
  validTemplate,
} from '../mail/templates.js';
import { chiefRequired } from './chief.js';
import { CertError, certUploadBytes, parseCertificates } from '../net/certs.js';

/** Скользящее окно по ключу: не больше `max` событий за `windowMs`. В памяти процесса. */
class Window {
  private readonly hits = new Map<string, number[]>();
  take(key: string, max: number, windowMs: number, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

export const registerAdminSmtpRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (
  app,
  { ctx },
) => {
  const { db } = ctx;
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('preHandler', (req) => adminGate(ctx, req));
  const params = z.object({ id: smtpProfileId });
  const profileWrite = smtpPut
    .extend({ name: z.string().trim().min(1).max(100), confirmInsecure: z.boolean().optional() })
    .strict();

  // тестовые письма и проверки: не чаще лимита на администратора и на сервер, одна проверка профиля за раз
  const limits = new Window();
  const running = new Set<string>();
  const throttle = (userId: string, kind: 'check' | 'mail'): void => {
    const per =
      kind === 'mail' ? ctx.config.SMTP_TEST_MAILS_PER_10MIN : ctx.config.SMTP_CHECKS_PER_10MIN;
    const all = per * 4;
    if (
      !limits.take(`${kind}:${userId}`, per, 10 * 60_000) ||
      !limits.take(`${kind}:*`, all, 10 * 60_000)
    )
      throw new AppError(
        429,
        'smtp_rate_limited',
        'Too many test requests. Try again in a few minutes',
      );
  };
  const exclusive = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (running.has(key))
      throw new AppError(409, 'smtp_busy', 'A check of this profile is already running');
    running.add(key);
    try {
      return await fn();
    } finally {
      running.delete(key);
    }
  };

  /**
   * Подготовка профиля из формы — одна для сохранения и для проверки без сохранения. Значения приводятся к выбранному
   * режиму (без шифрования — нет проверки сертификата и центра; без входа — нет логина и пароля), ошибки собираются
   * все сразу и указывают поле. Снижение защиты — только главный администратор и только с явным подтверждением
   * в форме (confirmInsecure); пароль разблокировки сейфов для этого не нужен.
   */
  async function prepareProfile(
    id: string | null,
    body: z.infer<typeof smtpPut> & { name?: string; confirmInsecure?: boolean },
    req: FastifyRequest,
  ) {
    const { user } = authOf(req);
    const previous = id ? await loadSmtpProfile(ctx, id) : null;
    const auth = body.auth ?? authMethodOf({ auth: undefined, user: body.user });
    const plaintext = body.security === 'none';
    const verifyCert = plaintext ? true : body.verifyCert;
    const caId = plaintext ? null : body.caId;
    const issues: { path: string; code: string }[] = [];
    if (auth !== 'none' && !body.user) issues.push({ path: 'user', code: 'smtp_account_required' });
    if (auth === 'ntlm' && plaintext) issues.push({ path: 'auth', code: 'smtp_ntlm_needs_tls' });
    if (net.isIP(body.host) && isForbiddenSmtpAddress(body.host, loopbackAllowed(ctx)))
      issues.push({ path: 'host', code: 'smtp_target_forbidden' });
    if (caId && !(await loadTrustedCas(ctx)).some((c) => c.id === caId))
      issues.push({ path: 'caId', code: 'smtp_ca_unknown' });
    const unverified = !plaintext && verifyCert === false;
    const plainAuth = plaintext && auth === 'password';
    if (plainAuth && body.plainAuth !== true)
      issues.push({ path: 'plainAuth', code: 'plain_auth_consent' });
    // сохранённый пароль не уходит на другой сервер: при смене адреса или порта его нужно ввести заново
    const moved = !!previous && (previous.host !== body.host || previous.port !== body.port);
    if (moved && auth !== 'none' && previous.passwordCipher && body.password === undefined)
      issues.push({ path: 'password', code: 'password_reentry' });
    const prevPlainAuth =
      !!previous &&
      previous.security === 'none' &&
      authMethodOf(previous) === 'password' &&
      (previous.plainAuth ?? true);
    const lowered =
      (plaintext && previous?.security !== 'none') ||
      (unverified && previous?.verifyCert !== false) ||
      (plainAuth && !prevPlainAuth);
    if ((plaintext || unverified) && !user.chief) throw chiefRequired();
    if (lowered && body.confirmInsecure !== true)
      issues.push({ path: 'confirmInsecure', code: 'insecure_confirm' });
    if (issues.length)
      throw new AppError(400, 'validation_error', 'Check the highlighted fields', issues);
    const value: StoredSmtp = {
      host: body.host,
      port: body.port,
      security: body.security,
      auth,
      user: auth === 'none' ? '' : body.user,
      from: body.from,
      fromName: body.fromName,
      timeoutSec: body.timeoutSec,
      verifyCert,
      caId,
      purposes: body.purposes,
      fallback: body.fallback,
      plainAuth,
      // доверие к сертификату относится к конкретному серверу: при смене адреса или порта оно снимается
      pinnedCert: previous && !moved && !plaintext ? previous.pinnedCert : undefined,
      name: body.name ?? previous?.name ?? 'Default',
      passwordCipher:
        auth === 'none'
          ? ''
          : body.password === undefined
            ? (previous?.passwordCipher ?? '')
            : body.password
              ? sealSetting(
                  ctx.config.APP_SECRET,
                  smtpPasswordPurpose(id ?? 'draft'),
                  body.password,
                )
              : '',
    };
    return { value, previous, auth, plaintext, unverified, plainAuth, lowered };
  }

  async function saveProfile(
    id: string,
    body: z.infer<typeof smtpPut> & { name?: string; confirmInsecure?: boolean },
    req: FastifyRequest,
  ) {
    const { user } = authOf(req);
    const { value, previous, auth, plaintext, unverified, plainAuth, lowered } =
      await prepareProfile(id, body, req);
    await db
      .insert(settings)
      .values({ key: smtpProfileKey(id), value, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedBy: user.id, updatedAt: new Date() },
      });
    // без паролей и значений секретов: только что изменилось и какие небезопасные режимы включены
    const changed = previous
      ? (
          [
            'host',
            'port',
            'security',
            'auth',
            'user',
            'from',
            'fromName',
            'timeoutSec',
            'verifyCert',
            'caId',
            'fallback',
          ] as const
        ).filter(
          (k) =>
            JSON.stringify(k === 'auth' ? authMethodOf(previous) : previous[k]) !==
            JSON.stringify(value[k === 'auth' ? 'auth' : k]),
        )
      : ['created'];
    await audit(db, `user:${user.id}`, 'admin.smtp.save', `smtp:${id}`, {
      host: body.host,
      port: body.port,
      security: body.security,
      auth,
      changed: changed.join(','),
      passwordChanged: body.password !== undefined && auth !== 'none',
      plaintext,
      tlsVerificationOff: unverified,
    });
    if (lowered)
      await audit(db, `user:${user.id}`, 'admin.smtp.insecure', `smtp:${id}`, {
        plaintext,
        tlsVerificationOff: unverified,
        passwordUnencrypted: plainAuth,
      });
  }

  app.get('/admin/smtp', async () => {
    const stored = await loadStoredSmtp(ctx);
    if (!stored) return { configured: false };
    const config: Partial<ReturnType<typeof publicSmtp>> = { ...publicSmtp(stored) };
    delete config.id;
    delete config.name;
    return { configured: true, ...config };
  });
  app.put('/admin/smtp', async (req) => {
    const { user } = authOf(req);
    const body = parse(smtpPut.extend({ confirmInsecure: z.boolean().optional() }), req.body);
    const id = (await activeSmtpId(ctx)) ?? 'default';
    await saveProfile(id, body, req);
    await db
      .insert(settings)
      .values({ key: SMTP_ACTIVE_KEY, value: id, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: id, updatedBy: user.id, updatedAt: new Date() },
      });
    return { ok: true };
  });
  app.get('/admin/smtp/profiles', () => smtpProfiles(ctx));
  app.post('/admin/smtp/profiles', async (req, reply) => {
    const id = crypto.randomUUID();
    await saveProfile(id, parse(profileWrite, req.body), req);
    return reply.status(201).send({ id });
  });
  app.put('/admin/smtp/profiles/:id', async (req) => {
    const { id } = parse(params, req.params);
    if (!(await loadSmtpProfile(ctx, id))) throw notFound();
    await saveProfile(id, parse(profileWrite, req.body), req);
    return { ok: true };
  });
  app.put('/admin/smtp/active', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: smtpProfileId.nullable() }).strict(), req.body);
    if (id && !(await loadSmtpProfile(ctx, id))) throw notFound();
    await db
      .insert(settings)
      .values({ key: SMTP_ACTIVE_KEY, value: id, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: id, updatedBy: user.id, updatedAt: new Date() },
      });
    await audit(db, `user:${user.id}`, 'admin.smtp.activate', id ? `smtp:${id}` : null);
    return { ok: true };
  });
  app.delete('/admin/smtp/profiles/:id', async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(params, req.params);
    const activeId = await activeSmtpId(ctx);
    await db.transaction(async (tx) => {
      const [sending] = await tx
        .select({ id: mailQueue.id })
        .from(mailQueue)
        .where(and(eq(mailQueue.profileId, id), eq(mailQueue.status, 'sending')))
        .limit(1);
      if (sending)
        throw new AppError(
          409,
          'smtp_profile_busy',
          'Wait until the in-flight delivery finishes before deleting this profile',
        );
      const removed = await tx
        .delete(settings)
        .where(eq(settings.key, smtpProfileKey(id)))
        .returning({ key: settings.key });
      if (!removed.length) throw notFound();
      await tx.delete(settings).where(eq(settings.key, `smtp.status.${id}`));
      if (activeId === id)
        await tx
          .insert(settings)
          .values({ key: SMTP_ACTIVE_KEY, value: null, updatedBy: user.id })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: null, updatedBy: user.id, updatedAt: new Date() },
          });
      await tx
        .update(mailQueue)
        .set({
          status: 'failed',
          payloadCipher: '',
          lastCode: 'profile_removed',
          updatedAt: new Date(),
        })
        .where(and(eq(mailQueue.profileId, id), inArray(mailQueue.status, ['queued', 'failed'])));
    });
    await audit(db, `user:${user.id}`, 'admin.smtp.remove', `smtp:${id}`);
    return reply.status(204).send();
  });

  /**
   * Проверка текущих значений формы без сохранения: те же правила, что при сохранении. Пароль из формы используется
   * как есть; без него — сохранённый пароль профиля, и только для того же сервера и порта.
   */
  app.post('/admin/smtp/check-draft', async (req) => {
    const { user } = authOf(req);
    const body = parse(profileWrite.extend({ id: smtpProfileId.optional() }), req.body);
    const { id = null, ...form } = body;
    const { value } = await prepareProfile(id, form, req);
    throttle(user.id, 'check');
    return exclusive(`check:draft:${user.id}`, async () => {
      const stages: StageResult[] = [];
      const config = await toSmtpConfig(ctx, { ...value, profileId: id ?? 'draft' });
      try {
        const response = await smtpSession(config, null, {
          probeCertificate: true,
          onStage: (st) => stages.push(st),
        });
        await audit(db, `user:${user.id}`, 'admin.smtp.test', id ? `smtp:${id}` : null, {
          ok: true,
          draft: true,
        });
        return {
          ok: true,
          banner: response.banner.slice(0, 200),
          stages,
          methods: response.methods,
        };
      } catch (error) {
        const failure = mailFailure(error);
        await audit(db, `user:${user.id}`, 'admin.smtp.test', id ? `smtp:${id}` : null, {
          ok: false,
          draft: true,
          code: failure.code,
          stage: failure.stage,
        });
        return {
          ok: false,
          ...failure,
          text: failure.text ? serverText(failure.text, config.password) : null,
          stages,
        };
      }
    });
  });

  /** Подбор профиля из маршрута: с идентификатором — он, без — активный. */
  const profileOf = async (req: FastifyRequest): Promise<StoredSmtp> => {
    const id = (req.params as { id?: string }).id;
    const profile = id
      ? await loadSmtpProfile(ctx, parse(smtpProfileId, id))
      : await loadStoredSmtp(ctx);
    if (!profile) throw new AppError(409, 'smtp_not_configured', 'SMTP is not configured');
    return profile;
  };

  for (const base of ['/admin/smtp', '/admin/smtp/profiles/:id']) {
    // проверка соединения по этапам: DNS, TCP, приветствие, EHLO, TLS, сертификат, способы входа, вход
    for (const path of [`${base}/test`, `${base}/check`])
      app.post(path, async (req) => {
        const { user } = authOf(req);
        const profile = await profileOf(req);
        throttle(user.id, 'check');
        return exclusive(`check:${profile.profileId}`, async () => {
          const stages: StageResult[] = [];
          const config = await toSmtpConfig(ctx, profile);
          try {
            const response = await smtpSession(config, null, {
              probeCertificate: true,
              onStage: (s) => stages.push(s),
            });
            await recordSmtpStatus(ctx, profile.profileId!, { ok: true });
            await audit(db, `user:${user.id}`, 'admin.smtp.test', `smtp:${profile.profileId}`, {
              ok: true,
            });
            return {
              ok: true,
              banner: response.banner.slice(0, 200),
              stages,
              methods: response.methods,
            };
          } catch (error) {
            const failure = mailFailure(error);
            await recordSmtpStatus(ctx, profile.profileId!, {
              ok: false,
              stage: failure.stage,
              code: failure.code,
            });
            await audit(db, `user:${user.id}`, 'admin.smtp.test', `smtp:${profile.profileId}`, {
              ok: false,
              code: failure.code,
              stage: failure.stage,
              smtpStatus: failure.smtpStatus,
            });
            return {
              ok: false,
              ...failure,
              text: failure.text ? serverText(failure.text, config.password) : null,
              stages,
            };
          }
        });
      });
    /**
     * «Доверять этому сертификату»: сервер снова подключается, получает сертификат, который предъявляет почтовый сервер,
     * и закрепляет его отпечаток, если он совпадает с тем, что видел администратор. Пароль не отправляется.
     */
    app.post(`${base}/trust-certificate`, async (req) => {
      const { user } = authOf(req);
      const profile = await profileOf(req);
      const body = parse(
        z.object({ fingerprint256: pinnedCert.shape.fingerprint256 }).strict(),
        req.body,
      );
      if (profile.security === 'none')
        throw new AppError(
          400,
          'smtp_no_tls',
          'The connection has no TLS: there is no certificate',
        );
      throttle(user.id, 'check');
      const config = await toSmtpConfig(ctx, profile);
      let seen: Awaited<ReturnType<typeof probeCertificate>>;
      try {
        const target = await resolveSmtpTarget(config.host, config.port, config.allowLoopback);
        seen = await probeCertificate(config, target.addresses[0]!);
      } catch (e) {
        throw new AppError(502, 'smtp_cert_unavailable', 'Could not read the server certificate', {
          reason: e instanceof TargetError ? e.code : 'connect',
        });
      }
      if (!seen?.fingerprint256 || seen.fingerprint256 !== body.fingerprint256)
        throw new AppError(
          409,
          'smtp_cert_changed',
          'The server now presents a different certificate: run the check again',
        );
      const pin = {
        fingerprint256: String(seen.fingerprint256),
        subject: String(seen.subject ?? '').slice(0, 500),
        issuer: String(seen.issuer ?? '').slice(0, 500),
        validTo: String(seen.validTo ?? '').slice(0, 40),
        pinnedAt: new Date().toISOString(),
      };
      const { profileId, ...rest } = profile;
      const value: StoredSmtp = { ...rest, pinnedCert: pin };
      await db
        .insert(settings)
        .values({ key: smtpProfileKey(profileId!), value, updatedBy: user.id })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedBy: user.id, updatedAt: new Date() },
        });
      await audit(db, `user:${user.id}`, 'admin.smtp.cert.trust', `smtp:${profileId}`, {
        fingerprint256: pin.fingerprint256,
        subject: pin.subject,
      });
      return { ok: true, pinnedCert: pin };
    });
    app.delete(`${base}/trust-certificate`, async (req, reply) => {
      const { user } = authOf(req);
      const profile = await profileOf(req);
      const { profileId, pinnedCert: _old, ...rest } = profile;
      void _old;
      const value: StoredSmtp = rest;
      await db
        .update(settings)
        .set({ value, updatedBy: user.id, updatedAt: new Date() })
        .where(eq(settings.key, smtpProfileKey(profileId!)));
      await audit(db, `user:${user.id}`, 'admin.smtp.cert.untrust', `smtp:${profileId}`);
      return reply.status(204).send();
    });

    // тестовое письмо: через очередь, как и все письма; «принято сервером» не равно «доставлено в ящик»
    app.post(`${base}/send-test`, async (req) => {
      const { user } = authOf(req);
      const profile = await profileOf(req);
      const address = email.safeParse((req.body as { to?: unknown } | undefined)?.to);
      if (!address.success)
        return { ok: false, code: 'invalid', message: 'Invalid recipient address' };
      throttle(user.id, 'mail');
      return exclusive(`mail:${profile.profileId}`, async () => {
        const rendered = await renderMail(ctx, 'test');
        const queuedId = await enqueueMail(
          ctx,
          address.data,
          rendered.subject,
          rendered.text,
          'test',
          profile.profileId,
        );
        if (!queuedId) throw new AppError(409, 'mail_queue_full', 'Mail queue is full');
        const sent = await sendQueuedMail(ctx, queuedId);
        await audit(db, `user:${user.id}`, 'admin.smtp.send-test', `mail:${queuedId}`, {
          ok: sent?.status === 'sent',
          code: sent?.lastCode ?? null,
        });
        return {
          ok: sent?.status === 'sent',
          accepted: sent?.status === 'sent',
          // подтверждения доставки в ящик у SMTP нет: сервер принял письмо, дальше его путь неизвестен
          deliveryConfirmed: false,
          queued: sent?.status === 'queued',
          id: queuedId,
          messageId: sent?.messageId ?? undefined,
          smtpRef: sent?.smtpRef ?? undefined,
          code: sent?.lastCode ?? undefined,
          stage: sent?.stage ?? undefined,
          text: sent?.text ?? undefined,
          smtpStatus: sent?.smtpStatus ?? undefined,
          attempts: sent?.attempts,
        };
      });
    });
  }

  // доверенные центры сертификации для проверки внутренних почтовых серверов
  /**
   * Что сервер хранит и чем пользуется при проверке TLS: читается из базы каждый раз, цепочки оцениваются по всему
   * набору (промежуточный центр без корневого помечается как неполная цепочка).
   */
  async function trustedList() {
    const cas = await loadTrustedCas(ctx);
    const now = Date.now();
    let byPrint = new Map<string, ReturnType<typeof parseCertificates>['certs'][number]>();
    try {
      const all = parseCertificates(Buffer.from(cas.map((c) => c.pem).join('\n')), { now });
      byPrint = new Map(all.certs.map((c) => [c.fingerprint256, c]));
    } catch {
      /* пустой или повреждённый набор: сведения о цепочке недоступны */
    }
    return cas.map(({ pem: _pem, ...c }) => {
      const info = byPrint.get(c.fingerprint256);
      return {
        ...c,
        stored: true,
        expired: Date.parse(c.validTo) < now,
        daysLeft: Math.floor((Date.parse(c.validTo) - now) / 86_400_000),
        kind: info?.kind ?? 'root',
        // для подтверждения нужна цепочка до корневого центра: если издатель не загружен, это сказано
        chainToRoot: info?.chainToRoot ?? false,
        issuer: info?.issuer ?? '',
        // доверие применяется ко всем профилям с шифрованием
        appliesToAll: true,
      };
    });
  }
  app.get('/admin/smtp/cas', async () => trustedList());
  app.post('/admin/smtp/cas', async (req, reply) => {
    const { user } = authOf(req);
    const body = parse(
      z
        .object({
          name: z.string().trim().min(1).max(100),
          pem: z.string().max(400_000).optional(),
          // файл .cer/.crt/.pem в base64: PEM или DER, формат определяется по содержимому
          data: z.string().max(400_000).optional(),
        })
        .strict(),
      req.body,
    );
    let found;
    try {
      const parsed = parseCertificates(certUploadBytes(body), { requireCa: true });
      found = parsed.certs
        .map((c, i) => ({
          c,
          pem: parsed.pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)![
            i
          ]!,
        }))
        .filter((x) => x.c.isCa && !x.c.expired)
        .map((x) => ({
          pem: x.pem,
          subject: x.c.subject,
          fingerprint256: x.c.fingerprint256,
          validTo: x.c.validTo,
        }));
    } catch (e) {
      throw new AppError(400, 'ca_invalid', 'No usable certificate authority certificate', {
        problem: e instanceof CertError ? e.problem : 'not_certificate',
      });
    }
    if (!found.length)
      throw new AppError(400, 'ca_invalid', 'No usable certificate authority certificate', {
        problem: 'not_ca',
      });
    const existing = await loadTrustedCas(ctx);
    if (existing.length + found.length > 30)
      throw new AppError(409, 'ca_limit', 'Too many trusted certificate authorities');
    const added = found.map((c, i) => ({
      id: crypto.randomUUID(),
      name: found.length > 1 ? `${body.name} (${i + 1})`.slice(0, 100) : body.name,
      ...c,
      addedAt: new Date().toISOString(),
    }));
    const next = [
      ...existing,
      ...added.filter((c) => !existing.some((e) => e.fingerprint256 === c.fingerprint256)),
    ];
    await db
      .insert(settings)
      .values({ key: SMTP_CA_KEY, value: next, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: next, updatedBy: user.id, updatedAt: new Date() },
      });
    await audit(db, `user:${user.id}`, 'admin.smtp.ca.add', null, {
      count: added.length,
      fingerprints: added.map((c) => c.fingerprint256).join(','),
    });
    // ответ строится из того, что сервер прочитал из базы после записи, а не из присланного
    const stored = await trustedList();
    const saved = stored.filter((c) => added.some((a) => a.id === c.id));
    return reply.status(201).send({
      ids: saved.map((c) => c.id),
      saved,
      alreadyStored: found.length - added.filter((c) => saved.some((s) => s.id === c.id)).length,
    });
  });
  app.delete('/admin/smtp/cas/:id', async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const cas = await loadTrustedCas(ctx);
    if (!cas.some((c) => c.id === id)) throw notFound();
    const next = cas.filter((c) => c.id !== id);
    await db
      .insert(settings)
      .values({ key: SMTP_CA_KEY, value: next, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: next, updatedBy: user.id, updatedAt: new Date() },
      });
    await audit(db, `user:${user.id}`, 'admin.smtp.ca.remove', `ca:${id}`);
    return reply.status(204).send();
  });

  // журнал отправки: фильтры, поиск, страницы
  const PUBLIC_STATUS = ['queued', 'retry', 'sending', 'accepted', 'failed', 'cancelled'] as const;
  const statusExpr = sql<string>`case
    when ${mailQueue.status} = 'sent' then 'accepted'
    when ${mailQueue.status} = 'queued' and ${mailQueue.attempts} > 0 then 'retry'
    else ${mailQueue.status} end`;
  app.get('/admin/smtp/queue', async (req) => {
    const q = parse(
      z.object({
        status: z.enum([...PUBLIC_STATUS, 'sent']).optional(),
        type: mailType.optional(),
        category: z.string().max(40).optional(),
        profile: z.string().max(80).optional(),
        recipient: z.string().max(200).optional(),
        q: z.string().max(200).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        errors: z.enum(['0', '1']).optional(),
        offset: z.coerce.number().int().min(0).max(100_000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    const status = q.status === 'sent' ? 'accepted' : q.status;
    const like = (v: string) => `%${escapeLike(v.trim())}%`;
    const where = and(
      status ? sql`${statusExpr} = ${status}` : undefined,
      q.type ? eq(mailQueue.type, q.type) : undefined,
      q.category ? eq(mailQueue.category, q.category) : undefined,
      q.profile ? eq(mailQueue.profileId, q.profile) : undefined,
      q.recipient ? ilike(mailQueue.to, like(q.recipient)) : undefined,
      q.from ? gte(mailQueue.createdAt, q.from) : undefined,
      q.to ? lte(mailQueue.createdAt, q.to) : undefined,
      q.errors === '1'
        ? or(inArray(mailQueue.status, ['failed']), isNotNull(mailQueue.lastCode))
        : undefined,
      q.q
        ? or(
            ilike(mailQueue.to, like(q.q)),
            ilike(mailQueue.messageId, like(q.q)),
            ilike(mailQueue.smtpRef, like(q.q)),
            ilike(mailQueue.lastText, like(q.q)),
            ilike(mailQueue.profileName, like(q.q)),
            sql`${mailQueue.id}::text = ${q.q.trim().toLowerCase()}`,
          )
        : undefined,
    );
    const [items, [filtered], totals] = await Promise.all([
      db
        .select({
          id: mailQueue.id,
          profileId: mailQueue.profileId,
          profileName: mailQueue.profileName,
          to: mailQueue.to,
          type: mailQueue.type,
          category: mailQueue.category,
          status: statusExpr,
          attempts: mailQueue.attempts,
          nextAttemptAt: mailQueue.nextAttemptAt,
          lastCode: mailQueue.lastCode,
          stage: mailQueue.lastStage,
          text: mailQueue.lastText,
          smtpStatus: mailQueue.lastSmtpStatus,
          messageId: mailQueue.messageId,
          smtpRef: mailQueue.smtpRef,
          createdAt: mailQueue.createdAt,
          deliveredAt: mailQueue.deliveredAt,
          expiresAt: mailQueue.expiresAt,
        })
        .from(mailQueue)
        .where(where)
        .orderBy(desc(mailQueue.createdAt))
        .limit(q.limit)
        .offset(q.offset),
      db.select({ n: count() }).from(mailQueue).where(where),
      db.select({ status: statusExpr, count: count() }).from(mailQueue).groupBy(statusExpr),
    ]);
    return { items, total: filtered?.n ?? 0, totals };
  });
  app.post('/admin/smtp/queue/:id/retry', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [row] = await db.select().from(mailQueue).where(eq(mailQueue.id, id));
    // просроченное письмо не отправляется: ссылка или приглашение уже недействительны
    if (!row || row.status !== 'failed' || !row.payloadCipher || row.expiresAt <= new Date())
      throw new AppError(
        409,
        'mail_not_retryable',
        'This message has expired or cannot be retried',
      );
    if (!(await loadSmtpProfile(ctx, row.profileId)))
      throw new AppError(409, 'smtp_not_configured', 'The message SMTP profile is unavailable');
    await db
      .update(mailQueue)
      .set({
        status: 'queued',
        attempts: 0,
        lastCode: null,
        lastSmtpStatus: null,
        lastStage: null,
        lastText: null,
        nextAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mailQueue.id, id),
          eq(mailQueue.status, 'failed'),
          gt(mailQueue.expiresAt, new Date()),
        ),
      );
    await audit(db, `user:${user.id}`, 'admin.smtp.mail.retry', `mail:${id}`, {
      previousAttempts: row.attempts,
    });
    return { ok: true };
  });
  app.post('/admin/smtp/queue/:id/cancel', async (req) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const cancelled = await db
      .update(mailQueue)
      .set({
        status: 'cancelled',
        payloadCipher: '',
        lockToken: null,
        lockedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(mailQueue.id, id), eq(mailQueue.status, 'queued')))
      .returning({ id: mailQueue.id });
    if (!cancelled.length)
      throw new AppError(
        409,
        'mail_not_cancellable',
        'Only a message waiting in the queue can be cancelled',
      );
    await audit(db, `user:${user.id}`, 'admin.smtp.mail.cancel', `mail:${id}`);
    return { ok: true };
  });
  app.get('/admin/smtp/templates', async () => {
    const templates = await loadMailTemplates(ctx);
    return mailType.options.map((id) => ({
      id,
      ...templates[id],
      variables: templateVariables[id],
      preview: previewTemplate(id, templates[id]),
    }));
  });
  app.put('/admin/smtp/templates/:id', async (req) => {
    const { user } = authOf(req);
    const id = parse(mailType, (req.params as { id: string }).id);
    const body = parse(templateWrite, req.body);
    if (!validTemplate(id, body))
      throw new AppError(400, 'template_invalid', 'Use only the listed template placeholders');
    const templates = { ...(await loadMailTemplates(ctx)), [id]: body };
    await db
      .insert(settings)
      .values({ key: MAIL_TEMPLATES_KEY, value: templates, updatedBy: user.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: templates, updatedBy: user.id, updatedAt: new Date() },
      });
    await audit(db, `user:${user.id}`, 'admin.smtp.template.save', `mail-template:${id}`);
    return { ok: true };
  });
  app.post('/admin/smtp/templates/:id/preview', async (req) => {
    const id = parse(mailType, (req.params as { id: string }).id);
    const body = parse(templateWrite, req.body);
    if (!validTemplate(id, body))
      throw new AppError(400, 'template_invalid', 'Use only the listed template placeholders');
    return previewTemplate(id, body);
  });
  app.get('/admin/smtp/notifications', () => mailNotificationPreferences(ctx));
  app.put('/admin/smtp/notifications', async (req) => {
    const { user } = authOf(req);
    const body = parse(notificationWrite, req.body);
    await db.transaction(async (tx) => {
      for (const [key, value] of [
        [MAIL_NOTIFICATIONS_KEY, body],
        ['notifications.security', body.security],
      ] as const)
        await tx
          .insert(settings)
          .values({ key, value, updatedBy: user.id })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedBy: user.id, updatedAt: new Date() },
          });
    });
    await audit(db, `user:${user.id}`, 'admin.smtp.notifications.save');
    return { ok: true };
  });
};
