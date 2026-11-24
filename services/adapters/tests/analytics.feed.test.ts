/**
 * T120 (FR-027): the governed analytics extract validates every published event against its JSON
 * Schema and stores it; an invalid event is recorded as `invalid` with the reason, never dropped.
 * Uses an in-memory Mongo replica set and the real event validator (Constitution I).
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createEventValidator, eventTypes } from '@ipc/contracts';
import { createLogger } from '@ipc/platform';
import { AnalyticsFeed, analyticsTopics, toAnalyticsDto, type AnalyticsEnvelope } from '../src/analytics/analytics.feed.js';

const logger = createLogger('adapters-test', 'silent');
const validator = createEventValidator();
const PROFILE = 'test';

/** A structurally valid envelope shell; each test fills a real event type's required payload. */
function envelope(type: string, over: Partial<AnalyticsEnvelope> = {}): AnalyticsEnvelope {
  return {
    eventId: randomUUID(),
    type,
    version: 1,
    occurredAt: '2026-11-23T10:00:00.000Z',
    programmeAt: '2026-11-23T10:00:00.000Z',
    profile: PROFILE,
    correlationId: 'c1',
    actor: { userId: 'system', role: 'SYSTEM' },
    subject: { type: 'task', id: 'a'.repeat(24) },
    payload: {},
    ...over,
  };
}

/** Minimal but schema-valid payload per event type (shape from contracts/events/*). */
const samplePayload: Record<string, Record<string, unknown>> = {
  'ipc.task.assigned': {
    taskId: 'a'.repeat(24), planId: 'b'.repeat(24), wardId: 'c'.repeat(24), facilityId: 'd'.repeat(24), riskLevel: 'high',
    assignment: 'initial', ownerUserId: 'fl-2', previousOwnerUserId: null, state: 'ASSIGNED', dueAt: '2026-12-07T00:00:00.000Z', secondValidation: true,
  },
  'ipc.task.evidence_submitted': {
    taskId: 'a'.repeat(24), planId: 'b'.repeat(24), wardId: 'c'.repeat(24), facilityId: 'd'.repeat(24), riskLevel: 'high',
    fromState: 'IN_PROGRESS', toState: 'EVIDENCE_SUBMITTED', evidenceIds: ['e'.repeat(24)], evidenceHashes: ['a'.repeat(64)], gpsMissingCount: 0,
  },
  'ipc.task.decided': {
    taskId: 'a'.repeat(24), planId: 'b'.repeat(24), wardId: 'c'.repeat(24), facilityId: 'd'.repeat(24), riskLevel: 'high',
    decisionId: 'e'.repeat(24), kind: 'accept', reasonCode: 'MEETS_STANDARD', fromState: 'EVIDENCE_SUBMITTED', toState: 'CLOSED', rejectionCount: 0, evidenceHashes: [],
  },
  'ipc.task.validated': {
    taskId: 'a'.repeat(24), planId: 'b'.repeat(24), wardId: 'c'.repeat(24), facilityId: 'd'.repeat(24), riskLevel: 'high',
    decisionId: 'e'.repeat(24), kind: 'validate', reasonCode: 'MEETS_STANDARD', fromState: 'PENDING_VALIDATION', toState: 'CLOSED', rejectionCount: 0, evidenceHashes: [],
  },
  'ipc.task.escalated': {
    escalationId: 'a'.repeat(24), taskId: 'b'.repeat(24), planId: 'c'.repeat(24), wardId: 'd'.repeat(24), facilityId: 'e'.repeat(24), riskLevel: 'critical',
    ruleCode: 'R1', level: 2, targetRole: 'IPC_OFFICER', targetUserCount: 1, vacantTargetFlag: false, ownerUserId: 'fl-2', taskState: 'IN_PROGRESS', dueAt: '2026-11-01T00:00:00.000Z',
    overdueHours: 12, rejectionCount: 0, channels: ['inapp', 'email'],
  },
  'ipc.checklist.published': {
    checklistVersionId: 'a'.repeat(24), checklistCode: 'IPC-WARD', version: 2, contentHash: 'b'.repeat(64), questionCount: 10,
    questionCountsByRisk: { critical: 2, high: 3, normal: 5 }, sectionKeys: ['hand_hygiene'], planTemplateVersion: 1,
    previousVersionId: null, previousVersionGraceUntil: null, publishedAt: '2026-11-23T10:00:00.000Z',
  },
  'ipc.plan.created': {
    planId: 'a'.repeat(24), wardId: 'b'.repeat(24), facilityId: 'c'.repeat(24), cycleId: 'd'.repeat(24), sourceAssessmentId: 'e'.repeat(24),
    revision: 1, planTemplateVersion: 1, taskCount: 4, taskCountsByRisk: { critical: 1, high: 1, normal: 2 }, carriedOverTaskIds: [],
    approvedBy: 'off-1', approvedAt: '2026-11-23T10:00:00.000Z',
  },
  'ipc.plan.revised': {
    planId: 'a'.repeat(24), wardId: 'b'.repeat(24), facilityId: 'c'.repeat(24), revision: 2, source: 'officer', changes: [{ op: 'add', taskId: 'e'.repeat(24) }],
  },
  'ipc.assessment.released': {
    assessmentId: 'a'.repeat(24), wardId: 'b'.repeat(24), facilityId: 'c'.repeat(24), cycleId: 'd'.repeat(24), checklistVersionId: 'e'.repeat(24),
    checklistVersion: 2, assessorType: 'external', baselineOfId: 'f'.repeat(24), scoreTotal: 8, completedAt: '2026-11-23T09:00:00.000Z',
    releasedBy: 'qm-1', releasedAt: '2026-11-23T10:00:00.000Z',
  },
  'ipc.notification.delivery': {
    notificationId: 'a'.repeat(24), recipientUserId: 'u1', channel: 'inapp', templateCode: 'task.escalated', status: 'queued', consentGiven: null, providerMessageId: null, sentAt: null, statusAt: '2026-11-23T10:00:00.000Z',
  },
};

