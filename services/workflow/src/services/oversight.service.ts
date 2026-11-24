import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { Types } from 'mongoose';
import { Problem, createResilience, type Resilience } from '@ipc/platform';
import {
  aggregateCounts, buildWardRows, noBaselineExceptions, scoreTrend, sortExceptions, staleDeviceExceptions,
  type AssessmentFact, type CycleRef, type DeviceQueueFact, type DqException, type DqKind, type OversightCounts, type TaskFact,
  type WardRef, type WardRow,
} from '../domain/oversight.js';
import type { Role, Scope } from '../domain/scope.js';
import {
  AssessmentContextModel, CycleModel, FacilityModel, PlanModel, ScopeAssignmentModel, TaskModel, WardModel,
  type AssessmentContext, type Cycle, type Facility, type Plan, type ScopeAssignmentDoc, type Task, type Ward,
} from '../domain/models/index.js';
import type { ActorScope } from './admin.service.js';
import type { Page } from './paging.js';

// ------------------------------------------------------------------------------- Edge DQ client

/** Response of `edgeInternalEvidenceDQ` (contract), one page. */
interface EdgeDqPage {
  items: DqException[];
  nextCursor: string | null;
  deviceQueues?: { deviceId: string; userId: string; pendingCount: number; oldestPendingAt: string | null }[];
}

/** The Edge owns evidence and device outboxes; workflow reads their exceptions through this port. */
export interface EdgeDqPort {
  dataQuality(): Promise<{ items: DqException[]; deviceQueues: DeviceQueueFact[] }>;
}

/**
 * `GET /internal/evidence/data-quality` on the Edge private listener with a service JWT
 * (iss `ipc-workflow`, aud `ipc-edge`). Pages through every evidence exception.
 */
export class HttpEdgeDq implements EdgeDqPort {
  private readonly resilience: Resilience;
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    resilience?: Resilience,
  ) {
    this.resilience = resilience ?? createResilience('edge', { timeoutMs: 5000, retries: 2, baseDelayMs: 200, breakerThreshold: 0.5, breakerMinimumRps: 1, breakerHalfOpenAfterMs: 15_000 });
  }

  private async token(): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('ipc-workflow').setIssuer('ipc-workflow').setAudience('ipc-edge')
      .setJti(randomUUID()).setIssuedAt().setExpirationTime('60s')
      .sign(new TextEncoder().encode(this.secret));
  }

  async dataQuality() {
    const items: DqException[] = [];
    let deviceQueues: DeviceQueueFact[] = [];
    let cursor: string | null = null;
    try {
      for (let i = 0; i < 100; i++) {
        const qs = `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const token = await this.token();
        const page = await this.resilience.execute(async (signal) => {
          const res = await fetch(`${this.baseUrl}/internal/evidence/data-quality${qs}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal });
          if (!res.ok) throw new Error(`edge answered ${res.status}`);
          return (await res.json()) as EdgeDqPage;
        }, { idempotent: true });
        items.push(...page.items);
        if (i === 0) deviceQueues = (page.deviceQueues ?? []).map((d) => ({ ...d, oldestPendingAt: d.oldestPendingAt ? new Date(d.oldestPendingAt) : null }));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
    } catch (err) {
      throw new Error('edge data-quality unavailable', { cause: err });
    }
    return { items, deviceQueues };
  }
}

// ------------------------------------------------------------------------------------- service

export type OversightActor = { userId: string } & ActorScope;

export type DataQualityExceptionDto = DqException & { facilityName?: string; wardName?: string; userName?: string };
export type OversightWardRowDto = WardRow;
export interface OversightSummaryDto {
  scope: Scope; programmeAt: string; cycleId: string; totals: OversightCounts;
  byDistrict: (OversightCounts & { districtCode: string })[];
  byFacility: (OversightCounts & { facilityId: string; name: string })[];
  trend: { cycleCode: string; averageScore: number }[];
}

const oid = (s: string) => new Types.ObjectId(s);
const OUTSIDE = () => Problem.forbidden('SCOPE_DENIED', 'This item is outside your area.');

/** Offset cursor over a deterministic order. */
function pageOf<T>(items: T[], cursor: string | undefined, limit: number): Page<T> {
  let start = 0;
  if (cursor) {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!/^\d{1,9}$/.test(raw)) throw Problem.badRequest('VALIDATION_FAILED', 'cursor is not valid');
    start = Number(raw);
  }
  const page = items.slice(start, start + limit);
  return { items: page, nextCursor: start + limit < items.length ? Buffer.from(String(start + limit)).toString('base64url') : null };
}

interface Loaded {
  wards: WardRef[];
  cycles: CycleRef[];
  cycle: CycleRef;
  assessments: AssessmentFact[];
  tasks: TaskFact[];
  exceptions: DataQualityExceptionDto[];
}

