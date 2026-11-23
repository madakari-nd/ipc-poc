import { Kafka, logLevel, type Consumer, type IHeaders, type Producer } from 'kafkajs';
import { currentTraceparent } from '@ipc/platform';
import type { z } from 'zod';

export interface KafkaOptions {
  brokers: string[];
  clientId: string;
}

/** kafkajs client for ELEVATE's broker (PLAINTEXT, no auth; `kafka:29092` in-network). */
export function createKafka(o: KafkaOptions): Kafka {
  return new Kafka({ clientId: o.clientId, brokers: o.brokers, logLevel: logLevel.NOTHING, retry: { retries: 3 } });
}

export interface PublishMessage {
  key?: string;
  value: unknown;
  headers?: Record<string, string>;
}

/** Thin producer wrapper: JSON values, traceparent header forwarded. */
export class ElevateProducer {
  private connected = false;
  private readonly producer: Producer;

  constructor(kafka: Kafka) {
    this.producer = kafka.producer({ allowAutoTopicCreation: false });
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
  }

  async publish(topic: string, messages: PublishMessage[]): Promise<void> {
    await this.connect();
    const tp = currentTraceparent();
    await this.producer.send({
      topic,
      messages: messages.map((m) => ({
        key: m.key ?? null,
        value: JSON.stringify(m.value),
        headers: { ...(tp ? { traceparent: tp } : {}), ...m.headers } as IHeaders,
      })),
    });
  }

  async disconnect(): Promise<void> {
    if (this.connected) await this.producer.disconnect();
    this.connected = false;
  }
}

export interface ConsumeOptions<T> {
  groupId: string;
  topics: string[];
  fromBeginning?: boolean;
  /** messages that fail parsing go to onInvalid (never crash the consumer) */
  schema?: z.ZodType<T>;
  /** e.g. keep only this profile's org (E16) */
  filter?: (value: T) => boolean;
  handle: (value: T, meta: { topic: string; partition: number; offset: string; key?: string; headers: Record<string, string> }) => Promise<void>;
  onInvalid?: (raw: string, error: unknown) => void | Promise<void>;
}

/**
 * Starts a consumer. The handler must be idempotent (key on `_id + status`); the offset is
 * committed by kafkajs only after `handle` resolves, so a crash re-delivers the message.
 */
export async function startConsumer<T = unknown>(kafka: Kafka, o: ConsumeOptions<T>): Promise<Consumer> {
  const consumer = kafka.consumer({ groupId: o.groupId });
  await consumer.connect();
  for (const topic of o.topics) await consumer.subscribe({ topic, fromBeginning: o.fromBeginning ?? false });
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const raw = message.value?.toString('utf8') ?? '';
      let value: T;
      try {
        const json: unknown = JSON.parse(raw);
        value = o.schema ? o.schema.parse(json) : (json as T);
      } catch (err) {
        await o.onInvalid?.(raw, err);
        return;
      }
      if (o.filter && !o.filter(value)) return;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(message.headers ?? {})) if (v !== undefined) headers[k] = String(v);
      await o.handle(value, { topic, partition, offset: message.offset, key: message.key?.toString(), headers });
    },
  });
  return consumer;
}

/** Topic names ELEVATE uses in this stack (stack/*_env). */
export const ELEVATE_TOPICS = {
  observations: 'elevate_observations_dev',
  projects: 'sl-improvement-project-submission-dev',
  notifications: 'dev.notifications',
  userEvents: 'dev.userCreate',
} as const;
