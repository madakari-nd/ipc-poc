import { describe, expect, it } from 'vitest';
import {
  buildFormBundle,
  previousCycle,
  releaseStateFor,
  sectionsForWardType,
  statusMove,
} from '../../src/domain/assessment.js';

describe('assessment status (forward only)', () => {
  it.each([
    ['draft', 'draft', 'same'],
    ['draft', 'submitted', 'forward'],
    ['draft', 'completed', 'forward'],
    ['submitted', 'completed', 'forward'],
    ['submitted', 'draft', 'backward'],
    ['completed', 'submitted', 'backward'],
    ['completed', 'completed', 'same'],
  ] as const)('%s → %s is %s', (from, to, expected) => {
    expect(statusMove(from, to)).toBe(expected);
  });
});

describe('release state (FR-024a)', () => {
  it('holds external results and leaves internal ones n/a', () => {
    expect(releaseStateFor('external')).toBe('held');
    expect(releaseStateFor('internal')).toBe('n/a');
  });
});

describe('previous cycle (baseline link)', () => {
  const c = (id: string, start: string) => ({ _id: id, startsAt: new Date(start) });
  it('is the latest cycle that started before this one', () => {
    const cycles = [c('c0', '2026-01-01'), c('c1', '2026-05-01'), c('c2', '2026-09-01')];
    expect(previousCycle(cycles, cycles[2]!)?._id).toBe('c1');
    expect(previousCycle(cycles, cycles[1]!)?._id).toBe('c0');
    expect(previousCycle(cycles, cycles[0]!)).toBeUndefined();
  });
});

describe('form bundle', () => {
  const checklist = {
    _id: 'c'.repeat(24),
    checklistCode: 'IPC-WARD',
    version: 1,
    contentHash: 'a'.repeat(64),
    graceUntil: new Date('2026-12-01T00:00:00Z'),
    sections: [
      { sectionKey: 'hand_hygiene', title: { en: 'Hand hygiene' }, wardTypes: ['general', 'ICU'] },
      { sectionKey: 'icu_only', title: { en: 'ICU lines' }, wardTypes: ['ICU'] },
      { sectionKey: 'all', title: { en: 'All wards' }, wardTypes: [] },
    ],
    questions: [
      { questionKey: 'HAND_RUB', sectionKey: 'hand_hygiene', riskLevel: 'critical' as const, passMark: 10, maxScore: 10, elevateQuestionExternalId: 'Q2' },
      { questionKey: 'CVC_CARE', sectionKey: 'icu_only', riskLevel: 'high' as const, passMark: 5, maxScore: 10, text: { en: 'Central line care' } },
      { questionKey: 'WASTE', sectionKey: 'all', riskLevel: 'normal' as const, passMark: 10, maxScore: 10 },
    ],
  };
  const ctx = { id: 'd'.repeat(24), v: 0, wardId: 'e'.repeat(24), cycleId: 'f'.repeat(24) };

  it('keeps only the sections for the ward type (empty = every ward), case-insensitively', () => {
    expect(sectionsForWardType(checklist.sections, 'general').map((s) => s.sectionKey)).toEqual(['hand_hygiene', 'all']);
    expect(sectionsForWardType(checklist.sections, 'icu').map((s) => s.sectionKey)).toEqual(['hand_hygiene', 'icu_only', 'all']);
  });

  it('builds a deterministic bundle with only the applicable questions', () => {
    const a = buildFormBundle({ assessment: ctx, wardType: 'general', checklist, issuedAt: new Date('2026-11-23T10:00:00Z') });
    const b = buildFormBundle({ assessment: ctx, wardType: 'general', checklist, issuedAt: new Date('2026-11-24T10:00:00Z') });
    expect(a.questions.map((q) => q.questionKey)).toEqual(['HAND_RUB', 'WASTE']);
    expect(a.questions[0]!.text).toEqual({ en: 'HAND_RUB' }); // readable fallback when only a hash is stored
    expect(a).toMatchObject({ assessmentId: ctx.id, wardType: 'general', checklistVersionId: checklist._id, version: 1, graceUntil: '2026-12-01T00:00:00.000Z' });
    expect(a.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(a.bundleHash).toBe(b.bundleHash); // issue time is not part of the hash
    const icu = buildFormBundle({ assessment: ctx, wardType: 'ICU', checklist, issuedAt: new Date() });
    expect(icu.bundleHash).not.toBe(a.bundleHash);
  });
});
