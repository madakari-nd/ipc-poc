// 0001: workflow-owned collections and their indexes (data-model.md "Indexes", plus the unique keys
// each entity needs). Indexes are created here, never at boot (research T12). Reversible: `down`
// drops exactly these indexes and removes a collection only when it is empty.
// This file is a frozen snapshot: never edit it after release, add a new migration instead.

const DAYS_7 = 7 * 24 * 60 * 60;

/** @type {Record<string, Array<{ name: string, key: Record<string, 1 | -1>, unique?: boolean, partialFilterExpression?: object, expireAfterSeconds?: number }>>} */
const COLLECTIONS = {
  programmes: [{ name: 'programme_code_unique', key: { code: 1 }, unique: true }],
  facilities: [
    { name: 'facility_code_unique', key: { facilityCode: 1 }, unique: true },
    { name: 'facility_district', key: { districtCode: 1 } },
  ],
  wards: [{ name: 'ward_facility_code_unique', key: { facilityId: 1, wardCode: 1 }, unique: true }],
  cycles: [{ name: 'cycle_code_unique', key: { code: 1 }, unique: true }],
  scope_assignments: [{ name: 'scope_user_validity', key: { userId: 1, validFrom: 1, validTo: 1 } }],
  checklist_versions: [{ name: 'checklist_code_version_unique', key: { checklistCode: 1, version: 1 }, unique: true }],
  risk_defaults: [{ name: 'risk_level_unique', key: { riskLevel: 1 }, unique: true }],
  escalation_rules: [{ name: 'escalation_rule_code_unique', key: { code: 1 }, unique: true }],
  assessment_contexts: [
    { name: 'assessment_submission_unique', key: { elevateSubmissionId: 1 }, unique: true },
    { name: 'assessment_ward_cycle_completed', key: { wardId: 1, cycleId: 1, completedAt: 1 } },
  ],
  plans: [
    // One plan per ward per cycle; a future "discarded" draft status is excluded from the rule.
    {
      name: 'plan_ward_cycle_unique',
      key: { wardId: 1, cycleId: 1 },
      unique: true,
      partialFilterExpression: { status: { $in: ['draft', 'active', 'closed'] } },
    },
    { name: 'plan_source_assessment_unique', key: { sourceAssessmentId: 1 }, unique: true },
  ],
  plan_revisions: [{ name: 'plan_revision_unique', key: { planId: 1, revision: 1 }, unique: true }],
  tasks: [
    { name: 'task_plan_state', key: { planId: 1, state: 1 } },
    { name: 'task_owner_state', key: { ownerUserId: 1, state: 1 } },
    { name: 'task_sweep', key: { dueAt: 1, riskLevel: 1, state: 1 } },
  ],
  decisions: [{ name: 'decision_task_at', key: { taskId: 1, at: 1 } }],
  escalations: [{ name: 'escalation_task_rule_level_unique', key: { taskId: 1, ruleCode: 1, level: 1 }, unique: true }],
  notifications: [{ name: 'notification_user_status', key: { userId: 1, status: 1, createdAt: -1 } }],
  mentor_profile_cache: [{ name: 'mentor_unique', key: { elevateMentorId: 1 }, unique: true }],
  support_requests: [
    { name: 'support_mentor_status', key: { chosenMentorId: 1, status: 1 } },
    { name: 'support_ward_status', key: { wardId: 1, status: 1 } },
  ],
  ledger: [
    { name: 'ledger_seq_unique', key: { seq: 1 }, unique: true },
    { name: 'ledger_subject_seq', key: { 'subject.type': 1, 'subject.id': 1, seq: 1 } },
  ],
  counters: [],
  retention_policy: [{ name: 'retention_profile_unique', key: { profile: 1 }, unique: true }],
  outbox_events: [
    { name: 'outbox_status_id', key: { status: 1, _id: 1 } },
    { name: 'outbox_event_id_unique', key: { eventId: 1 }, unique: true },
  ],
  consumed_events: [{ name: 'consumed_topic_key_status_unique', key: { topic: 1, key: 1, status: 1 }, unique: true }],
  dead_letters: [{ name: 'dlq_status_topic', key: { status: 1, topic: 1, firstFailedAt: 1 } }],
  clock_settings: [{ name: 'clock_profile_unique', key: { profile: 1 }, unique: true }],
  internal_idempotency: [
    { name: 'idem_service_key_unique', key: { service: 1, key: 1 }, unique: true },
    { name: 'idem_ttl_7d', key: { createdAt: 1 }, expireAfterSeconds: DAYS_7 },
  ],
};

async function existing(db) {
  return new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
}

module.exports = {
  COLLECTIONS,

  async up(db) {
    const have = await existing(db);
    for (const [name, indexes] of Object.entries(COLLECTIONS)) {
      if (!have.has(name)) await db.createCollection(name);
      for (const { key, ...opts } of indexes) {
        await db.collection(name).createIndex(key, opts);
      }
    }
  },

  async down(db) {
    const have = await existing(db);
    for (const [name, indexes] of Object.entries(COLLECTIONS)) {
      if (!have.has(name)) continue;
      const coll = db.collection(name);
      const present = new Set((await coll.indexes()).map((i) => i.name));
      for (const { name: indexName } of indexes) {
        if (present.has(indexName)) await coll.dropIndex(indexName);
      }
      if ((await coll.countDocuments({}, { limit: 1 })) === 0) await coll.drop();
    }
  },
};
