/**
 * Programme oversight rules (US8; FR-025, FR-026; data-model §1, §3, §4, §7). Pure functions over
 * plain facts: the oversight service loads the register, assessments and tasks, gets the
 * evidence-based exceptions and device outboxes from the Edge, and passes programme time in.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** FR-026 thresholds and the FR-025 repeated-rejection threshold. */
export const DQ_RULES = {
  farFromFacilityM: 1000,
  clockSkewSec: 10 * 60,
  lateUploadMs: 7 * DAY_MS,
  noBaselineAfterMs: 21 * DAY_MS,
  staleDeviceMs: 72 * HOUR_MS,
  repeatedRejections: 2,
} as const;

export type DqKind =
  | 'PHOTO_NO_GPS' | 'GPS_FAR_FROM_FACILITY' | 'DEVICE_CLOCK_SKEW' | 'LATE_UPLOAD' | 'DUPLICATE_PHOTO_ACROSS_WARDS'
  | 'NO_BASELINE' | 'STALE_DEVICE_QUEUE';

export type WardAssessmentStatus = 'not_started' | 'submitted' | 'completed' | 'held';

export interface WardRef {
  wardId: string; wardName: string; wardType?: string; facilityId: string; facilityName: string; districtCode: string;
}
export interface CycleRef { id: string; code: string; startsAt: Date }
export interface AssessmentFact {
  wardId: string; cycleId: string; status: 'draft' | 'submitted' | 'completed'; releaseState: 'n/a' | 'held' | 'released';
  isBaselineForCycle: boolean; completedAt?: Date; scoreTotal?: number; failedQuestionKeys: string[];
}
export interface TaskFact {
  wardId: string; cycleId: string; riskLevel: 'critical' | 'high' | 'normal'; state: string; dueAt: Date; rejectionCount: number;
}
/** Contract `DataQualityException` (names are added by the service). */
export interface DqException {
  id: string; kind: DqKind; detectedAt: string; facilityId: string; wardId?: string; evidenceId?: string;
  relatedEvidenceIds?: string[]; userId?: string; deviceId?: string; cycleId?: string; metric?: Record<string, number>;
}

export interface WardRow {
  wardId: string; wardName: string; wardType?: string; facilityId: string; facilityName: string; districtCode: string;
  assessmentStatus: WardAssessmentStatus; latestScore?: number; baselineScore?: number;
  openCriticalTasks: number; overdueCriticalTasks: number; repeatedFailures: number; dataQualityExceptions: number;
}

export interface OversightCounts {
  wards: number; wardsAssessed: number; completionRate: number; openCriticalTasks: number; overdueCriticalTasks: number;
  repeatedFailures: number; dataQualityExceptions: number; averageScore?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const byStart = (cycles: CycleRef[]) => [...cycles].sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime());
const isAssessed = (s: WardAssessmentStatus) => s === 'completed' || s === 'held';

// ------------------------------------------------------------------------------------ assessments

/** Ward status in one cycle: completed (released or internal) beats held beats submitted. */
export function assessmentStatus(inCycle: AssessmentFact[]): WardAssessmentStatus {
  const done = inCycle.filter((x) => x.status === 'completed');
  if (done.some((x) => x.releaseState !== 'held')) return 'completed';
  if (done.length) return 'held';
  return inCycle.some((x) => x.status === 'submitted') ? 'submitted' : 'not_started';
}

/** Latest completed assessment of a ward in a cycle (by completion time). */
export function latestCompleted(assessments: AssessmentFact[], wardId: string, cycleId: string): AssessmentFact | undefined {
  return assessments
    .filter((x) => x.wardId === wardId && x.cycleId === cycleId && x.status === 'completed')
    .sort((x, y) => (y.completedAt?.getTime() ?? 0) - (x.completedAt?.getTime() ?? 0))[0];
}

export function previousCycleId(cycles: CycleRef[], cycleId: string): string | undefined {
  const sorted = byStart(cycles);
  const i = sorted.findIndex((c) => c.id === cycleId);
  return i > 0 ? sorted[i - 1]!.id : undefined;
}

// ------------------------------------------------------------------------------------------ tasks

/** Critical tasks not closed; overdue when due strictly before programme now. */
export function taskCounts(tasks: TaskFact[], now: Date): { openCritical: number; overdueCritical: number } {
  const open = tasks.filter((x) => x.riskLevel === 'critical' && x.state !== 'CLOSED');
  return { openCritical: open.length, overdueCritical: open.filter((x) => x.dueAt.getTime() < now.getTime()).length };
}

