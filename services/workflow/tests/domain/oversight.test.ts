import { describe, expect, it } from 'vitest';
import {
  DQ_RULES,
  aggregateCounts,
  assessmentStatus,
  buildWardRows,
  duplicatePhotoGroups,
  evidenceRuleHits,
  noBaselineExceptions,
  previousCycleId,
  repeatedFailures,
  scoreTrend,
  sortExceptions,
  staleDeviceExceptions,
  taskCounts,
  type AssessmentFact,
  type CycleRef,
  type DqItem,
  type TaskFact,
  type WardRef,
} from '../../src/domain/oversight.js';

const NOW = new Date('2026-11-23T10:00:00.000Z');
const H = 3_600_000;
const DAY = 24 * H;

const C0: CycleRef = { id: 'c0', code: '2026-C0', startsAt: new Date('2026-08-01T00:00:00Z') };
const C1: CycleRef = { id: 'c1', code: '2026-C1', startsAt: new Date('2026-11-01T00:00:00Z') };
const CYCLES = [C1, C0]; // unsorted on purpose

const W: WardRef[] = [
  { wardId: 'wa1', wardName: 'Ward 1', wardType: 'general', facilityId: 'fa', facilityName: 'Hospital A', districtCode: 'D1' },
  { wardId: 'wa4', wardName: 'Ward 4', wardType: 'general', facilityId: 'fa', facilityName: 'Hospital A', districtCode: 'D1' },
  { wardId: 'wb1', wardName: 'Ward 1', wardType: 'general', facilityId: 'fb', facilityName: 'Hospital B', districtCode: 'D2' },
];

const a = (o: Partial<AssessmentFact> & Pick<AssessmentFact, 'wardId' | 'cycleId'>): AssessmentFact => ({
  status: 'completed', releaseState: 'n/a', isBaselineForCycle: false, completedAt: new Date('2026-11-10T00:00:00Z'), failedQuestionKeys: [], ...o,
});
const t = (o: Partial<TaskFact> & Pick<TaskFact, 'wardId'>): TaskFact => ({
  cycleId: 'c1', riskLevel: 'critical', state: 'ASSIGNED', dueAt: new Date(NOW.getTime() + DAY), rejectionCount: 0, ...o,
});

describe('assessment status and completion (FR-025)', () => {
  it('derives the ward status from its assessments in the cycle', () => {
    expect(assessmentStatus([])).toBe('not_started');
    expect(assessmentStatus([a({ wardId: 'w', cycleId: 'c1', status: 'draft' })])).toBe('not_started');
    expect(assessmentStatus([a({ wardId: 'w', cycleId: 'c1', status: 'submitted' })])).toBe('submitted');
    expect(assessmentStatus([a({ wardId: 'w', cycleId: 'c1', releaseState: 'held' })])).toBe('held');
    expect(assessmentStatus([a({ wardId: 'w', cycleId: 'c1', releaseState: 'held' }), a({ wardId: 'w', cycleId: 'c1' })])).toBe('completed');
    expect(assessmentStatus([a({ wardId: 'w', cycleId: 'c1', status: 'submitted' }), a({ wardId: 'w', cycleId: 'c1', releaseState: 'released' })])).toBe('completed');
  });

  it('completion counts completed and held wards over all wards in scope', () => {
    const rows = buildWardRows({
      wards: W, cycles: CYCLES, cycleId: 'c1', now: NOW, tasks: [], exceptions: [],
      assessments: [a({ wardId: 'wa4', cycleId: 'c1' }), a({ wardId: 'wb1', cycleId: 'c1', releaseState: 'held' }), a({ wardId: 'wa1', cycleId: 'c0' })],
    });
    expect(rows.map((r) => r.assessmentStatus)).toEqual(['not_started', 'completed', 'held']);
    const c = aggregateCounts(rows, 0);
    expect(c).toMatchObject({ wards: 3, wardsAssessed: 2 });
    expect(c.completionRate).toBeCloseTo(2 / 3, 6);
    expect(aggregateCounts([], 0)).toMatchObject({ wards: 0, wardsAssessed: 0, completionRate: 0 });
    expect(aggregateCounts([], 0).averageScore).toBeUndefined();
  });
});

