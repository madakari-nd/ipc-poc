import { describe, expect, it } from 'vitest';
import {
  applyDraftUpdate,
  assertApprovable,
  carryOverTaskIds,
  decideDraft,
  diffProjectTasks,
  elevateStatusOf,
  nextRevision,
  planRevisionChanges,
  scoreSubmission,
  type CatalogueQuestionLike,
  type DraftTask,
  type RiskDefaultLike,
} from '../../src/domain/plan.js';

const NOW = new Date('2026-11-23T10:00:00.000Z');
const DAY = 86_400_000;

const RISK_DEFAULTS: RiskDefaultLike[] = [
  { riskLevel: 'critical', dueDays: 7, evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true },
  { riskLevel: 'high', dueDays: 14, evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true },
  { riskLevel: 'normal', dueDays: 30, evidenceRule: { photoRequired: false, minPhotos: 0 }, secondValidation: false },
];

/** The seeded catalogue: two questions mapped onto the sample samiksha form (seed-programme.ts). */
const QUESTIONS: CatalogueQuestionLike[] = [
  {
    questionKey: 'hand_rub_at_bed', elevateQuestionExternalId: 'Q2_1763449620761-1763449623398-1795424380092', sectionKey: 'hand_hygiene',
    riskLevel: 'critical', passMark: 10, maxScore: 10, templateTaskKey: 'fit-hand-rub-dispensers',
  },
  {
    questionKey: 'waste_segregation', elevateQuestionExternalId: 'Q3_1763449620761-1763449623399-1795424380094', sectionKey: 'environment',
    riskLevel: 'normal', passMark: 10, maxScore: 10, templateTaskKey: 'segregate-waste-at-source',
  },
];

const TEMPLATE_TASKS = [
  { templateTaskKey: 'fit-hand-rub-dispensers', title: { en: 'Fit hand-rub dispensers', hi: 'हैंड-रब डिस्पेंसर लगाएँ' } },
];

/** Answers as on the real `completed` event (observed 2026-11-23): copied externalIds, ELEVATE scores, options with scores. */
const OPTIONS = [{ value: 'R1', score: 20 }, { value: 'R2', score: 40 }, { value: 'R3', score: 60 }];
const answer = (externalId: string, value: unknown, scored?: { scoreAchieved: number; maxScore: number }) => ({
  externalId, value, options: OPTIONS, ...(scored ? { ...scored, percentageScore: (scored.scoreAchieved / scored.maxScore) * 100 } : {}),
});

describe('scoreSubmission (E8)', () => {
  it('reads per-question scores from the event and maps copied externalIds to programme keys', () => {
    const r = scoreSubmission(QUESTIONS, {
      a: answer('Q2_1763449620761-1763449623398-1795424380465', 'R1', { scoreAchieved: 20, maxScore: 60 }),
      b: answer('Q3_1763449620761-1763449623399-1795424380472', ['R1', 'R2', 'R3'], { scoreAchieved: 120, maxScore: 120 }),
      other: answer('Q9_unrelated', 'R1', { scoreAchieved: 0, maxScore: 60 }),
    }, { eventScored: true });
    expect(r.source).toBe('event');
    expect(r.failedQuestionKeys).toEqual(['hand_rub_at_bed']);
    expect(r.bySection).toEqual({ hand_hygiene: 3.33, environment: 10 });
    expect(r.total).toBe(13.33);
  });

  it('falls back to catalogue scoring (deterministic) when the event has no scores', () => {
    const withOptions = QUESTIONS.map((q) => (q.questionKey === 'hand_rub_at_bed'
      ? { ...q, options: [{ value: 'R1', score: 0 }, { value: 'R3', score: 10 }] } : q));
    const answers = [
      answer('Q2_1763449620761-1763449623398-1795424380465', 'R3'),
      answer('Q3_1763449620761-1763449623399-1795424380472', ['R1']),
    ];
    const a = scoreSubmission(withOptions, answers, { eventScored: false });
    const b = scoreSubmission(withOptions, answers, { eventScored: false });
    expect(a).toEqual(b);
    expect(a.source).toBe('catalogue');
    // catalogue options score R3 = 10 (pass); the event's own option scores give R1 = 20/120 (fail)
    expect(a.failedQuestionKeys).toEqual(['waste_segregation']);
  });

  it("uses ELEVATE's raw points: a full multi-select passes although samiksha reports percentageScore 0", () => {
    const r = scoreSubmission(QUESTIONS, [
      { externalId: 'Q2_1763449620761-1763449623398-1795424380092', value: 'R1', scoreAchieved: 20, maxScore: 60, percentageScore: 33.3 },
      { externalId: 'Q3_1763449620761-1763449623399-1795424380094', value: ['R1', 'R2', 'R3'], scoreAchieved: 120, maxScore: 120, percentageScore: 0 },
    ], { eventScored: true });
    expect(r.failedQuestionKeys).toEqual(['hand_rub_at_bed']);
  });

  it('a catalogue question that was not answered is not a finding', () => {
    const r = scoreSubmission(QUESTIONS, [answer('Q2_1763449620761-1763449623398-1', 'R3', { scoreAchieved: 60, maxScore: 60 })], { eventScored: true });
    expect(r.failedQuestionKeys).toEqual([]);
  });
});