/**
 * District and state oversight read models (US8; FR-025, FR-026, FR-028). Everything is limited to
 * the acting user's server-derived scope: a district quality manager only ever reads wards,
 * assessments, tasks and exceptions of their own district. Due/overdue and data-quality ages use
 * programme time (`programmeNow()`).
 */
export class OversightService {
  constructor(private readonly d: { edge: EdgeDqPort; programmeNow: () => Date }) {}

  // ------------------------------------------------------------------------------------ scope

  /** Ward ids the actor may oversee; `all` for the state level. */
  private async visibleWards(a: OversightActor): Promise<{ all: true } | { wardIds: Set<string> }> {
    const mine = a.assignments.filter((x) => x.role === a.role);
    if (mine.some((x) => x.scope.level === 'state')) return { all: true };
    const facilityIds = new Set<string>();
    const wardIds = new Set<string>();
    for (const { scope } of mine) {
      if (scope.level === 'district' && scope.districtCode) {
        (await FacilityModel.find({ districtCode: scope.districtCode }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>()).forEach((f) => facilityIds.add(String(f._id)));
      } else if (scope.level === 'facility') {
        if (scope.facilityId) facilityIds.add(scope.facilityId);
        scope.facilityIds?.forEach((f) => facilityIds.add(f));
      } else if (scope.level === 'wards') {
        scope.wardIds?.forEach((w) => wardIds.add(w));
      }
    }
    if (facilityIds.size) {
      (await WardModel.find({ facilityId: { $in: [...facilityIds].map(oid) } }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>()).forEach((w) => wardIds.add(String(w._id)));
    }
    return { wardIds };
  }

  /** Register rows in scope, ordered by district, hospital and ward name. */
  private async wardRefs(a: OversightActor, q: { districtCode?: string; facilityId?: string }): Promise<WardRef[]> {
    const vis = await this.visibleWards(a);
    const wards = await WardModel.find({ active: { $ne: false }, ...('all' in vis ? {} : { _id: { $in: [...vis.wardIds].map(oid) } }) }).lean<Ward[]>();
    const facilities = new Map(
      (await FacilityModel.find({ _id: { $in: [...new Set(wards.map((w) => String(w.facilityId)))].map(oid) } }).lean<Facility[]>()).map((f) => [String(f._id), f]),
    );
    const refs = wards.flatMap((w) => {
      const f = facilities.get(String(w.facilityId));
      return f ? [{ wardId: String(w._id), wardName: w.name, wardType: w.wardType, facilityId: String(f._id), facilityName: f.name, districtCode: f.districtCode }] : [];
    });
    // Filters outside the viewer's scope are refused, not silently emptied (FR-028).
    if (q.districtCode && !refs.some((r) => r.districtCode === q.districtCode)) {
      if (!('all' in vis)) throw OUTSIDE();
    }
    if (q.facilityId && !refs.some((r) => r.facilityId === q.facilityId)) {
      if (!('all' in vis) || !/^[a-f0-9]{24}$/.test(q.facilityId) || !(await FacilityModel.exists({ _id: oid(q.facilityId) }))) throw OUTSIDE();
    }
    return refs
      .filter((r) => (!q.districtCode || r.districtCode === q.districtCode) && (!q.facilityId || r.facilityId === q.facilityId))
      .sort((x, y) => x.districtCode.localeCompare(y.districtCode) || x.facilityName.localeCompare(y.facilityName) || x.wardName.localeCompare(y.wardName) || x.wardId.localeCompare(y.wardId));
  }

  // ------------------------------------------------------------------------------------- data

  private async cycles(cycleId?: string): Promise<{ cycles: CycleRef[]; cycle: CycleRef }> {
    const docs = await CycleModel.find().sort({ startsAt: 1 }).lean<Cycle[]>();
    const cycles = docs.map((c) => ({ id: String(c._id), code: c.code, startsAt: c.startsAt }));
    let cycle: CycleRef | undefined;
    if (cycleId) {
      cycle = cycles.find((c) => c.id === cycleId);
      if (!cycle) throw Problem.badRequest('VALIDATION_FAILED', 'cycleId is not a programme cycle');
    } else {
      const active = docs.filter((c) => c.status === 'active').at(-1) ?? docs.filter((c) => c.status !== 'planned').at(-1) ?? docs.at(-1);
      cycle = active ? cycles.find((c) => c.id === String(active._id)) : undefined;
      if (!cycle) throw Problem.notFound('No programme cycle yet');
    }
    return { cycles, cycle };
  }

  private async load(a: OversightActor, q: { cycleId?: string; districtCode?: string; facilityId?: string }): Promise<Loaded> {
    const wards = await this.wardRefs(a, q);
    const { cycles, cycle } = await this.cycles(q.cycleId);
    const wardOids = wards.map((w) => oid(w.wardId));
    const assessments = (await AssessmentContextModel.find({ wardId: { $in: wardOids } }).lean<AssessmentContext[]>()).map((x) => ({
      wardId: String(x.wardId), cycleId: String(x.cycleId), status: x.status, releaseState: x.releaseState, isBaselineForCycle: !!x.isBaselineForCycle,
      ...(x.completedAt ? { completedAt: x.completedAt } : {}),
      ...(typeof x.scores?.total === 'number' ? { scoreTotal: x.scores.total } : {}),
      failedQuestionKeys: x.failedQuestionKeys ?? [],
    }));
    const plans = await PlanModel.find({ wardId: { $in: wardOids }, status: { $ne: 'draft' } }, { wardId: 1, cycleId: 1 }).lean<Pick<Plan, '_id' | 'wardId' | 'cycleId'>[]>();
    const planOf = new Map(plans.map((p) => [String(p._id), p]));
    const tasks = (await TaskModel.find({ planId: { $in: plans.map((p) => p._id) } }, { planId: 1, riskLevel: 1, state: 1, dueAt: 1, rejectionCount: 1 }).lean<Task[]>())
      .map((t) => {
        const p = planOf.get(String(t.planId))!;
        return { wardId: String(p.wardId), cycleId: String(p.cycleId), riskLevel: t.riskLevel, state: t.state, dueAt: t.dueAt, rejectionCount: t.rejectionCount ?? 0 };
      });
    const exceptions = await this.exceptions(wards, cycle, assessments, a);
    return { wards, cycles, cycle, assessments, tasks, exceptions };
  }

  /** Edge evidence exceptions + no baseline + stale devices, limited to the given wards, with display names. */
  private async exceptions(wards: WardRef[], cycle: CycleRef, assessments: AssessmentFact[], a: OversightActor): Promise<DataQualityExceptionDto[]> {
    const now = this.d.programmeNow();
    const edge = await this.d.edge.dataQuality().catch((err: unknown) => {
      if (err instanceof Problem) throw err;
      const p = Problem.unavailable('STORAGE_UNAVAILABLE', 'Evidence data-quality checks are unavailable, try again shortly');
      p.cause = err;
      throw p;
    });
    const wardIds = new Set(wards.map((w) => w.wardId));
    const facilityIds = new Set(wards.map((w) => w.facilityId));
    const wardLimited = a.assignments.filter((x) => x.role === a.role).every((x) => x.scope.level === 'wards' || x.scope.level === 'own_tasks');

    const deviceUsers = [...new Set(edge.deviceQueues.map((d) => d.userId))];
    const places = await this.placeUsers(deviceUsers);
    const own = [
      ...noBaselineExceptions({ wards, cycle, assessments, now }),
      ...staleDeviceExceptions({ devices: edge.deviceQueues, now, locate: (u) => places.get(u) }),
    ];
    const inScope = [...edge.items, ...own].filter((e) => (e.wardId ? wardIds.has(e.wardId) : !wardLimited && facilityIds.has(e.facilityId)));

    const names = await this.userNames([...new Set(inScope.map((e) => e.userId).filter((u): u is string => !!u))]);
    const wardById = new Map(wards.map((w) => [w.wardId, w]));
    const facilityName = new Map(wards.map((w) => [w.facilityId, w.facilityName]));
    return sortExceptions(inScope.map((e) => {
      const w = e.wardId ? wardById.get(e.wardId) : undefined;
      const fn = facilityName.get(e.facilityId);
      const un = e.userId ? names.get(e.userId) : undefined;
      return { ...e, ...(fn ? { facilityName: fn } : {}), ...(w ? { wardName: w.wardName } : {}), ...(un ? { userName: un } : {}) };
    }));
  }

  /** Facility (and single ward) of each device user, from their scope assignments. */
  private async placeUsers(userIds: string[]): Promise<Map<string, { facilityId: string; wardId?: string }>> {
    const out = new Map<string, { facilityId: string; wardId?: string }>();
    if (!userIds.length) return out;
    const docs = await ScopeAssignmentModel.find({ userId: { $in: userIds } }).sort({ validFrom: -1 }).lean<ScopeAssignmentDoc[]>();
    const wardIds = docs.flatMap((d) => d.scope.wardIds ?? []);
    const wardFacility = new Map((await WardModel.find({ _id: { $in: wardIds.map(oid) } }, { facilityId: 1 }).lean<Pick<Ward, '_id' | 'facilityId'>[]>()).map((w) => [String(w._id), String(w.facilityId)]));
    for (const d of docs) {
      if (out.has(d.userId)) continue;
      const ws = d.scope.wardIds ?? [];
      const facilityId = d.scope.facilityId ?? d.scope.facilityIds?.[0] ?? (ws[0] ? wardFacility.get(ws[0]) : undefined);
      if (facilityId) out.set(d.userId, { facilityId, ...(ws.length === 1 ? { wardId: ws[0]! } : {}) });
    }
    return out;
  }

  private async userNames(userIds: string[]): Promise<Map<string, string>> {
    if (!userIds.length) return new Map();
    const docs = await ScopeAssignmentModel.find({ userId: { $in: userIds }, userName: { $exists: true, $ne: '' } }, { userId: 1, userName: 1 }).lean<ScopeAssignmentDoc[]>();
    return new Map(docs.map((d) => [d.userId, d.userName!]));
  }

  private viewScope(a: OversightActor, districtCode?: string): Scope {
    if (districtCode) return { level: 'district', districtCode };
    const s = a.assignments.find((x) => x.role === a.role)?.scope;
    if (!s) return { level: 'own_tasks' };
    return {
      level: s.level,
      ...(s.districtCode ? { districtCode: s.districtCode } : {}),
      ...(s.facilityId ? { facilityId: s.facilityId } : {}),
      ...(s.facilityIds?.length ? { facilityIds: [...s.facilityIds] } : {}),
      ...(s.wardIds?.length ? { wardIds: [...s.wardIds] } : {}),
    };
  }

  // ------------------------------------------------------------------------------------ reads

  /** `getOversightSummary`. */
  async summary(a: OversightActor, q: { cycleId?: string; districtCode?: string }): Promise<OversightSummaryDto> {
    const l = await this.load(a, q);
    const rows = buildWardRows({ ...l, cycleId: l.cycle.id, now: this.d.programmeNow() });
    const group = <K extends string>(key: (r: WardRow) => K) => {
      const m = new Map<K, WardRow[]>();
      rows.forEach((r) => m.set(key(r), [...(m.get(key(r)) ?? []), r]));
      return m;
    };
    const exIn = (pred: (facilityId: string) => boolean) => l.exceptions.filter((e) => pred(e.facilityId)).length;
    const facilityDistrict = new Map(l.wards.map((w) => [w.facilityId, w.districtCode]));
    return {
      scope: this.viewScope(a, q.districtCode),
      programmeAt: this.d.programmeNow().toISOString(),
      cycleId: l.cycle.id,
      totals: aggregateCounts(rows, l.exceptions.length),
      byDistrict: [...group((r) => r.districtCode)].map(([districtCode, rs]) => ({
        districtCode, ...aggregateCounts(rs, exIn((f) => facilityDistrict.get(f) === districtCode)),
      })),
      byFacility: [...group((r) => r.facilityId)].map(([facilityId, rs]) => ({
        facilityId, name: rs[0]!.facilityName, ...aggregateCounts(rs, exIn((f) => f === facilityId)),
      })),
      trend: scoreTrend({ wards: l.wards, cycles: l.cycles, assessments: l.assessments, uptoCycleId: l.cycle.id }),
    };
  }

  /** `listOversightWards`. */
  async wards(a: OversightActor, q: { cycleId?: string; districtCode?: string; facilityId?: string; cursor?: string; limit: number }): Promise<Page<OversightWardRowDto>> {
    const l = await this.load(a, q);
    return pageOf(buildWardRows({ ...l, cycleId: l.cycle.id, now: this.d.programmeNow() }), q.cursor, q.limit);
  }

  /** `listDataQualityExceptions`. */
  async dataQuality(a: OversightActor, q: { kind?: DqKind; wardId?: string; facilityId?: string; cursor?: string; limit: number }): Promise<Page<DataQualityExceptionDto>> {
    const wards = await this.wardRefs(a, { facilityId: q.facilityId });
    if (q.wardId && !wards.some((w) => w.wardId === q.wardId)) throw OUTSIDE();
    const { cycle } = await this.cycles();
    const assessments = (await AssessmentContextModel.find({ wardId: { $in: wards.map((w) => oid(w.wardId)) }, cycleId: oid(cycle.id) }).lean<AssessmentContext[]>()).map((x) => ({
      wardId: String(x.wardId), cycleId: String(x.cycleId), status: x.status, releaseState: x.releaseState, isBaselineForCycle: !!x.isBaselineForCycle, failedQuestionKeys: [],
    }));
    const all = await this.exceptions(wards, cycle, assessments, a);
    return pageOf(all.filter((e) => (!q.kind || e.kind === q.kind) && (!q.wardId || e.wardId === q.wardId)), q.cursor, q.limit);
  }
}

export const OVERSIGHT_ROLES: Role[] = ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER'];
export const DATA_QUALITY_ROLES: Role[] = ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR'];
