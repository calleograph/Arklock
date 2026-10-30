import { createHmac } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import {
  isNtlmV2Authenticate,
  ntlmAuthenticate,
  ntlmNegotiate,
  ntlmType,
  NtlmError,
} from './ntlm.js';
import { resolveSmtpTarget, TargetError } from './target.js';

export interface SmtpConfig {
  host: string;
  port: number;
  /** none — без шифрования (выбирает главный администратор), starttls — повышение на порту 587, tls — сразу TLS (порт 465). */
  security: 'none' | 'starttls' | 'tls';
  /** none — relay без входа, password — SMTP AUTH (PLAIN, LOGIN, CRAM-MD5), ntlm — Windows NTLM (Exchange). */
  auth: 'none' | 'password' | 'ntlm';
  user: string;
  password: string;
  from: string;
  fromName?: string;
  /** Таймаут каждого этапа, мс. */
  timeoutMs?: number;
  /** Проверка сертификата сервера; по умолчанию включена. Выключается только главным администратором. */
  verifyCert?: boolean;
  /** Дополнительные доверенные центры сертификации (PEM): к системным, не вместо них. */
  ca?: string[];
  /** Только тестовый стенд: разрешить loopback. */
  allowLoopback?: boolean;
  /** Согласие отправлять пароль по соединению без шифрования; без него вход по паролю при security: none не выполняется. */
  plainAuth?: boolean;
  /**
   * Отпечаток SHA-256 сертификата, которому доверил администратор. Соединение принимается, если сертификат прошёл
   * обычную проверку (цепочка и имя) или совпадает с этим отпечатком; любой другой сертификат отклоняется.
   */
  pinnedFingerprint?: string;
}

/** Этапы проверки соединения в порядке выполнения. */
export const SMTP_STAGES = [
  'dns',
  'tcp',
  'greeting',
  'ehlo',
  'tls',
  'certificate',
  'methods',
  'auth',
  'sender',
  'recipient',
  'data',
] as const;
export type SmtpStage = (typeof SMTP_STAGES)[number];

export interface StageResult {
  stage: SmtpStage;
  ok: boolean;
  /** Этап не нужен при этих настройках (например, TLS при «без шифрования»). */
  skipped?: boolean;
  /** Выполнен, но небезопасно (проверка сертификата отключена). */
  warn?: boolean;
  code?: string;
  smtpStatus?: number;
  /** Ответ сервера: очищен от управляющих символов, секретов и ограничен по длине. */
  serverText?: string;
  info?: Record<string, string | number | boolean | string[]>;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly smtpStatus?: number,
    readonly stage?: SmtpStage,
    readonly serverText?: string,
    readonly detail?: StageResult['info'],
  ) {
    super(message);
  }
}

type Sock = net.Socket | tls.TLSSocket;

/** Построчное чтение ответов SMTP (многострочные ответы «250-…»/«250 …»). */
class Reader {
  private buf = '';
  private waiters: ((r: { code: number; text: string }) => void)[] = [];
  private lines: string[] = [];
  private failure: Error | null = null;
  private pending: { code: number; text: string }[] = [];

  constructor(private sock: Sock) {
    this.attach(sock);
  }

  attach(sock: Sock): void {
    this.sock = sock;
    sock.on('data', (d: Buffer) => {
      if (this.buf.length + this.lines.join('').length + d.length > 65536) {
        this.fail(new SmtpError('SMTP response is too large', 'protocol'));
        sock.destroy();
        return;
      }
      this.buf += d.toString('utf8');
      let i: number;
      while ((i = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        this.lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) this.flush();
      }
    });
    sock.on('error', (e) => this.fail(e));
    sock.on('close', () => this.fail(new SmtpError('The server closed the connection', 'closed')));
  }

  private fail(e: Error): void {
    this.failure = this.failure ?? e;
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f({ code: -1, text: e.message });
  }

  private flush(): void {
    const text = this.lines.join('\n');
    const code = Number(this.lines[this.lines.length - 1]!.slice(0, 3));
    this.lines = [];
    const w = this.waiters.shift();
    if (w) w({ code, text });
    else this.pending.push({ code, text });
  }

