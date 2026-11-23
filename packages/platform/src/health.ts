import { Router, type Router as ExpressRouter } from 'express';
import { metricsHandler } from './metrics.js';

export type Check = () => Promise<boolean>;

export interface HealthOptions {
  /** Own stores and broker only (Constitution VI v1.1.1, NFR-004). */
  readiness: Record<string, Check>;
  /** ELEVATE and other dependencies: reported, never fail readiness. */
  dependencies: Record<string, Check>;
}

async function run(checks: Record<string, Check>, timeoutMs = 2000) {
  const out: Record<string, 'up' | 'down'> = {};
  await Promise.all(
    Object.entries(checks).map(async ([k, fn]) => {
      try {
        const ok = await Promise.race([fn(), new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))]);
        out[k] = ok ? 'up' : 'down';
      } catch {
        out[k] = 'down';
      }
    }),
  );
  return out;
}

export type HealthRouter = ExpressRouter & { setDraining(): void };

/** /healthz (liveness), /readyz (own stores), /dependencies (ELEVATE status), /metrics. */
export function healthRouter(opts: HealthOptions): HealthRouter {
  let draining = false;
  const r = Router() as HealthRouter;
  r.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  r.get('/readyz', async (_req, res) => {
    const checks = await run(opts.readiness);
    const ok = !draining && Object.values(checks).every((v) => v === 'up');
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : draining ? 'draining' : 'not_ready', checks });
  });
  r.get('/dependencies', async (_req, res) => {
    res.json({ dependencies: await run(opts.dependencies, 3000) });
  });
  r.get('/metrics', metricsHandler);
  r.setDraining = () => { draining = true; };
  return r;
}