/** FR-025: tasks rejected ≥ 2 times plus questions failed in the latest assessment of two consecutive cycles. */
export function repeatedFailures(o: { tasks: TaskFact[]; current?: AssessmentFact; previous?: AssessmentFact }) {
  const rejectedTasks = o.tasks.filter((x) => x.rejectionCount >= DQ_RULES.repeatedRejections).length;
  const before = new Set(o.previous?.failedQuestionKeys ?? []);
  const repeatedQuestionKeys = o.current ? [...new Set(o.current.failedQuestionKeys)].filter((k) => before.has(k)) : [];
  return { rejectedTasks, repeatedQuestionKeys, total: rejectedTasks + repeatedQuestionKeys.length };
}

// ---------------------------------------------------------------------------------- read models

/** One row per ward (input order kept) for the selected cycle. */
export function buildWardRows(o: {
  wards: WardRef[]; cycles: CycleRef[]; cycleId: string; assessments: AssessmentFact[]; tasks: TaskFact[];
  exceptions: Pick<DqException, 'wardId' | 'facilityId'>[]; now: Date;
}): WardRow[] {
  const prev = previousCycleId(o.cycles, o.cycleId);
  return o.wards.map((w) => {
    const inCycle = o.assessments.filter((x) => x.wardId === w.wardId && x.cycleId === o.cycleId);
    const tasks = o.tasks.filter((x) => x.wardId === w.wardId && x.cycleId === o.cycleId);
    const current = latestCompleted(o.assessments, w.wardId, o.cycleId);
    const baseline = inCycle.find((x) => x.status === 'completed' && x.isBaselineForCycle);
    const counts = taskCounts(tasks, o.now);
    const rf = repeatedFailures({ tasks, current, previous: prev ? latestCompleted(o.assessments, w.wardId, prev) : undefined });
    return {
      ...w,
      assessmentStatus: assessmentStatus(inCycle),
      ...(current?.scoreTotal !== undefined ? { latestScore: current.scoreTotal } : {}),
      ...(baseline?.scoreTotal !== undefined ? { baselineScore: baseline.scoreTotal } : {}),
      openCriticalTasks: counts.openCritical,
      overdueCriticalTasks: counts.overdueCritical,
      repeatedFailures: rf.total,
      dataQualityExceptions: o.exceptions.filter((e) => e.wardId === w.wardId).length,
    };
  });
}

/** Sums rows; exceptions are counted by the caller (some have no ward, e.g. a stale device). */
export function aggregateCounts(rows: WardRow[], dataQualityExceptions: number): OversightCounts {
  const assessed = rows.filter((r) => isAssessed(r.assessmentStatus)).length;
  const scores = rows.map((r) => r.latestScore).filter((s): s is number => s !== undefined);
  const sum = (k: 'openCriticalTasks' | 'overdueCriticalTasks' | 'repeatedFailures') => rows.reduce((n, r) => n + r[k], 0);
  return {
    wards: rows.length,
    wardsAssessed: assessed,
    completionRate: rows.length ? assessed / rows.length : 0,
    openCriticalTasks: sum('openCriticalTasks'),
    overdueCriticalTasks: sum('overdueCriticalTasks'),
    repeatedFailures: sum('repeatedFailures'),
    dataQualityExceptions,
    ...(scores.length ? { averageScore: round2(scores.reduce((n, s) => n + s, 0) / scores.length) } : {}),
  };
}

/** Average of each ward's latest completed score per cycle, in start order up to the selected cycle. */
export function scoreTrend(o: { wards: WardRef[]; cycles: CycleRef[]; assessments: AssessmentFact[]; uptoCycleId: string }) {
  const sorted = byStart(o.cycles);
  const upto = sorted.findIndex((c) => c.id === o.uptoCycleId);
  const out: { cycleCode: string; averageScore: number }[] = [];
  for (const c of sorted.slice(0, upto + 1)) {
    const scores = o.wards
      .map((w) => latestCompleted(o.assessments, w.wardId, c.id)?.scoreTotal)
      .filter((s): s is number => s !== undefined);
    if (scores.length) out.push({ cycleCode: c.code, averageScore: round2(scores.reduce((n, s) => n + s, 0) / scores.length) });
  }
  return out;
}

// ------------------------------------------------------------------------------- data quality

/** Great-circle distance in metres. */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface EvidenceFact {
  isPhoto: boolean; gps?: { lat: number; lng: number } | null; gpsUnavailable?: boolean;
  /** Hospital point from the workflow Facility register. */
  facilityLocation?: { lat: number; lng: number };
  clockSkewSec: number; capturedAt: Date; receivedAt: Date;
}

