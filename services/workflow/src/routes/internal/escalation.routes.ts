import { Router } from 'express';
import { Problem } from '@ipc/platform';
import { serviceJwtAuth, type ServiceJwtOptions } from '../../auth/service-jwt.js';
import type { EscalationService } from '../../services/escalation.service.js';

export interface EscalationInternalDeps {
  /** Static shared secret the ELEVATE scheduler sends (V2: the scheduler has no auth and no HMAC). */
  schedulerSecret: string;
  escalations: EscalationService;
  /** Allows the demo "run now" sweep (only when the demo clock is allowed). */
  demoRunNowAllowed: () => boolean;
  /** Service-JWT options for the demo run-now route (forwarded by the Edge). */
  jwt: ServiceJwtOptions;
}

/**
 * /internal/escalations (US5, T100; research E12, security V2). `sweep` is called hourly by the
 * ELEVATE scheduler with a static `X-Scheduler-Secret` header (the Edge never exposes the scheduler);
 * `run-now` is forwarded by the Edge for STATE_ADMIN in demo mode (service JWT). Both are idempotent
 * per (task, ruleCode, level). This router mounts BEFORE the blanket service-JWT gate on /internal,
 * and guards each route itself: the scheduler secret is not a JWT, and run-now requires one.
 */
export function internalEscalationRoutes(d: EscalationInternalDeps): Router {
  const r = Router();

  // Scheduler callback: no JWT, only the static shared secret (security case V2).
  r.post('/escalations/sweep', async (req, res) => {
    if (req.header('x-scheduler-secret') !== d.schedulerSecret) {
      throw Problem.unauthorized('Missing or incorrect scheduler secret');
    }
    res.json(await d.escalations.sweep('schedule'));
  });

  // Demo "run now": reached only through the Edge with a service JWT (STATE_ADMIN, demo mode).
  r.post('/escalations/run-now', serviceJwtAuth(d.jwt), async (_req, res) => {
    if (!d.demoRunNowAllowed()) throw Problem.forbidden('DEMO_MODE_DISABLED', 'The demo escalation sweep is available only in demo mode on dev, test or uat');
    res.json(await d.escalations.sweep('demo_run_now'));
  });

  return r;
}
