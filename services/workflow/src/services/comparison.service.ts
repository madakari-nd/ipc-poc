import { Types } from 'mongoose';
import { Problem } from '@ipc/platform';
import {
  compareAssessments,
  trendPoints,
  type ComparableAssessment,
  type ComparableChecklist,
} from '../domain/comparison.js';
import {
  AssessmentContextModel,
  ChecklistVersionModel,
  CycleModel,
  WardModel,
  type AssessmentContext,
  type ChecklistVersion,
  type Cycle,
  type Ward,
} from '../domain/models/index.js';
import type { ActorScope } from './admin.service.js';
import type { AssessmentService } from './assessment.service.js';

type Actor = { userId: string } & ActorScope;

const isOid = (s: string) => /^[a-f0-9]{24}$/.test(s);
const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : undefined);
const mapObj = (m?: Map<string, number> | Record<string, number>): Record<string, number> =>
  m instanceof Map ? Object.fromEntries(m) : { ...(m ?? {}) };

function comparable(a: AssessmentContext): ComparableAssessment {
  const q = mapObj(a.questionScores);
  return {
    id: String(a._id),
    cycleId: String(a.cycleId),
    checklistVersionId: String(a.checklistVersionId),
    assessorType: a.assessorType,
    ...(a.completedAt ? { completedAt: a.completedAt } : {}),
    total: a.scores?.total ?? 0,
    bySection: mapObj(a.scores?.bySection),
    failedQuestionKeys: [...(a.failedQuestionKeys ?? [])],
    ...(Object.keys(q).length ? { questionScores: q } : {}),
  };
}

function checklistOf(c: ChecklistVersion, wardType?: string): ComparableChecklist {
  const t = wardType?.toLowerCase();
  const sections = c.sections.filter((s) => !t || s.wardTypes.length === 0 || s.wardTypes.some((w) => w.toLowerCase() === t));
  const keys = new Set(sections.map((s) => s.sectionKey));
  return {
    id: String(c._id),
    version: c.version,
    sections: sections.map((s) => ({ sectionKey: s.sectionKey, title: { ...s.title } })),
    questions: c.questions
      .filter((q) => keys.has(q.sectionKey))
      .map((q) => ({ questionKey: q.questionKey, sectionKey: q.sectionKey, ...(q.textHash ? { textHash: q.textHash } : {}), maxScore: q.maxScore })),
  };
}

/**
 * US7 (T111): repeat-assessment comparison and the ward trend. Visibility is the assessment
 * service's (scope + held external results hidden from hospital roles, FR-024a); the baseline is
 * the stored link (`baselineOfId`, officer-adjustable) or, when none, the same "latest completed in
 * the previous cycle" rule the assessment service applies when an assessment starts (FR-024).
 */
export class ComparisonService {
  constructor(private readonly d: { assessment: AssessmentService }) {}

  private side(a: AssessmentContext, version: number) {
    return {
      cycleId: String(a.cycleId),
      checklistVersionId: String(a.checklistVersionId),
      checklistVersion: version,
      assessorType: a.assessorType,
      ...(a.completedAt ? { completedAt: iso(a.completedAt) } : {}),
      total: a.scores?.total ?? 0,
    };
  }

