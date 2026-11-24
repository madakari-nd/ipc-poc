import { previousCycle, type AssessmentStatus, type AssessorType } from './assessment.js';

/**
 * Repeat assessment comparison, trend and release (US7, FR-024, FR-024a). Pure: no I/O.
 *
 * - Same checklist version: section by section from the recorded section scores.
 * - Different versions: only questions with the same programme key AND the same question-text
 *   fingerprint (`textHash`) are compared; everything else is listed as "Not comparable (version
 *   change)" with the reason.
 */

export interface ComparableChecklist {
  id: string;
  version: number;
  sections: { sectionKey: string; title: Record<string, string> }[];
  questions: { questionKey: string; sectionKey: string; textHash?: string; maxScore: number }[];
}

export interface ComparableAssessment {
  id: string;
  cycleId: string;
  checklistVersionId: string;
  assessorType: AssessorType;
  completedAt?: Date;
  total: number;
  bySection: Record<string, number>;
  failedQuestionKeys: string[];
  /** Per-question scores when recorded at completion; otherwise derived (pass/fail programme). */
  questionScores?: Record<string, number>;
}

export type NotComparableReason = 'missing_in_baseline' | 'missing_in_current' | 'text_changed';

export interface SectionComparison {
  sectionKey: string;
  title?: Record<string, string>;
  current: number;
  baseline: number;
  change: number;
  comparedQuestions: number;
}

export interface ComparisonResult {
  sameVersion: boolean;
  sections: SectionComparison[];
  notComparable: { questionKey: string; reason: NotComparableReason }[];
  /** Sum of the section changes: like-for-like only. */
  totalChange: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Per-question scores of an assessment: the recorded ones, or, for assessments recorded with
 * section scores only (seeded baselines), maxScore for a passed and 0 for a failed question of
 * every section that was scored.
 */
export function questionScoresOf(a: ComparableAssessment, checklist: ComparableChecklist): Record<string, number> {
  if (a.questionScores && Object.keys(a.questionScores).length > 0) return { ...a.questionScores };
  const scored = new Set(Object.keys(a.bySection));
  const failed = new Set(a.failedQuestionKeys);
  const out: Record<string, number> = {};
  for (const q of checklist.questions) {
    if (scored.has(q.sectionKey)) out[q.questionKey] = failed.has(q.questionKey) ? 0 : q.maxScore;
  }
  return out;
}

function orderedSectionKeys(keys: Set<string>, ...checklists: ComparableChecklist[]): string[] {
  const order: string[] = [];
  for (const c of checklists) for (const s of c.sections) if (keys.has(s.sectionKey) && !order.includes(s.sectionKey)) order.push(s.sectionKey);
  for (const k of [...keys].sort()) if (!order.includes(k)) order.push(k);
  return order;
}

function titleOf(key: string, ...checklists: ComparableChecklist[]): Record<string, string> | undefined {
  for (const c of checklists) {
    const s = c.sections.find((x) => x.sectionKey === key);
    if (s) return { ...s.title };
  }
  return undefined;
}

export function compareAssessments(i: {
  current: ComparableAssessment;
  baseline: ComparableAssessment;
  currentChecklist: ComparableChecklist;
  baselineChecklist: ComparableChecklist;
}): ComparisonResult {
  const { current, baseline, currentChecklist: cc, baselineChecklist: bc } = i;
  const sameVersion = current.checklistVersionId === baseline.checklistVersionId;

  if (sameVersion) {
    const keys = new Set([...Object.keys(current.bySection), ...Object.keys(baseline.bySection)]);
    const sections = orderedSectionKeys(keys, cc).map((k) => {
      const cur = current.bySection[k] ?? 0;
      const base = baseline.bySection[k] ?? 0;
      return {
        sectionKey: k,
        ...(titleOf(k, cc) ? { title: titleOf(k, cc) } : {}),
        current: round2(cur),
        baseline: round2(base),
        change: round2(cur - base),
        comparedQuestions: cc.questions.filter((q) => q.sectionKey === k).length,
      };
    });
    return { sameVersion, sections, notComparable: [], totalChange: round2(sections.reduce((n, s) => n + s.change, 0)) };
  }

  const curScores = questionScoresOf(current, cc);
  const baseScores = questionScoresOf(baseline, bc);
  const curQ = new Map(cc.questions.filter((q) => q.questionKey in curScores).map((q) => [q.questionKey, q]));
  const baseQ = new Map(bc.questions.filter((q) => q.questionKey in baseScores).map((q) => [q.questionKey, q]));

  const notComparable: ComparisonResult['notComparable'] = [];
  const bySection = new Map<string, { current: number; baseline: number; n: number }>();
  for (const key of [...new Set([...curQ.keys(), ...baseQ.keys()])].sort()) {
    const c = curQ.get(key);
    const b = baseQ.get(key);
    if (!b) notComparable.push({ questionKey: key, reason: 'missing_in_baseline' });
    else if (!c) notComparable.push({ questionKey: key, reason: 'missing_in_current' });
    else if (!c.textHash || !b.textHash || c.textHash !== b.textHash) notComparable.push({ questionKey: key, reason: 'text_changed' });
    else {
      const s = bySection.get(c.sectionKey) ?? { current: 0, baseline: 0, n: 0 };
      s.current += curScores[key] ?? 0;
      s.baseline += baseScores[key] ?? 0;
      s.n += 1;
      bySection.set(c.sectionKey, s);
    }
  }
  const sections = orderedSectionKeys(new Set(bySection.keys()), cc, bc).map((k) => {
    const s = bySection.get(k)!;
    const title = titleOf(k, cc, bc);
    return {
      sectionKey: k,
      ...(title ? { title } : {}),
      current: round2(s.current),
      baseline: round2(s.baseline),
      change: round2(s.current - s.baseline),
      comparedQuestions: s.n,
    };
  });
  return { sameVersion, sections, notComparable, totalChange: round2(sections.reduce((n, s) => n + s.change, 0)) };
}

/**
 * The baseline of a repeat: the latest completed assessment of the same ward in the previous cycle
 * (FR-024). Same rule as the link the assessment service stores when an assessment starts.
 */
export function selectBaseline<
  C extends { _id: unknown; startsAt: Date },
  A extends { wardId: unknown; cycleId: unknown; status: AssessmentStatus; completedAt?: Date },
>(of: { wardId: unknown; cycleId: unknown }, cycles: C[], assessments: A[]): A | undefined {
  const current = cycles.find((c) => String(c._id) === String(of.cycleId));
  if (!current) return undefined;
  const prev = previousCycle(cycles, current);
  if (!prev) return undefined;
  return assessments
    .filter((a) => String(a.wardId) === String(of.wardId) && String(a.cycleId) === String(prev._id) && a.status === 'completed')
    .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))[0];
}

