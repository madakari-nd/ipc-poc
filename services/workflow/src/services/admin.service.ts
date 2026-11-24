import type { ClientSession, Types } from 'mongoose';
import { Problem } from '@ipc/platform';
import { contentHash } from '../domain/canonical.js';
import type { LedgerActor } from '../domain/ledger-chain.js';
import {
  CycleModel,
  EscalationRuleModel,
  FacilityModel,
  ProgrammeModel,
  RiskDefaultModel,
  ScopeAssignmentModel,
  TaskModel,
  WardModel,
  type Cycle,
  type EscalationRule,
  type Facility,
  type Programme,
  type RiskDefault,
  type RiskLevel,
  type ScopeAssignmentDoc,
  type Ward,
} from '../domain/models/index.js';
import { isAssignmentActive, validateScopeAssignment, type Role, type Scope } from '../domain/scope.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { withTx } from '../repositories/tx.js';
import type { CatalogueService } from './catalogue.service.js';
import type { ElevateAdminPort } from './elevate-admin.gateway.js';
import { decodeCursor, encodeCursor, type Page } from './paging.js';
import { toScopeAssignmentDto, type ScopeAssignmentDto, type ScopeService } from './scope.service.js';
import type { RetentionService } from './retention.service.js';

const iso = (d?: Date | null) => (d ? d.toISOString() : undefined);
const meta = (d: { _id: Types.ObjectId; v: number; createdAt: Date; updatedAt: Date }) => ({
  id: String(d._id), v: d.v, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
});

export const OPEN_TASK_STATES = ['ASSIGNED', 'IN_PROGRESS', 'EVIDENCE_SUBMITTED', 'CHANGES_REQUESTED', 'VERIFIED', 'PENDING_VALIDATION'] as const;

// ---------------------------------------------------------------- DTOs (contract shapes)
export const toProgrammeDto = (p: Programme, demoMode: boolean) => ({
  ...meta(p), code: p.code, name: p.name, stateEntityId: p.stateEntityId, elevateOrgId: p.elevateOrgId,
  profile: p.profile, languages: [...p.languages], demoMode,
});
export const toWardDto = (w: Ward) => ({
  ...meta(w), facilityId: String(w.facilityId), wardCode: w.wardCode, elevateEntityId: w.elevateEntityId, name: w.name,
  wardType: w.wardType, active: w.active, ...(w.serviceAccountUserId ? { serviceAccountUserId: w.serviceAccountUserId } : {}),
});
export const toFacilityDto = (f: Facility, wards: Ward[]) => ({
  ...meta(f), facilityCode: f.facilityCode, elevateEntityId: f.elevateEntityId, name: f.name, districtCode: f.districtCode,
  level: f.level, ...(f.location ? { location: { lat: f.location.lat, lng: f.location.lng } } : {}), status: f.status,
  wards: wards.map(toWardDto),
});
export const toCycleDto = (c: Cycle) => ({
  ...meta(c), code: c.code, startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString(),
  targetDates: {
    ...(c.targetDates?.baselineBy ? { baselineBy: iso(c.targetDates.baselineBy) } : {}),
    ...(c.targetDates?.repeatBy ? { repeatBy: iso(c.targetDates.repeatBy) } : {}),
  },
  elevateSolutionIds: {
    ...(c.elevateSolutionIds?.plan ? { plan: c.elevateSolutionIds.plan } : {}),
    ...(c.elevateSolutionIds?.observation ? { observation: c.elevateSolutionIds.observation } : {}),
  },
  status: c.status,
});
export const toRiskDefaultDto = (r: RiskDefault) => ({
  ...meta(r), riskLevel: r.riskLevel, dueDays: r.dueDays,
  evidenceRule: { photoRequired: r.evidenceRule.photoRequired, minPhotos: r.evidenceRule.minPhotos }, secondValidation: r.secondValidation,
});
export const toEscalationRuleDto = (r: EscalationRule) => ({
  ...meta(r), code: r.code,
  condition: {
    type: r.condition.type, riskLevels: [...(r.condition.riskLevels ?? [])],
    ...(r.condition.thresholdHours ? { thresholdHours: r.condition.thresholdHours } : {}),
    ...(r.condition.thresholdCount ? { thresholdCount: r.condition.thresholdCount } : {}),
  },
  target: { mode: r.target.mode, ...(r.target.role ? { role: r.target.role } : {}) },
  channels: [...r.channels], active: r.active,
});

export interface ActorScope {
  role: Role;
  /** Active assignments of the actor (from ScopeService.effective). */
  assignments: { role: Role; scope: Scope }[];
  mentorFacilityIds?: string[];
}

