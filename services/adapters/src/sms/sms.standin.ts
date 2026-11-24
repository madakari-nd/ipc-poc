import { randomUUID } from 'node:crypto';
import mongoose, { type Connection } from 'mongoose';
import { type Logger } from '@ipc/platform';
import { createKafka, startConsumer, type KafkaOptions } from '@ipc/elevate-client';
import { z } from 'zod';

/**
 * SMS stand-in (US5, FR-021): demonstrates the scale-up SMS channel end to end without a real SMS
 * provider. It consumes `ipc.<profile>.notification.delivery` events with `channel: "sms"` and:
 *   - records the recipient's consent (given/withdrawn, at, source);
 *   - records a simulated `sms_messages` row (template, params, sentAt);
 *   - produces a simulated delivery receipt (a second `ipc.notification.delivery` event is not needed;
 *     the row carries `status: delivered` after a short delay, or `failed` for a phone without consent).
 *
 * Consent lives in the workflow `notifications` collection and here in `sms_consent`; the stand-in
 * only ever reads what the notification event already declares (no patient data).
 */

export interface SmsMessageDoc {
  _id: mongoose.Types.ObjectId;
  recipientUserId: string;
  templateCode: string;
  params: Record<string, string | number | boolean>;
  consent: { given: boolean; at: Date; source: string };
  sentAt: Date;
  deliveredAt?: Date;
  failedAt?: Date;
  failureCode?: string;
  providerMessageId?: string;
  v: number;
}

const smsMessageSchema = new mongoose.Schema<SmsMessageDoc>(
  {
    recipientUserId: { type: String, required: true },
    templateCode: { type: String, required: true, maxlength: 64 },
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    consent: {
      type: new mongoose.Schema(
        { given: { type: Boolean, required: true }, at: { type: Date, required: true }, source: { type: String, maxlength: 32 } },
        { _id: false },
      ),
      required: true,
    },
    sentAt: { type: Date, required: true },
    deliveredAt: Date,
    failedAt: Date,
    failureCode: { type: String, maxlength: 64 },
    providerMessageId: { type: String, maxlength: 128 },
    v: { type: Number, default: 0 },
  },
  { collection: 'sms_messages', timestamps: true, strict: 'throw' },
);

export interface SmsDeliveryEvent {
  notificationId: string;
  recipientUserId: string;
  channel: 'inapp' | 'email' | 'sms';
  templateCode: string;
  status: string;
  consentGiven: boolean | null;
  providerMessageId: string | null;
  sentAt: string | null;
  statusAt: string;
}

/** Validates the delivery event payload enough to act on it (the schema was already checked on publish). */
const deliveryPayload = (v: unknown): SmsDeliveryEvent => v as SmsDeliveryEvent;

/**
 * Consumes `ipc.*.notification.delivery` events and records the SMS stand-in rows. Delivered/failed
 * receipts are simulated after a short delay (`deliverAfterMs`), so a monitor or the UI can observe
 * the full send → receipt lifecycle.
 */
export class SmsStandin {
  private readonly model: mongoose.Model<SmsMessageDoc>;
  private readonly consumer: Promise<Awaited<ReturnType<typeof startConsumer>>> | null = null;
  private stopped = false;

  constructor(
    conn: Connection,
    private readonly o: { kafka: KafkaOptions; profile: string; deliverAfterMs?: number; logger?: Logger },
  ) {
    this.model = conn.model<SmsMessageDoc>('SmsMessage', smsMessageSchema);
    const topic = `ipc.${o.profile}.notification.delivery`;
    const kafka = createKafka(o.kafka);
    this.consumer = startConsumer(kafka, {
      groupId: `ipc-adapters-sms-${o.profile}`,
      topics: [topic],
      schema: z.object({ type: z.string(), payload: z.unknown() }).passthrough(),
      filter: (e) => String(e.type) === 'ipc.notification.delivery',
      handle: (e) => this.handle(deliveryPayload((e as { payload: unknown }).payload)),
      onInvalid: (raw, err) => o.logger?.warn({ raw, err }, 'invalid notification.delivery event'),
    });
  }

  private async handle(e: SmsDeliveryEvent): Promise<void> {
    if (e.channel !== 'sms') return;
    const logger = this.o.logger;
    if (e.consentGiven !== true) {
      await this.model.create([{
        recipientUserId: e.recipientUserId,
        templateCode: e.templateCode,
        params: {},
        consent: { given: false, at: new Date(e.statusAt), source: 'event' },
        sentAt: new Date(),
        failedAt: new Date(),
        failureCode: 'consent_not_given',
        providerMessageId: randomUUID(),
        v: 0,
      }]);
      logger?.warn({ recipientUserId: e.recipientUserId, templateCode: e.templateCode }, 'SMS stand-in: consent not given; recorded as failed');
      return;
    }

    const row = await this.model.create([{
      recipientUserId: e.recipientUserId,
      templateCode: e.templateCode,
      params: {},
      consent: { given: true, at: new Date(e.statusAt), source: 'event' },
      sentAt: new Date(),
      providerMessageId: randomUUID(),
      v: 0,
    }]);
    const id = String((row[0] as mongoose.Document).id);
    const delay = this.o.deliverAfterMs ?? 5_000;
    if (!this.stopped) {
      setTimeout(async () => {
        try {
          await this.model.updateOne({ _id: row[0]!._id }, { $set: { deliveredAt: new Date() }, $inc: { v: 1 } });
          logger?.info({ smsMessageId: id, recipientUserId: e.recipientUserId }, 'SMS stand-in: simulated delivery receipt');
        } catch (err) {
          logger?.error({ err, smsMessageId: id }, 'SMS stand-in receipt write failed');
        }
      }, delay).unref?.();
    }
  }

  async idle(): Promise<void> {
    this.stopped = true;
    await (await this.consumer)?.disconnect().catch(() => undefined);
  }
}

// Re-exported so tests can construct rows directly against the same shape.
export const smsMessageModel = (conn: Connection) => conn.model<SmsMessageDoc>('SmsMessage', smsMessageSchema);
