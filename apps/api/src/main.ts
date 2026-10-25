import { buildApp } from './app.js';
import { autoUpdateTick } from './auto-update.js';
import { createContext } from './context.js';
import { loadConfig } from './config.js';
import { connect } from './db/connect.js';
import { BlobStore } from './blobs.js';
import { runMaintenance } from './maintenance.js';
import { sampleMetrics } from './metrics.js';
import os from 'node:os';
import { syncScheduledLdap } from './auth/ldap-sync.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const database = await connect(config.DATABASE_URL);
  await database.migrate();
  const app = await buildApp({ config, database });

  // Корректная остановка контейнера: перестаём принимать соединения и закрываем БД.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }

  // Плановое обслуживание: очистка корзины по сроку хранения, старых сеансов и журналов.
  const timer = setInterval(
    () =>
      void runMaintenance(database.db, new Date(), new BlobStore(config.BLOB_DIR)).catch(
        (e: unknown) => app.log.error({ err: String(e) }, 'maintenance failed'),
      ),
    6 * 3_600_000,
  );
  timer.unref();
  // История ресурсов для графиков в панели: точка раз в пять минут, первая — сразу после запуска.
  const sample = () =>
    void sampleMetrics(database.db, [config.BLOB_DIR, os.tmpdir()]).catch((e: unknown) =>
      app.log.error({ err: String(e) }, 'metrics sample failed'),
    );
  sample();
  const metricsTimer = setInterval(sample, 5 * 60_000);
  metricsTimer.unref();
  // Автоматические проверки новой версии (каждые 30 минут) и плановая установка: раз в минуту решает, пора ли.
  // shortcut: таймер в каждом процессе; помощник принимает один запрос за раз, лишние отклоняются — при нескольких экземплярах нужна общая блокировка
  const ctx = createContext(config, database);
  let ticking = false;
  const updateTimer = setInterval(() => {
    if (config.AUTO_UPDATE === 'off') return;
    if (ticking) return;
    ticking = true;
    autoUpdateTick(ctx)
      .catch((e: unknown) => app.log.error({ err: String(e) }, 'auto update failed'))
      .finally(() => (ticking = false));
  }, 60_000);
  updateTimer.unref();
  // Сверка с каталогами — чаще обслуживания: отключённый в каталоге теряет сеансы не позже чем через 30 минут.
  // shortcut: таймер в каждом процессе; при нескольких экземплярах сверка повторяется (она идемпотентна) — тогда нужна общая блокировка
  let syncing = false;
  const directoryTimer = setInterval(() => {
    if (syncing) return; // большой каталог: следующий запуск не накладывается на незавершённый
    syncing = true;
    syncScheduledLdap(database.db, config.APP_SECRET)
      .catch((e: unknown) => app.log.error({ err: String(e) }, 'directory sync failed'))
      .finally(() => (syncing = false));
  }, 30 * 60_000);
  directoryTimer.unref();
  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