export interface TrendInput {
  id: string;
  cycleId: string;
  status: AssessmentStatus;
  completedAt?: Date;
  checklistVersion: number;
  assessorType: AssessorType;
  total: number;
  bySection?: Record<string, number>;
}

/** One point per cycle (its latest completed assessment), oldest cycle first. */
export function trendPoints(cycles: { _id: unknown; code: string; startsAt: Date }[], assessments: TrendInput[]) {
  return [...cycles]
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .flatMap((c) => {
      const latest = assessments
        .filter((a) => a.cycleId === String(c._id) && a.status === 'completed')
        .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))[0];
      if (!latest) return [];
      return [{
        cycleId: String(c._id),
        cycleCode: c.code,
        assessmentId: latest.id,
        checklistVersion: latest.checklistVersion,
        assessorType: latest.assessorType,
        total: latest.total,
        ...(latest.bySection ? { bySection: { ...latest.bySection } } : {}),
      }];
    });
}

/** Why a release is refused (undefined = allowed). Only DISTRICT_QM releases a held, completed external result. */
export function releaseRefusal(
  a: { assessorType: AssessorType; releaseState: 'n/a' | 'held' | 'released'; status: AssessmentStatus },
  role: string,
): { status: 403 | 409; code: 'ROLE_DENIED' | 'INVALID_TRANSITION'; detail: string } | undefined {
  if (role !== 'DISTRICT_QM') return { status: 403, code: 'ROLE_DENIED', detail: 'Only the district quality manager can release results.' };
  if (a.assessorType !== 'external' || a.releaseState !== 'held') {
    return { status: 409, code: 'INVALID_TRANSITION', detail: a.releaseState === 'released' ? 'This result is already released' : 'Only external-auditor results are held for release' };
  }
  if (a.status !== 'completed') return { status: 409, code: 'INVALID_TRANSITION', detail: 'The result is not complete yet' };
  return undefined;
}
