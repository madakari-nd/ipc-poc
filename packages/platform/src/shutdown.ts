import type { Server } from 'node:http';
import type { Logger } from 'pino';

export interface ShutdownOptions {
  server: Server;
  logger: Logger;
  /** Called first: mark not-ready so the proxy stops routing new traffic. */
  onDrainStart?: () => void;
  /** Stop consumers / jobs (no event acknowledged before its changes commit). */
  stopWorkers?: () => Promise<void>;
  /** Close stores last. */
  closeStores?: () => Promise<void>;
  graceMs?: number;
}

/** Graceful drain within 30 s (NFR-004). Returns the handler for tests. */
export function installGracefulShutdown(o: ShutdownOptions): (signal: string) => Promise<void> {
  const grace = o.graceMs ?? 30_000;
  let shuttingDown = false;
  const handler = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    o.logger.info({ signal }, 'shutdown: draining');
    o.onDrainStart?.();
    const force = setTimeout(() => {
      o.logger.error('shutdown: grace period exceeded, forcing exit');
      process.exit(1);
    }, grace);
    force.unref();
    await new Promise<void>((resolve) => o.server.close(() => resolve()));
    await o.stopWorkers?.();
    await o.closeStores?.();
    o.logger.info('shutdown: complete');
    clearTimeout(force);
  };
  process.once('SIGTERM', () => void handler('SIGTERM').then(() => process.exit(0)));
  process.once('SIGINT', () => void handler('SIGINT').then(() => process.exit(0)));
  return handler;
}