describe('decideDraft (FR-011, FR-018)', () => {
  it('maps each failed question to its template task with the risk defaults', () => {
    const d = decideDraft({
      questions: QUESTIONS, failedQuestionKeys: ['hand_rub_at_bed', 'waste_segregation'], firstInCycle: true,
      riskDefaults: RISK_DEFAULTS, templateTasks: TEMPLATE_TASKS, now: NOW,
    });
    expect(d.outcome).toBe('draft_plan_created');
    expect(d.draftTasks).toHaveLength(2);
    const [critical, normal] = d.draftTasks;
    expect(critical).toMatchObject({
      taskKey: 'fit-hand-rub-dispensers', sourceQuestionKey: 'hand_rub_at_bed', riskLevel: 'critical',
      title: { en: 'Fit hand-rub dispensers', hi: 'हैंड-रब डिस्पेंसर लगाएँ' },
      evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true, included: true, dependsOnTaskKeys: [],
    });
    expect(critical!.dueAt.getTime() - NOW.getTime()).toBe(7 * DAY);
    expect(normal).toMatchObject({ taskKey: 'segregate-waste-at-source', riskLevel: 'normal', secondValidation: false, title: { en: 'Segregate waste at source' } });
    expect(normal!.dueAt.getTime() - NOW.getTime()).toBe(30 * DAY);
    expect(normal!.ownerUserId).toBeUndefined();
  });

  it('no failed questions gives no plan ("no actions needed")', () => {
    const d = decideDraft({ questions: QUESTIONS, failedQuestionKeys: [], firstInCycle: true, riskDefaults: RISK_DEFAULTS, now: NOW });
    expect(d).toEqual({ outcome: 'no_actions_needed', draftTasks: [], carriedOverTaskIds: [] });
  });

  it('a second assessment in the same cycle gives no plan, even with failures', () => {
    const d = decideDraft({ questions: QUESTIONS, failedQuestionKeys: ['hand_rub_at_bed'], firstInCycle: false, riskDefaults: RISK_DEFAULTS, now: NOW });
    expect(d.outcome).toBe('same_cycle_no_plan');
    expect(d.draftTasks).toEqual([]);
  });

  it('a repeat cycle gives a new draft and links (not copies) the open tasks of the previous plan', () => {
    const previous = [
      { id: '65c000000000000000000001', state: 'IN_PROGRESS' as const },
      { id: '65c000000000000000000002', state: 'CLOSED' as const },
      { id: '65c000000000000000000003', state: 'CHANGES_REQUESTED' as const },
    ];
    const d = decideDraft({
      questions: QUESTIONS, failedQuestionKeys: ['waste_segregation'], firstInCycle: true, riskDefaults: RISK_DEFAULTS, now: NOW,
      previousPlanTasks: previous,
    });
    expect(d.outcome).toBe('draft_plan_created');
    expect(d.carriedOverTaskIds).toEqual(['65c000000000000000000001', '65c000000000000000000003']);
    expect(d.draftTasks.map((t) => t.taskKey)).toEqual(['segregate-waste-at-source']);
    // no failures in the new cycle: no plan, the open tasks stay on the previous plan
    const none = decideDraft({ questions: QUESTIONS, failedQuestionKeys: [], firstInCycle: true, riskDefaults: RISK_DEFAULTS, now: NOW, previousPlanTasks: previous });
    expect(none.outcome).toBe('no_actions_needed');
    expect(none.carriedOverTaskIds).toEqual([]);
    expect(carryOverTaskIds(previous)).toEqual(['65c000000000000000000001', '65c000000000000000000003']);
  });

  it('two failed questions with the same template task give one task at the higher risk', () => {
    const qs = [...QUESTIONS, { ...QUESTIONS[0]!, questionKey: 'hh_posters', riskLevel: 'high' as const }];
    const d = decideDraft({ questions: qs, failedQuestionKeys: ['hh_posters', 'hand_rub_at_bed'], firstInCycle: true, riskDefaults: RISK_DEFAULTS, now: NOW });
    expect(d.draftTasks).toHaveLength(1);
    expect(d.draftTasks[0]).toMatchObject({ riskLevel: 'critical', sourceQuestionKey: 'hand_rub_at_bed' });
  });
});

describe('plan revisions (FR-017)', () => {
  it('numbers revisions: draft 0 → approval r1 → each change +1', () => {
    expect(nextRevision(0)).toBe(1);
    expect(nextRevision(1)).toBe(2);
    expect(nextRevision(7)).toBe(8);
    expect(() => nextRevision(-1)).toThrow();
  });

  it('records add/remove/update changes with before and after', () => {
    const changes = planRevisionChanges([
      { op: 'add', taskId: 'a', after: { title: 'x' } },
      { op: 'update', taskId: 'b', before: { dueAt: '1' }, after: { dueAt: '2' } },
      { op: 'remove', taskId: 'c', before: { title: 'y' } },
    ]);
    expect(changes.map((c) => c.op)).toEqual(['add', 'update', 'remove']);
    expect(() => planRevisionChanges([])).toThrow(/at least one change/);
  });
});