describe('open and overdue critical tasks (programmeNow)', () => {
  it('counts critical tasks that are not closed; overdue when due before programme now', () => {
    const tasks = [
      t({ wardId: 'wa4' }), // open, not due
      t({ wardId: 'wa4', dueAt: new Date(NOW.getTime() - 1) }), // overdue
      t({ wardId: 'wa4', dueAt: new Date(NOW.getTime() - DAY), state: 'PENDING_VALIDATION' }), // overdue, still open
      t({ wardId: 'wa4', dueAt: new Date(NOW.getTime() - DAY), state: 'CLOSED' }), // closed: neither
      t({ wardId: 'wa4', dueAt: new Date(NOW.getTime() - DAY), riskLevel: 'high' }), // not critical
      t({ wardId: 'wa4', dueAt: NOW }), // due exactly now: not yet overdue
    ];
    expect(taskCounts(tasks, NOW)).toEqual({ openCritical: 4, overdueCritical: 2 });
    // the same tasks are not overdue an hour earlier on the programme clock
    expect(taskCounts(tasks, new Date(NOW.getTime() - 2 * DAY))).toEqual({ openCritical: 4, overdueCritical: 0 });
  });
});

describe('repeated failures (rejectionCount ≥ 2 or the same question failed in 2 consecutive cycles)', () => {
  it('finds the previous cycle by start date', () => {
    expect(previousCycleId(CYCLES, 'c1')).toBe('c0');
    expect(previousCycleId(CYCLES, 'c0')).toBeUndefined();
    expect(previousCycleId(CYCLES, 'nope')).toBeUndefined();
  });

  it('counts tasks rejected twice or more', () => {
    const r = repeatedFailures({
      tasks: [t({ wardId: 'w', rejectionCount: 2 }), t({ wardId: 'w', rejectionCount: 3, state: 'CLOSED' }), t({ wardId: 'w', rejectionCount: 1 })],
    });
    expect(r).toEqual({ rejectedTasks: 2, repeatedQuestionKeys: [], total: 2 });
  });

  it('counts questions failed in the latest completed assessment of this and the previous cycle', () => {
    const r = repeatedFailures({
      tasks: [],
      current: a({ wardId: 'w', cycleId: 'c1', failedQuestionKeys: ['hand_rub_at_bed', 'sharps'] }),
      previous: a({ wardId: 'w', cycleId: 'c0', failedQuestionKeys: ['hand_rub_at_bed', 'waste_segregation'] }),
    });
    expect(r).toEqual({ rejectedTasks: 0, repeatedQuestionKeys: ['hand_rub_at_bed'], total: 1 });
    expect(repeatedFailures({ tasks: [], current: a({ wardId: 'w', cycleId: 'c1', failedQuestionKeys: ['x'] }) }).total).toBe(0);
  });

  it('uses the latest completed assessment of each cycle in the ward rows', () => {
    const rows = buildWardRows({
      wards: W.slice(0, 2), cycles: CYCLES, cycleId: 'c1', now: NOW, exceptions: [],
      tasks: [t({ wardId: 'wa4', rejectionCount: 2 }), t({ wardId: 'wa4', cycleId: 'c0', rejectionCount: 5 })],
      assessments: [
        a({ wardId: 'wa4', cycleId: 'c0', failedQuestionKeys: ['q1', 'q2'], completedAt: new Date('2026-09-15T00:00:00Z'), isBaselineForCycle: true, scoreTotal: 0 }),
        a({ wardId: 'wa4', cycleId: 'c1', failedQuestionKeys: ['q2'], completedAt: new Date('2026-11-05T00:00:00Z'), isBaselineForCycle: true, scoreTotal: 10 }),
        a({ wardId: 'wa4', cycleId: 'c1', failedQuestionKeys: ['q1', 'q2'], completedAt: new Date('2026-11-20T00:00:00Z'), scoreTotal: 6 }),
        a({ wardId: 'wa4', cycleId: 'c1', status: 'submitted', failedQuestionKeys: ['q3'], completedAt: undefined }),
      ],
    });
    const w4 = rows.find((r) => r.wardId === 'wa4')!;
    // q1 and q2 failed in the latest of both cycles; the c0 task does not belong to the c1 view
    expect(w4.repeatedFailures).toBe(3);
    expect(w4.latestScore).toBe(6);
    expect(w4.baselineScore).toBe(10);
  });
});

