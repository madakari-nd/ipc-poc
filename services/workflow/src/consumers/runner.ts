import type { Kafka } from 'kafkajs';
import type { Logger } from '@ipc/platform';
import type { BaseConsumer } from './base.consumer.js';

export interface RunningConsumers { stop(): Promise<void> }

/**
 * Subscribes the consumer group to every registered consumer's topic. `process` never throws, so
 * the offset is committed only after the dedupe marker and the handler's writes have committed
 * (or the message was dead-lettered).
 */
export async function startConsumers(
  kafka: Kafka,
  consumers: BaseConsumer<unknown>[],
  o: { groupId: string; logger: Logger },
): Promise<RunningConsumers> {
  if (consumers.length === 0) return { stop: async () => {} };
  const byTopic = new Map(consumers.map((c) => [c.topic, c]));
  const consumer = kafka.consumer({ groupId: o.groupId });
  await consumer.connect();
  for (const topic of byTopic.keys()) await consumer.subscribe({ topic, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const c = byTopic.get(topic);
      if (!c) return;
      await c.process({
        topic,
        partition,
        offset: message.offset,
        key: message.key?.toString('utf8') ?? null,
        value: message.value?.toString('utf8') ?? '',
      });
    },
  });
  o.logger.info({ topics: [...byTopic.keys()], groupId: o.groupId }, 'consumers started');
  return { stop: () => consumer.disconnect() };
}
