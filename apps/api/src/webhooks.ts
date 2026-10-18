import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AuditSinkEvent } from './audit.js';
import type { Db } from './db/connect.js';
import { settings } from './db/schema.js';
import { safeGet } from './net/safeFetch.js';
import { openSetting } from './secretbox.js';

export const WEBHOOKS_KEY = 'webhooks.config';
export const webhookSecretPurpose = (id: string) => `webhook-secret:${id}`;

export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  /** Секрет подписи, запечатанный ключом приложения; наружу не отдаётся. */
  secretSealed: string;
  /** Префиксы событий журнала («admin.», «auth.»); пусто — все. */
  prefixes: string[];
  enabled: boolean;
}

export interface WebhookStatus {
  sent: number;
  failed: number;
  lastError: string;
  lastAt: string | null;
}

/** Подпись: HMAC-SHA256 над «метка.тело». Получатель сверяет подпись и отбрасывает старые метки. */
export const signWebhook = (secret: string, timestamp: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

/**
 * Исходящие уведомления о событиях журнала. В тело попадают только несекретные метаданные события (идентификаторы и коды):
 * записи, пароли и ключи сюда не поступают. Доставка в фоне, три попытки; сбой не влияет на работу приложения.
 */
export class WebhookSink {
  private hooks: WebhookConfig[] | null = null;
  private loadedAt = 0;
  readonly status = new Map<string, WebhookStatus>();

  constructor(
    private readonly db: Db,
    private readonly appSecret: string,
    private readonly insecureForTests = false,
  ) {}

  reset(): void {
    this.hooks = null;
  }

  async load(): Promise<WebhookConfig[]> {
    if (!this.hooks || Date.now() - this.loadedAt > 30_000) {
      const [row] = await this.db.select().from(settings).where(eq(settings.key, WEBHOOKS_KEY));
      this.hooks = ((row?.value as { hooks?: WebhookConfig[] } | undefined)?.hooks ?? []).slice();
      this.loadedAt = Date.now();
    }
    return this.hooks;
  }

  statusOf(id: string): WebhookStatus {
    return this.status.get(id) ?? { sent: 0, failed: 0, lastError: '', lastAt: null };
  }

  /** Одна доставка; возвращает код ответа получателя. */
  async deliver(hook: WebhookConfig, type: string, data: Record<string, unknown>): Promise<number> {
    const body = JSON.stringify({ id: randomUUID(), type, at: new Date().toISOString(), ...data });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const secret = openSetting(this.appSecret, webhookSecretPurpose(hook.id), hook.secretSealed);
    const res = await safeGet(hook.url, {
      method: 'POST',
      body,
      timeoutMs: 8000,
      maxBytes: 64 * 1024,
      allowInsecureForTests: this.insecureForTests,
      headers: {
        'Content-Type': 'application/json',
        'X-Arklock-Event': type,
        'X-Arklock-Timestamp': timestamp,
        'X-Arklock-Signature': signWebhook(secret, timestamp, body),
      },
    });
    return res.status;
  }

  private async deliverWithRetry(hook: WebhookConfig, ev: AuditSinkEvent): Promise<void> {
    const st = this.statusOf(hook.id);
    this.status.set(hook.id, st);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const code = await this.deliver(hook, ev.action, {
          actor: ev.actor,
          target: ev.target,
          detail: ev.detail,
        });
        if (code >= 200 && code < 300) {
          st.sent++;
          st.lastAt = new Date().toISOString();
          return;
        }
        st.lastError = `HTTP ${code}`;
      } catch (e) {
        st.lastError = (e instanceof Error ? e.message : 'delivery failed').slice(0, 200);
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, attempt === 0 ? 1000 : 5000));
    }
    st.failed++;
    st.lastAt = new Date().toISOString();
  }

  /** Вызывается из журнала для каждого события; ожидание доставки не блокирует запрос пользователя. */
  forward(ev: AuditSinkEvent): void {
    void this.load()
      .then((hooks) => {
        for (const h of hooks) {
          if (!h.enabled) continue;
          if (h.prefixes.length && !h.prefixes.some((p) => ev.action.startsWith(p))) continue;
          void this.deliverWithRetry(h, ev);
        }
      })
      .catch(() => undefined);
  }
}
