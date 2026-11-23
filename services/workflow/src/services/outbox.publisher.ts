import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { currentCorrelationId, outboxPending, type Logger } from '@ipc/platform';
import type { EventValidator } from '@ipc/contracts';
import type { Profile } from '../domain/clock.js';
import type { LedgerActor, LedgerSubject } from '../domain/ledger-chain.js';
import { OutboxEventModel, type OutboxEventDoc } from '../domain/models/index.js';
import { requireTx } from '../repositories/tx.js';

/** Topic for an event type: `ipc.task.assigned` on profile `uat` → `ipc.uat.task.assigned`. */
export function topicFor(profile: Profile, type: string): string {
  if (!/^ipc\.[a-z_]+\.[a-z_]+$/.test(type)) throw new Error(`not an ipc.* event type: ${type}`);
  return `ipc.${profile}.${type.slice('ipc.'.length)}`;
}

export interface EventDraft {
  /** e.g. `ipc.task.assigned` (one of contracts/events). */
  type: string;
  /** Kafka key: wardId (checklist events: checklistCode). */
  key: string;
  actor: LedgerActor;
  subject: LedgerSubject;
  payload: Record<string, unknown>;
  correlationId?: string;
}

export interface EventEnvelope {
  eventId: string; type: string; version: 1; occurredAt: string; programmeAt: string; profile: Profile;
  correlationId: string; actor: LedgerActor; subject: LedgerSubject; payload: Record<string, unknown>;
}

export class EventSchemaError extends Error {
  constructor(public readonly type: string, public readonly errors: string[]) {
    super(`event ${type} does not match its schema: ${errors.join('; ')}`);
    this.name = 'EventSchemaError';
  }
}

/** Transactional outbox writer (research T5): call inside the same withTx as the state change. */
export class Outbox {
  constructor(
    private readonly o: { profile: Profile; validator: EventValidator; programmeNow: () => Date; realNow?: () => Date },
  ) {}

  build(d: EventDraft): EventEnvelope {
    return {
      eventId: randomUUID(),
      type: d.type,
      version: 1,
      occurredAt: (this.o.realNow?.() ?? new Date()).toISOString(),
      programmeAt: this.o.programmeNow().toISOString(),
      profile: this.o.profile,
      correlationId: d.correlationId ?? currentCorrelationId() ?? randomUUID().replace(/-/g, ''),
      actor: d.actor,
      subject: d.subject,
      payload: d.payload,
    };
  }

  /** Validates (an invalid event aborts the whole transaction) and stores it as pending. */
  async enqueue(d: EventDraft, session: ClientSession): Promise<EventEnvelope> {
    requireTx(session);
    const env = this.build(d);
    const v = this.o.validator(env.type, env);
    if (!v.ok) throw new EventSchemaError(env.type, v.errors);
    await OutboxEventModel.create(
      [{ eventId: env.eventId, type: env.type, topic: topicFor(this.o.profile, env.type), key: d.key, payload: env, status: 'pending', attempts: 0 }],
      { session },
    );
    return env;
  }
}

/** The part of a kafkajs Producer the publisher needs (a real Producer satisfies it). */
export interface EventProducer {
  send(record: {
    topic: string;
    messages: { key: string; value: string; headers?: Record<string, string> }[];
  }): Promise<unknown>;
}

export interface PublishResult { published: number; failed: number; skipped: number }

/**
 * Publishes pending outbox events to Kafka. Each event is re-validated against its JSON Schema
 * just before publishing; a failure (schema or broker) increments `attempts` and keeps the event
 * for the next run until `maxAttempts`. Events of one key are published in order: after a failure,
 * later events with the same key wait for the next run. Claims use a short lease so two instances
 * never publish the same event at once.
 */
export class OutboxPublisher {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;

  constructor(
    private readonly o: {
      producer: EventProducer;
      validator: EventValidator;
      logger: Logger;
      maxAttempts: number;
      batchSize?: number;
      leaseMs?: number;
    },
  ) {}

  private async claim(blockedKeys: string[]): Promise<OutboxEventDoc | null> {
    const now = new Date();
    return OutboxEventModel.findOneAndUpdate(
      {
        status: { $in: ['pending', 'failed'] },
        attempts: { $lt: this.o.maxAttempts },
        key: { $nin: blockedKeys },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
      },
      { $set: { lockedUntil: new Date(now.getTime() + (this.o.leaseMs ?? 30_000)) } },
      { sort: { _id: 1 }, new: true, lean: true },
    );
  }

  async publishPending(): Promise<PublishResult> {
    const result: PublishResult = { published: 0, failed: 0, skipped: 0 };
    const blocked: string[] = [];
    for (let i = 0; i < (this.o.batchSize ?? 100); i++) {
      const ev = await this.claim(blocked);
      if (!ev) break;
      try {
        const v = this.o.validator(ev.type, ev.payload);
        if (!v.ok) throw new EventSchemaError(ev.type, v.errors);
        const env = ev.payload as unknown as EventEnvelope;
        await this.o.producer.send({
          topic: ev.topic,
          messages: [{
            key: ev.key,
            value: JSON.stringify(env),
            headers: { 'ipc-event-id': ev.eventId, 'ipc-event-type': ev.type, 'x-correlation-id': env.correlationId },
          }],
        });
        await OutboxEventModel.updateOne(
          { _id: ev._id },
          { $set: { status: 'published', publishedAt: new Date(), lockedUntil: null }, $inc: { v: 1 }, $unset: { lastError: 1 } },
        );
        result.published += 1;
      } catch (err) {
        const attempts = ev.attempts + 1;
        const message = err instanceof Error ? err.message : String(err);
        await OutboxEventModel.updateOne(
          { _id: ev._id },
          { $set: { status: 'failed', lastError: message.slice(0, 500), lockedUntil: null }, $inc: { attempts: 1, v: 1 } },
        );
        blocked.push(ev.key);
        result.failed += 1;
        const log = { eventId: ev.eventId, type: ev.type, topic: ev.topic, attempts, alert: attempts >= this.o.maxAttempts ? 'outbox_exhausted' : undefined };
        if (attempts >= this.o.maxAttempts) this.o.logger.error({ ...log, err: message }, 'outbox event gave up after max attempts');
        else this.o.logger.warn({ ...log, err: message }, 'outbox publish failed; will retry');
      }
    }
    await this.refreshGauge();
    return result;
  }

  async refreshGauge(): Promise<number> {
    const n = await OutboxEventModel.countDocuments({ status: { $ne: 'published' } });
    outboxPending.set(n);
    return n;
  }

  start(intervalMs: number): void {
    const tick = () => {
      this.running = this.publishPending()
        .catch((err: unknown) => this.o.logger.error({ err }, 'outbox run failed'))
        .finally(() => {
          if (this.timer !== undefined) this.timer = setTimeout(tick, intervalMs);
        });
    };
    this.timer = setTimeout(tick, intervalMs);
  }

  async stop(): Promise<void> {
    const t = this.timer;
    this.timer = undefined;
    if (t) clearTimeout(t);
    await this.running;
  }
}