/** Facility ids the actor may see; `null` = every facility (state level). */
export async function visibleFacilityIds(a: ActorScope): Promise<{ all: true } | { facilityIds: Set<string>; wardIds?: Set<string> }> {
  const mine = a.assignments.filter((x) => x.role === a.role);
  if (a.role === 'STATE_ADMIN' && mine.some((x) => x.scope.level === 'state')) return { all: true };
  const facilityIds = new Set<string>();
  let wardIds: Set<string> | undefined;
  for (const { scope } of mine) {
    if (scope.level === 'district' && scope.districtCode) {
      const fs = await FacilityModel.find({ districtCode: scope.districtCode }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>();
      fs.forEach((f) => facilityIds.add(String(f._id)));
    }
    if (scope.facilityId) facilityIds.add(scope.facilityId);
    scope.facilityIds?.forEach((f) => facilityIds.add(f));
    if (scope.level === 'wards' && scope.wardIds) {
      wardIds ??= new Set();
      scope.wardIds.forEach((w) => wardIds!.add(w));
    }
  }
  if (a.role === 'MENTOR') a.mentorFacilityIds?.forEach((f) => facilityIds.add(f));
  return { facilityIds, ...(wardIds ? { wardIds } : {}) };
}

export interface FacilityRow {
  facilityCode: string; elevateEntityId: string; name: string; districtCode: string;
  level: Facility['level']; location?: { lat: number; lng: number }; status: Facility['status'];
  wards: { wardCode: string; elevateEntityId: string; name: string; wardType: string; active: boolean }[];
}

export interface StaffRow {
  userId: string;
  name: string;
  role: Role;
  status: 'active' | 'left';
  scope: { level: Scope['level']; districtCode?: string; facilityCode?: string; facilityCodes?: string[]; wardCodes?: string[] };
  validFrom?: Date;
}

/**
 * Programme setup (US1, T072): programme, cycles, scope assignments, risk defaults, escalation
 * rules, the register written by the facility/HR importers, and the people picker. Every change
 * writes the ledger in the same transaction (Constitution IV).
 */
export class AdminService {
  constructor(
    private readonly d: {
      ledger: LedgerService;
      scope: ScopeService;
      catalogue: CatalogueService;
      elevate: ElevateAdminPort;
      profile: string;
      demoMode: () => boolean;
      /** Real time for scope validity (access control never follows the demo clock). */
      now?: () => Date;
      checklistCode?: string;
      /** T128 retention policy get/set/scan. */
      retention?: RetentionService;
    },
  ) {}

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  private conflict(current: unknown, v: number) {
    return Problem.conflict('VERSION_CONFLICT', 'Someone changed this item since you opened it', { currentVersion: v, current });
  }

  private requireIfMatch(ifMatch: number | undefined): number {
    if (ifMatch === undefined) throw Problem.badRequest('IF_MATCH_REQUIRED', 'If-Match header is required');
    return ifMatch;
  }

  // ---------------------------------------------------------------- programme
  async getProgramme() {
    const p = await ProgrammeModel.findOne({ profile: this.d.profile }).lean<Programme>();
    if (!p) throw Problem.notFound('The programme is not set up yet (run the seed)');
    return toProgrammeDto(p, this.d.demoMode());
  }

  async updateProgramme(patch: { name?: string; languages?: string[] }, ifMatch: number | undefined, actor: LedgerActor) {
    const v = this.requireIfMatch(ifMatch);
    const p = await ProgrammeModel.findOne({ profile: this.d.profile }).lean<Programme>();
    if (!p) throw Problem.notFound('The programme is not set up yet (run the seed)');
    if (p.v !== v) throw this.conflict(toProgrammeDto(p, this.d.demoMode()), p.v);
    return withTx(async (session) => {
      const u = await ProgrammeModel.findOneAndUpdate({ _id: p._id, v }, { $set: patch, $inc: { v: 1 } }, { new: true, session, lean: true });
      if (!u) throw this.conflict(toProgrammeDto(p, this.d.demoMode()), p.v);
      const dto = toProgrammeDto(u as Programme, this.d.demoMode());
      await this.d.ledger.append({
        actor, action: 'programme.changed', subject: { type: 'programme', id: dto.id },
        beforeHash: contentHash(toProgrammeDto(p, this.d.demoMode())), afterHash: contentHash(dto),
      }, session);
      return dto;
    });
  }

  // ---------------------------------------------------------------- facilities (register)
  async listFacilities(a: ActorScope, q: { districtCode?: string; status?: string; cursor?: string; limit: number }): Promise<Page<ReturnType<typeof toFacilityDto>>> {
    const vis = await visibleFacilityIds(a);
    const filter: Record<string, unknown> = {};
    if (q.districtCode) filter.districtCode = q.districtCode;
    if (q.status) filter.status = q.status;
    const after = decodeCursor(q.cursor);
    const idFilter: Record<string, unknown> = {};
    if (after) idFilter.$gt = after;
    if (!('all' in vis)) idFilter.$in = [...vis.facilityIds];
    if (Object.keys(idFilter).length) filter._id = idFilter;
    const docs = await FacilityModel.find(filter).sort({ _id: 1 }).limit(q.limit + 1).lean<Facility[]>();
    const page = docs.slice(0, q.limit);
    const wards = await WardModel.find({ facilityId: { $in: page.map((f) => f._id) } }).sort({ wardCode: 1 }).lean<Ward[]>();
    const wardFilter = 'wardIds' in vis && vis.wardIds && !vis.facilityIds.size ? vis.wardIds : undefined;
    const items = page.map((f) => toFacilityDto(f, wards.filter((w) => String(w.facilityId) === String(f._id) && (!wardFilter || wardFilter.has(String(w._id))))));
    return { items, nextCursor: docs.length > q.limit ? encodeCursor(page[page.length - 1]!._id) : null };
  }

  /** Facility import (T069): upsert by facility code, wards by (facility, ward code). */
  async upsertFacility(row: FacilityRow, actor: LedgerActor, reason: string) {
    return withTx(async (session) => {
      const before = await FacilityModel.findOne({ facilityCode: row.facilityCode }, null, { session }).lean<Facility>();
      const fields = {
        elevateEntityId: row.elevateEntityId, name: row.name, districtCode: row.districtCode, level: row.level,
        ...(row.location ? { location: row.location } : {}), status: row.status,
      };
      let facility: Facility;
      let created = false;
      let changed = false;
      if (!before) {
        const [doc] = await FacilityModel.create([{ facilityCode: row.facilityCode, ...fields }], { session });
        facility = doc!.toObject() as Facility;
        created = true;
        changed = true;
      } else {
        const same = contentHash(pick(before, Object.keys(fields))) === contentHash(fields);
        facility = same ? before : ((await FacilityModel.findOneAndUpdate({ _id: before._id }, { $set: fields, $inc: { v: 1 } }, { new: true, session, lean: true })) as Facility);
        changed = !same;
      }
      if (changed) {
        await this.d.ledger.append({
          actor, action: created ? 'facility.created' : 'facility.changed', subject: { type: 'facility', id: String(facility._id) }, reason,
          ...(before ? { beforeHash: contentHash(pick(before, Object.keys(fields))) } : {}), afterHash: contentHash(fields),
        }, session);
      }
      const wards: { wardCode: string; wardId: string; created: boolean; changed: boolean }[] = [];
      for (const w of row.wards) {
        const prev = await WardModel.findOne({ facilityId: facility._id, wardCode: w.wardCode }, null, { session }).lean<Ward>();
        const wf = { elevateEntityId: w.elevateEntityId, name: w.name, wardType: w.wardType, active: w.active };
        if (!prev) {
          const [doc] = await WardModel.create([{ facilityId: facility._id, wardCode: w.wardCode, ...wf }], { session });
          await this.d.ledger.append({ actor, action: 'ward.created', subject: { type: 'ward', id: String(doc!._id) }, reason, afterHash: contentHash(wf) }, session);
          wards.push({ wardCode: w.wardCode, wardId: String(doc!._id), created: true, changed: true });
        } else {
          const same = contentHash(pick(prev, Object.keys(wf))) === contentHash(wf);
          if (!same) {
            await WardModel.updateOne({ _id: prev._id }, { $set: wf, $inc: { v: 1 } }, { session });
            await this.d.ledger.append({
              actor, action: 'ward.changed', subject: { type: 'ward', id: String(prev._id) }, reason,
              beforeHash: contentHash(pick(prev, Object.keys(wf))), afterHash: contentHash(wf),
            }, session);
          }
          wards.push({ wardCode: w.wardCode, wardId: String(prev._id), created: false, changed: !same });
        }
      }
      return { facilityId: String(facility._id), created, changed, wards };
    });
  }

  // ---------------------------------------------------------------- cycles
  async listCycles(q: { status?: string; cursor?: string; limit: number }): Promise<Page<ReturnType<typeof toCycleDto>>> {
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    const after = decodeCursor(q.cursor);
    if (after) filter._id = { $lt: after };
    const docs = await CycleModel.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean<Cycle[]>();
    const page = docs.slice(0, q.limit);
    return { items: page.map(toCycleDto), nextCursor: docs.length > q.limit ? encodeCursor(page[page.length - 1]!._id) : null };
  }

  private checkCycleDates(c: { startsAt: Date; endsAt: Date; baselineBy?: Date; repeatBy?: Date }) {
    const errors: { path: string; message: string }[] = [];
    if (c.endsAt <= c.startsAt) errors.push({ path: 'endsAt', message: 'must be after startsAt' });
    if (c.baselineBy && (c.baselineBy < c.startsAt || c.baselineBy > c.endsAt)) errors.push({ path: 'targetDates.baselineBy', message: 'must be inside the cycle' });
    if (c.repeatBy && (c.repeatBy < c.startsAt || c.repeatBy > c.endsAt)) errors.push({ path: 'targetDates.repeatBy', message: 'must be inside the cycle' });
    if (c.repeatBy && c.baselineBy && c.repeatBy <= c.baselineBy) errors.push({ path: 'targetDates.repeatBy', message: 'must be after baselineBy' });
    if (errors.length) throw Problem.unprocessable('VALIDATION_FAILED', 'Cycle dates are not consistent', { errors });
  }

  /**
   * New cycle with its OWN ELEVATE plan solution (FR-018a: one plan per user per solution) and its
   * own observation solution copied from the current checklist (E6: one observation per assessor
   * per solution).
   */
  async createCycle(input: { code: string; startsAt: Date; endsAt: Date; targetDates: { baselineBy: Date; repeatBy?: Date } }, actor: LedgerActor) {
    this.checkCycleDates({ startsAt: input.startsAt, endsAt: input.endsAt, ...input.targetDates });
    if (await CycleModel.exists({ code: input.code })) throw Problem.conflict('VERSION_CONFLICT', `Cycle ${input.code} already exists`);
    const plan = await this.d.elevate.createCyclePlanSolution({ cycleCode: input.code });
    const notes = [`plan solution ${plan.solutionId}${plan.templateCopied ? ' with plan template' : ' (plan template not copied: IPC_PLAN_TEMPLATE_EXTERNAL_ID unset)'}`];
    let observation: string | undefined;
    const current = await this.d.catalogue.current(this.d.checklistCode ?? 'IPC-WARD');
    if (current?.elevateSolutionId) {
      const copy = await this.d.elevate.copyChecklistSolution({
        sourceSolutionId: current.elevateSolutionId,
        externalId: `${current.checklistCode}-${input.code}-${Date.now()}`,
        name: `${current.checklistCode} v${current.version} ${input.code}`,
      });
      observation = copy._id;
      notes.push(`observation solution ${copy.externalId} from v${current.version}`);
    } else {
      notes.push('no published checklist yet: observation solution not created');
    }
    try {
      return await withTx(async (session) => {
        const [doc] = await CycleModel.create([{
          code: input.code, startsAt: input.startsAt, endsAt: input.endsAt, targetDates: input.targetDates,
          elevateSolutionIds: { plan: plan.solutionId, ...(observation ? { observation } : {}) }, status: 'planned',
        }], { session });
        const dto = toCycleDto(doc!.toObject() as Cycle);
        await this.d.ledger.append({ actor, action: 'cycle.created', subject: { type: 'cycle', id: dto.id }, reason: notes.join('; ').slice(0, 500), afterHash: contentHash(dto) }, session);
        return dto;
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw Problem.conflict('VERSION_CONFLICT', `Cycle ${input.code} already exists`);
      throw err;
    }
  }

  async updateCycle(id: string, patch: { startsAt?: Date; endsAt?: Date; targetDates?: { baselineBy?: Date; repeatBy?: Date }; status?: Cycle['status'] }, ifMatch: number | undefined, actor: LedgerActor) {
    const v = this.requireIfMatch(ifMatch);
    const c = await this.findById<Cycle>(CycleModel, id);
    if (c.v !== v) throw this.conflict(toCycleDto(c), c.v);
    const next = {
      startsAt: patch.startsAt ?? c.startsAt, endsAt: patch.endsAt ?? c.endsAt,
      targetDates: { ...c.targetDates, ...patch.targetDates } as { baselineBy?: Date; repeatBy?: Date },
    };
    this.checkCycleDates({ ...next, ...next.targetDates });
    if (patch.status && c.status === 'closed' && patch.status !== 'closed') throw Problem.unprocessable('INVALID_TRANSITION', 'A closed cycle cannot be reopened');
    return withTx(async (session) => {
      const u = await CycleModel.findOneAndUpdate({ _id: c._id, v }, { $set: { ...next, ...(patch.status ? { status: patch.status } : {}) }, $inc: { v: 1 } }, { new: true, session, lean: true });
      if (!u) throw this.conflict(toCycleDto(c), c.v);
      const dto = toCycleDto(u as Cycle);
      await this.d.ledger.append({ actor, action: 'cycle.changed', subject: { type: 'cycle', id }, beforeHash: contentHash(toCycleDto(c)), afterHash: contentHash(dto) }, session);
      return dto;
    });
  }

  private async findById<T>(model: { findById(id: string): { lean<R>(): Promise<R | null> } }, id: string): Promise<T> {
    if (!/^[a-f0-9]{24}$/.test(id)) throw Problem.notFound();
    const doc = await model.findById(id).lean<T>();
    if (!doc) throw Problem.notFound();
    return doc;
  }

  // ---------------------------------------------------------------- scope assignments
  async listScopeAssignments(q: { userId?: string; role?: string; activeOn?: Date; cursor?: string; limit: number }): Promise<Page<ScopeAssignmentDto>> {
    const filter: Record<string, unknown> = {};
    if (q.userId) filter.userId = q.userId;
    if (q.role) filter.role = q.role;
    if (q.activeOn) {
      filter.validFrom = { $lte: q.activeOn };
      filter.$or = [{ validTo: null }, { validTo: { $gt: q.activeOn } }];
    }
    const after = decodeCursor(q.cursor);
    if (after) filter._id = { $gt: after };
    const docs = await ScopeAssignmentModel.find(filter).sort({ _id: 1 }).limit(q.limit + 1).lean<ScopeAssignmentDoc[]>();
    const page = docs.slice(0, q.limit);
    return { items: page.map(toScopeAssignmentDto), nextCursor: docs.length > q.limit ? encodeCursor(page[page.length - 1]!._id) : null };
  }

  private async assertScopeRefs(scope: Scope) {
    const fids = [...(scope.facilityId ? [scope.facilityId] : []), ...(scope.facilityIds ?? [])];
    if (fids.length && (await FacilityModel.countDocuments({ _id: { $in: fids } })) !== new Set(fids).size) {
      throw Problem.unprocessable('VALIDATION_FAILED', 'Unknown facility in scope', { errors: [{ path: 'scope.facilityId', message: 'is not a facility' }] });
    }
    if (scope.wardIds?.length) {
      const n = await WardModel.countDocuments({ _id: { $in: scope.wardIds }, ...(scope.facilityId ? { facilityId: scope.facilityId } : {}) });
      if (n !== scope.wardIds.length) throw Problem.unprocessable('VALIDATION_FAILED', 'Unknown ward in scope', { errors: [{ path: 'scope.wardIds', message: 'must be wards of the facility' }] });
    }
  }

  private async insertAssignment(
    a: { userId: string; role: Role; scope: Scope; validFrom: Date; validTo?: Date | null; source: 'hr_import' | 'admin'; userName?: string },
    actor: LedgerActor, reason: string | undefined, session: ClientSession,
  ): Promise<ScopeAssignmentDto> {
    const valid = validateScopeAssignment(a);
    const [doc] = await ScopeAssignmentModel.create([{
      userId: valid.userId, role: valid.role, scope: valid.scope, validFrom: valid.validFrom, validTo: valid.validTo ?? null, source: a.source,
      ...(a.userName ? { userName: a.userName } : {}),
    }], { session });
    const dto = toScopeAssignmentDto(doc!.toObject() as ScopeAssignmentDoc);
    await this.d.ledger.append({ actor, action: 'scope.changed', subject: { type: 'scope_assignment', id: dto.id }, reason, afterHash: contentHash(dto) }, session);
    return dto;
  }

  async createScopeAssignment(input: { userId: string; role: Role; scope: Scope; validFrom: Date; validTo?: Date; reason?: string }, actor: LedgerActor) {
    validateScopeAssignment(input);
    await this.assertScopeRefs(input.scope);
    const userName = (await ScopeAssignmentModel.findOne({ userId: input.userId, userName: { $exists: true } }, { userName: 1 }).lean<{ userName?: string }>())?.userName;
    return withTx((s) => this.insertAssignment({ ...input, source: 'admin', ...(userName ? { userName } : {}) }, actor, input.reason, s));
  }

  async updateScopeAssignment(id: string, patch: { scope?: Scope; validTo?: Date; reason: string }, ifMatch: number | undefined, actor: LedgerActor) {
    const v = this.requireIfMatch(ifMatch);
    const a = await this.findById<ScopeAssignmentDoc>(ScopeAssignmentModel, id);
    if (a.v !== v) throw this.conflict(toScopeAssignmentDto(a), a.v);
    const next = validateScopeAssignment({ userId: a.userId, role: a.role, scope: patch.scope ?? a.scope, validFrom: a.validFrom, validTo: patch.validTo ?? a.validTo ?? null });
    if (patch.scope) await this.assertScopeRefs(next.scope);
    return withTx(async (session) => {
      const u = await ScopeAssignmentModel.findOneAndUpdate(
        { _id: a._id, v }, { $set: { scope: next.scope, validTo: next.validTo ?? null }, $inc: { v: 1 } }, { new: true, session, lean: true },
      );
      if (!u) throw this.conflict(toScopeAssignmentDto(a), a.v);
      const dto = toScopeAssignmentDto(u as ScopeAssignmentDoc);
      await this.d.ledger.append({
        actor, action: 'scope.changed', subject: { type: 'scope_assignment', id }, reason: patch.reason,
        beforeHash: contentHash(toScopeAssignmentDto(a)), afterHash: contentHash(dto),
      }, session);
      return dto;
    });
  }

  /**
   * HR import (T070): one staff row. Active staff get the assignment for their role and place
   * (an unchanged assignment is left alone; a changed one is ended and replaced, history kept).
   * Leavers: every active assignment ends now, and their open tasks are counted as needing
   * reassignment (the owner no longer has a valid scope; see tasksNeedingReassignment()).
   */
  async applyStaff(row: StaffRow, actor: LedgerActor, reason: string) {
    const now = this.now();
    const active = (await ScopeAssignmentModel.find({ userId: row.userId }).lean<ScopeAssignmentDoc[]>()).filter((a) => isAssignmentActive(a, now));
    if (row.status === 'left') {
      const openTasks = await TaskModel.find({ ownerUserId: row.userId, state: { $in: [...OPEN_TASK_STATES] } }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>();
      if (!active.length && !openTasks.length) return { outcome: 'unchanged' as const, assignmentIds: [], tasksNeedingReassignment: 0 };
      await withTx(async (session) => {
        for (const a of active) {
          await ScopeAssignmentModel.updateOne({ _id: a._id }, { $set: { validTo: now }, $inc: { v: 1 } }, { session });
          await this.d.ledger.append({
            actor, action: 'scope.changed', subject: { type: 'scope_assignment', id: String(a._id) }, reason: `${reason}: left, scope ended`,
            beforeHash: contentHash(toScopeAssignmentDto(a)), afterHash: contentHash(toScopeAssignmentDto({ ...a, validTo: now })),
          }, session);
        }
        for (const t of openTasks) {
          await this.d.ledger.append({ actor, action: 'task.needs_reassignment', subject: { type: 'task', id: String(t._id) }, reason: `${reason}: owner left` }, session);
        }
      });
      return { outcome: 'deactivated' as const, assignmentIds: active.map((a) => String(a._id)), tasksNeedingReassignment: openTasks.length };
    }

    const scope = await this.resolveStaffScope(row);
    const wanted = validateScopeAssignment({ userId: row.userId, role: row.role, scope, validFrom: row.validFrom ?? now });
    const sameRole = active.filter((a) => a.role === row.role);
    const same = sameRole.find((a) => contentHash(a.scope) === contentHash(wanted.scope));
    if (same && sameRole.length === 1) {
      if (same.userName !== row.name) await ScopeAssignmentModel.updateOne({ _id: same._id }, { $set: { userName: row.name }, $inc: { v: 1 } });
      return { outcome: 'unchanged' as const, assignmentIds: [String(same._id)], tasksNeedingReassignment: 0 };
    }
    const dto = await withTx(async (session) => {
      for (const a of sameRole) {
        await ScopeAssignmentModel.updateOne({ _id: a._id }, { $set: { validTo: now }, $inc: { v: 1 } }, { session });
        await this.d.ledger.append({
          actor, action: 'scope.changed', subject: { type: 'scope_assignment', id: String(a._id) }, reason: `${reason}: scope replaced`,
          beforeHash: contentHash(toScopeAssignmentDto(a)), afterHash: contentHash(toScopeAssignmentDto({ ...a, validTo: now })),
        }, session);
      }
      return this.insertAssignment({ ...wanted, validFrom: sameRole.length ? now : wanted.validFrom, source: 'hr_import', userName: row.name }, actor, reason, session);
    });
    return { outcome: sameRole.length ? ('updated' as const) : ('created' as const), assignmentIds: [dto.id], tasksNeedingReassignment: 0 };
  }

  /** HR rows name places by code; the programme stores ids. */
  private async resolveStaffScope(row: StaffRow): Promise<Scope> {
    const s = row.scope;
    const facility = async (code: string) => {
      const f = await FacilityModel.findOne({ facilityCode: code }, { _id: 1 }).lean<{ _id: Types.ObjectId }>();
      if (!f) throw Problem.unprocessable('VALIDATION_FAILED', `Unknown facility code ${code}`, { errors: [{ path: 'facilityCode', message: 'is not in the register; import facilities first' }] });
      return String(f._id);
    };
    switch (s.level) {
      case 'state': return { level: 'state' };
      case 'district': return { level: 'district', districtCode: s.districtCode ?? '' };
      case 'facility':
        if (row.role === 'EXTERNAL_AUDITOR') return { level: 'facility', facilityIds: await Promise.all((s.facilityCodes ?? (s.facilityCode ? [s.facilityCode] : [])).map(facility)) };
        return { level: 'facility', facilityId: s.facilityCode ? await facility(s.facilityCode) : '' };
      case 'wards':
      case 'own_tasks': {
        if (!s.facilityCode) return { level: s.level };
        const facilityId = await facility(s.facilityCode);
        const codes = s.wardCodes ?? [];
        const wards = codes.length ? await WardModel.find({ facilityId, wardCode: { $in: codes } }, { _id: 1, wardCode: 1 }).lean<{ _id: Types.ObjectId; wardCode: string }[]>() : [];
        const missing = codes.filter((c) => !wards.some((w) => w.wardCode === c));
        if (missing.length) throw Problem.unprocessable('VALIDATION_FAILED', `Unknown ward code ${missing.join(', ')}`, { errors: [{ path: 'wardCodes', message: 'not in the register' }] });
        return { level: s.level, facilityId, ...(wards.length ? { wardIds: codes.map((c) => String(wards.find((w) => w.wardCode === c)!._id)) } : {}) };
      }
    }
  }

  /**
   * Open tasks whose owner has no active scope assignment (leavers, ended scopes): the ward
   * supervisor's "needs reassignment" list (US1 AS5). Optionally limited to wards (plans' wardId).
   */
  async tasksNeedingReassignment(o: { planIds?: Types.ObjectId[] } = {}) {
    const filter: Record<string, unknown> = { state: { $in: [...OPEN_TASK_STATES] } };
    if (o.planIds) filter.planId = { $in: o.planIds };
    const owners = (await TaskModel.distinct('ownerUserId', filter)) as string[];
    const now = this.now();
    const withScope = new Set(
      (await ScopeAssignmentModel.find({ userId: { $in: owners } }).lean<ScopeAssignmentDoc[]>()).filter((a) => isAssignmentActive(a, now)).map((a) => a.userId),
    );
    const orphaned = owners.filter((u) => !withScope.has(u));
    if (!orphaned.length) return [];
    return TaskModel.find({ ...filter, ownerUserId: { $in: orphaned } }).lean();
  }

  // ---------------------------------------------------------------- people picker
  async listUsers(a: ActorScope, q: { wardId?: string; facilityId?: string; role?: string; cursor?: string; limit: number }) {
    const now = this.now();
    const vis = await visibleFacilityIds(a);
    const filter: Record<string, unknown> = {};
    if (q.role) filter.role = q.role;
    const all = (await ScopeAssignmentModel.find(filter).sort({ userId: 1 }).lean<ScopeAssignmentDoc[]>()).filter((x) => isAssignmentActive(x, now));
    const facilityOf = (s: Scope) => [...(s.facilityId ? [s.facilityId] : []), ...(s.facilityIds ?? [])];
    const inView = (s: Scope) => {
      if ('all' in vis) return true;
      const fs = facilityOf(s);
      if (vis.wardIds && !vis.facilityIds.size) return (s.wardIds ?? []).some((w) => vis.wardIds!.has(w));
      return fs.some((f) => vis.facilityIds.has(f));
    };
    const rows = all.filter((x) => inView(x.scope))
      .filter((x) => !q.facilityId || facilityOf(x.scope).includes(q.facilityId))
      .filter((x) => !q.wardId || (x.scope.wardIds ?? []).includes(q.wardId));
    const byUser = new Map<string, { userId: string; name: string; roles: Set<string>; wardIds: Set<string> }>();
    for (const x of rows) {
      const u = byUser.get(x.userId) ?? { userId: x.userId, name: x.userName ?? x.userId, roles: new Set(), wardIds: new Set() };
      u.roles.add(x.role);
      (x.scope.wardIds ?? []).forEach((w) => u.wardIds.add(w));
      if (x.userName) u.name = x.userName;
      byUser.set(x.userId, u);
    }
    const sorted = [...byUser.values()].sort((l, r) => l.userId.localeCompare(r.userId));
    const after = q.cursor ? Buffer.from(q.cursor, 'base64url').toString('utf8') : undefined;
    const rest = after ? sorted.filter((u) => u.userId > after) : sorted;
    const page = rest.slice(0, q.limit);
    return {
      items: page.map((u) => ({ userId: u.userId, name: u.name.slice(0, 200), roles: [...u.roles].sort(), ...(u.wardIds.size ? { wardIds: [...u.wardIds] } : {}), active: true })),
      nextCursor: rest.length > q.limit ? Buffer.from(page[page.length - 1]!.userId, 'utf8').toString('base64url') : null,
    };
  }

  // ---------------------------------------------------------------- risk defaults
  async listRiskDefaults() {
    const docs = await RiskDefaultModel.find({}).lean<RiskDefault[]>();
    const order: RiskLevel[] = ['critical', 'high', 'normal'];
    return { items: docs.sort((a, b) => order.indexOf(a.riskLevel) - order.indexOf(b.riskLevel)).map(toRiskDefaultDto) };
  }

  /**
   * Saves one level. Applies to findings from the NEXT assessment (US1 AS4): tasks copy the default
   * when they are created, so existing tasks keep theirs. If-Match "0" creates a missing level.
   */
  async setRiskDefault(level: RiskLevel, input: { dueDays: number; evidenceRule: { photoRequired: boolean; minPhotos: number }; secondValidation: boolean; reason?: string }, ifMatch: number | undefined, actor: LedgerActor) {
    const v = this.requireIfMatch(ifMatch);
    if (input.evidenceRule.photoRequired && input.evidenceRule.minPhotos < 1) {
      throw Problem.unprocessable('VALIDATION_FAILED', 'A photo rule needs at least one photo', { errors: [{ path: 'evidenceRule.minPhotos', message: 'must be at least 1 when photoRequired' }] });
    }
    const cur = await RiskDefaultModel.findOne({ riskLevel: level }).lean<RiskDefault>();
    if ((cur?.v ?? 0) !== v) throw this.conflict(cur ? toRiskDefaultDto(cur) : null, cur?.v ?? 0);
    const fields = { dueDays: input.dueDays, evidenceRule: input.evidenceRule, secondValidation: input.secondValidation };
    return withTx(async (session) => {
      const u = cur
        ? await RiskDefaultModel.findOneAndUpdate({ _id: cur._id, v }, { $set: fields, $inc: { v: 1 } }, { new: true, session, lean: true })
        : (await RiskDefaultModel.create([{ riskLevel: level, ...fields }], { session }))[0]!.toObject();
      if (!u) throw this.conflict(cur ? toRiskDefaultDto(cur) : null, cur?.v ?? 0);
      const dto = toRiskDefaultDto(u as RiskDefault);
      await this.d.ledger.append({
        actor, action: 'risk_default.changed', subject: { type: 'risk_default', id: dto.id }, reason: input.reason ?? `${level} defaults saved`,
        ...(cur ? { beforeHash: contentHash(pick(cur, Object.keys(fields))) } : {}), afterHash: contentHash(fields),
      }, session);
      return dto;
    });
  }

  // ---------------------------------------------------------------- retention policy (T128, NFR-010)
  private retention(): RetentionService {
    if (!this.d.retention) throw new Problem(503, 'ELEVATE_UNAVAILABLE', 'Retention is not configured');
    return this.d.retention;
  }
  /** getRetentionPolicy. */
  async getRetentionPolicy() {
    return this.retention().get();
  }

  /** setRetentionPolicy: save + ledger `retention.changed` (If-Match). */
  async setRetentionPolicy(input: {
    evidenceYearsAfterPlanClosure: number; auditYears: number; otherYearsAfterProgrammeEnd: number;
    purgeMode: 'dry_run' | 'enforce'; reason?: string;
  }, ifMatch: number | undefined, actor: LedgerActor) {
    return this.retention().set(input, ifMatch, actor);
  }

  // ---------------------------------------------------------------- escalation rules
  async listEscalationRules() {
    const docs = await EscalationRuleModel.find({}).lean<EscalationRule[]>();
    return { items: docs.sort((a, b) => Number(a.code.slice(1)) - Number(b.code.slice(1))).map(toEscalationRuleDto) };
  }

  private checkRule(r: { condition: EscalationRule['condition']; target: EscalationRule['target'] }) {
    const errors: { path: string; message: string }[] = [];
    if (r.condition.type === 'overdue' && !r.condition.thresholdHours) errors.push({ path: 'condition.thresholdHours', message: 'is required for overdue rules' });
    if (r.condition.type === 'rejections' && !r.condition.thresholdCount) errors.push({ path: 'condition.thresholdCount', message: 'is required for rejection rules' });
    if (r.target.mode === 'role' && !r.target.role) errors.push({ path: 'target.role', message: 'is required when the target is a role' });
    if (errors.length) throw Problem.unprocessable('VALIDATION_FAILED', 'The rule is not complete', { errors });
  }

  async createEscalationRule(input: Pick<EscalationRule, 'code' | 'condition' | 'target' | 'channels'> & { active?: boolean }, actor: LedgerActor) {
    this.checkRule(input);
    if (await EscalationRuleModel.exists({ code: input.code })) throw Problem.conflict('VERSION_CONFLICT', `Rule ${input.code} already exists`);
    return withTx(async (session) => {
      const [doc] = await EscalationRuleModel.create([{ ...input, active: input.active ?? true }], { session });
      const dto = toEscalationRuleDto(doc!.toObject() as EscalationRule);
      await this.d.ledger.append({ actor, action: 'escalation_rule.created', subject: { type: 'escalation_rule', id: dto.id }, afterHash: contentHash(dto) }, session);
      return dto;
    });
  }

  async updateEscalationRule(code: string, patch: Partial<Pick<EscalationRule, 'condition' | 'target' | 'channels' | 'active'>> & { reason?: string }, ifMatch: number | undefined, actor: LedgerActor) {
    const v = this.requireIfMatch(ifMatch);
    const cur = await EscalationRuleModel.findOne({ code }).lean<EscalationRule>();
    if (!cur) throw Problem.notFound('No such rule');
    if (cur.v !== v) throw this.conflict(toEscalationRuleDto(cur), cur.v);
    const { reason, ...fields } = patch;
    this.checkRule({ condition: fields.condition ?? cur.condition, target: fields.target ?? cur.target });
    return withTx(async (session) => {
      const u = await EscalationRuleModel.findOneAndUpdate({ _id: cur._id, v }, { $set: fields, $inc: { v: 1 } }, { new: true, session, lean: true });
      if (!u) throw this.conflict(toEscalationRuleDto(cur), cur.v);
      const dto = toEscalationRuleDto(u as EscalationRule);
      await this.d.ledger.append({
        actor, action: 'escalation_rule.changed', subject: { type: 'escalation_rule', id: dto.id }, reason,
        beforeHash: contentHash(toEscalationRuleDto(cur)), afterHash: contentHash(dto),
      }, session);
      return dto;
    });
  }
}

function pick(o: object, keys: string[]): Record<string, unknown> {
  const src = o as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = JSON.parse(JSON.stringify(src[k])) as unknown;
  return out;
}
