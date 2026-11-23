import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { dlqSize, withCorrelation, type Logger } from '@ipc/platform';
import { ConsumedEventModel, DeadLetterModel } from '../domain/models/index.js';
import { withTx } from '../repositories/tx.js';

export interface RawMessage {
  topic: string;
  key?: string | null;
  value: string;
  partition?: number;
  offset?: string;
}

export type ConsumeOutcome = 'processed' | 'duplicate' | 'filtered' | 'dead_lettered' | 'failed';

export interface ConsumerDeps {
  logger: Logger;
  /** ELEVATE organisation of this profile; events from other orgs are ignored (research E16). */
  orgId: string;
  /** Attempts before a message goes to the dead-letter store. */
  maxAttempts?: number;
  retryDelayMs?: number;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Base for idempotent event consumers (Constitution VI, research T5):
 * - parse → orgId filter → dedupe on (topic, key, status) → `handle` in ONE transaction with the
 *   dedupe marker, so a redelivered message never applies twice and a failed one leaves no trace;
 * - after `maxAttempts` failures the raw message goes to `dead_letters` with an alertable log line,
 *   replayable with `npm run dlq:replay`.
 * Subclasses define how to read the event and what to do with it.
 */
export abstract class BaseConsumer<E> {
  abstract readonly topic: string;

  constructor(protected readonly deps: ConsumerDeps) {}

  /** Parses the raw value; throw for a malformed message. */
  protected parse(value: string): E {
    return JSON.parse(value) as E;
  }

  /** ELEVATE org of the event (undefined → filtered out). */
  protected abstract orgIdOf(event: E): string | undefined;

  /** Dedupe identity: e.g. (submissionId, status) for observation events. */
  protected abstract dedupeOf(event: E, msg: RawMessage): { key: string; status: string };

  protected correlationOf(_event: E): string | undefined {
    return undefined;
  }

  /** Applies the event. Every write MUST use `session` (it shares the dedupe transaction). */
  protected abstract handle(event: E, session: ClientSession): Promise<void>;

  /**
   * Processes one message and never throws (the Kafka offset may be committed afterwards).
   * `fromDeadLetter` replays do not create a second dead letter; they report 'failed' instead.
   */
  async process(msg: RawMessage, opts: { fromDeadLetter?: boolean } = {}): Promise<ConsumeOutcome> {
    let event: E;
    try {
      event = this.parse(msg.value);
    } catch (err) {
      return opts.fromDeadLetter ? 'failed' : this.deadLetter(msg, err, 1);
    }

    const org = this.orgIdOf(event);
    if (org === undefined || String(org) !== this.deps.orgId) {
      this.deps.logger.debug({ topic: msg.topic, org }, 'event from another organisation ignored');
      return 'filtered';
    }

    const correlationId = this.correlationOf(event) ?? randomUUID().replace(/-/g, '');
    return withCorrelation(correlationId, async () => {
      let dedupe: { key: string; status: string };
      try {
        dedupe = this.dedupeOf(event, msg);
      } catch (err) {
        return opts.fromDeadLetter ? 'failed' : this.deadLetter(msg, err, 1);
      }

      const max = this.deps.maxAttempts ?? 3;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= max; attempt++) {
        try {
          await withTx(async (session) => {
            await ConsumedEventModel.create([{ topic: msg.topic, key: dedupe.key, status: dedupe.status }], { session });
            await this.handle(event, session);
          });
          return 'processed';
        } catch (err) {
          if (isDuplicateKey(err) && (await this.alreadyConsumed(msg.topic, dedupe))) return 'duplicate';
          lastErr = err;
          if (attempt < max) await sleep((this.deps.retryDelayMs ?? 200) * attempt);
        }
      }
      if (opts.fromDeadLetter) {
        this.deps.logger.warn({ topic: msg.topic, key: dedupe.key, err: lastErr }, 'dead-letter replay failed');
        return 'failed';
      }
      return this.deadLetter(msg, lastErr, max, dedupe.key);
    });
  }

  private async alreadyConsumed(topic: string, d: { key: string; status: string }): Promise<boolean> {
    return (await ConsumedEventModel.exists({ topic, key: d.key, status: d.status })) !== null;
  }

  private async deadLetter(msg: RawMessage, err: unknown, attempts: number, key?: string): Promise<ConsumeOutcome> {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    const now = new Date();
    try {
      await DeadLetterModel.create({
        topic: msg.topic,
        key: key ?? msg.key ?? undefined,
        partition: msg.partition,
        offset: msg.offset,
        payload: msg.value,
        error,
        attempts,
        firstFailedAt: now,
        lastFailedAt: now,
        status: 'open',
      });
      dlqSize.set(await DeadLetterModel.countDocuments({ status: 'open' }));
    } catch (writeErr) {
      this.deps.logger.fatal({ topic: msg.topic, err: writeErr }, 'could not write dead letter');
      return 'failed';
    }
    // Alertable line (research §5): Alertmanager keys on alert="dead_letter".
    this.deps.logger.error({ alert: 'dead_letter', topic: msg.topic, key: key ?? msg.key, attempts, error }, 'event moved to dead-letter store');
    return 'dead_lettered';
  }
}

export interface ReplayResult { replayed: number; stillFailing: number; skipped: number }

/**
 * Replays open dead letters through the consumer registered for their topic. Success marks the
 * dead letter `replayed`; a repeat failure increments `attempts` and keeps it open.
 */
export async function replayDeadLetters(
  consumers: BaseConsumer<unknown>[],
  opts: { topic?: string; limit?: number; logger: Logger },
): Promise<ReplayResult> {
  const byTopic = new Map(consumers.map((c) => [c.topic, c]));
  const filter: Record<string, unknown> = { status: 'open', ...(opts.topic ? { topic: opts.topic } : {}) };
  const letters = await DeadLetterModel.find(filter).sort({ firstFailedAt: 1 }).limit(opts.limit ?? 100).lean();
  const out: ReplayResult = { replayed: 0, stillFailing: 0, skipped: 0 };
  for (const dl of letters) {
    const consumer = byTopic.get(dl.topic);
    if (!consumer) {
      opts.logger.warn({ topic: dl.topic, id: String(dl._id) }, 'no consumer for dead-letter topic; skipped');
      out.skipped += 1;
      continue;
    }
    const outcome = await consumer.process(
      { topic: dl.topic, key: dl.key ?? null, value: dl.payload, partition: dl.partition, offset: dl.offset },
      { fromDeadLetter: true },
    );
    if (outcome === 'failed') {
      await DeadLetterModel.updateOne({ _id: dl._id }, { $inc: { attempts: 1, v: 1 }, $set: { lastFailedAt: new Date() } });
      out.stillFailing += 1;
    } else {
      await DeadLetterModel.updateOne({ _id: dl._id }, { $set: { status: 'replayed', replayedAt: new Date() }, $inc: { v: 1 } });
      out.replayed += 1;
    }
  }
  dlqSize.set(await DeadLetterModel.countDocuments({ status: 'open' }));
  return out;
}
