import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEventValidator, eventTypes } from '@ipc/contracts';
import { createLogger } from '@ipc/platform';
import { Outbox, OutboxPublisher, topicFor, type EventProducer } from '../../src/services/outbox.publisher.js';
import { withTx } from '../../src/repositories/tx.js';
import { OutboxEventModel } from '../../src/domain/models/index.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

const validator = createEventValidator();
const logger = createLogger('workflow-test', 'silent');
const WARD_A = 'a'.repeat(24);
const WARD_B = 'b'.repeat(24);
const now = () => new Date('2026-11-23T10:00:00.000Z');
const outbox = new Outbox({ profile: 'test', validator, programmeNow: now });

function taskAssigned(wardId: string, ownerUserId = 'fl-2') {
  return {
    type: 'ipc.task.assigned',
    key: wardId,
    actor: { userId: 'sup-1', role: 'WARD_SUPERVISOR' as const },
    subject: { type: 'task', id: 'c'.repeat(24) },
    payload: {
      taskId: 'c'.repeat(24), planId: 'd'.repeat(24), wardId, facilityId: 'e'.repeat(24), riskLevel: 'high',
      assignment: 'initial', ownerUserId, previousOwnerUserId: null, state: 'ASSIGNED',
      dueAt: '2026-12-07T00:00:00.000Z', secondValidation: true,
    },
  };
}

class FakeProducer implements EventProducer {
  sent: { topic: string; key: string; value: string; headers?: Record<string, string> }[] = [];
  failTimes = 0;
  async send(r: Parameters<EventProducer['send']>[0]) {
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error('broker unavailable');
    }
    for (const m of r.messages) this.sent.push({ topic: r.topic, ...m });
  }
}

let mongo: TestMongo;
beforeAll(async () => { mongo = await startMongo('ipc_outbox_test'); });
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => { await mongo.clear(); });

describe('topics', () => {
  it('maps every contract event to ipc.<profile>.<name>', () => {
    expect(eventTypes.length).toBeGreaterThan(0);
    for (const t of eventTypes) expect(topicFor('uat', t)).toBe(`ipc.uat.${t.slice(4)}`);
    expect(topicFor('test', 'ipc.task.assigned')).toBe('ipc.test.task.assigned');
    expect(() => topicFor('dev', 'elevate.thing')).toThrow();
  });
});

describe('outbox → Kafka (contract: every published event matches its JSON Schema)', () => {
  it('stores a schema-valid envelope and publishes it with the ward key', async () => {
    await withTx((s) => outbox.enqueue(taskAssigned(WARD_A), s));
    const producer = new FakeProducer();
    const pub = new OutboxPublisher({ producer, validator, logger, maxAttempts: 3 });
    expect(await pub.publishPending()).toEqual({ published: 1, failed: 0, skipped: 0 });

    expect(producer.sent).toHaveLength(1);
    const msg = producer.sent[0]!;
    expect(msg.topic).toBe('ipc.test.task.assigned');
    expect(msg.key).toBe(WARD_A);
    const event = JSON.parse(msg.value) as Record<string, unknown>;
    expect(validator('ipc.task.assigned', event)).toEqual({ ok: true });
    expect(event).toMatchObject({ type: 'ipc.task.assigned', version: 1, profile: 'test', programmeAt: now().toISOString() });
    expect(msg.headers?.['ipc-event-id']).toBe(event.eventId);
    expect(await OutboxEventModel.findOne().lean()).toMatchObject({ status: 'published', attempts: 0 });
    expect(await pub.refreshGauge()).toBe(0);
  });

  it('increments attempts on broker failure and holds later events of the same key', async () => {
    await withTx(async (s) => {
      await outbox.enqueue(taskAssigned(WARD_A, 'first'), s);
      await outbox.enqueue(taskAssigned(WARD_A, 'second'), s);
      await outbox.enqueue(taskAssigned(WARD_B), s);
    });
    const producer = new FakeProducer();
    producer.failTimes = 1;
    const pub = new OutboxPublisher({ producer, validator, logger, maxAttempts: 3 });

    expect(await pub.publishPending()).toMatchObject({ published: 1, failed: 1 });
    expect(producer.sent.map((m) => m.key)).toEqual([WARD_B]);
    const first = await OutboxEventModel.findOne({ 'payload.payload.ownerUserId': 'first' }).lean();
    expect(first).toMatchObject({ status: 'failed', attempts: 1, lastError: 'broker unavailable' });

    // next run: ward A goes out in order
    await pub.publishPending();
    const owners = producer.sent.filter((m) => m.key === WARD_A).map((m) => (JSON.parse(m.value) as { payload: { ownerUserId: string } }).payload.ownerUserId);
    expect(owners).toEqual(['first', 'second']);
  });

  it('re-validates before publishing: a stored event that no longer matches is not sent', async () => {
    await withTx((s) => outbox.enqueue(taskAssigned(WARD_A), s));
    await OutboxEventModel.updateOne({}, { $set: { 'payload.payload.riskLevel': 'extreme' } });
    const producer = new FakeProducer();
    const pub = new OutboxPublisher({ producer, validator, logger, maxAttempts: 2 });
    await pub.publishPending();
    await pub.publishPending();
    await pub.publishPending();
    expect(producer.sent).toHaveLength(0);
    expect(await OutboxEventModel.findOne().lean()).toMatchObject({ status: 'failed', attempts: 2 });
    expect(await pub.refreshGauge()).toBe(1);
  });

  it('refuses to enqueue an invalid event', async () => {
    await expect(withTx((s) => outbox.enqueue({ ...taskAssigned(WARD_A), type: 'ipc.task.unknown' }, s))).rejects.toThrow(/schema/);
    expect(await OutboxEventModel.countDocuments()).toBe(0);
  });

  it('start/stop runs the publisher loop', async () => {
    await withTx((s) => outbox.enqueue(taskAssigned(WARD_A), s));
    const producer = new FakeProducer();
    const pub = new OutboxPublisher({ producer, validator, logger, maxAttempts: 3 });
    pub.start(20);
    await expect.poll(() => producer.sent.length, { timeout: 5000 }).toBe(1);
    await pub.stop();
  });
});
