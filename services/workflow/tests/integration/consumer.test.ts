import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ClientSession } from 'mongoose';
import { createLogger } from '@ipc/platform';
import { BaseConsumer, replayDeadLetters, type RawMessage } from '../../src/consumers/base.consumer.js';
import { ConsumedEventModel, DeadLetterModel, ScopeAssignmentModel } from '../../src/domain/models/index.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

interface ObsEvent { orgId?: string; submissionId: string; status: string; userId: string }

const logger = createLogger('workflow-test', 'silent');
const TOPIC = 'elevate_observations_test';

/** Test consumer: writes one scope assignment per event (a visible side effect inside the tx). */
class TestConsumer extends BaseConsumer<ObsEvent> {
  readonly topic = TOPIC;
  failNext = 0;
  protected orgIdOf(e: ObsEvent) { return e.orgId; }
  protected dedupeOf(e: ObsEvent) { return { key: e.submissionId, status: e.status }; }
  protected async handle(e: ObsEvent, session: ClientSession) {
    await ScopeAssignmentModel.create(
      [{ userId: e.userId, role: 'STATE_ADMIN', scope: { level: 'state' }, validFrom: new Date(), source: 'admin' }],
      { session },
    );
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('handler failed');
    }
  }
}

const msg = (e: Partial<ObsEvent>, value?: string): RawMessage => ({
  topic: TOPIC,
  key: e.submissionId ?? null,
  value: value ?? JSON.stringify({ orgId: '7', submissionId: 's-1', status: 'completed', userId: 'u-1', ...e }),
  partition: 0,
  offset: '42',
});

let mongo: TestMongo;
let consumer: TestConsumer;
beforeAll(async () => { mongo = await startMongo('ipc_consumer_test'); });
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => {
  await mongo.clear();
  consumer = new TestConsumer({ logger, orgId: '7', maxAttempts: 2, retryDelayMs: 1 });
});

describe('BaseConsumer', () => {
  it('processes once and dedupes redeliveries on (topic, key, status)', async () => {
    expect(await consumer.process(msg({}))).toBe('processed');
    expect(await consumer.process(msg({}))).toBe('duplicate');
    expect(await ScopeAssignmentModel.countDocuments()).toBe(1);
    // a new status for the same submission is a different event
    expect(await consumer.process(msg({ status: 'submitted' }))).toBe('processed');
    expect(await ConsumedEventModel.countDocuments()).toBe(2);
  });

  it('dedupes concurrent deliveries of the same event', async () => {
    const outcomes = await Promise.all([consumer.process(msg({})), consumer.process(msg({})), consumer.process(msg({}))]);
    expect(outcomes.filter((o) => o === 'processed')).toHaveLength(1);
    expect(await ScopeAssignmentModel.countDocuments()).toBe(1);
  });

  it("ignores events from another ELEVATE organisation or without one", async () => {
    expect(await consumer.process(msg({ orgId: '8' }))).toBe('filtered');
    expect(await consumer.process(msg({}, JSON.stringify({ submissionId: 's', status: 'x', userId: 'u' })))).toBe('filtered');
    expect(await ConsumedEventModel.countDocuments()).toBe(0);
  });

  it('retries, then dead-letters with nothing half-written', async () => {
    consumer.failNext = 5;
    expect(await consumer.process(msg({}))).toBe('dead_lettered');
    expect(await ScopeAssignmentModel.countDocuments()).toBe(0);
    expect(await ConsumedEventModel.countDocuments()).toBe(0);
    const dl = await DeadLetterModel.findOne().lean();
    expect(dl).toMatchObject({ topic: TOPIC, key: 's-1', status: 'open', attempts: 2, error: 'handler failed', offset: '42' });
  });

  it('a transient failure within maxAttempts still succeeds', async () => {
    consumer.failNext = 1;
    expect(await consumer.process(msg({}))).toBe('processed');
    expect(await ScopeAssignmentModel.countDocuments()).toBe(1);
  });

  it('dead-letters malformed messages', async () => {
    expect(await consumer.process(msg({}, '{not json'))).toBe('dead_lettered');
    expect(await DeadLetterModel.countDocuments({ payload: '{not json' })).toBe(1);
  });

  it('replays dead letters (dlq:replay) and marks them replayed', async () => {
    consumer.failNext = 2;
    await consumer.process(msg({}));
    consumer.failNext = 2; // still broken
    expect(await replayDeadLetters([consumer as BaseConsumer<unknown>], { logger })).toEqual({ replayed: 0, stillFailing: 1, skipped: 0 });
    expect(await DeadLetterModel.findOne().lean()).toMatchObject({ status: 'open', attempts: 3 });
    expect(await DeadLetterModel.countDocuments()).toBe(1); // replay never creates a second dead letter

    expect(await replayDeadLetters([consumer as BaseConsumer<unknown>], { logger })).toEqual({ replayed: 1, stillFailing: 0, skipped: 0 });
    expect(await DeadLetterModel.findOne().lean()).toMatchObject({ status: 'replayed' });
    expect(await ScopeAssignmentModel.countDocuments()).toBe(1);
  });

  it('skips dead letters with no registered consumer', async () => {
    await DeadLetterModel.create({ topic: 'other', payload: '{}', error: 'x', attempts: 1, firstFailedAt: new Date(), lastFailedAt: new Date(), status: 'open' });
    expect(await replayDeadLetters([consumer as BaseConsumer<unknown>], { logger })).toEqual({ replayed: 0, stillFailing: 0, skipped: 1 });
  });
});
