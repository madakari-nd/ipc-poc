import { Types, type ClientSession } from 'mongoose';
import { Problem, type Logger } from '@ipc/platform';
import { contentHash } from '../domain/canonical.js';
import type { LedgerActor } from '../domain/ledger-chain.js';
import {
  candidateSlotDays, fromElevateSessionStatus, isOpenWithin, rankMentors, sessionWindow, supportTransitionAllowed,
  type MentorProfile, type RankedMentor, type SupportStatus,
} from '../domain/mentor-rank.js';
import {
  MentorProfileCacheModel, PlanModel, PlanRevisionModel, ScopeAssignmentModel, SupportRequestModel, WardModel,
  type MentorProfileCache, type Plan, type PlanRevision, type ScopeAssignmentDoc, type SupportRequest, type Ward,
} from '../domain/models/index.js';
import type { RiskLevel } from '../domain/catalogue.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { withTx } from '../repositories/tx.js';
import { visibleFacilityIds } from './admin.service.js';
import { decodeCursor, encodeCursor, type Page } from './paging.js';
import { toRevisionDto, type PlanActor, type PlanService } from './plan.service.js';

export type SupportActor = PlanActor;

/** A request-session status the Edge read from ELEVATE mentoring with the caller's own token. */
export interface ElevateSessionFact { id: string; status: string }
/** An open-slot probe result the Edge got from ELEVATE `isAvailable` (null = no open slot found). */
export interface AvailabilityFact { mentorId: string; nextOpenSlotAt: string | null; name?: string }

/** What the Edge sends to ELEVATE `requestSessions/create` (officer token), computed here. */
export interface SessionPlan {
  supportRequestId: string;
  requesteeId: string;
  title: string;
  agenda: string;
  startEpoch: number;
  endEpoch: number;
  startAt: string;
}

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : undefined);
const oid = (s: string | Types.ObjectId) => new Types.ObjectId(String(s));
const DENIED = () => Problem.forbidden('SCOPE_DENIED', 'This item is outside your area.');
const RAISERS = new Set(['IPC_OFFICER', 'DISTRICT_QM']);
const byMentorId = (a: { elevateMentorId: string }, b: { elevateMentorId: string }) =>
  a.elevateMentorId.localeCompare(b.elevateMentorId, 'en', { numeric: true });

/**
 * Expert support (US6; FR-022, FR-023; research E10, E11). Workflow owns the request, the ranked
 * shortlist (MentorProfileCache: skills/languages from the seed, open slots probed by the Edge with
 * ELEVATE `isAvailable`), the session reference, the outcome and the plan revision. ELEVATE
 * mentoring itself is only ever called by the Edge with the user's own token; its answers arrive
 * here as facts. Every state change writes the ledger in the same transaction. A mentor's facility
 * scope is derived from requests in `accepted`/`held` (ScopeService.effective).
 */
export class SupportService {
  constructor(private readonly d: {
    ledger: LedgerService;
    plans: PlanService;
    programmeNow: () => Date;
    logger?: Logger;
  }) {}

  // ------------------------------------------------------------------------------------ helpers

  private async names(ids: string[]): Promise<Map<string, string>> {
    const docs = await ScopeAssignmentModel.find({ userId: { $in: ids }, role: 'MENTOR' }, { userId: 1, userName: 1 }).lean<ScopeAssignmentDoc[]>();
    return new Map(docs.filter((d) => d.userName).map((d) => [d.userId, d.userName!]));
  }

  /** Mentor register in a deterministic order (numeric ELEVATE id) so ranking ties are stable. */
  async profiles(): Promise<MentorProfile[]> {
    const cache = (await MentorProfileCacheModel.find({}).lean<MentorProfileCache[]>()).sort(byMentorId);
    const names = await this.names(cache.map((c) => c.elevateMentorId));
    return cache.map((c) => {
      const name = c.name ?? names.get(c.elevateMentorId);
      return { mentorId: c.elevateMentorId, skills: c.skills, languages: c.languages, nextOpenSlotAt: c.nextOpenSlotAt ?? null, ...(name ? { name } : {}) };
    });
  }

  /** Mentor ids to probe and the one-hour slots to try, grouped per programme day. */
  async probePlan(): Promise<{ mentorIds: string[]; slotDays: string[][] }> {
    const ids = (await MentorProfileCacheModel.find({}, { elevateMentorId: 1 }).lean<MentorProfileCache[]>()).sort(byMentorId).map((m) => m.elevateMentorId);
    return { mentorIds: ids, slotDays: candidateSlotDays(this.d.programmeNow()).map((d) => d.map((s) => s.toISOString())) };
  }