  next(): Promise<{ code: number; text: string }> {
    const p = this.pending.shift();
    if (p) return Promise.resolve(p);
    if (this.failure) return Promise.resolve({ code: -1, text: this.failure.message });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** Нет ли в значении перевода строки (защита от внедрения команд SMTP и заголовков). */
const clean = (s: string): string => {
  if (/[\r\n\0]/.test(s)) throw new SmtpError('Invalid characters in address or header', 'invalid');
  return s;
};

export interface Mail {
  to: string;
  subject: string;
  text: string;
  id?: string;
}

/**
 * Ответ сервера в безопасном для показа виде: управляющие символы убраны, пробелы свёрнуты, длина ограничена,
 * пароль подключения (если сервер повторил его) вырезан, данные обмена AUTH не выводятся.
 */
export function serverText(raw: string | undefined, password = '', limit = 300): string {
  let text = (raw ?? '')
    // eslint-disable-next-line no-control-regex -- именно управляющие символы здесь и убираются
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (password.length >= 4) text = text.split(password).join('***');
  text = text.replace(/\b[A-Za-z0-9+/]{40,}={0,2}/g, '***');
  return text.slice(0, limit);
}

/** Куда относить отказ сервера на этапе: понятный код для подсказки и решения о повторе. */
export function classifyReply(stage: SmtpStage, status: number, text: string): string {
  const t = text.toLowerCase();
  if (status === 421 || status === 450 || status === 451 || status === 454 || status === 455) {
    if (/too many|rate|limit|throttl|exceed|quota/.test(t)) return 'limit';
    return stage === 'auth' && status === 454 ? 'auth_failed' : 'temporary';
  }
  if (status === 452 || status === 552 || /too many|rate limit|quota exceeded|exceeds/.test(t))
    return /size|large|exceed/.test(t) && status === 552 ? 'data' : 'limit';
  if (status >= 400 && status < 500) return 'temporary';
  if (stage === 'auth')
    return status === 504 || status === 538 ? 'auth_unsupported' : 'auth_failed';
  if (/relay|not permitted|unable to relay|not allowed to send|access denied/.test(t))
    return stage === 'sender' ? 'sender_rejected' : 'relay_denied';
  if (stage === 'sender') return 'sender_rejected';
  if (stage === 'recipient') return 'recipient_rejected';
  if (stage === 'tls') return 'starttls';
  if (stage === 'greeting' || stage === 'ehlo') return 'protocol';
  return 'data';
}

const CERT_REASONS: Record<string, string> = {
  CERT_HAS_EXPIRED: 'expired',
  CERT_NOT_YET_VALID: 'not_yet_valid',
  ERR_TLS_CERT_ALTNAME_INVALID: 'hostname',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self_signed',
  SELF_SIGNED_CERT_IN_CHAIN: 'untrusted',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'untrusted',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'untrusted',
  UNABLE_TO_GET_ISSUER_CERT: 'untrusted',
  CERT_UNTRUSTED: 'untrusted',
  CERT_REVOKED: 'revoked',
  PIN_MISMATCH: 'pin_mismatch',
};

function certInfo(sock: tls.TLSSocket): StageResult['info'] {
  const c = sock.getPeerCertificate();
  if (!c || !('subject' in c)) return {};
  const cn = (o: unknown) => {
    const v = o as { CN?: string | string[]; O?: string } | undefined;
    const x = Array.isArray(v?.CN) ? v.CN[0] : v?.CN;
    return x ?? v?.O ?? '';
  };
  return {
    subject: cn(c.subject),
    issuer: cn(c.issuer),
    validTo: c.valid_to ? new Date(c.valid_to).toISOString() : '',
    fingerprint256: c.fingerprint256 ?? '',
  };
}

/**
 * Каким доверенным центром организации подтверждён сертификат сервера: идём по цепочке, которую предъявил сервер,
 * и ищем в ней загруженный администратором сертификат. Пусто — сертификат подтверждён системными центрами.
 */
function trustAnchor(sock: tls.TLSSocket, ours: string[]): string {
  if (!ours.length) return '';
  const known = new Map<string, string>();
  for (const pem of ours)
    try {
      const x = new X509Certificate(pem);
      known.set(
        x.fingerprint256,
        x.subject.match(/CN=([^\n]+)/)?.[1] ?? x.subject.split('\n')[0] ?? '',
      );
    } catch {
      /* повреждённая запись не должна ломать проверку */
    }
  let cur: tls.DetailedPeerCertificate | undefined = sock.getPeerCertificate(true);
  for (let i = 0; cur && i < 10; i++) {
    const name = known.get(cur.fingerprint256);
    if (name !== undefined) return name;
    const next: tls.DetailedPeerCertificate | undefined = cur.issuerCertificate;
    if (!next || next === cur) break;
    cur = next;
  }
  return '';
}

export interface SessionOptions {
  signal?: AbortSignal;
  /** Результат каждого этапа сразу по готовности (для проверки соединения). */
  onStage?: (s: StageResult) => void;
  /** Проверка: при ошибке сертификата показать, какой сертификат предъявил сервер (без отправки учётных данных). */
  probeCertificate?: boolean;
}

export interface SessionResult {
  banner: string;
  features: string[];
  /** Способы входа, объявленные сервером до и после перехода на TLS. */
  methods: { before: string[]; after: string[] };
  /** Ответ сервера на конец письма и идентификатор, который он назвал (если назвал). */
  accepted?: { reply: string; ref: string | null; messageId: string };
}

const authList = (caps: string): string[] =>
  caps
    .split('\n')
    .map((l) => /^250[ -]AUTH[ =](.*)$/i.exec(l)?.[1])
    .filter((x): x is string => !!x)
    .flatMap((x) => x.trim().toUpperCase().split(/\s+/));

function fail(
  stage: SmtpStage,
  code: string,
  message: string,
  extra: { status?: number; text?: string; info?: StageResult['info'] } = {},
): SmtpError {
  const { status, text, info } = extra;
  return new SmtpError(message, code, status, stage, text, info);
}

/**
 * Клиент SMTP: DNS (адрес проверяется и закрепляется), TCP, приветствие, EHLO, STARTTLS/TLS с проверкой сертификата,
 * способы входа, вход (PLAIN, LOGIN, CRAM-MD5, NTLMv2) и, если передано письмо, его отправка. mail === null —
 * проверка соединения: письмо не отправляется. Каждый этап сообщается через onStage; при отказе бросается SmtpError
 * с этапом, кодом причины и очищенным ответом сервера.
 */
export async function smtpSession(
  cfg: SmtpConfig,
  mail: Mail | null,
  opts: SessionOptions = {},
): Promise<SessionResult> {
  const { signal, onStage } = opts;
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const verify = cfg.verifyCert !== false;
  if (signal?.aborted) throw new SmtpError('Mail delivery stopped', 'aborted');
  if (mail) {
    clean(mail.to);
    clean(mail.subject);
  }
  clean(cfg.from);
  clean(cfg.fromName ?? '');
  if (cfg.auth === 'ntlm' && cfg.security === 'none')
    throw new SmtpError('NTLM is only used over a protected connection', 'invalid');
  if (cfg.auth === 'password' && cfg.security === 'none' && cfg.plainAuth !== true)
    throw new SmtpError('The password is not sent unencrypted without explicit consent', 'invalid');
  const report = (s: StageResult) => onStage?.(s);
  const withTimeout = <T>(p: Promise<T>, stage: SmtpStage): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, rej) => {
        setTimeout(
          () => rej(fail(stage, 'timeout', `Timed out at stage ${stage}`)),
          timeoutMs,
        ).unref();
      }),
    ]);

  // 1. DNS: адрес разрешается и проверяется, дальше соединение идёт по нему
  let addresses: string[];
  try {
    addresses = (await withTimeout(resolveSmtpTarget(cfg.host, cfg.port, cfg.allowLoopback), 'dns'))
      .addresses;
    report({ stage: 'dns', ok: true, info: { addresses } });
  } catch (error) {
    const code =
      error instanceof TargetError ? error.code : error instanceof SmtpError ? error.code : 'dns';
    const err = fail('dns', code, error instanceof Error ? error.message : 'DNS failed');
    report({ stage: 'dns', ok: false, code });
    throw err;
  }

  const named = net.isIP(cfg.host) === 0;
  const tlsBase = {
    // имя сервера для SNI и проверки сертификата — настроенное, а не IP, по которому идёт соединение
    ...(named ? { servername: cfg.host } : {}),
    ca: cfg.ca?.length ? [...tls.rootCertificates, ...cfg.ca] : undefined,
    // с закреплённым сертификатом решение принимается после рукопожатия (см. handshake)
    rejectUnauthorized: verify && !cfg.pinnedFingerprint,
    minVersion: 'TLSv1.2' as const,
  };

  let pendingSocket: Sock | undefined;
  const abort = () => pendingSocket?.destroy(new SmtpError('Mail delivery stopped', 'aborted'));
  signal?.addEventListener('abort', abort, { once: true });

  const handshake = async (s: net.Socket | null, address: string): Promise<tls.TLSSocket> =>
    withTimeout(
      new Promise<tls.TLSSocket>((resolve, reject) => {
        const t: tls.TLSSocket = tls.connect(
          // host нужен и при готовом сокете: по нему проверяется имя в сертификате, когда сервер указан адресом
          s
            ? { ...tlsBase, socket: s, host: address }
            : { ...tlsBase, host: address, port: cfg.port },
          () => {
            if (verify && cfg.pinnedFingerprint && !t.authorized) {
              // не прошёл обычную проверку: принимается только сертификат с закреплённым отпечатком
              if (t.getPeerCertificate().fingerprint256 !== cfg.pinnedFingerprint) {
                t.destroy();
                return reject(
                  Object.assign(new Error('Pinned certificate mismatch'), { code: 'PIN_MISMATCH' }),
                );
              }
            }
            resolve(t);
          },
        );
        pendingSocket = t;
        t.once('error', reject);
      }),
      'tls',
    );

  const tlsFailure = (e: unknown): SmtpError => {
    const code = (e as { code?: string }).code ?? '';
    const reason = CERT_REASONS[code];
    if (reason)
      return fail('certificate', 'certificate', 'The server certificate was not verified', {
        info: { reason },
      });
    if (e instanceof SmtpError) return e;
    return fail('tls', 'tls', `TLS failed: ${(e as Error).message.slice(0, 120)}`);
  };

  // 2. TCP (+ неявный TLS)
  let sock: Sock | undefined;
  let connected = addresses[0]!;
  let lastError: unknown;
  /** Соединение с портом установлено: дальнейшая неудача относится к защите, а не к соединению. */
  let tcpReached = false;
  for (const address of addresses) {
    connected = address;
    tcpReached = false;
    try {
      // соединение и (для SSL/TLS) рукопожатие — разные этапы: тайм-аут относится к тому, где он случился
      const raw = await withTimeout(
        new Promise<net.Socket>((resolve, reject) => {
          const s = net.connect({ host: address, port: cfg.port }, () => resolve(s));
          pendingSocket = s;
          s.once('error', reject);
        }),
        'tcp',
      );
      tcpReached = true;
      report({ stage: 'tcp', ok: true, info: { address } });
      sock = cfg.security === 'tls' ? await handshake(raw, address) : raw;
      break;
    } catch (error) {
      pendingSocket?.destroy();
      lastError = error;
    }
  }
  if (!sock) {
    signal?.removeEventListener('abort', abort);
    const e = lastError as { code?: string; message?: string };
    const tlsLike =
      !!CERT_REASONS[e.code ?? ''] ||
      /^ERR_(SSL|TLS)|ssl|tls|handshake/i.test(`${e.code ?? ''} ${e.message ?? ''}`);
    if (cfg.security === 'tls' && (tlsLike || tcpReached)) {
      const err = tlsFailure(e);
      let info = err.detail;
      if (opts.probeCertificate && err.code === 'certificate')
        info = { ...info, ...(await probeCertificate(cfg, connected).catch(() => ({}))) };
      report({ stage: err.stage ?? 'tls', ok: false, code: err.code, info });
      throw new SmtpError(err.message, err.code, undefined, err.stage, undefined, info);
    }
    const code = e instanceof SmtpError ? e.code : e.code === 'ETIMEDOUT' ? 'timeout' : 'connect';
    const err = new SmtpError(
      `Cannot connect to ${cfg.host}:${cfg.port}`,
      code,
      undefined,
      'tcp',
      undefined,
      e.code ? { reason: e.code } : undefined,
    );
    report({ stage: 'tcp', ok: false, code, info: err.detail });
    throw err;
  }
  if (cfg.security === 'tls')
    report({
      stage: 'tls',
      ok: true,
      warn: !verify,
      info: { protocol: (sock as tls.TLSSocket).getProtocol() ?? '' },
    });

  const reader = new Reader(sock);
  const send = (line: string) => sock!.write(line + '\r\n');
  let stage: SmtpStage = 'greeting';
  const expect = async (ok: number[], st: SmtpStage, what: string) => {
    stage = st;
    const r = await withTimeout(reader.next(), st);
    if (!ok.includes(r.code)) {
      if (r.code < 0) {
        throw signal?.aborted
          ? new SmtpError('Mail delivery stopped', 'aborted')
          : fail(st, 'closed', `${what}: the server closed the connection`);
      }
      throw fail(st, classifyReply(st, r.code, r.text), `${what} failed (SMTP ${r.code})`, {
        status: r.code,
        text: serverText(r.text, cfg.password),
      });
    }
    return r;
  };
  const needTls = cfg.security !== 'none';
  let methodsBefore: string[] = [];
  let methodsAfter: string[] = [];
  let probed = false;
  try {
    const banner = (await expect([220], 'greeting', 'Greeting')).text;
    report({ stage: 'greeting', ok: true, info: { banner: serverText(banner, '', 120) } });
    send('EHLO arklock.local');
    let caps = (await expect([250], 'ehlo', 'EHLO')).text;
    methodsBefore = authList(caps);
    report({
      stage: 'ehlo',
      ok: true,
      info: {
        features: caps
          .split('\n')
          .slice(1)
          .map((l) => l.slice(4))
          .slice(0, 20),
      },
    });

    if (cfg.security === 'starttls') {
      if (!/STARTTLS/i.test(caps)) {
        throw fail('tls', 'starttls', 'The server does not offer STARTTLS');
      }
      send('STARTTLS');
      await expect([220], 'tls', 'STARTTLS');
      try {
        const upgraded = await handshake(sock as net.Socket, cfg.host);
        sock = upgraded;
        pendingSocket = upgraded;
        reader.attach(upgraded);
      } catch (error) {
        const err = tlsFailure(error);
        let info = err.detail;
        if (opts.probeCertificate && err.code === 'certificate' && !probed) {
          probed = true;
          info = { ...info, ...(await probeCertificate(cfg, connected).catch(() => ({}))) };
        }
        throw new SmtpError(err.message, err.code, undefined, err.stage, undefined, info);
      }
      report({
        stage: 'tls',
        ok: true,
        warn: !verify,
        info: { protocol: (sock as tls.TLSSocket).getProtocol() ?? '' },
      });
      send('EHLO arklock.local');
      caps = (await expect([250], 'ehlo', 'EHLO')).text;
    } else if (cfg.security === 'none') report({ stage: 'tls', ok: true, skipped: true });
    methodsAfter = authList(caps);
    if (needTls) {
      const info = certInfo(sock as tls.TLSSocket);
      const pinned = !!cfg.pinnedFingerprint && !(sock as tls.TLSSocket).authorized;
      const anchor = pinned ? '' : trustAnchor(sock as tls.TLSSocket, cfg.ca ?? []);
      report({
        stage: 'certificate',
        ok: true,
        warn: !verify,
        info: { ...info, verified: verify, pinned, anchor },
      });
    } else report({ stage: 'certificate', ok: true, skipped: true });

    const features = caps
      .split('\n')
      .slice(1)
      .map((l) => l.slice(4));
    report({ stage: 'methods', ok: true, info: { before: methodsBefore, after: methodsAfter } });

    // 3. Вход
    if (cfg.auth === 'none') report({ stage: 'auth', ok: true, skipped: true });
    else {
      stage = 'auth';
      if (!cfg.user) throw fail('auth', 'auth_failed', 'The account is not set');
      if (cfg.auth === 'ntlm') {
        if (!methodsAfter.includes('NTLM'))
          throw fail('methods', 'auth_unsupported', 'The server does not offer NTLM', {
            info: { before: methodsBefore, after: methodsAfter },
          });
        send('AUTH NTLM');
        await expect([334], 'auth', 'AUTH NTLM');
        const negotiate = ntlmNegotiate();
        send(negotiate.toString('base64'));
        const c = await expect([334], 'auth', 'NTLM Negotiate');
        const challenge = Buffer.from(c.text.replace(/^334\s*/, '').trim(), 'base64');
        if (ntlmType(challenge) !== 2)
          throw fail(
            'auth',
            'auth_ntlm',
            'The server sent something that is not an NTLM challenge',
          );
        let type3: Buffer;
        try {
          type3 = ntlmAuthenticate(negotiate, challenge, cfg.user, cfg.password);
        } catch (error) {
          throw fail(
            'auth',
            'auth_ntlm',
            error instanceof NtlmError ? error.message : 'NTLM failed',
            {
              info: { reason: error instanceof NtlmError ? error.code : 'ntlm' },
            },
          );
        }
        if (!isNtlmV2Authenticate(type3))
          throw fail('auth', 'auth_ntlm', 'The NTLM response is not NTLMv2');
        send(type3.toString('base64'));
        await expect([235], 'auth', 'NTLM Authenticate');
      } else if (methodsAfter.includes('PLAIN')) {
        send(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.password}`)}`);
        await expect([235], 'auth', 'AUTH');
      } else if (methodsAfter.includes('LOGIN')) {
        send('AUTH LOGIN');
        await expect([334], 'auth', 'AUTH');
        send(b64(cfg.user));
        await expect([334], 'auth', 'AUTH');
        send(b64(cfg.password));
        await expect([235], 'auth', 'AUTH');
      } else if (methodsAfter.includes('CRAM-MD5')) {
        send('AUTH CRAM-MD5');
        const c = await expect([334], 'auth', 'AUTH');
        const challenge = Buffer.from(c.text.replace(/^334\s*/, '').trim(), 'base64');
        const digest = createHmac('md5', cfg.password).update(challenge).digest('hex');
        send(b64(`${cfg.user} ${digest}`));
        await expect([235], 'auth', 'AUTH');
      } else {
        throw fail('methods', 'auth_unsupported', 'The server offers no supported AUTH method', {
          info: { before: methodsBefore, after: methodsAfter },
        });
      }
      report({ stage: 'auth', ok: true });
    }

    let accepted: SessionResult['accepted'];
    if (mail) {
      const domain = cfg.from.split('@')[1] ?? 'arklock.local';
      const messageId = `${mail.id ?? crypto.randomUUID()}@${domain}`;
      send(`MAIL FROM:<${cfg.from}>`);
      await expect([250], 'sender', 'MAIL FROM');
      send(`RCPT TO:<${clean(mail.to)}>`);
      await expect([250, 251], 'recipient', 'RCPT TO');
      send('DATA');
      await expect([354], 'data', 'DATA');
      const from = cfg.fromName ? `=?UTF-8?B?${b64(cfg.fromName)}?= <${cfg.from}>` : cfg.from;
      const body = [
        `From: ${from}`,
        `To: ${clean(mail.to)}`,
        `Subject: =?UTF-8?B?${b64(clean(mail.subject))}?=`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${messageId}>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        ...(Buffer.from(mail.text, 'utf8')
          .toString('base64')
          .match(/.{1,76}/g) ?? ['']),
      ].join('\r\n');
      send(body + '\r\n.');
      const done = await expect([250], 'data', 'message');
      const reply = serverText(done.text.replace(/^250[ -]?/gm, ''), cfg.password, 200);
      const ref =
        /(?:queued as|id=|Message accepted for delivery as)\s*([A-Za-z0-9._@<>:=-]{3,80})/i.exec(
          reply,
        )?.[1] ?? null;
      accepted = { reply, ref, messageId };
      report({ stage: 'sender', ok: true });
      report({ stage: 'recipient', ok: true });
      report({ stage: 'data', ok: true, info: { reply } });
    }
    send('QUIT');
    return { banner, features, methods: { before: methodsBefore, after: methodsAfter }, accepted };
  } catch (error) {
    const err =
      error instanceof SmtpError
        ? error
        : fail(stage, 'closed', (error as Error).message ?? 'Connection failed');
    if (err.stage)
      report({
        stage: err.stage,
        ok: false,
        code: err.code,
        smtpStatus: err.smtpStatus,
        serverText: err.serverText,
        info: err.detail,
      });
    throw err;
  } finally {
    signal?.removeEventListener('abort', abort);
    sock.destroy();
  }
}