describe('score trend across cycles', () => {
  it('averages the latest completed score per ward, per cycle, in start order up to the selected cycle', () => {
    const assessments = [
      a({ wardId: 'wa1', cycleId: 'c0', scoreTotal: 10, completedAt: new Date('2026-09-18T00:00:00Z') }),
      a({ wardId: 'wa4', cycleId: 'c0', scoreTotal: 0, completedAt: new Date('2026-09-15T00:00:00Z') }),
      a({ wardId: 'wa4', cycleId: 'c1', scoreTotal: 5, completedAt: new Date('2026-11-05T00:00:00Z') }),
      a({ wardId: 'wa4', cycleId: 'c1', scoreTotal: 13.33, completedAt: new Date('2026-11-20T00:00:00Z') }),
      a({ wardId: 'wb1', cycleId: 'c1', scoreTotal: 99, status: 'submitted' }),
      a({ wardId: 'zz', cycleId: 'c1', scoreTotal: 99 }), // ward not in scope
    ];
    expect(scoreTrend({ wards: W, cycles: CYCLES, assessments, uptoCycleId: 'c1' })).toEqual([
      { cycleCode: '2026-C0', averageScore: 5 },
      { cycleCode: '2026-C1', averageScore: 13.33 },
    ]);
    expect(scoreTrend({ wards: W, cycles: CYCLES, assessments, uptoCycleId: 'c0' })).toEqual([{ cycleCode: '2026-C0', averageScore: 5 }]);
    expect(scoreTrend({ wards: [W[2]!], cycles: CYCLES, assessments, uptoCycleId: 'c1' })).toEqual([]);
  });

  it('aggregates average score over wards with a score', () => {
    const rows = buildWardRows({
      wards: W, cycles: CYCLES, cycleId: 'c1', now: NOW, tasks: [], exceptions: [],
      assessments: [a({ wardId: 'wa1', cycleId: 'c1', scoreTotal: 10 }), a({ wardId: 'wa4', cycleId: 'c1', scoreTotal: 15 })],
    });
    expect(aggregateCounts(rows, 4)).toMatchObject({ averageScore: 12.5, dataQualityExceptions: 4 });
  });
});

