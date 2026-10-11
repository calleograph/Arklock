import net from 'node:net';
import tls from 'node:tls';

export interface SmtpConfig {
  host: string;
  port: number;
  /** none — без шифрования (только для доверенной сети), starttls — повышение на порту 587, tls — сразу TLS (порт 465). */
  security: 'none' | 'starttls' | 'tls';
  user: string;
  password: string;
  from: string;
  /** Не проверять сертификат сервера (только для тестового стенда). */
  allowSelfSigned?: boolean;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code: string,
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

  constructor(private sock: Sock) {
    this.attach(sock);
  }

  attach(sock: Sock): void {
    this.sock = sock;
    sock.on('data', (d: Buffer) => {
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

  private pending: { code: number; text: string }[] = [];

  next(): Promise<{ code: number; text: string }> {
    const p = this.pending.shift();
    if (p) return Promise.resolve(p);
    if (this.failure) return Promise.resolve({ code: -1, text: this.failure.message });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new SmtpError(`Timed out: ${what}`, 'timeout')), ms).unref(),
    ),
  ]);

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
}

/**
 * Минимальный клиент SMTP: соединение, STARTTLS/TLS, AUTH PLAIN/LOGIN, отправка одного письма.
 * mail === null — только проверка соединения и входа (письмо не отправляется).
 */
export async function smtpSession(
  cfg: SmtpConfig,
  mail: Mail | null,
  timeoutMs = 15_000,
): Promise<{ banner: string; features: string[] }> {
  const tlsOpts = {
    host: cfg.host,
    port: cfg.port,
    servername: cfg.host,
    rejectUnauthorized: !cfg.allowSelfSigned,
  };
  let sock: Sock = await withTimeout(
    new Promise<Sock>((resolve, reject) => {
      const s: Sock =
        cfg.security === 'tls'
          ? tls.connect(tlsOpts, () => resolve(s))
          : net.connect({ host: cfg.host, port: cfg.port }, () => resolve(s));
      s.once('error', (e) =>
        reject(new SmtpError(`Cannot connect: ${(e as Error).message}`, 'connect')),
      );
    }),
    timeoutMs,
    'connect',
  );
  const reader = new Reader(sock);
  const send = (line: string) => sock.write(line + '\r\n');
  const expect = async (ok: number[], what: string) => {
    const r = await withTimeout(reader.next(), timeoutMs, what);
    if (!ok.includes(r.code)) throw new SmtpError(`${what}: ${r.text.slice(0, 200)}`, 'protocol');
    return r;
  };
  try {
    const banner = (await expect([220], 'greeting')).text;
    send(`EHLO arklock.local`);
    let caps = (await expect([250], 'EHLO')).text;
    if (cfg.security === 'starttls') {
      if (!/STARTTLS/i.test(caps))
        throw new SmtpError('The server does not offer STARTTLS', 'starttls');
      send('STARTTLS');
      await expect([220], 'STARTTLS');
      const upgraded = tls.connect({ ...tlsOpts, socket: sock as net.Socket });
      await withTimeout(
        new Promise<void>((res, rej) => {
          upgraded.once('secureConnect', () => res());
          upgraded.once('error', (e) => rej(new SmtpError(`TLS failed: ${e.message}`, 'tls')));
        }),
        timeoutMs,
        'TLS',
      );
      sock = upgraded;
      reader.attach(upgraded);
      send(`EHLO arklock.local`);
      caps = (await expect([250], 'EHLO')).text;
    }
    const features = caps
      .split('\n')
      .slice(1)
      .map((l) => l.slice(4));
    if (cfg.user) {
      if (cfg.security === 'none') {
        // пароль в открытом виде по сети — только по явному выбору администратора
      }
      if (/AUTH[^\n]*PLAIN/i.test(caps)) {
        send(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.password}`)}`);
        await expect([235], 'AUTH');
      } else if (/AUTH[^\n]*LOGIN/i.test(caps)) {
        send('AUTH LOGIN');
        await expect([334], 'AUTH');
        send(b64(cfg.user));
        await expect([334], 'AUTH');
        send(b64(cfg.password));
        await expect([235], 'AUTH');
      } else throw new SmtpError('The server offers no supported AUTH method', 'auth');
    }
    if (mail) {
      send(`MAIL FROM:<${clean(cfg.from)}>`);
      await expect([250], 'MAIL FROM');
      send(`RCPT TO:<${clean(mail.to)}>`);
      await expect([250, 251], 'RCPT TO');
      send('DATA');
      await expect([354], 'DATA');
      const body = [
        `From: ${clean(cfg.from)}`,
        `To: ${clean(mail.to)}`,
        `Subject: =?UTF-8?B?${b64(clean(mail.subject))}?=`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        ...(Buffer.from(mail.text, 'utf8')
          .toString('base64')
          .match(/.{1,76}/g) ?? ['']),
      ].join('\r\n');
      send(body + '\r\n.');
      await expect([250], 'message');
    }
    send('QUIT');
    return { banner, features };
  } finally {
    sock.destroy();
  }
}
