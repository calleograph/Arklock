import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connect } from './db/connect.js';

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

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
