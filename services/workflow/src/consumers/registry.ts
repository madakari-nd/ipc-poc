import type { BaseConsumer, ConsumerDeps } from './base.consumer.js';

/**
 * Every event consumer of the workflow service. Used by the server (live consumption) and by
 * `npm run dlq:replay` (replay by topic). Story phases add their consumers here (e.g. the ELEVATE
 * observation-completed consumer).
 */
export function createConsumers(_deps: ConsumerDeps): BaseConsumer<unknown>[] {
  return [];
}