/**
 * Какой сертификат предъявляет сервер, когда проверка не прошла: соединение без проверки, ничего не отправляется
 * и вход не выполняется. Нужно только для подсказки администратору (кто выдал, до какого срока, отпечаток).
 */
export async function probeCertificate(
  cfg: SmtpConfig,
  address: string,
): Promise<StageResult['info']> {
  const opts = {
    ...(net.isIP(cfg.host) === 0 ? { servername: cfg.host } : {}),
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2' as const,
  };
  const timeout = cfg.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeout).unref();
    const done = (t: tls.TLSSocket) => {
      clearTimeout(timer);
      const c = t.getPeerCertificate(true);
      const info = { ...certInfo(t), selfSigned: !!c && c.issuerCertificate === c };
      t.destroy();
      resolve(info as StageResult['info']);
    };
    if (cfg.security === 'tls') {
      const t = tls.connect({ ...opts, host: address, port: cfg.port }, () => done(t));
      t.once('error', reject);
      return;
    }
    const s = net.connect({ host: address, port: cfg.port });
    s.once('error', reject);
    const r = new Reader(s);
    void (async () => {
      try {
        await r.next();
        s.write('EHLO arklock.local\r\n');
        await r.next();
        s.write('STARTTLS\r\n');
        await r.next();
        const t = tls.connect({ ...opts, socket: s }, () => done(t));
        t.once('error', reject);
      } catch (e) {
        reject(e);
      }
    })();
  });
}
