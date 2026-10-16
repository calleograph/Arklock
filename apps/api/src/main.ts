import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connect } from './db/connect.js';
import { BlobStore } from './blobs.js';
import { runMaintenance } from './maintenance.js';

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
      void runMaintenance(
        database.db,
        new Date(),
        new BlobStore(config.BLOB_DIR),
        config.APP_SECRET,
      ).catch((e: unknown) => app.log.error({ err: String(e) }, 'maintenance failed')),
    6 * 3_600_000,
  );
  timer.unref();
  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