let rs: MongoMemoryReplSet;
let feed: AnalyticsFeed;
const model = () => mongoose.connection.db!.collection('analytics_events');

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(rs.getUri(), { dbName: 'ipc_test' });
  feed = new AnalyticsFeed(mongoose.connection, {
    kafka: { brokers: ['localhost:9092'], clientId: 'test' }, profile: PROFILE, logger, validator,
  });
});
afterAll(async () => { await mongoose.disconnect(); await rs.stop(); });
beforeEach(async () => { await model().deleteMany({}); });

it('every published event type validates against its schema', () => {
  for (const t of eventTypes) {
    const subjectType = t === 'ipc.assessment.released' ? 'assessment' : t === 'ipc.checklist.published' ? 'checklist_version' : t === 'ipc.notification.delivery' ? 'notification' : t.startsWith('ipc.plan.') ? 'plan' : 'task';
    const v = validator(t, envelope(t, { subject: { type: subjectType, id: 'a'.repeat(24) }, payload: samplePayload[t] ?? {} }));
    if (!v.ok) expect.fail(`${t}: ${v.errors.join('; ')}`);
  }
});

it('the feed extracts a valid event as governed, deduped by eventId', async () => {
  const e = envelope('ipc.task.assigned', { payload: samplePayload['ipc.task.assigned'] });
  await feed['handle'](e);
  await feed['handle'](e); // redelivery
  const rows = await model().find().toArray();
  expect(rows).toHaveLength(1);
  const dto = toAnalyticsDto(rows[0] as never);
  expect(dto).toMatchObject({ type: 'ipc.task.assigned', status: 'governed', correlationId: 'c1' });
});

it('records an invalid event with its reason instead of dropping it', async () => {
  const e = envelope('ipc.task.assigned', { payload: { taskId: 'not-an-object-id' } });
  await feed['handle'](e);
  const rows = await model().find().toArray();
  expect(rows).toHaveLength(1);
  const dto = toAnalyticsDto(rows[0] as never);
  expect(dto.status).toBe('invalid');
  expect(dto.invalidReason).toMatch(/payload/);
});

it('analyticsTopics covers every event type on the profile', () => {
  const topics = analyticsTopics(PROFILE, eventTypes);
  expect(topics).toContain('ipc.test.task.assigned');
  expect(topics).toHaveLength(eventTypes.length);
});
