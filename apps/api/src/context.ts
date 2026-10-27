import type { Config } from './config.js';
import type { Database, Db } from './db/connect.js';
import { ReauthStore } from './auth/reauth.js';
import { setAuditSink } from './audit.js';
import { BlobStore } from './blobs.js';
import { SyslogSink } from './syslog.js';
import { WebhookSink } from './webhooks.js';
import { EnrollStore } from './auth/enroll.js';
import { LoginTickets } from './auth/tickets.js';
import { MfaChallenges, type MfaPolicy } from './auth/mfa.js';
import { AttemptLimiter } from './rateLimit.js';
import { UpdaterChannel } from './updater/protocol.js';
import { SecurityLog } from './shield/events.js';
import { Shield } from './shield/throttle.js';
import { AccessControl } from './shield/access.js';
import { Alerts } from './shield/alerts.js';

/** Общие зависимости маршрутов. */
export interface AppContext {
  config: Config;
  database: Database;
  db: Db;
  /** Ограничитель попыток входа/восстановления по адресу и по IP. */
  attempts: { byEmail: AttemptLimiter; byIp: AttemptLimiter };
  /** Централизованная защита входа и восстановления (ограничения, блокировки, дополнительная проверка). */
  shield: Shield;
  /** Разрешённые клиентские подсети и доверенные reverse proxy. */
  access: AccessControl;
  alerts: Alerts;
  securityLog: SecurityLog;
  reauth: ReauthStore;
  updater: UpdaterChannel;
  blobs: BlobStore;
  mfa: MfaChallenges;
  enroll: EnrollStore;
  /** Билеты возврата после входа через OIDC / SAML. */
  tickets: LoginTickets;
  syslog: SyslogSink;
  webhooks: WebhookSink;
  /** Кэш предельной длительности сеанса пользователей SAML (часы). */
  samlPolicy?: { hours: number; until: number };
  /** Публичный адрес, заданный в панели (system.publicUrl); главнее APP_PUBLIC_URL из файла установки. */
  publicUrlOverride?: string;
  mfaPolicyCache?: { value: MfaPolicy; until: number };
}

export function createContext(config: Config, database: Database): AppContext {
  const windowMs = config.LOGIN_WINDOW_MINUTES * 60_000;
  const syslog = new SyslogSink(database.db);
  const webhooks = new WebhookSink(database.db, config.APP_SECRET, config.NODE_ENV === 'test');
  setAuditSink(database.db, (ev) => {
    void syslog.forward(ev);
    webhooks.forward(ev);
  });
  const securityLog = new SecurityLog(database.db);
  const ctx: AppContext = {
    alerts: undefined as never,
    shield: new Shield(database.db, config.APP_SECRET, securityLog),
    access: new AccessControl(database.db, () =>
      securityLog.record({
        kind: 'access_restriction_rollback',
        level: 'critical',
        result: 'rolled_back',
        rule: 'access.confirm',
        source: 'system',
      }),
    ),
    securityLog,
    config,
    database,
    db: database.db,
    reauth: new ReauthStore(),
    updater: new UpdaterChannel(config.UPDATER_DIR),
    blobs: new BlobStore(config.BLOB_DIR),
    mfa: new MfaChallenges(),
    enroll: new EnrollStore(),
    tickets: new LoginTickets(),
    syslog,
    webhooks,
    attempts: {
      byEmail: new AttemptLimiter(config.LOGIN_MAX_ATTEMPTS, windowMs),
      byIp: new AttemptLimiter(config.LOGIN_MAX_ATTEMPTS * 5, windowMs),
    },
  };
  ctx.alerts = new Alerts(ctx);
  securityLog.onRecord = (e) => ctx.alerts.handle(e);
  return ctx;
}
