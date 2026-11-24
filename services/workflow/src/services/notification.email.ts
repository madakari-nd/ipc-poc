import { createKafka, ElevateProducer, NotificationClient } from '@ipc/elevate-client';
import type { EmailSender } from './notification.service.js';

/**
 * ELEVATE email delivery (US5, FR-021; research E13): the ELEVATE notification service consumes a
 * `type:"email"` message on its notification topic and sends it through its SMTP (Mailpit locally).
 * Built from the workflow Kafka client, so notifications reuse the same broker (Constitution X).
 */
export function createEmailSender(o: { brokers: string[]; topic: string; clientId?: string }): EmailSender {
  const kafka = createKafka({ clientId: o.clientId ?? 'ipc-workflow-notifications', brokers: o.brokers });
  const producer = new ElevateProducer(kafka);
  const client = new NotificationClient(producer, o.topic);
  let connected = false;
  return {
    async sendEmail(msg, key) {
      if (!connected) {
        await producer.connect();
        connected = true;
      }
      await client.sendEmail(msg, key);
    },
  };
}
