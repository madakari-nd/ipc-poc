import type { ClientSession } from 'mongoose';
import { type Logger } from '@ipc/platform';
import type { EmailMessage } from '@ipc/elevate-client';
import type { LedgerActor, LedgerSubject } from '../domain/ledger-chain.js';
import { NotificationModel, type Notification } from '../domain/models/index.js';
import type { Outbox } from './outbox.publisher.js';

/**
 * Notifications (US5, FR-021; data-model §5). In-app notifications are stored and shown unread until
 * the recipient opens them (`status: read`). Email is sent through ELEVATE's notification service
 * (Kafka `type:"email"`, Mailpit locally) when an EmailSender is configured; otherwise the email
 * notification is recorded as `queued` and the outbox `ipc.notification.delivery` event still fires,
 * so the demo never blocks on an unreachable mail path.
 *
 * Every notification is created inside the same transaction as the decision that caused it, and a
 * delivery event is enqueued to the same outbox (FR-021, FR-027).
 */
export interface EmailSender {
  sendEmail(msg: EmailMessage, key?: string): Promise<void>;
}

export type NotificationChannel = 'inapp' | 'email' | 'sms';

export interface NotifyInput {
  userId: string;
  /** Recipient email for the email channel (ELEVATE notification delivers to this address). */
  email?: string;
  channel: NotificationChannel;
  templateCode: string;
  params: Record<string, string | number | boolean>;
  /** The governed resource the notification is about (task, plan, assessment, escalation, support_request). */
  subject: LedgerSubject;
  /** SMS only: explicit consent (FR-021). */
  consent?: { given: boolean; at: Date; source: string };
  actor: LedgerActor;
  programmeNow: () => Date;
}

export interface NotificationServiceDeps {
  outbox: Outbox;
  /** ELEVATE notification client; absent → email notifications stay `queued` (demo never blocks). */
  email?: EmailSender;
  logger?: Logger;
}

const TEMPLATE_MAX = 64;

/** Creates one notification and, for email, attempts delivery; returns the stored doc. */
export class NotificationService {
  private readonly deps: NotificationServiceDeps;

  constructor(deps: NotificationServiceDeps) {
    this.deps = deps;
  }

  /** For SMS the record lives in the adapters (sms_messages); here it is only acknowledged. */
  async notify(input: NotifyInput, session: ClientSession): Promise<Notification> {
    const [doc] = await NotificationModel.create([{
      userId: input.userId,
      channel: input.channel,
      templateCode: input.templateCode.slice(0, TEMPLATE_MAX),
      params: input.params,
      ...(input.consent ? { consent: input.consent } : {}),
      status: 'queued',
      v: 0,
    }], { session });
    const notif = doc!.toObject() as Notification;

    if (input.channel === 'email' && this.deps.email) {
      try {
        await this.deps.email.sendEmail(
          { to: input.email ?? input.userId, subject: templateSubject(input.templateCode), body: templateBody(input.templateCode, input.params) },
          `notification-${String(notif._id)}`,
        );
        notif.status = 'sent';
        notif.sentAt = new Date();
        await NotificationModel.updateOne({ _id: notif._id }, { $set: { status: 'sent', sentAt: notif.sentAt }, $inc: { v: 1 } }, { session });
      } catch (err) {
        this.deps.logger?.warn({ err, notificationId: String(notif._id) }, 'email send failed; notification kept queued');
      }
    }

    await this.deps.outbox.enqueue({
      type: 'ipc.notification.delivery',
      key: String(notif._id),
      actor: input.actor,
      subject: { type: 'notification', id: String(notif._id) },
      payload: {
        notificationId: String(notif._id),
        recipientUserId: input.userId,
        channel: input.channel,
        templateCode: input.templateCode.slice(0, TEMPLATE_MAX),
        status: notif.status,
        consentGiven: input.consent?.given ?? null,
        providerMessageId: null,
        sentAt: notif.sentAt ? new Date(notif.sentAt).toISOString() : null,
        statusAt: new Date().toISOString(),
        ...(input.subject.type === 'task' ? { relatedSubject: { type: 'task' as const, id: input.subject.id } } : {}),
      },
    }, session);
    return notif;
  }

  /** Marks an in-app notification read (only the recipient). Returns the updated doc or null. */
  async markRead(id: string, userId: string): Promise<Notification | null> {
    const cur = await NotificationModel.findOne({ _id: id, userId }).lean<Notification>();
    if (!cur) return null;
    if (cur.status === 'read') return cur;
    return NotificationModel.findOneAndUpdate(
      { _id: id, userId },
      { $set: { status: 'read', readAt: new Date() }, $inc: { v: 1 } },
      { new: true, lean: true },
    ) as Promise<Notification | null>;
  }

  /** My notifications, newest first; optional channel/unread filters. */
  async list(userId: string, q: { unread?: boolean; channel?: NotificationChannel; cursor?: string; limit: number }) {
    const filter: Record<string, unknown> = { userId };
    if (q.unread) filter.status = { $ne: 'read' };
    if (q.channel) filter.channel = q.channel;
    if (q.cursor) filter._id = { $lt: q.cursor };
    const docs = await NotificationModel.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean<Notification[]>();
    const page = docs.slice(0, q.limit);
    const unreadCount = await NotificationModel.countDocuments({ userId, status: { $ne: 'read' } });
    return { items: page.map(toNotificationDto), nextCursor: docs.length > q.limit ? String(page[page.length - 1]!._id) : null, unreadCount };
  }
}

export function toNotificationDto(n: Notification) {
  return {
    id: String(n._id), v: n.v, createdAt: n.createdAt.toISOString(), updatedAt: n.updatedAt.toISOString(),
    userId: n.userId, channel: n.channel, templateCode: n.templateCode, params: n.params,
    ...(n.consent ? { consent: { given: n.consent.given, at: n.consent.at.toISOString(), source: n.consent.source } } : {}),
    ...(n.sentAt ? { sentAt: n.sentAt.toISOString() } : {}),
    status: n.status,
    ...(n.providerMessageId ? { providerMessageId: n.providerMessageId } : {}),
    ...(n.readAt ? { readAt: n.readAt.toISOString() } : {}),
  };
}

/** Placeholder subjects (translated in the UI; templates are identified by code, not text). */
const SUBJECTS: Record<string, string> = {
  'task.escalated': 'A task needs attention',
  'notification.escalation.manual': 'Manual escalation raised',
  'notification.task.returned': 'A task was returned',
};

function templateSubject(code: string): string {
  return SUBJECTS[code] ?? 'IPC programme notification';
}

function templateBody(code: string, params: Record<string, string | number | boolean>): string {
  const lines = Object.entries(params).map(([k, v]) => `${k}: ${String(v)}`);
  return `<p>${code}</p>${lines.length ? `<ul>${lines.map((l) => `<li>${l.replace(/[<>&]/g, '')}</li>`).join('')}</ul>` : ''}`;
}
