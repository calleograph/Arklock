import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import { eq } from 'drizzle-orm';
import type { Db } from './db/connect.js';
import { settings } from './db/schema.js';

export const SYSLOG_KEY = 'syslog.config';

export interface SyslogConfig {
  enabled: boolean;
  host: string;
  port: number;
  protocol: 'udp' | 'tcp' | 'tls';
  /** Не проверять сертификат сервера (только стенд). */
  insecureTls: boolean;
  /** Минимальный набор действий: пусто — все события. Префиксы вида «auth.», «admin.». */
  prefixes: string[];
}

export interface AuditEvent {
  at: Date;
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
}

/** Серьёзность по смыслу события (RFC 5424): отказ и блокировка — предупреждение, остальное — уведомление. */
const severity = (action: string): number =>
  /failed|denied|reject|blocked|reset/.test(action)
    ? 4
    : /delete|purge|revoke|disable|restore/.test(action)
      ? 5
      : 6;

/** Значение структурированных данных: экранирование по RFC 5424 §6.3.3. */
const sdEscape = (v: string): string =>
  v.replace(/[\\"\]]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, ' ');

/**
 * Сообщение RFC 5424: <PRI>1 TIMESTAMP HOST APP PROCID MSGID [SD] MSG. Пароли, ключи и содержимое записей в события
 * журнала не попадают (audit() принимает только идентификаторы и коды); здесь дополнительно усекаются значения.
 */
export function formatSyslog(ev: AuditEvent, host = os.hostname()): string {
  const pri = 16 * 8 + severity(ev.action); // local0
  const sd = [`actor="${sdEscape(ev.actor)}"`];
  if (ev.target) sd.push(`target="${sdEscape(ev.target)}"`);
  for (const [k, v] of Object.entries(ev.detail ?? {})) {
    if (/^[A-Za-z0-9_-]{1,32}$/.test(k)) sd.push(`${k}="${sdEscape(String(v)).slice(0, 200)}"`);
  }
  const hostname = (host || '-').replace(/[^\x21-\x7e]/g, '-').slice(0, 255);
  return `<${pri}>1 ${ev.at.toISOString()} ${hostname} arklock - ${ev.action.replace(/[^\x21-\x7e]/g, '_').slice(0, 32)} [arklock@0 ${sd.join(' ')}] ${ev.action}`;
}

/** Отправка событий во внешний сборщик журналов (syslog). Сбои не влияют на работу приложения: счётчик и последняя ошибка видны администратору. */
export class SyslogSink {
  private cfg: SyslogConfig | null = null;
  private loadedAt = 0;
  sent = 0;
  failed = 0;
  lastError = '';
  lastAt: string | null = null;
  private tcp: net.Socket | tls.TLSSocket | null = null;
  private udp: dgram.Socket | null = null;

  constructor(private readonly db: Db) {}

  reset(): void {
    this.cfg = null;
    this.loadedAt = 0;
    this.close();
  }

  private close(): void {
    this.tcp?.destroy();
    this.tcp = null;
    this.udp?.close();
    this.udp = null;
  }

  private async config(): Promise<SyslogConfig | null> {
    if (Date.now() - this.loadedAt < 10_000) return this.cfg;
    const [row] = await this.db.select().from(settings).where(eq(settings.key, SYSLOG_KEY));
    const v = row?.value as SyslogConfig | undefined;
    this.cfg = v?.enabled ? v : null;
    this.loadedAt = Date.now();
    return this.cfg;
  }

  /** Вызывается после записи в журнал. Никогда не бросает исключений. */
  async forward(ev: AuditEvent): Promise<void> {
    try {
      const cfg = await this.config();
      if (!cfg) return;
      if (cfg.prefixes.length && !cfg.prefixes.some((p) => ev.action.startsWith(p))) return;
      await this.send(cfg, formatSyslog(ev));
      this.sent++;
      this.lastAt = new Date().toISOString();
    } catch (e) {
      this.failed++;
      this.lastError = (e as Error).message.slice(0, 200);
    }
  }

  /** Проверочная отправка: ошибка возвращается, а не скрывается. */
  async test(cfg: SyslogConfig): Promise<void> {
    const msg = formatSyslog({
      at: new Date(),
      actor: 'system',
      action: 'admin.syslog.test',
      target: null,
      detail: null,
    });
    await this.send(cfg, msg, true);
  }

  private async send(cfg: SyslogConfig, msg: string, fresh = false): Promise<void> {
    if (cfg.protocol === 'udp') {
      const sock = fresh ? dgram.createSocket('udp4') : (this.udp ??= dgram.createSocket('udp4'));
      await new Promise<void>((resolve, reject) =>
        sock.send(msg, cfg.port, cfg.host, (err) => {
          if (fresh) sock.close();
          if (err) reject(err);
          else resolve();
        }),
      );
      return;
    }
    // TCP/TLS: кадрирование с подсчётом октетов (RFC 6587): «длина сообщение»
    const framed = `${Buffer.byteLength(msg)} ${msg}`;
    const socket = fresh ? await this.connect(cfg) : await this.ensureTcp(cfg);
    await new Promise<void>((resolve, reject) =>
      socket.write(framed, (err) => {
        if (fresh) socket.end();
        if (err) {
          this.tcp = null;
          reject(err);
        } else resolve();
      }),
    );
  }

  private connecting: Promise<net.Socket> | null = null;

  /** Одно общее соединение: параллельные отправки ждут один и тот же вызов connect. */
  private async ensureTcp(cfg: SyslogConfig): Promise<net.Socket> {
    if (this.tcp && !this.tcp.destroyed) return this.tcp;
    this.connecting ??= this.connect(cfg)
      .then((sock) => {
        this.tcp = sock;
        sock.on('close', () => {
          if (this.tcp === sock) this.tcp = null;
        });
        sock.on('error', () => {
          if (this.tcp === sock) this.tcp = null;
        });
        return sock;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private connect(cfg: SyslogConfig): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), 5000);
      const done = (s: net.Socket) => {
        clearTimeout(timer);
        s.on('error', () => undefined);
        resolve(s);
      };
      const s: net.Socket =
        cfg.protocol === 'tls'
          ? tls.connect(
              {
                host: cfg.host,
                port: cfg.port,
                servername: cfg.host,
                rejectUnauthorized: !cfg.insecureTls,
              },
              () => done(s),
            )
          : net.connect({ host: cfg.host, port: cfg.port }, () => done(s));
      s.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
}
