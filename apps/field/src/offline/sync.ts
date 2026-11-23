/** Background sync registration and the foreground retry policy (research T15). */
export const SYNC_TAG = 'ipc-outbox';
export const MAX_ATTEMPTS = 6;
const BASE_MS = 2_000;
const CAP_MS = 5 * 60_000;

/** Exponential backoff with "equal jitter": half fixed, half random. `attempt` starts at 1. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + (exp / 2) * random());
}

interface SyncCapableRegistration {
  sync?: { register: (tag: string) => Promise<void> };
}

/** Asks the service worker to wake us when connectivity returns. False when unsupported. */
export async function registerBackgroundSync(nav: Navigator = navigator): Promise<boolean> {
  if (!nav.serviceWorker) return false;
  try {
    const reg = (await nav.serviceWorker.ready) as unknown as SyncCapableRegistration;
    if (!reg.sync) return false;
    await reg.sync.register(SYNC_TAG);
    return true;
  } catch {
    return false;
  }
}

export interface SyncTarget {
  flush: () => Promise<{ nextAttemptAt?: number; authRequired?: boolean }>;
  reportQueueStatus: () => Promise<void>;
}

/**
 * Foreground runner: flushes on start, on "online", on the service worker's sync message and when
 * the app becomes visible, then re-arms a timer for the earliest backoff.
 */
export class SyncRunner {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private readonly onWake = () => void this.run();
  private readonly onMessage = (e: MessageEvent) => {
    if ((e.data as { type?: string } | null)?.type === 'ipc-outbox-sync') void this.run();
  };

  constructor(
    private readonly target: SyncTarget,
    private readonly hooks: { onAuthRequired?: () => void; onAfterRun?: () => void } = {},
  ) {}

  start(): void {
    window.addEventListener('online', this.onWake);
    document.addEventListener('visibilitychange', this.onWake);
    navigator.serviceWorker?.addEventListener('message', this.onMessage);
    void this.run();
  }

  stop(): void {
    window.removeEventListener('online', this.onWake);
    document.removeEventListener('visibilitychange', this.onWake);
    navigator.serviceWorker?.removeEventListener('message', this.onMessage);
    if (this.timer) clearTimeout(this.timer);
  }

  async run(): Promise<void> {
    if (this.running || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    this.running = true;
    try {
      const res = await this.target.flush();
      if (res.authRequired) this.hooks.onAuthRequired?.();
      await this.target.reportQueueStatus().catch(() => undefined);
      if (this.timer) clearTimeout(this.timer);
      if (res.nextAttemptAt !== undefined) {
        this.timer = setTimeout(() => void this.run(), Math.max(1_000, res.nextAttemptAt - Date.now()));
      }
    } finally {
      this.running = false;
      this.hooks.onAfterRun?.();
    }
  }
}
