import mongoose from 'mongoose';
import { ConfigError, createLogger, installGracefulShutdown } from '@ipc/platform';
import { readConfig } from './config.js';
import { createApp } from './app.js';

const logger = createLogger('adapters');

async function main() {
  const cfg = readConfig();
  const conn = await mongoose.createConnection(cfg.MONGO_URL, { dbName: `ipc_${cfg.IPC_PROFILE}` }).asPromise();
  const { app, health } = createApp({
    logger,
    readiness: { mongo: async () => conn.readyState === 1 },
  });
  const server = app.listen(cfg.PORT, () => logger.info({ port: cfg.PORT }, 'adapters listening'));
  installGracefulShutdown({ server, logger, onDrainStart: () => health.setDraining(), closeStores: () => conn.close() });
}

main().catch((err: unknown) => {
  logger.fatal({ err: err instanceof ConfigError ? err.message : err }, 'adapters failed to start');
  process.exit(1);
});
