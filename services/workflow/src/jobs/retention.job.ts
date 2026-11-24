import type { Logger } from '@ipc/platform';
import type { RetentionService } from '../services/retention.service.js';

export const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;

/** Daily retention purge (T128, NFR-010): dry-run report in the POC, every purge decision ledgered. */
export class RetentionJob {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;

  constructor(private readonly d: { service: RetentionService; logger: Logger }) {}

  async runOnce(): Promise<void> {
    try {
      await this.d.service.scan();
    } catch (err) {
      this.d.logger.error({ err }, 'retention scan failed');
    }
  }

  start(intervalMs = RETENTION_INTERVAL_MS): void {
    const tick = () => {
      this.running = this.runOnce()
        .catch((err: unknown) => this.d.logger.error({ err }, 'retention run failed'))
        .finally(() => {
          if (this.timer !== undefined) this.timer = setTimeout(tick, intervalMs);
        });
    };
    this.timer = setTimeout(tick, intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    const t = this.timer;
    this.timer = undefined;
    if (t) clearTimeout(t);
    await this.running;
  }
}