describe('draft editing and approval (FR-012)', () => {
  const draft = (): DraftTask[] => decideDraft({
    questions: QUESTIONS, failedQuestionKeys: ['hand_rub_at_bed', 'waste_segregation'], firstInCycle: true,
    riskDefaults: RISK_DEFAULTS, templateTasks: TEMPLATE_TASKS, now: NOW,
  }).draftTasks;

  it('sets owners, dependencies and inclusion; refuses unknown keys, self or circular dependencies', () => {
    const out = applyDraftUpdate(draft(), [
      { taskKey: 'fit-hand-rub-dispensers', ownerUserId: '62' },
      { taskKey: 'segregate-waste-at-source', ownerUserId: '63', dependsOnTaskKeys: ['fit-hand-rub-dispensers'] },
    ]);
    expect(out.map((t) => t.ownerUserId)).toEqual(['62', '63']);
    expect(out[1]!.dependsOnTaskKeys).toEqual(['fit-hand-rub-dispensers']);
    expect(() => applyDraftUpdate(draft(), [{ taskKey: 'nope', ownerUserId: '1' }])).toThrow(/not a task of this draft/);
    expect(() => applyDraftUpdate(draft(), [{ taskKey: 'fit-hand-rub-dispensers', dependsOnTaskKeys: ['fit-hand-rub-dispensers'] }])).toThrow(/itself/);
    expect(() => applyDraftUpdate(out, [{ taskKey: 'fit-hand-rub-dispensers', dependsOnTaskKeys: ['segregate-waste-at-source'] }])).toThrow(/circular/);
  });

  it('approval needs an owner for every included task and at least one task', () => {
    expect(() => assertApprovable(draft())).toThrow(/owner/);
    const owned = applyDraftUpdate(draft(), [
      { taskKey: 'fit-hand-rub-dispensers', ownerUserId: '62' },
      { taskKey: 'segregate-waste-at-source', included: false },
    ]);
    expect(() => assertApprovable(owned)).not.toThrow();
    expect(() => assertApprovable(applyDraftUpdate(owned, [{ taskKey: 'fit-hand-rub-dispensers', included: false }]))).toThrow(/at least one task/);
    // a dependency on an excluded task is refused
    expect(() => assertApprovable(applyDraftUpdate(owned, [{ taskKey: 'fit-hand-rub-dispensers', dependsOnTaskKeys: ['segregate-waste-at-source'] }]))).toThrow(/not included/);
  });
});

describe('ELEVATE task set (E9, FR-019)', () => {
  const project = [
    { _id: 'e1', name: 'Fit hand-rub dispensers at every bed', description: 'fit-hand-rub-dispensers', status: 'notStarted', isDeleted: false },
    { _id: 'e2', name: 'Display hand hygiene posters', externalId: 'TEST-G2-TASK-display-hand-hygiene-posters-1795424380993', status: 'notStarted', isDeleted: false },
    { _id: 'e3', name: 'Old', status: 'notStarted', isDeleted: true },
  ];

  it('links template tasks, removes the rest, adds programme-only tasks and sets display status', () => {
    const d = diffProjectTasks([
      { id: 't1', taskKey: 'fit-hand-rub-dispensers', title: 'Fit', state: 'IN_PROGRESS' },
      { id: 't2', taskKey: 'agreed-action', title: 'Agreed action', state: 'ASSIGNED', newElevateId: 'n2' },
    ], project);
    expect(d.links).toEqual({ t1: 'e1', t2: 'n2' });
    expect(d.sync).toEqual([
      { _id: 'e1', name: 'Fit hand-rub dispensers at every bed', status: 'inProgress' },
      { _id: 'n2', name: 'Agreed action', status: 'notStarted', isNew: true },
      { _id: 'e2', name: 'Display hand hygiene posters', status: 'notStarted', isDeleted: true },
    ]);
    expect(d.corrections.map((c) => c.kind)).toEqual(['status', 'missing', 'extra']);
  });

  it('is in line when ELEVATE matches the programme', () => {
    const d = diffProjectTasks([{ id: 't1', taskKey: 'fit-hand-rub-dispensers', title: 'Fit', state: 'CLOSED', elevateTaskId: 'e1' }], [
      { _id: 'e1', name: 'Fit', status: 'completed', isDeleted: false },
    ]);
    expect(d.sync).toEqual([]);
    expect(d.corrections).toEqual([]);
  });

  it('maps every task state to an ELEVATE display status', () => {
    expect(elevateStatusOf('ASSIGNED')).toBe('notStarted');
    expect(elevateStatusOf('PENDING_VALIDATION')).toBe('inProgress');
    expect(elevateStatusOf('CLOSED')).toBe('completed');
  });
});
