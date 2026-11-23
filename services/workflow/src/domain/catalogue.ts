import { Problem } from '@ipc/platform';
import { contentHash, sha256Hex } from './canonical.js';

/**
 * Checklist catalogue rules (FR-005, data-model §2, research E5). Pure functions: the catalogue
 * service does the I/O (Mongo, ELEVATE samiksha, ledger, outbox).
 */

export const GRACE_PERIOD_DAYS = 7;
export const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

export type ChecklistStatus = 'draft' | 'published' | 'retired';
export type RiskLevel = 'critical' | 'high' | 'normal';

export interface LocalizedText { en: string; hi?: string; kn?: string }

export interface CatalogueSection { sectionKey: string; title: LocalizedText; wardTypes: string[] }

export interface CatalogueQuestion {
  questionKey: string;
  /** ROOT ELEVATE question externalId (the id in the first solution); copies append `-<epoch>`. */
  elevateQuestionExternalId?: string;
  sectionKey: string;
  text?: LocalizedText;
  textHash?: string;
  answerType?: 'score' | 'yes_no' | 'single_choice';
  options?: { value: string; label: LocalizedText; score: number }[];
  riskLevel: RiskLevel;
  passMark: number;
  maxScore: number;
  templateTaskKey?: string;
}

export interface Violation { path: string; message: string }

/** Any write to a published or retired version is refused (US1 AS3). */
export function assertEditable(v: { status: ChecklistStatus }): void {
  if (v.status !== 'draft') {
    throw Problem.conflict('CHECKLIST_PUBLISHED', 'This checklist version is published and cannot be changed. Create a new draft instead.');
  }
}

/** Text fingerprint: SHA-256 of the English wording (translations do not change the question). */
export function textHashOf(text: LocalizedText): string {
  return sha256Hex(text.en);
}

function questionTextHash(q: Pick<CatalogueQuestion, 'text' | 'textHash' | 'questionKey'>): string {
  if (q.text) return textHashOf(q.text);
  if (q.textHash) return q.textHash;
  throw Problem.unprocessable('VALIDATION_FAILED', `Question ${q.questionKey} has no text`);
}

/**
 * Content hash over the ORDERED question keys and their text hashes (data-model §2). The same
 * formula is used by the seed, so a seeded v1 and a published v1 fingerprint identically.
 */
export function computeContentHash(questions: Pick<CatalogueQuestion, 'questionKey' | 'text' | 'textHash'>[]): string {
  return contentHash(questions.map((q) => ({ k: q.questionKey, t: questionTextHash(q) })));
}

/** ELEVATE renames a copied question `<old>-<epoch>` (research-elevate d2): strip every copy suffix. */
const COPY_SUFFIX = /(?:-\d{10,13})+$/;
export function rootExternalId(externalId: string): string {
  return externalId.replace(COPY_SUFFIX, '');
}

/** Maps any ELEVATE question externalId of any version in the lineage to the stable programme key. */
export function questionKeyResolver(questions: Pick<CatalogueQuestion, 'questionKey' | 'elevateQuestionExternalId'>[]) {
  const byRoot = new Map<string, string>();
  for (const q of questions) if (q.elevateQuestionExternalId) byRoot.set(rootExternalId(q.elevateQuestionExternalId), q.questionKey);
  return (externalId: string): string | undefined => byRoot.get(rootExternalId(externalId));
}

export function nextVersionNumber(existing: number[]): number {
  return existing.length ? Math.max(...existing) + 1 : 1;
}

/** A new draft based on a published version: same programme keys and ELEVATE roots, fresh hashes. */
export function deriveDraftFromBase(base: { questions: CatalogueQuestion[]; sections: CatalogueSection[] }) {
  return {
    sections: base.sections.map((s) => ({ sectionKey: s.sectionKey, title: { ...s.title }, wardTypes: [...s.wardTypes] })),
    questions: base.questions.map((q) => {
      const rest: Partial<CatalogueQuestion> = { ...q };
      delete rest.textHash;
      return {
        ...structuredClone(rest),
        ...(q.elevateQuestionExternalId ? { elevateQuestionExternalId: rootExternalId(q.elevateQuestionExternalId) } : {}),
        // a seeded question without text keeps its fingerprint as the only content we know
        ...(!q.text && q.textHash ? { textHash: q.textHash } : {}),
      } as CatalogueQuestion;
    }),
  };
}

