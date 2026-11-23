import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Problem } from '@ipc/platform';
import {
  GRACE_PERIOD_MS,
  acceptsNewAssessments,
  acceptsSubmissions,
  assertEditable,
  computeContentHash,
  deriveDraftFromBase,
  effectiveStatus,
  nextVersionNumber,
  planPublication,
  questionKeyResolver,
  rootExternalId,
  textHashOf,
  validateDraftContent,
  type CatalogueQuestion,
  type CatalogueSection,
} from '../../src/domain/catalogue.js';

const sections: CatalogueSection[] = [
  { sectionKey: 'hand_hygiene', title: { en: 'Hand hygiene' }, wardTypes: ['ICU', 'general'] },
  { sectionKey: 'environment', title: { en: 'Environment' }, wardTypes: [] },
];
const q = (key: string, over: Partial<CatalogueQuestion> = {}): CatalogueQuestion => ({
  questionKey: key,
  sectionKey: 'hand_hygiene',
  text: { en: `Question ${key}` },
  riskLevel: 'critical',
  passMark: 10,
  maxScore: 10,
  elevateQuestionExternalId: `IPC_${key}`,
  ...over,
});
const questions = [q('HH_1'), q('HH_2', { riskLevel: 'high' }), q('ENV_1', { sectionKey: 'environment', riskLevel: 'normal' })];
const NOW = new Date('2026-11-23T10:00:00Z');

function problemOf(fn: () => unknown): Problem {
  try {
    fn();
  } catch (e) {
    if (e instanceof Problem) return e;
    throw e;
  }
  throw new Error('expected a Problem');
}

describe('published versions are immutable (FR-005, US1 AS3)', () => {
  it('allows edits to a draft', () => {
    expect(() => assertEditable({ status: 'draft' })).not.toThrow();
  });
  it.each(['published', 'retired'] as const)('refuses any write to a %s version with 409 CHECKLIST_PUBLISHED', (status) => {
    const p = problemOf(() => assertEditable({ status }));
    expect(p.status).toBe(409);
    expect(p.code).toBe('CHECKLIST_PUBLISHED');
  });
  it('refuses to publish anything that is not a draft', () => {
    const p = problemOf(() => planPublication({ draft: { status: 'published', version: 2, questions, sections }, previous: null, now: NOW }));
    expect(p.code).toBe('CHECKLIST_PUBLISHED');
  });
});

describe('publishing v(n+1) retires v(n) after a 7-day grace period', () => {
  const previous = { id: 'a'.repeat(24), status: 'published' as const, version: 1 };

  it('grace is exactly 7 days', () => {
    expect(GRACE_PERIOD_MS).toBe(7 * 24 * 3600 * 1000);
  });

  it('stamps the new version and sets graceUntil on the previous one', () => {
    const plan = planPublication({ draft: { status: 'draft', version: 2, questions, sections }, previous, now: NOW });
    expect(plan.publish.status).toBe('published');
    expect(plan.publish.publishedAt).toEqual(NOW);
    expect(plan.publish.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.publish.questions.every((x) => /^[a-f0-9]{64}$/.test(x.textHash))).toBe(true);
    expect(plan.retirePrevious).toEqual({ id: previous.id, graceUntil: new Date(NOW.getTime() + GRACE_PERIOD_MS) });
  });

  it('v1 has no previous version to retire', () => {
    expect(planPublication({ draft: { status: 'draft', version: 1, questions, sections }, previous: null, now: NOW }).retirePrevious).toBeNull();
  });

  it('refuses to publish a draft numbered at or below the current published version', () => {
    const p = problemOf(() => planPublication({ draft: { status: 'draft', version: 1, questions, sections }, previous, now: NOW }));
    expect(p.status).toBe(409);
    // an abandoned v2 draft does not block v3
    expect(planPublication({ draft: { status: 'draft', version: 3, questions, sections }, previous, now: NOW }).retirePrevious?.id).toBe(previous.id);
  });

  it('v(n) reads as published during grace and retired after it; it stays readable', () => {
    const v1 = { status: 'published' as const, graceUntil: new Date(NOW.getTime() + GRACE_PERIOD_MS) };
    expect(effectiveStatus(v1, NOW)).toBe('published');
    expect(acceptsSubmissions(v1, NOW)).toBe(true);
    expect(acceptsNewAssessments(v1)).toBe(false);
    const after = new Date(NOW.getTime() + GRACE_PERIOD_MS);
    expect(effectiveStatus(v1, after)).toBe('retired');
    expect(acceptsSubmissions(v1, after)).toBe(false);
    expect(effectiveStatus({ status: 'published' }, after)).toBe('published');
    expect(acceptsNewAssessments({ status: 'published' })).toBe(true);
    expect(effectiveStatus({ status: 'draft' }, after)).toBe('draft');
  });

  it('numbers versions from 1 and never reuses a number', () => {
    expect(nextVersionNumber([])).toBe(1);
    expect(nextVersionNumber([1, 3, 2])).toBe(4);
  });
});

