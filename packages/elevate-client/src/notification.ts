import type { ElevateProducer } from './kafka.js';

export interface EmailMessage {
  /** one address or comma-separated list */
  to: string;
  subject: string;
  /** HTML body */
  body: string;
  cc?: string;
  from?: string;
  attachments?: { url: string; filename: string }[];
}

/**
 * ELEVATE notification service via Kafka (research E13, register e4/i1): a `type:"email"`
 * message on the notification topic is sent through the service's SMTP (Mailpit in the lab).
 * The notification HTTP API is not routed through the gateway, so Kafka is the path used.
 */
export class NotificationClient {
  constructor(private readonly producer: ElevateProducer, private readonly topic: string) {}

  async sendEmail(email: EmailMessage, key?: string): Promise<void> {
    await this.producer.publish(this.topic, [{ key, value: { type: 'email', email } }]);
  }
}
