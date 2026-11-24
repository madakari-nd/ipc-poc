import mongoose, { type Connection } from 'mongoose';
import { type Logger } from '@ipc/platform';
import { createKafka, startConsumer, type KafkaOptions } from '@ipc/elevate-client';
import { createEventValidator, eventTypes, type EventValidator } from '@ipc/contracts';

/**
 * Governed analytics extract (T120, FR-027): consumes every `ipc.<profile>.*` event published by the
 * workflow/adapters outbox, validates it against its JSON Schema, and writes a governed row per event
 * to `analytics_events`. The extract is the read-only source for dashboards and the analytics feed —
 * it never holds patient data (the events are contract-guaranteed free of it) and every row records
 * the event it came from, so a dashboard can be traced back to the decision that produced it.
 *
 * A message that fails schema validation is recorded with `status: 'invalid'` and a reason (never
 * silently dropped); the feed keeps running.
 */

export interface AnalyticsEventDoc {
  _id: mongoose.Types.ObjectId;
  eventId: string;
  type: string;
  version: number;
  occurredAt: Date;
  programmeAt: Date;
  profile: string;
  correlationId: string;
  actor: { userId: string; role: string };
  subject: { type: string; id: string };
  payload: Record<string, unknown>;
  receivedAt: Date;
  status: 'governed' | 'invalid';
  invalidReason?: string;
  v: number;
}

const analyticsEventSchema = new mongoose.Schema<AnalyticsEventDoc>(
  {
    eventId: { type: String, required: true },
    type: { type: String, required: true, maxlength: 64 },
    version: { type: Number, required: true },
    occurredAt: { type: Date, required: true },
    programmeAt: { type: Date, required: true },
    profile: { type: String, required: true, maxlength: 16 },
    correlationId: { type: String, required: true, maxlength: 64 },
    actor: {
      type: new mongoose.Schema(
        { userId: { type: String, required: true, maxlength: 64 }, role: { type: String, required: true, maxlength: 32 } },
        { _id: false },
      ),
      required: true,
    },
    subject: {
      type: new mongoose.Schema(
        { type: { type: String, required: true, maxlength: 32 }, id: { type: String, required: true, maxlength: 64 } },
        { _id: false },
      ),
      required: true,
    },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    receivedAt: { type: Date, required: true },
    status: { type: String, required: true, enum: ['governed', 'invalid'] },
    invalidReason: { type: String, maxlength: 2000 },
    v: { type: Number, default: 0 },
  },
  { collection: 'analytics_events', timestamps: true, strict: 'throw' },
);
analyticsEventSchema.index({ type: 1, receivedAt: -1 });
analyticsEventSchema.index({ eventId: 1 }, { unique: true });

export interface AnalyticsEnvelope {
  eventId: string;
  type: string;
  version: number;
  occurredAt: string;
  programmeAt: string;
  profile: string;
  correlationId: string;
  actor: { userId: string; role: string };
  subject: { type: string; id: string };
  payload: Record<string, unknown>;
}

/**
 * Consumes `ipc.<profile>.*` and writes the governed extract. `validator` defaults to the real event
 * schema validator (contract test in tests/contract validates every published event, FR-027).
 */
export class AnalyticsFeed {
  private readonly model: mongoose.Model<AnalyticsEventDoc>;
  private readonly validator: EventValidator;
  private readonly consumer: Promise<Awaited<ReturnType<typeof startConsumer>>> | null;

  constructor(
    conn: Connection,
    private readonly o: { kafka: KafkaOptions; profile: string; topics?: string[]; logger?: Logger; validator?: EventValidator },
  ) {
    this.model = conn.model<AnalyticsEventDoc>('AnalyticsEvent', analyticsEventSchema);
    this.validator = o.validator ?? createEventValidator();
    const topics = o.topics ?? analyticsTopics(o.profile, eventTypes);
    const kafka = createKafka(o.kafka);
    void this.model.createIndexes().catch((err: unknown) => o.logger?.warn({ err }, 'analytics feed: index creation deferred'));
    this.consumer = startConsumer(kafka, {
      groupId: `ipc-adapters-analytics-${o.profile}`,
      // A single subscription per concrete topic is not possible from a pattern, so the caller passes
      // the exact topics; the default subscribes to every known event type's topic.
      topics,
      handle: (e) => this.handle(e as unknown as AnalyticsEnvelope),
      onInvalid: (raw, err) => o.logger?.warn({ raw, err }, 'invalid analytics event (parse)'),
    });
  }

  private async handle(e: AnalyticsEnvelope): Promise<void> {
    const logger = this.o.logger;
    // Idempotent on eventId: a redelivered message is already extracted (the unique index is the backstop).
    if (await this.model.exists({ eventId: e.eventId })) return;
    const now = new Date();
    const base = {
      eventId: e.eventId,
      type: e.type,
      version: e.version,
      occurredAt: new Date(e.occurredAt),
      programmeAt: new Date(e.programmeAt),
      profile: e.profile,
      correlationId: e.correlationId,
      actor: { userId: e.actor.userId, role: e.actor.role },
      subject: { type: e.subject.type, id: e.subject.id },
      payload: e.payload,
      receivedAt: now,
      v: 0,
    };
    const v = this.validator(e.type, e);
    if (!v.ok) {
      await this.model.create([{ ...base, status: 'invalid', invalidReason: v.errors.join('; ').slice(0, 2000) }]);
      logger?.warn({ type: e.type, eventId: e.eventId, errors: v.errors }, 'analytics feed: event failed schema validation');
      return;
    }
    await this.model.create([{ ...base, status: 'governed' }]);
  }

  async idle(): Promise<void> {
    await (await this.consumer)?.disconnect().catch(() => undefined);
  }
}

/** A governed extract row's DTO (what an analytics reader sees). */
export function toAnalyticsDto(d: AnalyticsEventDoc) {
  return {
    id: String(d._id), eventId: d.eventId, type: d.type, version: d.version,
    occurredAt: d.occurredAt.toISOString(), programmeAt: d.programmeAt.toISOString(), profile: d.profile,
    correlationId: d.correlationId, actor: { ...d.actor }, subject: { ...d.subject }, payload: d.payload,
    receivedAt: d.receivedAt.toISOString(), status: d.status,
    ...(d.invalidReason ? { invalidReason: d.invalidReason } : {}),
  };
}

/** The concrete `ipc.<profile>.*` topics of every event type (used to subscribe). */
export function analyticsTopics(profile: string, types: string[]): string[] {
  return types.map((t) => `ipc.${profile}.${t.replace(/^ipc\./, '')}`);
}
