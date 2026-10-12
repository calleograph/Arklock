import type { Config } from './config.js';
import type { Database, Db } from './db/connect.js';
import { ReauthStore } from './auth/reauth.js';
import { setAuditSink } from './audit.js';
import { BlobStore } from './blobs.js';
import { SyslogSink } from './syslog.js';
import { EnrollStore } from './auth/enroll.js';
import { LoginTickets } from './auth/tickets.js';
import { MfaChallenges, type MfaPolicy } from './auth/mfa.js';
import { AttemptLimiter } from './rateLimit.js';
import { UpdaterChannel } from './updater/protocol.js';

/** Общие зависимости маршрутов. */
export interface AppContext {
  config: Config;
  database: Database;
  db: Db;
  /** Ограничитель попыток входа/восстановления по адресу и по IP. */
  attempts: { byEmail: AttemptLimiter; byIp: AttemptLimiter };
  reauth: ReauthStore;
  updater: UpdaterChannel;
  blobs: BlobStore;
  mfa: MfaChallenges;
  enroll: EnrollStore;
  /** Билеты возврата после входа через OIDC / SAML. */
  tickets: LoginTickets;
  syslog: SyslogSink;
  /** Кэш предельной длительности сеанса пользователей SAML (часы). */
  samlPolicy?: { hours: number; until: number };
  mfaPolicyCache?: { value: MfaPolicy; until: number };
}

export function createContext(config: Config, database: Database): AppContext {
  const windowMs = config.LOGIN_WINDOW_MINUTES * 60_000;
  const syslog = new SyslogSink(database.db);
  setAuditSink(database.db, (ev) => void syslog.forward(ev));
  return {
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
    attempts: {
      byEmail: new AttemptLimiter(config.LOGIN_MAX_ATTEMPTS, windowMs),
      byIp: new AttemptLimiter(config.LOGIN_MAX_ATTEMPTS * 5, windowMs),
    },
  };
}