describe('the question key map holds across copies (research E5)', () => {
  it('reduces a copied ELEVATE externalId (<old>-<epoch>, repeated per copy) to its root', () => {
    expect(rootExternalId('IPC_HH_1')).toBe('IPC_HH_1');
    expect(rootExternalId('IPC_HH_1-1795424177414')).toBe('IPC_HH_1');
    expect(rootExternalId('IPC_HH_1-1795424177414-1795424199999')).toBe('IPC_HH_1');
    // a short numeric suffix is part of the id, not a copy epoch
    expect(rootExternalId('IPC_HH-12')).toBe('IPC_HH-12');
  });

  it('a draft based on v(n) keeps every programme key and ELEVATE root id', () => {
    const draft = deriveDraftFromBase({ questions: questions.map((x) => ({ ...x, textHash: textHashOf(x.text!) })), sections });
    expect(draft.questions.map((x) => x.questionKey)).toEqual(['HH_1', 'HH_2', 'ENV_1']);
    expect(draft.questions.map((x) => x.elevateQuestionExternalId)).toEqual(['IPC_HH_1', 'IPC_HH_2', 'IPC_ENV_1']);
    expect(draft.questions.every((x) => x.textHash === undefined)).toBe(true);
    expect(draft.sections).toEqual(sections);
    expect(draft.sections[0]).not.toBe(sections[0]);
  });

  it('resolves an ELEVATE question id of v1, v2 or v3 to the same programme key', () => {
    const resolve = questionKeyResolver(questions);
    expect(resolve('IPC_HH_2')).toBe('HH_2');
    expect(resolve('IPC_HH_2-1795424177414')).toBe('HH_2');
    expect(resolve('IPC_HH_2-1795424177414-1795424188888')).toBe('HH_2');
    expect(resolve('UNKNOWN-1795424177414')).toBeUndefined();
  });

  it('stores the root id even when a copy id is given', () => {
    const plan = planPublication({
      draft: { status: 'draft', version: 1, questions: [q('HH_1', { elevateQuestionExternalId: 'IPC_HH_1-1795424177414' })], sections },
      previous: null,
      now: NOW,
    });
    expect(plan.publish.questions[0]!.elevateQuestionExternalId).toBe('IPC_HH_1');
  });
});

describe('the content hash is stable', () => {
  it('is the same for the same ordered keys and text, whatever else changes', () => {
    const a = computeContentHash(questions);
    expect(computeContentHash(questions.map((x) => ({ ...x, riskLevel: 'normal' as const, passMark: 5 })))).toBe(a);
    expect(computeContentHash(structuredClone(questions))).toBe(a);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
  it('changes when question text, a key, or the order changes', () => {
    const a = computeContentHash(questions);
    expect(computeContentHash([{ ...questions[0]!, text: { en: 'Changed' } }, ...questions.slice(1)])).not.toBe(a);
    expect(computeContentHash([{ ...questions[0]!, questionKey: 'HH_9' }, ...questions.slice(1)])).not.toBe(a);
    expect(computeContentHash([...questions].reverse())).not.toBe(a);
  });
  it('uses the English text for the text hash (translations do not change the fingerprint)', () => {
    expect(textHashOf({ en: 'Soap at sinks', hi: 'सिंक पर साबुन' })).toBe(textHashOf({ en: 'Soap at sinks' }));
    expect(textHashOf({ en: 'Soap at sinks' })).toBe(createHash('sha256').update('Soap at sinks', 'utf8').digest('hex'));
  });
  it('keeps a stored textHash when there is no text (seeded versions)', () => {
    const h = textHashOf({ en: 'x' });
    expect(computeContentHash([{ questionKey: 'K', textHash: h }])).toBe(computeContentHash([{ questionKey: 'K', text: { en: 'x' } }]));
  });
});

describe('draft content rules', () => {
  it('accepts a well-formed draft', () => {
    expect(validateDraftContent({ sections, questions })).toEqual([]);
  });
  it('lists every violation', () => {
    const v = validateDraftContent({
      sections: [...sections, sections[0]!],
      questions: [q('HH_1'), q('HH_1'), q('X', { sectionKey: 'nope' }), q('Y', { passMark: 11 })],
    });
    expect(v.map((x) => x.path)).toEqual(
      expect.arrayContaining(['sections[2].sectionKey', 'questions[1].questionKey', 'questions[2].sectionKey', 'questions[3].passMark']),
    );
  });
  it('needs at least one question to publish', () => {
    const p = problemOf(() => planPublication({ draft: { status: 'draft', version: 1, questions: [], sections }, previous: null, now: NOW }));
    expect(p.status).toBe(422);
    expect(p.code).toBe('VALIDATION_FAILED');
  });
});
