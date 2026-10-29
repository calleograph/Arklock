import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  bindAccount,
  captchaSolution,
  ldapTransportProblem,
  normalizeLdapUrl,
  uuid,
} from '@arklock/contracts';
import type { MfaChallengeResponse, SessionResponse } from '@arklock/contracts';
import { audit } from '../audit.js';
import {
  DEFAULT_USER_FILTER,
  LdapError,
  ldapAuthenticate,
  ldapBrowse,
  accessAllowed,
  ldapCheckLogin,
  ldapLookup,
  ldapRootDse,
  type LdapConfig,
} from '../auth/ldap.js';
import { ldapDiagnose } from '../auth/ldap-diagnose.js';
import { requireReauth } from '../auth/reauth.js';
import { CertError, certUploadBytes, parseCertificates } from '../net/certs.js';
import { chiefRequired } from './chief.js';
import { isEnrolled, mfaChallenge } from '../auth/mfa.js';
import { adminGate } from '../auth/adminperm.js';
import { authOf, createSession, requireAuth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { circleMembers, circles, sessions, settings, users } from '../db/schema.js';
import type { Db } from '../db/connect.js';
import { auditRotations, circleVaults, rotateLostAccess } from '../rotate-signals.js';
import { AppError, parse } from '../errors.js';
import { sealSetting } from '../secretbox.js';
import { bundle } from './auth.js';
import {
  ldapBindSecret,
  ldapExternalId,
  ldapIdentityProfile,
  ldapSecretPurpose,
  readLdapProfiles,
  writeLdapProfiles,
  type LdapProfile,
} from '../auth/ldap-profiles.js';
import {
  revokeLdapProfileSessions,
  syncCirclesFor,
  previewLdapProfile,
  syncLdapProfile,
  syncProfileFor,
} from '../auth/ldap-sync.js';
export { syncCirclesFor } from '../auth/ldap-sync.js';
export { LDAP_SETTING_KEY } from '../auth/ldap-profiles.js';

const profileId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

const putSchema = z.object({
  enabled: z.boolean(),
  name: z.string().trim().min(1).max(100).default('LDAP'),
  syncEnabled: z.boolean().default(false),
  // адрес проверяется отдельно (normalizeLdapUrl): ошибка указывает поле и причину, а «/» в конце убирается
  url: z.string().max(300),
  startTls: z.boolean().default(false),
  caPem: z.string().max(200_000).default(''),
  insecureTls: z.boolean().default(false),
  /** Явное согласие передавать пароли без шифрования (только изолированная сеть). */
  allowPlaintext: z.boolean().default(false),
  bindDn: z.string().trim().max(500).default(''),
  /** Не передан — прежний пароль сохраняется; пустая строка — удаляется. */
  bindPassword: z.string().max(500).optional(),
  baseDn: z.string().trim().max(500),
  userFilter: z.string().trim().max(500).default(DEFAULT_USER_FILTER),
  emailAttr: z.string().trim().min(1).max(100).default('mail'),
  nameAttr: z.string().trim().min(1).max(100).default('cn'),
  titleAttr: z.string().trim().max(100).default('title'),
  departmentAttr: z.string().trim().max(100).default('department'),
  phoneAttr: z.string().trim().max(100).default('telephoneNumber'),
  groups: z
    .array(z.object({ dn: z.string().trim().min(1).max(500), circleId: uuid }))
    .max(200)
    .default([]),
  autoProvision: z.boolean().default(true),
  /** Вид каталога; без поля — прежнее поведение (обычный LDAP). */
  directoryType: z.enum(['ad', 'ldap']).optional(),
  /** Кто может входить; без поля у существующего подключения — как было (все найденные фильтром). */
  access: z.enum(['all', 'groups']).optional(),
  allowedGroups: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  /** Сертификат контроллера домена, которому доверяет администратор (по отпечатку). */
  pinnedPem: z.string().max(20_000).default(''),
  pinnedFingerprint: z.string().max(200).default(''),
});

const loginSchema = z.object({
  profileId: profileId.optional(),
  username: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(512),
  captcha: captchaSolution.optional(),
});

const ipOf = (req: FastifyRequest) => req.ip ?? null;

export const registerLdapRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, config } = ctx;
  const auth = requireAuth(ctx);

  async function stored(id = 'default'): Promise<LdapProfile | null> {
    return (await readLdapProfiles(db)).find((p) => p.id === id) ?? null;
  }
  const bindSecret = (s: LdapProfile) => ldapBindSecret(s, config.APP_SECRET);
  const queryId = (req: FastifyRequest) =>
    parse(z.object({ profileId: profileId.default('default') }), req.query).profileId;
  const failure = (e: unknown) =>
    e instanceof LdapError
      ? { ok: false as const, code: e.code, reason: e.reason, detail: e.detail }
      : { ok: false as const, code: 'error', reason: 'ldap_error', detail: '' };

  /**
   * Проверка формы подключения. Все ошибки собираются сразу и указывают поле и причину (интерфейс показывает их под полями);
   * однозначные отклонения адреса исправляются. Возвращает нормализованные значения.
   */
  function checkForm(body: z.infer<typeof putSchema>, prev: LdapProfile | null, forTest = false) {
    const issues: { path: string; code: string }[] = [];
    const url = normalizeLdapUrl(body.url);
    if (!url.ok) issues.push({ path: 'url', code: `url_${url.problem}` });
    else {
      const transport = ldapTransportProblem(url.value, body.startTls, body.allowPlaintext);
      if (transport)
        issues.push({ path: transport === 'plaintext' ? 'url' : 'startTls', code: transport });
    }
    // при проверке пустой Base DN определяется по каталогу (RootDSE); сохранить без него нельзя
    if (!body.baseDn && !forTest) issues.push({ path: 'baseDn', code: 'required' });
    if (!forTest && body.enabled) {
      // «все найденные фильтром» без явного выбора — только у подключения, которое уже работало так до этой версии
      const access = body.access ?? prev?.access ?? (prev?.enabled ? 'all' : undefined);
      // новое подключение не открывает вход всем молча: администратор выбирает, кто может входить
      if (!access) issues.push({ path: 'access', code: 'access_required' });
      if (access === 'groups' && !body.allowedGroups.length)
        issues.push({ path: 'allowedGroups', code: 'groups_required' });
    }
    if (body.pinnedPem.trim()) {
      try {
        const pin = parseCertificates(Buffer.from(body.pinnedPem, 'utf8')).certs[0];
        if (pin?.fingerprint256 !== body.pinnedFingerprint)
          issues.push({ path: 'pinnedPem', code: 'pin_mismatch' });
      } catch {
        issues.push({ path: 'pinnedPem', code: 'cert_not_certificate' });
      }
    }
    const account = bindAccount(body.bindDn, body.baseDn);
    if (!account.ok) issues.push({ path: 'bindDn', code: `bind_${account.problem}` });
    if (!body.userFilter.includes('{u}'))
      issues.push({ path: 'userFilter', code: 'filter_placeholder' });
    else if (!/^\(.*\)$/s.test(body.userFilter))
      issues.push({ path: 'userFilter', code: 'filter_parens' });
    let caPem = '';
    if (body.caPem.trim()) {
      try {
        caPem = parseCertificates(Buffer.from(body.caPem, 'utf8')).pem;
      } catch (e) {
        issues.push({
          path: 'caPem',
          code: `cert_${e instanceof CertError ? e.problem : 'not_certificate'}`,
        });
      }
    }
    // сохранённый пароль не уходит на другой сервер: при смене адреса его нужно ввести заново
    const prevUrl = prev ? normalizeLdapUrl(prev.url) : null;
    const moved =
      url.ok &&
      prevUrl?.ok &&
      (prevUrl.value.host !== url.value.host || prevUrl.value.port !== url.value.port);
    if (
      moved &&
      prev?.bindPasswordCipher &&
      body.bindPassword === undefined &&
      account.ok &&
      account.value
    )
      issues.push({ path: 'bindPassword', code: 'password_reentry' });
    if (issues.length)
      throw new AppError(400, 'validation_error', 'Check the highlighted fields', issues);
    return {
      url: url.ok ? url.value.url : body.url,
      caPem,
      access: body.access ?? prev?.access ?? (prev?.enabled ? 'all' : undefined),
    };
  }

  // ——— состояние подключения: настроено, подключение проверено, вход проверен (отдельно от доп. возможностей)
  const statusKey = (id: string) => `ldap.status.${id}`;
  type Status = {
    connection?: { ok: boolean; at: string; stage?: string; code?: string };
    login?: { ok: boolean; at: string; reason?: string };
  };
  async function readStatus(id: string): Promise<Status> {
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, statusKey(id)));
    return (row?.value as Status | undefined) ?? {};
  }
  async function writeStatus(id: string, patch: Status | null) {
    const value = patch === null ? {} : { ...(await readStatus(id)), ...patch };
    await db
      .insert(settings)
      .values({ key: statusKey(id), value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }

  /** Снижение защиты (без шифрования, без проверки сертификата) — только главный администратор с подтверждением. */
  async function confirmLowering(
    req: FastifyRequest,
    body: z.infer<typeof putSchema>,
    prev: LdapProfile | null,
  ) {
    const lowering =
      (body.insecureTls && !prev?.insecureTls) || (body.allowPlaintext && !prev?.allowPlaintext);
    if (!lowering) return false;
    if (!authOf(req).user.chief) throw chiefRequired();
    requireReauth(ctx, req);
    return true;
  }

  const adminOnly = [
    auth,
    async (req: FastifyRequest) => {
      await adminGate(ctx, req);
    },
  ];

  // ------------------------------------------------------------------ настройка (администратор)

  app.get('/admin/ldap', { preHandler: adminOnly }, async () => {
    const s = await stored();
    if (!s) return { configured: false };
    const { bindPasswordCipher, ...rest } = s;
    return { configured: true, ...rest, hasBindPassword: !!bindPasswordCipher };
  });

  app.get('/admin/ldap/profiles', { preHandler: adminOnly }, async () => {
    const profiles = await readLdapProfiles(db);
    const syncs = await db.select().from(settings);
    return {
      profiles: profiles.map(({ bindPasswordCipher, ...profile }) => ({
        ...profile,
        hasBindPassword: !!bindPasswordCipher,
        lastSync: syncs.find((r) => r.key === `ldap.sync.${profile.id}`)?.value ?? null,
        status: syncs.find((r) => r.key === `ldap.status.${profile.id}`)?.value ?? {},
        // «все» без явного выбора — только у подключения, которое уже было включено до этой версии
        access: profile.access ?? (profile.enabled ? 'all' : null),
      })),
      circles: await db.select({ id: circles.id, name: circles.name }).from(circles),
    };
  });

  async function saveProfile(req: FastifyRequest, id: string) {
    const { user } = authOf(req);
    const body = parse(putSchema, req.body);
    const before = await stored(id);
    const { url, caPem, access } = checkForm(body, before);
    const lowered = await confirmLowering(req, body, before);
    const known = new Set((await db.select({ id: circles.id }).from(circles)).map((c) => c.id));
    for (const g of body.groups)
      if (!known.has(g.circleId))
        throw new AppError(400, 'validation_error', 'Unknown circle in group mapping');
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('arklock.ldap.profiles'))`);
      const profiles = await readLdapProfiles(tx);
      if (!profiles.some((p) => p.id === id) && profiles.length >= 20)
        throw new AppError(
          409,
          'ldap_profile_limit',
          'At most 20 directory profiles are supported',
        );
      const prev = profiles.find((p) => p.id === id);
      const cipher =
        body.bindPassword === undefined
          ? (prev?.bindPasswordCipher ?? '')
          : body.bindPassword === ''
            ? ''
            : sealSetting(config.APP_SECRET, ldapSecretPurpose(id), body.bindPassword);
      const { bindPassword: _omit, ...rest } = body;
      void _omit;
      const value: LdapProfile = {
        ...rest,
        url,
        caPem,
        ...(access ? { access } : {}),
        id,
        bindPasswordCipher: cipher,
      };
      const removedCircles = [...new Set((prev?.groups ?? []).map((g) => g.circleId))].filter(
        (cid) => !value.groups.some((g) => g.circleId === cid),
      );
      const linkedIds = removedCircles.length
        ? (
            await tx
              .select({ id: users.id, externalId: users.externalId })
              .from(users)
              .where(eq(users.authSource, 'ldap'))
          )
            .filter((u) => ldapIdentityProfile(u.externalId) === id)
            .map((u) => u.id)
        : [];
      await writeLdapProfiles(
        tx,
        prev ? profiles.map((p) => (p.id === id ? value : p)) : [...profiles, value],
        user.id,
      );
      if (removedCircles.length && linkedIds.length) {
        // группа больше не сопоставлена каталогу: её участники из каталога теряют её доступ — «смените пароль»
        const txDb = tx as unknown as Db;
        const vaultIds = [
          ...new Set((await Promise.all(removedCircles.map((c) => circleVaults(txDb, c)))).flat()),
        ];
        const { opened } = await rotateLostAccess(
          txDb,
          linkedIds.flatMap((userId) => vaultIds.map((vaultId) => ({ vaultId, userId }))),
          () =>
            tx
              .delete(circleMembers)
              .where(
                and(
                  inArray(circleMembers.circleId, removedCircles),
                  inArray(circleMembers.userId, linkedIds),
                ),
              ),
          user.id,
        );
        await auditRotations(txDb, `user:${user.id}`, opened);
      }
      if (!value.enabled || (prev && (prev.url !== value.url || prev.baseDn !== value.baseDn)))
        await revokeLdapProfileSessions(tx, id);
      await audit(tx, `user:${user.id}`, 'admin.ldap.save', `ldap:${id}`, {
        url,
        enabled: body.enabled,
        access: access ?? 'all',
      });
      // подключение изменилось по существу — прежние отметки «проверено» больше не относятся к нему
      const essential = (p?: LdapProfile) =>
        p &&
        JSON.stringify([
          p.url,
          p.baseDn,
          p.bindDn,
          p.userFilter,
          p.caPem,
          p.pinnedFingerprint ?? '',
          p.access ?? 'all',
          p.allowedGroups ?? [],
        ]);
      if (!prev || essential(prev) !== essential(value) || body.bindPassword !== undefined)
        await tx
          .insert(settings)
          .values({ key: statusKey(id), value: {} })
          .onConflictDoUpdate({ target: settings.key, set: { value: {}, updatedAt: new Date() } });
      if (lowered)
        await audit(tx, `user:${user.id}`, 'admin.ldap.insecure', `ldap:${id}`, {
          insecureTls: body.insecureTls,
          allowPlaintext: body.allowPlaintext,
        });
    });
    return { ok: true, url };
  }
  app.put('/admin/ldap', { preHandler: adminOnly }, async (req) => saveProfile(req, 'default'));
  app.put('/admin/ldap/profiles/:id', { preHandler: adminOnly }, async (req) => {
    const { id } = parse(z.object({ id: profileId }), req.params);
    return saveProfile(req, id);
  });
  app.delete('/admin/ldap/profiles/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { user } = authOf(req);
    const { id } = parse(z.object({ id: profileId }), req.params);
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('arklock.ldap.profiles'))`);
      const profiles = await readLdapProfiles(tx);
      if (!profiles.some((p) => p.id === id))
        throw new AppError(404, 'not_found', 'Directory profile not found');
      const linked = await tx
        .select({ externalId: users.externalId })
        .from(users)
        .where(eq(users.authSource, 'ldap'));
      if (linked.some((u) => ldapIdentityProfile(u.externalId) === id))
        throw new AppError(
          409,
          'ldap_profile_in_use',
          'Disable this profile instead: enrolled users still depend on it',
        );
      await writeLdapProfiles(
        tx,
        profiles.filter((p) => p.id !== id),
        user.id,
      );
      await tx.delete(settings).where(eq(settings.key, `ldap.sync.${id}`));
      await audit(tx, `user:${user.id}`, 'admin.ldap.delete', `ldap:${id}`);
    });
    return reply.status(204).send();
  });

  /**
   * Сертификат центра сертификации: файл .cer, .crt или .pem в кодировке PEM или DER (формат определяется по содержимому)
   * либо вставленный текст. Ответ — сведения о каждом сертификате, проверка цепочки и нормализованный PEM для настройки.
   * Ничего не сохраняется и в сеть не отправляется.
   */
  app.post('/admin/ldap/ca-info', { preHandler: adminOnly }, async (req) => {
    const body = parse(
      z.object({
        data: z.string().max(400_000).optional(),
        pem: z.string().max(400_000).optional(),
      }),
      req.body,
    );
    try {
      return { ok: true as const, ...parseCertificates(certUploadBytes(body)) };
    } catch (e) {
      return {
        ok: false as const,
        problem: e instanceof CertError ? e.problem : 'not_certificate',
      };
    }
  });

  /**
   * Пошаговая проверка подключения. Без тела — сохранённые настройки; с телом — то, что сейчас в форме (до сохранения).
   * Сохранённый пароль служебной записи используется только для того же сервера.
   */
  app.post('/admin/ldap/test', { preHandler: adminOnly }, async (req) => {
    const id = queryId(req);
    const s = await stored(id);
    if (req.body && typeof req.body === 'object' && 'url' in (req.body as object)) {
      const body = parse(putSchema, req.body);
      const { url, caPem } = checkForm(body, s, true);
      // проверка без проверки сертификата отправила бы пароль на неподтверждённый сервер — те же условия, что и при сохранении
      await confirmLowering(req, body, s);
      const draft: LdapConfig = { ...body, url, caPem };
      const secret = body.bindPassword ?? (s ? bindSecret(s) : '');
      // Base DN не задан: берётся из каталога (RootDSE), форма подставит его сама
      let detected: Awaited<ReturnType<typeof ldapRootDse>> | null = null;
      if (!draft.baseDn) {
        detected = await ldapRootDse(draft, secret).catch(() => null);
        if (detected?.baseDn) draft.baseDn = detected.baseDn;
      }
      return { ...(await ldapDiagnose(draft, secret)), detected };
    }
    if (!s) throw new AppError(409, 'ldap_not_saved', 'Save the connection first');
    const r = await ldapDiagnose(s, bindSecret(s));
    const failed = r.stages.find((x) => !x.ok && !x.skipped);
    await writeStatus(id, {
      connection: {
        ok: r.ok,
        at: new Date().toISOString(),
        stage: failed?.stage,
        code: failed?.code,
      },
    });
    return r;
  });

  // проверка входа сотрудника: пароль самого сотрудника проверяет каталог; ничего не создаётся и не сохраняется
  const loginTests = new Map<string, number[]>();
  app.post('/admin/ldap/login-test', { preHandler: adminOnly }, async (req) => {
    const { user } = authOf(req);
    const id = queryId(req);
    const s = await stored(id);
    if (!s) throw new AppError(409, 'ldap_not_saved', 'Save the connection first');
    const body = parse(
      z.object({
        username: z.string().trim().min(1).max(256),
        password: z.string().min(1).max(512),
      }),
      req.body,
    );
    const now = Date.now();
    const recent = (loginTests.get(user.id) ?? []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= 10)
      throw new AppError(429, 'too_many_attempts', 'Too many sign-in checks, try again later');
    loginTests.set(user.id, [...recent, now]);
    const r = await ldapCheckLogin(s, bindSecret(s), body.username, body.password);
    let account: 'new' | 'linked' | 'local_conflict' | 'blocked' | null = null;
    if (r.ok) {
      const [linked] = await db
        .select({ id: users.id, disabledAt: users.disabledAt })
        .from(users)
        .where(
          and(eq(users.authSource, 'ldap'), eq(users.externalId, ldapExternalId(s.id, r.user.dn))),
        );
      if (linked) account = linked.disabledAt ? 'blocked' : 'linked';
      else {
        const [clash] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, r.user.email));
        account = clash ? 'local_conflict' : 'new';
      }
    }
    const reason = !r.ok
      ? r.reason
      : !r.allowed
        ? 'not_allowed'
        : account === 'local_conflict'
          ? 'local_exists'
          : account === 'blocked'
            ? 'blocked_in_arklock'
            : account === 'new' && !s.autoProvision
              ? 'not_provisioned'
              : !s.enabled
                ? 'login_disabled'
                : 'ok';
    const ok = reason === 'ok';
    await writeStatus(id, { login: { ok, at: new Date().toISOString(), reason } });
    await audit(db, `user:${user.id}`, 'admin.ldap.login_test', `ldap:${id}`, {
      username: body.username.slice(0, 100),
      ok,
      reason,
    });
    const u = 'user' in r ? r.user : undefined;
    return {
      ok,
      reason,
      account,
      detail: !r.ok ? (r.detail ?? '') : '',
      user: u
        ? { dn: u.dn, name: u.name, email: u.email, groups: u.groups.length, disabled: u.disabled }
        : null,
    };
  });

  app.post('/admin/ldap/lookup', { preHandler: adminOnly }, async (req) => {
    const body = parse(z.object({ username: z.string().trim().min(1).max(256) }), req.body);
    const s = await stored(queryId(req));
    if (!s) throw new AppError(409, 'ldap_not_saved', 'Save the connection first');
    try {
      const u = await ldapLookup(s, bindSecret(s), body.username);
      return u ? { ok: true as const, found: true, user: u } : { ok: true as const, found: false };
    } catch (e) {
      return failure(e);
    }
  });

  app.post('/admin/ldap/browse', { preHandler: adminOnly }, async (req) => {
    const body = parse(
      z.object({
        kind: z.enum(['users', 'groups', 'ous']),
        baseDn: z.string().trim().max(500).optional(),
        q: z.string().trim().max(200).default(''),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).max(500).default(0),
        activeOnly: z.boolean().default(true),
      }),
      req.body,
    );
    const s = await stored(queryId(req));
    if (!s) throw new AppError(409, 'ldap_not_saved', 'Save the connection first');
    try {
      return { ok: true, ...(await ldapBrowse(s, bindSecret(s), body)) };
    } catch (e) {
      return failure(e);
    }
  });

  /** Предпросмотр сверки: что изменится, без записи. */
  app.post('/admin/ldap/sync/preview', { preHandler: adminOnly }, async (req) => {
    const s = await stored(queryId(req));
    if (!s) throw new AppError(409, 'ldap_not_saved', 'Save the connection first');
    if (!s.enabled) throw new AppError(409, 'ldap_disabled', 'Directory sign-in is turned off');
    return previewLdapProfile(db, config.APP_SECRET, s);
  });

  /** Сверка со справочником: учётные записи, исчезнувшие из каталога или отключённые в нём, блокируются; круги обновляются. */
  app.post('/admin/ldap/sync', { preHandler: adminOnly }, async (req) => {
    const { user } = authOf(req);
    const s = await stored(queryId(req));
    if (!s) throw new AppError(409, 'ldap_not_saved', 'Save the connection first');
    if (!s.enabled) throw new AppError(409, 'ldap_disabled', 'Directory sign-in is turned off');
    return syncLdapProfile(db, config.APP_SECRET, s, `user:${user.id}`);
  });

  // ------------------------------------------------------------------ вход пользователей

  app.get('/auth/ldap', async () => {
    const profiles = (await readLdapProfiles(db)).filter((p) => p.enabled);
    return {
      enabled: profiles.length > 0,
      autoProvision: profiles.some((p) => p.autoProvision),
      profiles: profiles.map((p) => ({ id: p.id, name: p.name, autoProvision: p.autoProvision })),
    };
  });

  app.post(
    '/auth/ldap/login',
    async (
      req,
      reply,
    ): Promise<
      | SessionResponse
      | MfaChallengeResponse
      | { enroll: true; enrollToken: string; email: string; name: string }
    > => {
      const body = parse(loginSchema, req.body);
      const s = await stored(body.profileId ?? 'default');
      if (!s?.enabled) throw new AppError(404, 'ldap_disabled', 'LDAP sign-in is not enabled');
      await ctx.shield.guard(req, 'directory', body.username, body.captcha);
      let ident;
      try {
        ident = await ldapAuthenticate(s, bindSecret(s), body.username, body.password);
      } catch (e) {
        // недоступность каталога — не ошибка пароля и не должна копить неудачные попытки
        throw new AppError(
          503,
          'ldap_unavailable',
          e instanceof LdapError ? e.message : 'Directory is unavailable',
        );
      }
      if (!ident) {
        const disabled = await ldapLookup(s, bindSecret(s), body.username).catch(() => null);
        if (disabled?.disabled) {
          const [linked] = await db
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                eq(users.authSource, 'ldap'),
                eq(users.externalId, ldapExternalId(s.id, disabled.dn)),
              ),
            );
          if (linked) {
            await db
              .update(users)
              .set({ disabledAt: new Date(), disabledReason: 'directory' })
              .where(eq(users.id, linked.id));
            await db
              .update(sessions)
              .set({ revokedAt: new Date() })
              .where(eq(sessions.userId, linked.id));
          }
        }
        ctx.shield.recordFailure(req, 'directory', body.username, null);
        await audit(db, 'anonymous', 'auth.ldap.failed', null, { ip: ipOf(req) });
        throw new AppError(401, 'invalid_credentials', 'Invalid username or password');
      }
      ctx.shield.recordSuccess(req, 'directory', body.username);
      // пароль верный, но администратор ограничил вход группами каталога
      if (!accessAllowed(s, ident.groups)) {
        await audit(db, 'anonymous', 'auth.ldap.not_allowed', null, { ip: ipOf(req) });
        throw new AppError(
          403,
          'ldap_not_allowed',
          'Directory sign-in is not allowed for this account',
        );
      }
      if (!ident.email)
        throw new AppError(403, 'ldap_no_email', 'The directory entry has no e-mail address');

      const [linked] = await db
        .select()
        .from(users)
        .where(
          and(eq(users.authSource, 'ldap'), eq(users.externalId, ldapExternalId(s.id, ident.dn))),
        );
      if (!linked) {
        const [clash] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, ident.email));
        if (clash)
          throw new AppError(
            409,
            'account_exists_local',
            'A local account with this e-mail already exists',
          );
        if (!s.autoProvision)
          throw new AppError(
            403,
            'ldap_not_provisioned',
            'Your account has not been created yet — contact an administrator',
          );
        const token = ctx.enroll.issue({
          source: 'ldap',
          externalId: ldapExternalId(s.id, ident.dn),
          directoryId: s.id,
          email: ident.email,
          name: ident.name,
          groups: ident.groups,
        });
        return {
          enroll: true,
          enrollToken: token,
          email: ident.email,
          name: ident.name || ident.email,
        };
      }
      if (linked.disabledAt)
        throw new AppError(401, 'invalid_credentials', 'Invalid username or password');
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('arklock.ldap.profiles'))`);
        const current = (await readLdapProfiles(tx)).find((p) => p.id === s.id);
        if (!current?.enabled || JSON.stringify(current) !== JSON.stringify(s))
          throw new AppError(
            403,
            'not_provisioned',
            'The directory configuration changed; start sign-in again',
          );
        await syncCirclesFor(tx, linked.id, current, ident.groups);
        await syncProfileFor(tx, linked.id, ident, current);
      });
      if (await isEnrolled(ctx, linked.id)) {
        reply.status(200);
        return mfaChallenge(ctx, linked.id);
      }
      const sess = await createSession(
        ctx,
        linked.id,
        ipOf(req),
        req.headers['user-agent'] ?? null,
      );
      await audit(db, `user:${linked.id}`, 'auth.login', `session:${sess.id}`, {
        ip: ipOf(req),
        via: 'ldap',
      });
      reply.status(200);
      return {
        token: sess.token,
        expiresAt: sess.expiresAt.toISOString(),
        user: await bundle(ctx, linked),
      };
    },
  );
};