/** Per-item evidence rules: no GPS, > 1 km from the hospital, clock skew > 10 min, upload > 7 days. */
export function evidenceRuleHits(e: EvidenceFact): { kind: DqKind; metric?: Record<string, number> }[] {
  const out: { kind: DqKind; metric?: Record<string, number> }[] = [];
  if (e.isPhoto && (e.gpsUnavailable || !e.gps)) out.push({ kind: 'PHOTO_NO_GPS' });
  if (e.gps && e.facilityLocation) {
    const distanceM = Math.round(haversineM(e.gps, e.facilityLocation));
    if (distanceM > DQ_RULES.farFromFacilityM) out.push({ kind: 'GPS_FAR_FROM_FACILITY', metric: { distanceM } });
  }
  if (Math.abs(e.clockSkewSec) > DQ_RULES.clockSkewSec) out.push({ kind: 'DEVICE_CLOCK_SKEW', metric: { skewSec: e.clockSkewSec } });
  const delay = e.receivedAt.getTime() - e.capturedAt.getTime();
  if (delay > DQ_RULES.lateUploadMs) out.push({ kind: 'LATE_UPLOAD', metric: { uploadDelayHours: Math.round(delay / HOUR_MS) } });
  return out;
}

export interface DqItem { evidenceId: string; sha256: string; wardId: string; isPhoto: boolean }

/** Photos whose SHA-256 appears in two or more wards → evidenceId → the other evidence ids. */
export function duplicatePhotoGroups(items: DqItem[]): Map<string, string[]> {
  const bySha = new Map<string, DqItem[]>();
  for (const i of items.filter((x) => x.isPhoto)) bySha.set(i.sha256, [...(bySha.get(i.sha256) ?? []), i]);
  const out = new Map<string, string[]>();
  for (const group of bySha.values()) {
    if (new Set(group.map((g) => g.wardId)).size < 2) continue;
    for (const g of group) out.set(g.evidenceId, group.filter((x) => x !== g).map((x) => x.evidenceId));
  }
  return out;
}

/** Wards with no completed (or held) assessment 3 weeks after the cycle started. */
export function noBaselineExceptions(o: { wards: WardRef[]; cycle: CycleRef; assessments: AssessmentFact[]; now: Date }): DqException[] {
  const due = o.cycle.startsAt.getTime() + DQ_RULES.noBaselineAfterMs;
  if (o.now.getTime() < due) return [];
  const daysSinceStart = Math.floor((o.now.getTime() - o.cycle.startsAt.getTime()) / DAY_MS);
  return o.wards
    .filter((w) => !isAssessed(assessmentStatus(o.assessments.filter((x) => x.wardId === w.wardId && x.cycleId === o.cycle.id))))
    .map((w) => ({
      id: `NO_BASELINE:${o.cycle.id}:${w.wardId}`, kind: 'NO_BASELINE' as const, detectedAt: new Date(due).toISOString(),
      facilityId: w.facilityId, wardId: w.wardId, cycleId: o.cycle.id, metric: { daysSinceStart },
    }));
}

export interface DeviceQueueFact { deviceId: string; userId: string; pendingCount: number; oldestPendingAt: Date | null }

/** Device outboxes whose oldest unsent item is older than 72 h, placed by the user's scope. */
export function staleDeviceExceptions(o: {
  devices: DeviceQueueFact[]; now: Date; locate: (userId: string) => { facilityId: string; wardId?: string } | undefined;
}): DqException[] {
  const out: DqException[] = [];
  for (const d of o.devices) {
    if (d.pendingCount <= 0 || !d.oldestPendingAt) continue;
    const age = o.now.getTime() - d.oldestPendingAt.getTime();
    if (age <= DQ_RULES.staleDeviceMs) continue;
    const where = o.locate(d.userId);
    if (!where) continue;
    out.push({
      id: `STALE_DEVICE_QUEUE:${d.deviceId}:${d.userId}`, kind: 'STALE_DEVICE_QUEUE',
      detectedAt: new Date(d.oldestPendingAt.getTime() + DQ_RULES.staleDeviceMs).toISOString(),
      facilityId: where.facilityId, ...(where.wardId ? { wardId: where.wardId } : {}), userId: d.userId, deviceId: d.deviceId,
      metric: { oldestPendingHours: Math.floor(age / HOUR_MS), pendingCount: d.pendingCount },
    });
  }
  return out;
}

/** Newest first, then by id (stable paging). */
export function sortExceptions<T extends Pick<DqException, 'detectedAt' | 'id'>>(list: T[]): T[] {
  return [...list].sort((x, y) => (x.detectedAt === y.detectedAt ? x.id.localeCompare(y.id) : x.detectedAt < y.detectedAt ? 1 : -1));
}