describe('data-quality rules (FR-026)', () => {
  const FAC = { lat: 12.9716, lng: 77.5946 };
  const base = {
    isPhoto: true, gps: { lat: 12.9718, lng: 77.5947 }, gpsUnavailable: false, facilityLocation: FAC, clockSkewSec: 0,
    capturedAt: new Date('2026-11-20T10:00:00Z'), receivedAt: new Date('2026-11-20T10:05:00Z'),
  };
  const kinds = (e: Parameters<typeof evidenceRuleHits>[0]) => evidenceRuleHits(e).map((h) => h.kind);

  it('a clean photo raises nothing', () => {
    expect(evidenceRuleHits(base)).toEqual([]);
  });

  it('photo without GPS (documents need none)', () => {
    expect(kinds({ ...base, gps: null, gpsUnavailable: true })).toEqual(['PHOTO_NO_GPS']);
    expect(kinds({ ...base, gps: null })).toEqual(['PHOTO_NO_GPS']);
    expect(kinds({ ...base, isPhoto: false, gps: null })).toEqual([]);
  });

  it('GPS more than 1 km from the hospital location in the facility register', () => {
    const near = { lat: FAC.lat + 0.0085, lng: FAC.lng }; // ~945 m
    const far = { lat: FAC.lat + 0.0095, lng: FAC.lng }; // ~1056 m
    expect(kinds({ ...base, gps: near })).toEqual([]);
    const hit = evidenceRuleHits({ ...base, gps: far });
    expect(hit.map((h) => h.kind)).toEqual(['GPS_FAR_FROM_FACILITY']);
    expect(hit[0]!.metric!.distanceM).toBeGreaterThan(DQ_RULES.farFromFacilityM);
    expect(kinds({ ...base, gps: far, facilityLocation: undefined })).toEqual([]); // no register point: not judged
  });

  it('device clock skew over 10 minutes, either direction', () => {
    expect(kinds({ ...base, clockSkewSec: 600 })).toEqual([]);
    expect(kinds({ ...base, clockSkewSec: 601 })).toEqual(['DEVICE_CLOCK_SKEW']);
    expect(evidenceRuleHits({ ...base, clockSkewSec: -1860 })[0]).toEqual({ kind: 'DEVICE_CLOCK_SKEW', metric: { skewSec: -1860 } });
  });

  it('capture to upload over 7 days', () => {
    const at = (ms: number) => ({ ...base, receivedAt: new Date(base.capturedAt.getTime() + ms) });
    expect(kinds(at(7 * DAY))).toEqual([]);
    expect(evidenceRuleHits(at(7 * DAY + H))).toEqual([{ kind: 'LATE_UPLOAD', metric: { uploadDelayHours: 169 } }]);
  });

  it('the same photo hash in two wards (not twice in one ward, not documents)', () => {
    const items: DqItem[] = [
      { evidenceId: 'e1', sha256: 'aa', wardId: 'wa1', isPhoto: true },
      { evidenceId: 'e2', sha256: 'aa', wardId: 'wa4', isPhoto: true },
      { evidenceId: 'e3', sha256: 'aa', wardId: 'wa4', isPhoto: true },
      { evidenceId: 'e4', sha256: 'bb', wardId: 'wa4', isPhoto: true },
      { evidenceId: 'e5', sha256: 'bb', wardId: 'wa4', isPhoto: true },
      { evidenceId: 'e6', sha256: 'cc', wardId: 'wa1', isPhoto: false },
      { evidenceId: 'e7', sha256: 'cc', wardId: 'wa4', isPhoto: false },
    ];
    const g = duplicatePhotoGroups(items);
    expect([...g.keys()].sort()).toEqual(['e1', 'e2', 'e3']);
    expect(g.get('e1')).toEqual(['e2', 'e3']);
    expect(g.get('e2')).toEqual(['e1', 'e3']);
  });

  it('no baseline 3 weeks after the cycle starts', () => {
    const assessments = [a({ wardId: 'wa4', cycleId: 'c1' }), a({ wardId: 'wa1', cycleId: 'c1', status: 'submitted' }), a({ wardId: 'wb1', cycleId: 'c0' })];
    const at = (d: Date) => noBaselineExceptions({ wards: W, cycle: C1, assessments, now: d });
    expect(at(new Date(C1.startsAt.getTime() + 21 * DAY - 1))).toEqual([]);
    const list = at(NOW);
    expect(list.map((e) => e.wardId)).toEqual(['wa1', 'wb1']);
    expect(list[0]).toEqual({
      id: 'NO_BASELINE:c1:wa1', kind: 'NO_BASELINE', detectedAt: '2026-11-22T00:00:00.000Z', facilityId: 'fa', wardId: 'wa1', cycleId: 'c1',
      metric: { daysSinceStart: 22 },
    });
    // a held external result is still a baseline
    expect(noBaselineExceptions({ wards: [W[2]!], cycle: C1, assessments: [a({ wardId: 'wb1', cycleId: 'c1', releaseState: 'held' })], now: NOW })).toEqual([]);
  });

  it('devices with unsent items older than 72 hours, placed by the user scope', () => {
    const devices = [
      { deviceId: 'd-stale', userId: 'u1', pendingCount: 2, oldestPendingAt: new Date(NOW.getTime() - 73 * H) },
      { deviceId: 'd-fresh', userId: 'u1', pendingCount: 2, oldestPendingAt: new Date(NOW.getTime() - 72 * H) },
      { deviceId: 'd-empty', userId: 'u1', pendingCount: 0, oldestPendingAt: new Date(NOW.getTime() - 100 * H) },
      { deviceId: 'd-null', userId: 'u1', pendingCount: 1, oldestPendingAt: null },
      { deviceId: 'd-nobody', userId: 'ghost', pendingCount: 1, oldestPendingAt: new Date(NOW.getTime() - 100 * H) },
    ];
    const list = staleDeviceExceptions({ devices, now: NOW, locate: (u) => (u === 'u1' ? { facilityId: 'fa', wardId: 'wa4' } : undefined) });
    expect(list).toEqual([{
      id: 'STALE_DEVICE_QUEUE:d-stale:u1', kind: 'STALE_DEVICE_QUEUE', detectedAt: new Date(NOW.getTime() - H).toISOString(),
      facilityId: 'fa', wardId: 'wa4', userId: 'u1', deviceId: 'd-stale', metric: { oldestPendingHours: 73, pendingCount: 2 },
    }]);
  });

  it('lists exceptions newest first, then by id', () => {
    const l = [{ id: 'b', detectedAt: '2026-11-01T00:00:00.000Z' }, { id: 'c', detectedAt: '2026-11-02T00:00:00.000Z' }, { id: 'a', detectedAt: '2026-11-01T00:00:00.000Z' }];
    expect(sortExceptions(l).map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });

  it('ward rows count their exceptions', () => {
    const rows = buildWardRows({
      wards: W, cycles: CYCLES, cycleId: 'c1', now: NOW, tasks: [], assessments: [],
      exceptions: [{ wardId: 'wa4', facilityId: 'fa' }, { wardId: 'wa4', facilityId: 'fa' }, { facilityId: 'fa' }],
    });
    expect(rows.map((r) => r.dataQualityExceptions)).toEqual([0, 2, 0]);
  });
});
