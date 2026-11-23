import { contentHash } from './canonical.js';

/** AssessmentContext lifecycle (data-model §3): draft → submitted → completed, never backwards. */
export const ASSESSMENT_STATUSES = ['draft', 'submitted', 'completed'] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];
export type AssessorType = 'internal' | 'external';

const RANK: Record<AssessmentStatus, number> = { draft: 0, submitted: 1, completed: 2 };

export function statusMove(from: AssessmentStatus, to: AssessmentStatus): 'same' | 'forward' | 'backward' {
  if (RANK[to] === RANK[from]) return 'same';
  return RANK[to] > RANK[from] ? 'forward' : 'backward';
}

/** External-auditor results are held until a DISTRICT_QM releases them (FR-024a). */
export function releaseStateFor(t: AssessorType): 'held' | 'n/a' {
  return t === 'external' ? 'held' : 'n/a';
}

/** The cycle that started most recently before `current` (the baseline link looks there). */
export function previousCycle<C extends { startsAt: Date }>(cycles: C[], current: C): C | undefined {
  return cycles
    .filter((c) => c.startsAt.getTime() < current.startsAt.getTime())
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())[0];
}

export interface BundleSection {
  sectionKey: string;
  title: Record<string, string>;
  wardTypes: string[];
}

export interface BundleQuestion {
  questionKey: string;
  sectionKey: string;
  elevateQuestionExternalId?: string;
  text?: Record<string, string>;
  textHash?: string;
  answerType?: 'score' | 'yes_no' | 'single_choice';
  options?: { value: string; label: Record<string, string>; score: number }[];
  riskLevel: 'critical' | 'high' | 'normal';
  passMark: number;
  maxScore: number;
  templateTaskKey?: string;
}

/** Sections that apply to a ward type (empty `wardTypes` = every ward). Case-insensitive. */
export function sectionsForWardType<S extends { wardTypes: string[] }>(sections: S[], wardType: string): S[] {
  const t = wardType.toLowerCase();
  return sections.filter((s) => s.wardTypes.length === 0 || s.wardTypes.some((w) => w.toLowerCase() === t));
}

const iso = (d: Date) => d.toISOString();

/**
 * Offline form bundle (contract `FormBundle`): the checklist version cut to the ward's type.
 * `bundleHash` covers only the content, so re-downloading the same version gives the same hash.
 */
export function buildFormBundle(i: {
  assessment: { id: string; v: number; wardId: string; cycleId: string };
  wardType: string;
  checklist: {
    _id: unknown;
    checklistCode: string;
    version: number;
    contentHash?: string;
    graceUntil?: Date;
    sections: BundleSection[];
    questions: BundleQuestion[];
  };
  issuedAt: Date;
}) {
  const c = i.checklist;
  const sections = sectionsForWardType(c.sections, i.wardType).map((s) => ({
    sectionKey: s.sectionKey,
    title: { ...s.title } as { en: string },
    wardTypes: [...s.wardTypes],
  }));
  const keys = new Set(sections.map((s) => s.sectionKey));
  const questions = c.questions
    .filter((q) => keys.has(q.sectionKey))
    .map((q) => ({
      questionKey: q.questionKey,
      ...(q.elevateQuestionExternalId ? { elevateQuestionExternalId: q.elevateQuestionExternalId } : {}),
      sectionKey: q.sectionKey,
      // seeded versions carry only the text hash: the key is the readable fallback
      text: q.text ? ({ ...q.text } as { en: string }) : { en: q.questionKey },
      ...(q.textHash ? { textHash: q.textHash } : {}),
      ...(q.answerType ? { answerType: q.answerType } : {}),
      ...(q.options?.length ? { options: q.options.map((o) => ({ value: o.value, label: { ...o.label }, score: o.score })) } : {}),
      riskLevel: q.riskLevel,
      passMark: q.passMark,
      maxScore: q.maxScore,
      ...(q.templateTaskKey ? { templateTaskKey: q.templateTaskKey } : {}),
    }));
  const checklistVersionId = String(c._id);
  const contentHashValue = c.contentHash ?? contentHash(questions.map((q) => ({ k: q.questionKey, t: q.textHash ?? q.text })));
  const bundleHash = contentHash({ checklistVersionId, version: c.version, contentHash: contentHashValue, wardType: i.wardType, sections, questions });
  return {
    assessmentId: i.assessment.id,
    assessmentV: i.assessment.v,
    wardId: i.assessment.wardId,
    wardType: i.wardType,
    cycleId: i.assessment.cycleId,
    checklistVersionId,
    checklistCode: c.checklistCode,
    version: c.version,
    contentHash: contentHashValue,
    bundleHash,
    ...(c.graceUntil ? { graceUntil: iso(c.graceUntil) } : {}),
    issuedAt: iso(i.issuedAt),
    sections,
    questions,
  };
}
export type FormBundle = ReturnType<typeof buildFormBundle>;
