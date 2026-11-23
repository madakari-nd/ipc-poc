import { createEventValidator } from '@ipc/contracts';
import { ELEVATE_TOPICS } from '@ipc/elevate-client';
import type { Profile } from '../domain/clock.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { Outbox } from '../services/outbox.publisher.js';
import { UnconfiguredPlanElevate } from '../services/plan-elevate.gateway.js';
import { PlanService } from '../services/plan.service.js';
import type { BaseConsumer, ConsumerDeps } from './base.consumer.js';
import { ObservationCompletedConsumer } from './observation-completed.consumer.js';

export interface RegistryDeps extends ConsumerDeps {
  /** US3: the server passes its own ledger and plan service (shared clock); replay builds defaults. */
  ledger?: LedgerService;
  plans?: PlanService;
  /** `elevate_observations_<env>` (default: the ELEVATE stack's topic). */
  observationTopic?: string;
}

/**
 * Every event consumer of the workflow service. Used by the server (live consumption) and by
 * `npm run dlq:replay` (replay by topic). Story phases add their consumers here.
 */
export function createConsumers(deps: RegistryDeps): BaseConsumer<unknown>[] {
  const ledger = deps.ledger ?? new LedgerService(() => new Date());
  const plans = deps.plans ?? new PlanService({
    ledger,
    outbox: new Outbox({ profile: (process.env.IPC_PROFILE ?? 'dev') as Profile, validator: createEventValidator(), programmeNow: () => new Date() }),
    elevate: new UnconfiguredPlanElevate(['replay: drafting needs no ELEVATE call']),
    programmeNow: () => new Date(),
  });
  return [
    // US3 (T084): ELEVATE observation completion → assessment result → draft plan.
    new ObservationCompletedConsumer({
      ...deps,
      topic: deps.observationTopic ?? process.env.ELEVATE_OBSERVATION_TOPIC ?? ELEVATE_TOPICS.observations,
      plans,
      ledger,
    }) as unknown as BaseConsumer<unknown>,
  ];
}