  /** MentorProfileCache refresh from the Edge's ELEVATE availability probe (a cache of ELEVATE data, not a decision). */
  async refreshAvailability(facts: AvailabilityFact[]): Promise<void> {
    const now = new Date();
    for (const f of facts) {
      await MentorProfileCacheModel.updateOne(
        { elevateMentorId: f.mentorId },
        f.nextOpenSlotAt
          ? { $set: { nextOpenSlotAt: new Date(f.nextOpenSlotAt), refreshedAt: now, ...(f.name ? { name: f.name } : {}) } }
          : { $set: { refreshedAt: now, ...(f.name ? { name: f.name } : {}) }, $unset: { nextOpenSlotAt: 1 } },
      );
    }
  }

  private async wardScope(actor: SupportActor): Promise<{ all: true } | { wardIds: Set<string> }> {
    const v = await visibleFacilityIds(actor);
    if ('all' in v) return { all: true };
    const wards = await WardModel.find({ facilityId: { $in: [...v.facilityIds].map(oid) } }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>();
    const ids = new Set(wards.map((w) => String(w._id)));
    v.wardIds?.forEach((w) => ids.add(w));
    return { wardIds: ids };
  }

  /**
   * Officer/QM: the request's ward is in scope. MENTOR: only requests addressed to them; another
   * mentor's request in a facility the caller may see is NOT_OWNER, anything else SCOPE_DENIED.
   */
  private async visible(id: string, actor: SupportActor): Promise<SupportRequest> {
    if (!/^[a-f0-9]{24}$/.test(id)) throw DENIED();
    const doc = await SupportRequestModel.findById(id).lean<SupportRequest>();
    if (!doc) throw DENIED();
    if (actor.role === 'MENTOR') {
      if (doc.chosenMentorId === actor.userId) return doc;
      if ((actor.mentorFacilityIds ?? []).includes(String(doc.facilityId))) throw Problem.forbidden('NOT_OWNER', 'Only the mentor this request was sent to can do this.');
      throw DENIED();
    }
    const s = await this.wardScope(actor);
    if ('wardIds' in s && !s.wardIds.has(String(doc.wardId))) throw DENIED();
    return doc;
  }

  private assertVersion(doc: SupportRequest, ifMatch: number | undefined, current: unknown): void {
    if (ifMatch === undefined) throw Problem.badRequest('IF_MATCH_REQUIRED', 'If-Match header with the version you edited is required');
    if (ifMatch !== doc.v) throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this request since you opened it', { currentVersion: doc.v, current });
  }

  private transition(from: SupportStatus, to: SupportStatus, what: string): void {
    if (!supportTransitionAllowed(from, to)) throw Problem.conflict('INVALID_TRANSITION', `${what} is not possible while the request is ${from}`);
  }

  private async record(s: ClientSession, actor: LedgerActor, action: string, before: SupportRequest | null, after: SupportRequest, reason?: string) {
    await this.d.ledger.append({
      actor, action, subject: { type: 'support_request', id: String(after._id) }, ...(reason ? { reason: reason.slice(0, 500) } : {}),
      ...(before ? { beforeHash: contentHash(this.plain(before)) } : {}), afterHash: contentHash(this.plain(after)),
    }, s);
  }

  /** Stored fields only (hash input); the DTO adds names and cache data at read time. */
  private plain(d: SupportRequest) {
    return {
      id: String(d._id), v: d.v, wardId: String(d.wardId), facilityId: String(d.facilityId), raisedBy: d.raisedBy, problem: d.problem,
      skill: d.skill, language: d.language, status: d.status, chosenMentorId: d.chosenMentorId ?? null,
      elevateRequestSessionId: d.elevateRequestSessionId ?? null, heldAt: iso(d.heldAt) ?? null,
      shortlist: d.shortlist.map((x) => ({ ...x })),
      agreedActions: d.agreedActions.map((a) => ({ text: a.text, proposedOwnerUserId: a.proposedOwnerUserId ?? null, taskId: a.taskId ? String(a.taskId) : null })),
      planRevision: d.planRevision ?? null,
    };
  }

  private async dtos(docs: SupportRequest[]) {
    const profiles = new Map((await this.profiles()).map((p) => [p.mentorId, p]));
    return docs.map((d) => toSupportDto(d, profiles));
  }

  private async dto(d: SupportRequest) {
    return (await this.dtos([d]))[0]!;
  }

  // --------------------------------------------------------------------------------- operations

  /** createSupportRequest: ward in scope, initial shortlist from the register (FR-022). */
  async create(body: { wardId: string; problem: string; skill: string; language: string }, actor: SupportActor) {
    if (!RAISERS.has(actor.role)) throw Problem.forbidden('ROLE_DENIED', 'Your role cannot do this.');
    const ward = await WardModel.findById(body.wardId).lean<Ward>();
    const s = await this.wardScope(actor);
    if (!ward || ('wardIds' in s && !s.wardIds.has(String(ward._id)))) throw Problem.forbidden('SCOPE_DENIED', 'This ward is outside your area.');
    if (!ward.active) throw Problem.unprocessable('VALIDATION_FAILED', 'This ward is not active', { errors: [{ path: 'wardId', message: 'inactive ward' }] });
    const ranked = rankMentors(await this.profiles(), body, this.d.programmeNow());
    const doc = await withTx(async (session) => {
      const [created] = await SupportRequestModel.create([{
        wardId: ward._id, facilityId: ward.facilityId, raisedBy: actor.userId, problem: body.problem, skill: body.skill, language: body.language,
        shortlist: ranked.map(stored), status: 'open', agreedActions: [], v: 0,
      }], { session });
      const d = created!.toObject() as SupportRequest;
      await this.record(session, { userId: actor.userId, role: actor.role }, 'support_request.created', null, d, `${body.skill}/${body.language}: ${body.problem}`);
      return d;
    });
    return this.dto(doc);
  }

  /**
   * getMentorShortlist. With `facts` (refresh=true: the Edge probed ELEVATE `isAvailable`) the
   * cache is refreshed first; an open or rejected request's stored shortlist follows the new ranking.
   */
  async shortlist(id: string, actor: SupportActor, facts?: AvailabilityFact[]) {
    if (!RAISERS.has(actor.role) && actor.role !== 'STATE_ADMIN') throw Problem.forbidden('ROLE_DENIED', 'Your role cannot do this.');
    const doc = await this.visible(id, actor);
    if (facts) await this.refreshAvailability(facts);
    const now = this.d.programmeNow();
    const ranked = rankMentors(await this.profiles(), doc, now);
    if (doc.status === 'open' || doc.status === 'rejected') {
      // Derived data (a re-ranking of the register), not a decision: no version change.
      await SupportRequestModel.updateOne({ _id: doc._id, status: doc.status }, { $set: { shortlist: ranked.map(stored) } });
    }
    return { supportRequestId: String(doc._id), computedAt: now.toISOString(), items: ranked.map(toShortlistDto) };
  }

  /**
   * requestMentorSession, phase 1: validates (scope, state, version, mentor shortlisted, slot) and
   * returns what the Edge sends to ELEVATE with the officer's token. Nothing changes.
   */
  async planSession(id: string, body: { mentorId: string; message?: string; proposedStartAt?: string }, ifMatch: number | undefined, actor: SupportActor): Promise<SessionPlan> {
    const doc = await this.visible(id, actor);
    this.assertVersion(doc, ifMatch, await this.dto(doc));
    this.transition(doc.status, 'requested', 'Requesting a session');
    if (!doc.shortlist.some((m) => m.mentorId === body.mentorId)) {
      throw Problem.unprocessable('VALIDATION_FAILED', 'Choose a mentor from the shortlist', { errors: [{ path: 'mentorId', message: 'not on the shortlist' }] });
    }
    const now = this.d.programmeNow();
    const cached = (await MentorProfileCacheModel.findOne({ elevateMentorId: body.mentorId }).lean<MentorProfileCache>())?.nextOpenSlotAt;
    const start = body.proposedStartAt ? new Date(body.proposedStartAt) : isOpenWithin(cached, now) ? cached! : undefined;
    if (!start) throw Problem.unprocessable('VALIDATION_FAILED', 'This mentor has no open slot in the next 14 days; propose a time', { errors: [{ path: 'proposedStartAt', message: 'required: no open slot' }] });
    if (start.getTime() <= now.getTime()) throw Problem.unprocessable('VALIDATION_FAILED', 'The session must start in the future', { errors: [{ path: 'proposedStartAt', message: 'in the past' }] });
    const ward = await WardModel.findById(doc.wardId, { name: 1 }).lean<Ward>();
    const w = sessionWindow(start);
    return {
      supportRequestId: String(doc._id), requesteeId: body.mentorId,
      title: elevateTitle(`IPC support - ${doc.skill.replace(/_/g, ' ')}, ${ward?.name ?? 'ward'}`),
      agenda: (body.message ? `${doc.problem}\n\n${body.message}` : doc.problem).trim().split(/\s+/).slice(0, 300).join(' '),
      startEpoch: w.startEpoch, endEpoch: w.endEpoch, startAt: start.toISOString(),
    };
  }

  /** requestMentorSession, phase 2: records the ELEVATE request-session reference (status `requested`). */
  async commitSession(id: string, body: { mentorId: string; elevateRequestSessionId: string; startAt?: string }, ifMatch: number | undefined, actor: SupportActor) {
    const doc = await this.visible(id, actor);
    this.assertVersion(doc, ifMatch, await this.dto(doc));
    this.transition(doc.status, 'requested', 'Requesting a session');
    const next = await withTx(async (s) => {
      const after = await SupportRequestModel.findOneAndUpdate(
        { _id: doc._id, v: doc.v },
        { $set: { status: 'requested', chosenMentorId: body.mentorId, elevateRequestSessionId: body.elevateRequestSessionId }, $inc: { v: 1 } },
        { new: true, session: s, lean: true },
      );
      if (!after) throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this request since you opened it');
      await this.record(s, { userId: actor.userId, role: actor.role }, 'support_request.session_requested', doc, after as SupportRequest,
        `ELEVATE request session ${body.elevateRequestSessionId} to mentor ${body.mentorId}${body.startAt ? ` at ${body.startAt}` : ''}`);
      return after as SupportRequest;
    });
    return this.dto(next);
  }

  /**
   * Applies ELEVATE request-session statuses the Edge read with the caller's token: a `requested`
   * request the caller raised or was asked on becomes accepted/rejected (ledgered as SYSTEM, the
   * fact's source is ELEVATE). Returns the ids of the requests that changed.
   */
  async sync(actor: SupportActor, facts: ElevateSessionFact[]): Promise<string[]> {
    const byId = new Map(facts.map((f) => [String(f.id), fromElevateSessionStatus(f.status)]));
    if (byId.size === 0) return [];
    const docs = await SupportRequestModel.find({
      status: 'requested', elevateRequestSessionId: { $in: [...byId.keys()] },
      $or: [{ raisedBy: actor.userId }, { chosenMentorId: actor.userId }],
    }).lean<SupportRequest[]>();
    const changed: string[] = [];
    for (const doc of docs) {
      const to = byId.get(doc.elevateRequestSessionId!);
      if (!to || to === doc.status || !supportTransitionAllowed(doc.status, to)) continue;
      await withTx(async (s) => {
        const after = await SupportRequestModel.findOneAndUpdate({ _id: doc._id, v: doc.v, status: 'requested' }, { $set: { status: to }, $inc: { v: 1 } }, { new: true, session: s, lean: true });
        if (!after) return;
        await this.record(s, { userId: 'system', role: 'SYSTEM' }, `support_request.${to}`, doc, after as SupportRequest, `ELEVATE request session ${doc.elevateRequestSessionId} is ${to} (seen by ${actor.userId})`);
        changed.push(String(doc._id));
      });
    }
    return changed;
  }

  /** listSupportRequests: officers/QM/state by ward scope; a mentor only the requests addressed to them. */
  async list(actor: SupportActor, q: { status?: SupportStatus; wardId?: string; cursor?: string; limit: number }, facts?: ElevateSessionFact[]): Promise<Page<Awaited<ReturnType<SupportService['dto']>>>> {
    if (facts?.length) await this.sync(actor, facts);
    const filter: Record<string, unknown> = {};
    if (actor.role === 'MENTOR') filter.chosenMentorId = actor.userId;
    else {
      const s = await this.wardScope(actor);
      if ('wardIds' in s) filter.wardId = { $in: [...s.wardIds].filter((w) => !q.wardId || w === q.wardId).map(oid) };
      else if (q.wardId) filter.wardId = oid(q.wardId);
    }
    if (actor.role === 'MENTOR' && q.wardId) filter.wardId = oid(q.wardId);
    if (q.status) filter.status = q.status;
    const after = decodeCursor(q.cursor);
    if (after) filter._id = { $lt: after };
    const docs = await SupportRequestModel.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean<SupportRequest[]>();
    const page = docs.slice(0, q.limit);
    return { items: await this.dtos(page), nextCursor: docs.length > q.limit ? encodeCursor(page[page.length - 1]!._id) : null };
  }

  /**
   * recordSupportOutcome (mentor only): the request must be accepted in ELEVATE (a `requested`
   * request is accepted here first when the Edge's fact says so, in the same transaction).
   */
  async outcome(id: string, body: { held: true; heldAt: string; agreedActions: { text: string }[] }, ifMatch: number | undefined, actor: SupportActor, facts: ElevateSessionFact[] = []) {
    if (actor.role !== 'MENTOR') throw Problem.forbidden('ROLE_DENIED', 'Only the mentor can record the outcome.');
    const doc = await this.visible(id, actor);
    this.assertVersion(doc, ifMatch, await this.dto(doc));
    const fact = facts.find((f) => String(f.id) === doc.elevateRequestSessionId);
    const elevate = fact ? fromElevateSessionStatus(fact.status) : undefined;
    const acceptNow = doc.status === 'requested' && elevate === 'accepted';
    const from: SupportStatus = acceptNow ? 'accepted' : doc.status;
    if (from === 'requested') throw Problem.conflict('INVALID_TRANSITION', 'Accept the session request in ELEVATE mentoring first');
    this.transition(from, 'held', 'Recording the outcome');
    const heldAt = new Date(body.heldAt);
    if (heldAt.getTime() > this.d.programmeNow().getTime() + 60_000) {
      throw Problem.unprocessable('VALIDATION_FAILED', 'The session cannot be held in the future', { errors: [{ path: 'heldAt', message: 'in the future' }] });
    }
    const next = await withTx(async (s) => {
      let before = doc;
      if (acceptNow) {
        const acc = await SupportRequestModel.findOneAndUpdate({ _id: doc._id, v: doc.v, status: 'requested' }, { $set: { status: 'accepted' }, $inc: { v: 1 } }, { new: true, session: s, lean: true });
        if (!acc) throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this request since you opened it');
        await this.record(s, { userId: 'system', role: 'SYSTEM' }, 'support_request.accepted', doc, acc as SupportRequest, `ELEVATE request session ${doc.elevateRequestSessionId} is accepted (seen by ${actor.userId})`);
        before = acc as SupportRequest;
      }
      const after = await SupportRequestModel.findOneAndUpdate(
        { _id: doc._id, v: before.v, status: 'accepted' },
        { $set: { status: 'held', heldAt, agreedActions: body.agreedActions.map((a) => ({ text: a.text })) }, $inc: { v: 1 } },
        { new: true, session: s, lean: true },
      );
      if (!after) throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this request since you opened it');
      await this.record(s, { userId: actor.userId, role: actor.role }, 'support_request.held', before, after as SupportRequest, `Session held ${heldAt.toISOString()}; ${body.agreedActions.length} agreed action(s)`);
      return after as SupportRequest;
    });
    return this.dto(next);
  }

  /**
   * addAgreedActionsToPlan (FR-023): the agreed actions become tasks of the ward's active plan
   * through the US3 plan revision (`source=mentor_outcome`, tasks carry `supportRequestId`); the
   * request closes in the same transaction.
   */
  async addToPlan(
    id: string,
    body: { reason?: string; actions: { index: number; ownerUserId: string; riskLevel: RiskLevel; dueAt?: string }[] },
    ifMatch: number | undefined,
    actor: SupportActor,
  ) {
    if (!RAISERS.has(actor.role)) throw Problem.forbidden('ROLE_DENIED', 'Your role cannot do this.');
    const doc = await this.visible(id, actor);
    this.assertVersion(doc, ifMatch, await this.dto(doc));
    this.transition(doc.status, 'closed', 'Adding the agreed actions to the plan');
    const seen = new Set<number>();
    body.actions.forEach((a, i) => {
      if (a.index >= doc.agreedActions.length || seen.has(a.index)) {
        throw Problem.unprocessable('VALIDATION_FAILED', `Action ${i + 1}: not one of the agreed actions`, { errors: [{ path: `actions[${i}].index`, message: 'unknown or repeated' }] });
      }
      seen.add(a.index);
    });
    const plan = await PlanModel.findOne({ wardId: doc.wardId, status: 'active' }).sort({ _id: -1 }).lean<Plan>();
    if (!plan) throw Problem.conflict('INVALID_TRANSITION', 'This ward has no active plan yet; approve the ward plan first');
    const sid = String(doc._id);
    let revisionNo = 0;
    await this.d.plans.revise(String(plan._id), {
      reason: (body.reason ?? `Mentor-agreed actions (support request ${sid})`).slice(0, 500),
      changes: body.actions.map((a) => ({
        op: 'add' as const,
        task: { title: { en: doc.agreedActions[a.index]!.text }, riskLevel: a.riskLevel, ownerUserId: a.ownerUserId, ...(a.dueAt ? { dueAt: a.dueAt } : {}) },
      })),
    }, plan.v, actor, {
      source: 'mentor_outcome',
      supportRequestId: sid,
      inTx: async (s, r) => {
        revisionNo = r.revision;
        const actions = doc.agreedActions.map((x) => ({ ...x }));
        body.actions.forEach((a, i) => {
          actions[a.index] = { ...actions[a.index]!, proposedOwnerUserId: a.ownerUserId, taskId: oid(r.taskIds[i]!) };
        });
        const after = await SupportRequestModel.findOneAndUpdate(
          { _id: doc._id, v: doc.v, status: 'held' },
          { $set: { status: 'closed', planRevision: r.revision, agreedActions: actions }, $inc: { v: 1 } },
          { new: true, session: s, lean: true },
        );
        if (!after) throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this request since you opened it');
        await this.record(s, { userId: actor.userId, role: actor.role }, 'support_request.closed', doc, after as SupportRequest, `Plan ${String(plan._id)} r${r.revision}: ${body.actions.length} task(s) from agreed actions`);
      },
    });
    const rev = await PlanRevisionModel.findOne({ planId: plan._id, revision: revisionNo }).lean<PlanRevision>();
    if (!rev) throw new Error(`plan revision r${revisionNo} not found after commit`);
    return toRevisionDto(rev);
  }
}

/** ELEVATE mentoring accepts titles of letters, digits, spaces and `-.,` only (requestSessions validator). */
export const elevateTitle = (t: string) => t.replace(/[^a-zA-Z0-9\-.,\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'IPC support';

// ------------------------------------------------------------------------------------------- DTOs

const stored = (m: RankedMentor) => ({ mentorId: m.mentorId, rank: m.rank, skillMatch: m.skillMatch, languageMatch: m.languageMatch, available: m.available });

export function toShortlistDto(m: RankedMentor | (ReturnType<typeof stored> & Partial<MentorProfile>)) {
  return {
    mentorId: m.mentorId, rank: m.rank, skillMatch: m.skillMatch, languageMatch: m.languageMatch, available: m.available,
    ...(m.name ? { name: m.name.slice(0, 200) } : {}),
    ...(m.nextOpenSlotAt ? { nextOpenSlotAt: new Date(m.nextOpenSlotAt).toISOString() } : {}),
    ...(m.skills ? { skills: m.skills } : {}),
    ...(m.languages ? { languages: m.languages } : {}),
  };
}

export function toSupportDto(d: SupportRequest, profiles: Map<string, MentorProfile> = new Map()) {
  return {
    id: String(d._id), v: d.v, createdAt: iso(d.createdAt)!, updatedAt: iso(d.updatedAt)!,
    wardId: String(d.wardId), facilityId: String(d.facilityId), raisedBy: d.raisedBy, problem: d.problem, skill: d.skill, language: d.language,
    shortlist: d.shortlist.map((m) => {
      const p = profiles.get(m.mentorId);
      return toShortlistDto({ ...m, ...(p ? { name: p.name, skills: p.skills, languages: p.languages, nextOpenSlotAt: p.nextOpenSlotAt } : {}) });
    }),
    status: d.status,
    ...(d.chosenMentorId ? { chosenMentorId: d.chosenMentorId } : {}),
    ...(d.elevateRequestSessionId ? { elevateRequestSessionId: d.elevateRequestSessionId } : {}),
    ...(d.heldAt ? { heldAt: iso(d.heldAt)! } : {}),
    agreedActions: (d.agreedActions ?? []).map((a) => ({
      text: a.text, ...(a.proposedOwnerUserId ? { proposedOwnerUserId: a.proposedOwnerUserId } : {}), ...(a.taskId ? { taskId: String(a.taskId) } : {}),
    })),
    ...(d.planRevision ? { planRevision: d.planRevision } : {}),
  };
}
