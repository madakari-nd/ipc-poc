import { describe, expect, it } from 'vitest';
import {
  compareAssessments,
  questionScoresOf,
  releaseRefusal,
  selectBaseline,
  trendPoints,
  type ComparableAssessment,
  type ComparableChecklist,
} from '../../src/domain/comparison.js';

const H = (c: string) => c.repeat(64);

const v1: ComparableChecklist = {
  id: 'cv1',
  version: 1,
  sections: [
    { sectionKey: 'hand_hygiene', title: { en: 'Hand hygiene' } },
    { sectionKey: 'environment', title: { en: 'Environment and waste' } },
  ],
  questions: [
    { questionKey: 'hand_rub_at_bed', sectionKey: 'hand_hygiene', textHash: H('a'), maxScore: 10 },
    { questionKey: 'hh_posters', sectionKey: 'hand_hygiene', textHash: H('b'), maxScore: 10 },
    { questionKey: 'waste_segregation', sectionKey: 'environment', textHash: H('c'), maxScore: 10 },
    { questionKey: 'surface_cleaning', sectionKey: 'environment', textHash: H('d'), maxScore: 10 },
  ],
};

/** v2: hh_posters reworded, surface_cleaning removed, sharps_bins added. */
const v2: ComparableChecklist = {
  id: 'cv2',
  version: 2,
  sections: v1.sections,
  questions: [
    { questionKey: 'hand_rub_at_bed', sectionKey: 'hand_hygiene', textHash: H('a'), maxScore: 10 },
    { questionKey: 'hh_posters', sectionKey: 'hand_hygiene', textHash: H('e'), maxScore: 10 },
    { questionKey: 'waste_segregation', sectionKey: 'environment', textHash: H('c'), maxScore: 10 },
    { questionKey: 'sharps_bins', sectionKey: 'environment', textHash: H('f'), maxScore: 10 },
  ],
};

const side = (o: Partial<ComparableAssessment> & Pick<ComparableAssessment, 'id' | 'checklistVersionId'>): ComparableAssessment => ({
  cycleId: 'c1',
  assessorType: 'internal',
  total: 0,
  bySection: {},
  failedQuestionKeys: [],
  ...o,
});

describe('per-question scores', () => {
  it('uses recorded question scores when present', () => {
    const a = side({ id: 'a', checklistVersionId: 'cv1', questionScores: { hand_rub_at_bed: 5 }, bySection: { hand_hygiene: 5 } });
    expect(questionScoresOf(a, v1)).toEqual({ hand_rub_at_bed: 5 });
  });
  it('derives pass/fail scores from the failed questions for the sections that were scored', () => {
    const a = side({ id: 'a', checklistVersionId: 'cv1', bySection: { hand_hygiene: 10 }, failedQuestionKeys: ['hand_rub_at_bed'] });
    expect(questionScoresOf(a, v1)).toEqual({ hand_rub_at_bed: 0, hh_posters: 10 });
  });
});

describe('comparison: same checklist version (US7 AS1)', () => {
  const baseline = side({ id: 'b', cycleId: 'c0', checklistVersionId: 'cv1', total: 20, bySection: { hand_hygiene: 10, environment: 10 }, failedQuestionKeys: ['hand_rub_at_bed', 'waste_segregation'] });
  const current = side({ id: 'r', cycleId: 'c1', checklistVersionId: 'cv1', assessorType: 'external', total: 30, bySection: { hand_hygiene: 20, environment: 10 }, failedQuestionKeys: ['waste_segregation'] });

  it('compares section by section with the change', () => {
    const c = compareAssessments({ current, baseline, currentChecklist: v1, baselineChecklist: v1 });
    expect(c.sameVersion).toBe(true);
    expect(c.sections).toEqual([
      { sectionKey: 'hand_hygiene', title: { en: 'Hand hygiene' }, current: 20, baseline: 10, change: 10, comparedQuestions: 2 },
      { sectionKey: 'environment', title: { en: 'Environment and waste' }, current: 10, baseline: 10, change: 0, comparedQuestions: 2 },
    ]);
    expect(c.notComparable).toEqual([]);
    expect(c.totalChange).toBe(10);
  });

  it('a section scored on one side only counts as 0 on the other', () => {
    const c = compareAssessments({
      current: { ...current, bySection: { hand_hygiene: 20 } },
      baseline: { ...baseline, bySection: { environment: 10 } },
      currentChecklist: v1,
      baselineChecklist: v1,
    });
    expect(c.sections.map((s) => [s.sectionKey, s.current, s.baseline, s.change])).toEqual([
      ['hand_hygiene', 20, 0, 20],
      ['environment', 0, 10, -10],
    ]);
  });
});