/** All content-rule violations of a draft (empty when it is valid). */
export function validateDraftContent(d: { sections: CatalogueSection[]; questions: CatalogueQuestion[] }): Violation[] {
  const out: Violation[] = [];
  const sectionKeys = new Set<string>();
  d.sections.forEach((s, i) => {
    if (sectionKeys.has(s.sectionKey)) out.push({ path: `sections[${i}].sectionKey`, message: 'is used twice' });
    sectionKeys.add(s.sectionKey);
  });
  const keys = new Set<string>();
  d.questions.forEach((q, i) => {
    if (keys.has(q.questionKey)) out.push({ path: `questions[${i}].questionKey`, message: 'is used twice' });
    keys.add(q.questionKey);
    if (!sectionKeys.has(q.sectionKey)) out.push({ path: `questions[${i}].sectionKey`, message: 'is not a section of this checklist' });
    if (q.passMark > q.maxScore) out.push({ path: `questions[${i}].passMark`, message: 'must not be above maxScore' });
    if (!q.text && !q.textHash) out.push({ path: `questions[${i}].text`, message: 'is required' });
  });
  return out;
}

export interface PublicationPlan {
  publish: {
    status: 'published';
    publishedAt: Date;
    contentHash: string;
    questions: (CatalogueQuestion & { textHash: string })[];
  };
  /** The version this one replaces: it stays readable and usable until `graceUntil`, then retires. */
  retirePrevious: { id: string; graceUntil: Date } | null;
}

/**
 * What publishing a draft changes. The previous published version gets `graceUntil = now + 7 d`
 * (offline drafts built on it may still be submitted until then); new assessments use the new one.
 */
export function planPublication(a: {
  draft: { status: ChecklistStatus; version: number; questions: CatalogueQuestion[]; sections: CatalogueSection[] };
  previous: { id: string; status: ChecklistStatus; version: number } | null;
  now: Date;
}): PublicationPlan {
  assertEditable(a.draft);
  const errors = validateDraftContent(a.draft);
  if (a.draft.questions.length === 0) errors.push({ path: 'questions', message: 'a checklist needs at least one question' });
  if (errors.length) throw Problem.unprocessable('VALIDATION_FAILED', 'The draft is not complete', { errors });
  if (a.previous && a.previous.version >= a.draft.version) {
    throw Problem.conflict('VERSION_CONFLICT', `Version ${a.previous.version} is already published`);
  }
  const questions = a.draft.questions.map((q) => ({
    ...q,
    ...(q.elevateQuestionExternalId ? { elevateQuestionExternalId: rootExternalId(q.elevateQuestionExternalId) } : {}),
    textHash: questionTextHash(q),
  }));
  return {
    publish: { status: 'published', publishedAt: a.now, contentHash: computeContentHash(questions), questions },
    retirePrevious: a.previous ? { id: a.previous.id, graceUntil: new Date(a.now.getTime() + GRACE_PERIOD_MS) } : null,
  };
}

/** Status as readers see it: a published version whose grace period has ended reads as retired. */
export function effectiveStatus(v: { status: ChecklistStatus; graceUntil?: Date | null }, now: Date): ChecklistStatus {
  if (v.status === 'published' && v.graceUntil && v.graceUntil.getTime() <= now.getTime()) return 'retired';
  return v.status;
}

/** New assessments start only on the current version (no grace period set). */
export function acceptsNewAssessments(v: { status: ChecklistStatus; graceUntil?: Date | null }): boolean {
  return v.status === 'published' && !v.graceUntil;
}

/** Submissions on a version are accepted until its grace period ends (then 409 CHECKLIST_VERSION_RETIRED). */
export function acceptsSubmissions(v: { status: ChecklistStatus; graceUntil?: Date | null }, now: Date): boolean {
  return effectiveStatus(v, now) === 'published';
}

export function countsByRisk(questions: { riskLevel: RiskLevel }[]): Record<RiskLevel, number> {
  const out: Record<RiskLevel, number> = { critical: 0, high: 0, normal: 0 };
  for (const q of questions) out[q.riskLevel] += 1;
  return out;
}