  /** `getAssessmentComparison` (contract `Comparison`). */
  async compare(id: string, actor: Actor) {
    const current = await this.d.assessment.findVisible(id, actor);
    const [ward, cycle] = await Promise.all([
      WardModel.findById(current.wardId).lean<Ward>(),
      CycleModel.findById(current.cycleId).lean<Cycle>(),
    ]);
    const baselineId = current.baselineOfId ?? (cycle ? await this.d.assessment.defaultBaselineOf(current.wardId, cycle) : undefined);
    let baseline: AssessmentContext | null = null;
    if (baselineId) {
      // The baseline must itself be visible to the caller (a held external result stays hidden).
      const filter = await this.d.assessment.visibleFilter(actor);
      baseline = await AssessmentContextModel.findOne({ _id: baselineId, status: 'completed', ...filter }).lean<AssessmentContext>();
    }
    const ids = [current.checklistVersionId, ...(baseline ? [baseline.checklistVersionId] : [])];
    const checklists = new Map(
      (await ChecklistVersionModel.find({ _id: { $in: ids } }).lean<ChecklistVersion[]>()).map((c) => [String(c._id), c]),
    );
    const cc = checklists.get(String(current.checklistVersionId));
    if (!cc) throw Problem.notFound();
    const curChecklist = checklistOf(cc, ward?.wardType);
    const base = {
      assessmentId: String(current._id),
      wardId: String(current.wardId),
      facilityId: String(current.facilityId),
      current: this.side(current, cc.version),
    };
    if (!baseline) {
      // No baseline: both sides carry the repeat's identity and the baseline total is 0 (contract requires the object).
      return { ...base, baselineAssessmentId: null, baseline: { ...this.side(current, cc.version), total: 0 }, totalChange: 0, sections: [], notComparable: [] };
    }
    const bc = checklists.get(String(baseline.checklistVersionId)) ?? cc;
    const result = compareAssessments({
      current: comparable(current),
      baseline: comparable(baseline),
      currentChecklist: curChecklist,
      baselineChecklist: checklistOf(bc, ward?.wardType),
    });
    return {
      ...base,
      baselineAssessmentId: String(baseline._id),
      baseline: this.side(baseline, bc.version),
      totalChange: result.totalChange,
      sections: result.sections,
      notComparable: result.notComparable,
    };
  }

  /** `getWardTrend` (contract `Trend`): one point per cycle, only assessments the caller may see. */
  async trend(wardId: string, actor: Actor) {
    if (!isOid(wardId)) throw Problem.forbidden('SCOPE_DENIED', 'This item is outside your area.');
    const ward = await WardModel.findById(wardId).lean<Ward>();
    const filter = await this.d.assessment.visibleFilter(actor);
    const inScope = ward && (await this.wardVisible(ward, filter));
    if (!inScope) throw Problem.forbidden('SCOPE_DENIED', 'This item is outside your area.');
    const docs = await AssessmentContextModel.find({ ...filter, wardId: new Types.ObjectId(wardId), status: 'completed' }).lean<AssessmentContext[]>();
    const [cycles, versions] = await Promise.all([
      CycleModel.find({ _id: { $in: [...new Set(docs.map((d) => String(d.cycleId)))] } }, { code: 1, startsAt: 1 }).lean<Cycle[]>(),
      ChecklistVersionModel.find({ _id: { $in: docs.map((d) => d.checklistVersionId) } }, { version: 1 }).lean<{ _id: Types.ObjectId; version: number }[]>(),
    ]);
    const vmap = new Map(versions.map((v) => [String(v._id), v.version]));
    return {
      wardId,
      points: trendPoints(cycles, docs.map((d) => ({
        id: String(d._id),
        cycleId: String(d.cycleId),
        status: d.status,
        ...(d.completedAt ? { completedAt: d.completedAt } : {}),
        checklistVersion: vmap.get(String(d.checklistVersionId)) ?? 1,
        assessorType: d.assessorType,
        total: d.scores?.total ?? 0,
        bySection: mapObj(d.scores?.bySection),
      }))),
    };
  }

  /** The ward is inside the caller's facilities (and wards, for ward-scoped roles). */
  private async wardVisible(ward: Ward, filter: Record<string, unknown>): Promise<boolean> {
    const f = filter.facilityId as { $in: Types.ObjectId[] } | undefined;
    const w = filter.wardId as { $in: Types.ObjectId[] } | undefined;
    if (f && !f.$in.some((x) => String(x) === String(ward.facilityId))) return false;
    if (w && !w.$in.some((x) => String(x) === String(ward._id))) return false;
    return true;
  }
}