describe('comparison: across versions (US7 AS2, FR-024)', () => {
  const baseline = side({
    id: 'b', cycleId: 'c0', checklistVersionId: 'cv1', total: 20,
    questionScores: { hand_rub_at_bed: 0, hh_posters: 10, waste_segregation: 0, surface_cleaning: 10 },
  });
  const current = side({
    id: 'r', cycleId: 'c1', checklistVersionId: 'cv2', total: 30,
    questionScores: { hand_rub_at_bed: 10, hh_posters: 10, waste_segregation: 10, sharps_bins: 0 },
  });

  it('compares only questions with the same key AND the same text fingerprint', () => {
    const c = compareAssessments({ current, baseline, currentChecklist: v2, baselineChecklist: v1 });
    expect(c.sameVersion).toBe(false);
    expect(c.sections).toEqual([
      { sectionKey: 'hand_hygiene', title: { en: 'Hand hygiene' }, current: 10, baseline: 0, change: 10, comparedQuestions: 1 },
      { sectionKey: 'environment', title: { en: 'Environment and waste' }, current: 10, baseline: 0, change: 10, comparedQuestions: 1 },
    ]);
    expect(c.totalChange).toBe(20);
  });

  it('lists the rest under "Not comparable (version change)" with the reason', () => {
    const c = compareAssessments({ current, baseline, currentChecklist: v2, baselineChecklist: v1 });
    expect(c.notComparable).toEqual([
      { questionKey: 'hh_posters', reason: 'text_changed' },
      { questionKey: 'sharps_bins', reason: 'missing_in_baseline' },
      { questionKey: 'surface_cleaning', reason: 'missing_in_current' },
    ]);
  });

  it('a question without a text fingerprint on either side is not comparable', () => {
    const noHash: ComparableChecklist = { ...v2, questions: v2.questions.map((q) => (q.questionKey === 'hand_rub_at_bed' ? { ...q, textHash: undefined } : q)) };
    const c = compareAssessments({ current, baseline, currentChecklist: noHash, baselineChecklist: v1 });
    expect(c.notComparable).toContainEqual({ questionKey: 'hand_rub_at_bed', reason: 'text_changed' });
    expect(c.sections.find((s) => s.sectionKey === 'hand_hygiene')).toBeUndefined();
  });
});

describe('baseline = latest completed assessment of the same ward in the previous cycle (FR-024)', () => {
  const cycles = [
    { _id: 'c0', startsAt: new Date('2026-08-01') },
    { _id: 'c1', startsAt: new Date('2026-11-01') },
    { _id: 'cx', startsAt: new Date('2026-05-01') },
  ];
  const a = (id: string, cycleId: string, status: 'draft' | 'submitted' | 'completed', completedAt?: string, wardId = 'w4') => ({
    _id: id, wardId, cycleId, status, ...(completedAt ? { completedAt: new Date(completedAt) } : {}),
  });

  it('picks the latest completed one of the previous cycle', () => {
    const list = [
      a('older', 'c0', 'completed', '2026-08-20'),
      a('latest', 'c0', 'completed', '2026-09-15'),
      a('draft', 'c0', 'draft'),
      a('same-cycle', 'c1', 'completed', '2026-11-10'),
      a('two-back', 'cx', 'completed', '2026-06-01'),
      a('other-ward', 'c0', 'completed', '2026-10-01', 'w1'),
    ];
    expect(selectBaseline({ wardId: 'w4', cycleId: 'c1' }, cycles, list)?._id).toBe('latest');
  });

  it('is none when the previous cycle has no completed assessment of the ward', () => {
    expect(selectBaseline({ wardId: 'w4', cycleId: 'c1' }, cycles, [a('x', 'c0', 'submitted')])).toBeUndefined();
    expect(selectBaseline({ wardId: 'w4', cycleId: 'cx' }, cycles, [a('y', 'c0', 'completed', '2026-09-01')])).toBeUndefined();
  });
});

describe('trend across cycles', () => {
  const cycles = [
    { _id: 'c1', code: '2026-C1', startsAt: new Date('2026-11-01') },
    { _id: 'c0', code: '2026-C0', startsAt: new Date('2026-08-01') },
  ];
  it('one point per cycle (latest completed), oldest cycle first', () => {
    const pts = trendPoints(cycles, [
      { id: 'r', cycleId: 'c1', status: 'completed', completedAt: new Date('2026-12-01'), checklistVersion: 1, assessorType: 'external', total: 30, bySection: { a: 30 } },
      { id: 'b', cycleId: 'c0', status: 'completed', completedAt: new Date('2026-09-15'), checklistVersion: 1, assessorType: 'internal', total: 20, bySection: { a: 20 } },
      { id: 'b0', cycleId: 'c0', status: 'completed', completedAt: new Date('2026-08-15'), checklistVersion: 1, assessorType: 'internal', total: 10 },
      { id: 'd', cycleId: 'c1', status: 'draft', checklistVersion: 1, assessorType: 'internal', total: 0 },
    ]);
    expect(pts).toEqual([
      { cycleId: 'c0', cycleCode: '2026-C0', assessmentId: 'b', checklistVersion: 1, assessorType: 'internal', total: 20, bySection: { a: 20 } },
      { cycleId: 'c1', cycleCode: '2026-C1', assessmentId: 'r', checklistVersion: 1, assessorType: 'external', total: 30, bySection: { a: 30 } },
    ]);
  });
});

describe('release (FR-024a)', () => {
  const held = { assessorType: 'external' as const, releaseState: 'held' as const, status: 'completed' as const };
  it('only the district quality manager releases', () => {
    expect(releaseRefusal(held, 'DISTRICT_QM')).toBeUndefined();
    for (const role of ['STATE_ADMIN', 'IPC_OFFICER', 'EXTERNAL_AUDITOR', 'WARD_SUPERVISOR']) {
      expect(releaseRefusal(held, role)).toMatchObject({ status: 403, code: 'ROLE_DENIED' });
    }
  });
  it('only a held, completed external result can be released', () => {
    expect(releaseRefusal({ ...held, releaseState: 'released' }, 'DISTRICT_QM')).toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
    expect(releaseRefusal({ ...held, assessorType: 'internal', releaseState: 'n/a' }, 'DISTRICT_QM')).toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
    expect(releaseRefusal({ ...held, status: 'submitted' }, 'DISTRICT_QM')).toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
  });
});
