import type { Logger } from '@ipc/platform';
import type { WorkflowConfig } from '../config/index.js';
import { ReconcileJob } from '../jobs/reconcile.job.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { Outbox } from './outbox.publisher.js';
import { ElevatePlanGateway, SeedStateDirectory, UnconfiguredPlanElevate, type PlanElevatePort } from './plan-elevate.gateway.js';
import { PlanService } from './plan.service.js';

export interface PlanRuntime { plans: PlanService; reconcile: ReconcileJob; elevate: PlanElevatePort }

/**
 * US3 wiring: the ELEVATE plan gateway (ward service accounts from the seed state file and
 * `WARD_SERVICE_ACCOUNT_PASSWORD`, falling back to `DEMO_USER_PASSWORD`), the plan service and the
 * reconcile job, connected so every plan transition triggers a reconciliation (FR-019).
 */
export function createPlanRuntime(o: {
  cfg: Pick<WorkflowConfig, 'IPC_PROFILE' | 'ELEVATE_USER_URL' | 'ELEVATE_PROJECT_URL' | 'ELEVATE_INTERNAL_ACCESS_TOKEN' | 'ELEVATE_TENANT_CODE' | 'ELEVATE_ORIGIN'>;
  ledger: LedgerService;
  outbox: Outbox;
  programmeNow: () => Date;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  elevate?: PlanElevatePort;
}): PlanRuntime {
  const env = o.env ?? process.env;
  let elevate = o.elevate;
  if (!elevate) {
    const password = env.WARD_SERVICE_ACCOUNT_PASSWORD ?? env.DEMO_USER_PASSWORD;
    const file = SeedStateDirectory.locate(o.cfg.IPC_PROFILE, env);
    let dir: SeedStateDirectory | undefined;
    try {
      dir = file && password ? SeedStateDirectory.fromFile(file, password) : undefined;
    } catch (err) {
      o.logger.warn({ err, file }, 'seed state file unreadable: plan approval will answer 503');
    }
    const g = ElevatePlanGateway.fromSettings({
      userUrl: o.cfg.ELEVATE_USER_URL, projectUrl: o.cfg.ELEVATE_PROJECT_URL, internalToken: o.cfg.ELEVATE_INTERNAL_ACCESS_TOKEN,
      tenantCode: o.cfg.ELEVATE_TENANT_CODE, origin: o.cfg.ELEVATE_ORIGIN, dir,
    });
    if ('missing' in g) o.logger.warn({ missing: g.missing }, 'ELEVATE plan settings missing: plan approval answers 503');
    elevate = 'missing' in g ? new UnconfiguredPlanElevate(g.missing) : g;
  }
  const plans = new PlanService({ ledger: o.ledger, outbox: o.outbox, elevate, programmeNow: o.programmeNow, logger: o.logger });
  const reconcile = new ReconcileJob({ elevate, ledger: o.ledger, logger: o.logger });
  plans.attachReconcile(reconcile);
  return { plans, reconcile, elevate };
}
