import type { Request, Response } from 'express';
import { z } from 'zod';
import { Problem } from '@ipc/platform';
import { serviceIdentity } from '../auth/service-jwt.js';
import type { ClockService } from '../clock/clock.js';
import type { LedgerActor } from '../domain/ledger-chain.js';
import { RISK_LEVELS } from '../domain/models/index.js';
import { ROLES, SCOPE_LEVELS, type Role } from '../domain/scope.js';
import type { ActorScope, AdminService } from '../services/admin.service.js';
import type { CatalogueService } from '../services/catalogue.service.js';
import type { ScopeService } from '../services/scope.service.js';
import { parseOrThrow } from './validate.js';

// ---------------------------------------------------------------- boundary schemas (contracts/openapi.yaml)
const ts = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const oid = z.string().regex(/^[a-f0-9]{24}$/);
const limit = z.coerce.number().int().min(1).max(100).default(25);
const cursor = z.string().max(512).optional();
const loc = z.object({ en: z.string().min(1).max(500), hi: z.string().max(500).optional(), kn: z.string().max(500).optional() }).strict();
const role = z.enum(ROLES);
const scope = z.object({
  level: z.enum(SCOPE_LEVELS),
  districtCode: z.string().max(32).optional(),
  facilityId: oid.optional(),
  facilityIds: z.array(oid).optional(),
  wardIds: z.array(oid).optional(),
}).strict();
const riskLevel = z.enum(RISK_LEVELS);
const evidenceRule = z.object({ photoRequired: z.boolean(), minPhotos: z.number().int().min(0).max(10) }).strict();
const condition = z.object({
  type: z.enum(['overdue', 'rejections']),
  riskLevels: z.array(riskLevel),
  thresholdHours: z.number().int().min(1).optional(),
  thresholdCount: z.number().int().min(1).optional(),
}).strict();
const target = z.object({ mode: z.enum(['role', 'level_above_decider']), role: role.optional() }).strict();
const channels = z.array(z.enum(['inapp', 'email', 'sms'])).min(1);
const section = z.object({ sectionKey: z.string().regex(/^[a-z0-9_]{1,40}$/), title: loc, wardTypes: z.array(z.string().max(32)) }).strict();
const question = z.object({
  questionKey: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/),
  elevateQuestionExternalId: z.string().max(64).optional(),
  sectionKey: z.string().regex(/^[a-z0-9_]{1,40}$/),
  text: loc,
  textHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  answerType: z.enum(['score', 'yes_no', 'single_choice']).optional(),
  options: z.array(z.object({ value: z.string().max(32), label: loc, score: z.number() }).strict()).optional(),
  riskLevel,
  passMark: z.number().min(0),
  maxScore: z.number().min(0),
  templateTaskKey: z.string().max(40).optional(),
}).strict();
const planTask = z.object({ templateTaskKey: z.string().max(40), title: loc, description: loc.optional() }).strict();

const schemas = {
  programmeUpdate: z.object({ name: z.string().min(1).max(200).optional(), languages: z.array(z.enum(['en', 'hi', 'kn'])).min(1).optional() }).strict()
    .refine((o) => Object.keys(o).length > 0, 'at least one field'),
  cycleCreate: z.object({
    code: z.string().regex(/^[0-9]{4}-C[0-9]+$/), startsAt: ts, endsAt: ts,
    targetDates: z.object({ baselineBy: ts, repeatBy: ts.optional() }).strict(),
  }).strict(),
  cycleUpdate: z.object({
    startsAt: ts.optional(), endsAt: ts.optional(),
    targetDates: z.object({ baselineBy: ts.optional(), repeatBy: ts.optional() }).strict().optional(),
    status: z.enum(['planned', 'active', 'closed']).optional(),
  }).strict().refine((o) => Object.keys(o).length > 0, 'at least one field'),
  scopeCreate: z.object({ userId: z.string().min(1).max(64), role, scope, validFrom: ts, validTo: ts.optional(), reason: z.string().max(500).optional() }).strict(),
  scopeUpdate: z.object({ scope: scope.optional(), validTo: ts.optional(), reason: z.string().min(1).max(500) }).strict(),
  draftCreate: z.object({
    checklistCode: z.string().min(1).max(32), basedOnVersionId: oid.optional(),
    sections: z.array(section).optional(), questions: z.array(question).optional(), planTemplateTasks: z.array(planTask).optional(),
  }).strict(),
  draftUpdate: z.object({ sections: z.array(section).optional(), questions: z.array(question).optional(), planTemplateTasks: z.array(planTask).optional() }).strict()
    .refine((o) => Object.keys(o).length > 0, 'at least one field'),
  publish: z.object({ reason: z.string().max(500).optional() }).strict(),
  riskDefault: z.object({ dueDays: z.number().int().min(1).max(365), evidenceRule, secondValidation: z.boolean(), reason: z.string().max(500).optional() }).strict(),
  ruleCreate: z.object({ code: z.string().regex(/^R[0-9]{1,3}$/), condition, target, channels, active: z.boolean().optional() }).strict(),
  ruleUpdate: z.object({ condition: condition.optional(), target: target.optional(), channels: channels.optional(), active: z.boolean().optional(), reason: z.string().max(500).optional() }).strict()
    .refine((o) => Object.keys(o).length > 0, 'at least one field'),
  clockSet: z.object({ programmeNow: ts.optional(), advanceBy: z.string().max(32).optional(), reason: z.string().max(500).optional() }).strict(),
  clockReset: z.object({ reason: z.string().max(500).optional() }).strict(),
  pageQuery: z.object({ cursor, limit }).passthrough(),
};

const queries = {
  facilities: z.object({ districtCode: z.string().max(32).optional(), status: z.enum(['active', 'inactive']).optional(), cursor, limit }).strict(),
  cycles: z.object({ status: z.enum(['planned', 'active', 'closed']).optional(), cursor, limit }).strict(),
  scopes: z.object({ userId: z.string().max(64).optional(), role: role.optional(), activeOn: ts.optional(), cursor, limit }).strict(),
  checklists: z.object({ checklistCode: z.string().max(32).optional(), status: z.enum(['draft', 'published', 'retired']).optional(), cursor, limit }).strict(),
  users: z.object({ wardId: oid.optional(), facilityId: oid.optional(), role: role.optional(), cursor, limit }).strict(),
};

// ---------------------------------------------------------------- helpers
/** Acting user from the service JWT `act` claim; the role must be one the operation allows. */
export function actorOf(res: Response, allowed: readonly Role[] | 'any'): LedgerActor & { role: Role } {
  const act = serviceIdentity(res).act;
  if (!act || act.role === 'SYSTEM') throw Problem.forbidden('ROLE_DENIED', 'An acting programme user is required');
  if (allowed !== 'any' && !allowed.includes(act.role)) throw Problem.forbidden('ROLE_DENIED', 'Your role cannot do this.');
  return { userId: act.sub, role: act.role };
}

/** Reads open to every signed-in role and to a programme service acting as SYSTEM (e.g. the Edge guard). */
export function readerOf(res: Response): LedgerActor {
  const act = serviceIdentity(res).act;
  if (!act) throw Problem.forbidden('ROLE_DENIED', 'An acting user is required');
  return { userId: act.sub, role: act.role };
}

const STRONG_ETAG = /^"(\d{1,9})"$/;
export function ifMatchOf(req: Request): number | undefined {
  const h = req.header('if-match');
  if (h === undefined) return undefined;
  const m = STRONG_ETAG.exec(h.trim());
  if (!m) throw Problem.badRequest('VALIDATION_FAILED', 'If-Match must be a strong ETag like "7"');
  return Number(m[1]);
}

function send(res: Response, status: number, body: { v?: number; id?: string } & object, location?: string) {
  if (typeof body.v === 'number') res.setHeader('ETag', `"${body.v}"`);
  if (location) res.setHeader('Location', location);
  res.status(status).json(body);
}

const ADMIN = ['STATE_ADMIN'] as const;

export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly catalogue: CatalogueService,
    private readonly scopes: ScopeService,
    private readonly clock: ClockService,
  ) {}

  private async actorScope(actor: { userId: string; role: Role }): Promise<ActorScope> {
    try {
      const eff = await this.scopes.effective(actor.userId);
      return { role: actor.role, assignments: eff.assignments.map((a) => ({ role: a.role, scope: a.scope })), mentorFacilityIds: eff.mentorFacilityIds };
    } catch (err) {
      if (err instanceof Problem && err.status === 404) return { role: actor.role, assignments: [] };
      throw err;
    }
  }

  // programme
  getProgramme = async (_req: Request, res: Response) => {
    actorOf(res, ADMIN);
    send(res, 200, await this.admin.getProgramme());
  };
  updateProgramme = async (req: Request, res: Response) => {
    const actor = actorOf(res, ADMIN);
    send(res, 200, await this.admin.updateProgramme(parseOrThrow(schemas.programmeUpdate, req.body), ifMatchOf(req), actor));
  };

  // hierarchy and people
  listFacilities = async (req: Request, res: Response) => {
    const actor = actorOf(res, ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR', 'MENTOR', 'EXTERNAL_AUDITOR']);
    res.json(await this.admin.listFacilities(await this.actorScope(actor), parseOrThrow(queries.facilities, req.query)));
  };
  listUsers = async (req: Request, res: Response) => {
    const actor = actorOf(res, ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR']);
    res.json(await this.admin.listUsers(await this.actorScope(actor), parseOrThrow(queries.users, req.query)));
  };

  // cycles
  listCycles = async (req: Request, res: Response) => {
    actorOf(res, 'any');
    res.json(await this.admin.listCycles(parseOrThrow(queries.cycles, req.query)));
  };
  createCycle = async (req: Request, res: Response) => {
    const actor = actorOf(res, ADMIN);
    const dto = await this.admin.createCycle(parseOrThrow(schemas.cycleCreate, req.body), actor);
    send(res, 201, dto, `/ipc/v1/admin/cycles/${dto.id}`);
  };
  updateCycle = async (req: Request, res: Response) => {
    const actor = actorOf(res, ADMIN);
    send(res, 200, await this.admin.updateCycle(String(req.params.cycleId), parseOrThrow(schemas.cycleUpdate, req.body), ifMatchOf(req), actor));
  };

  // scope assignments
  listScopeAssignments = async (req: Request, res: Response) => {
    actorOf(res, ADMIN);
    res.json(await this.admin.listScopeAssignments(parseOrThrow(queries.scopes, req.query)));
  };
  createScopeAssignment = async (req: Request, res: Response) => {
    const actor = actorOf(res, ADMIN);
    send(res, 201, await this.admin.createScopeAssignment(parseOrThrow(schemas.scopeCreate, req.body), actor));
  };
  updateScopeAssignment = async (req: Request, res: Response) => {
    const actor = actorOf(res, ADMIN);
    send(res, 200, await this.admin.updateScopeAssignment(String(req.params.assignmentId), parseOrThrow(schemas.scopeUpdate, req.body), ifMatchOf(req), actor));
  };

  // catalogue
  listChecklists = async (req: Request, res: Response) => {
    const actor = readerOf(res);
    res.json(await this.catalogue.list({ ...parseOrThrow(queries.checklists, req.query), includeDrafts: actor.role === 'STATE_ADMIN' }));
  };
  getChecklist = async (req: Request, res: Response) => {
    const actor = readerOf(res);
    send(res, 200, await this.catalogue.get(String(req.params.checklistVersionId), { includeDrafts: actor.role === 'STATE_ADMIN' }));
  };
  createDraft = async (req: Request, res: Response) => {
    const actor = actorOf(res, ADMIN);
    const dto = await this.catalogue.createDraft(parseOrThrow(schemas.draftCreate, req.body), actor);
    send(res, 201, dto, `/ipc/v1/checklists/${dto.id}`);
  };
  updateDraft = async (req: Request, res: Response) => {
    const actor = actorOf(res, ADMIN);
    send(res, 200, await this.catalogue.updateDraft(String(req.params.checklistVersionId), parseOrThrow(schemas.draftUpdate, req.body), ifMatchOf(req), actor));
  };
  publish = async (req: Request, res: Response) => {
    const actor = actorOf(res, ADMIN);
    const body = parseOrThrow(schemas.publish, req.body ?? {});
    send(res, 200, await this.catalogue.publish(String(req.params.checklistVersionId), ifMatchOf(req), actor, body.reason));
  };

  // rules
  listRiskDefaults = async (_req: Request, res: Response) => {
    actorOf(res, ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER']);
    res.json(await this.admin.listRiskDefaults());
  };
  setRiskDefault = async (req: Request, res: Response) => {
    const actor = actorOf(res, ADMIN);
    const level = parseOrThrow(riskLevel, req.params.riskLevel);
    send(res, 200, await this.admin.setRiskDefault(level, parseOrThrow(schemas.riskDefault, req.body), ifMatchOf(req), actor));
  };
  listEscalationRules = async (_req: Request, res: Response) => {
    actorOf(res, ['STATE_ADMIN', 'DISTRICT_QM']);
    res.json(await this.admin.listEscalationRules());
  };
  createEscalationRule = async (req: Request, res: Response) => {
    const actor = actorOf(res, ADMIN);
    send(res, 201, await this.admin.createEscalationRule(parseOrThrow(schemas.ruleCreate, req.body), actor));
  };
  updateEscalationRule = async (req: Request, res: Response) => {
    const actor = actorOf(res, ADMIN);
    const code = parseOrThrow(z.string().regex(/^R[0-9]{1,3}$/), req.params.ruleCode);
    send(res, 200, await this.admin.updateEscalationRule(code, parseOrThrow(schemas.ruleUpdate, req.body), ifMatchOf(req), actor));
  };

  // demo clock (FR-038): ClockService refuses shifts unless DEMO_MODE on dev/test/uat (403 DEMO_MODE_DISABLED)
  getClock = async (_req: Request, res: Response) => {
    actorOf(res, 'any');
    send(res, 200, await this.clock.view());
  };
  setClock = async (req: Request, res: Response) => {
    const actor = actorOf(res, ADMIN);
    const body = parseOrThrow(schemas.clockSet, req.body);
    const expected = ifMatchOf(req);
    const cur = await this.clock.view();
    if (expected !== undefined && expected !== cur.v) throw Problem.conflict('VERSION_CONFLICT', 'The clock changed since you opened it', { currentVersion: cur.v, current: cur });
    send(res, 200, await this.clock.set({ actor, ...body }));
  };
  resetClock = async (req: Request, res: Response) => {
    const actor = actorOf(res, ADMIN);
    const body = parseOrThrow(schemas.clockReset, req.body ?? {});
    send(res, 200, await this.clock.reset(actor, body.reason));
  };
}

// ---------------------------------------------------------------- internal register (adapters importers)
const facilityRow = z.object({
  facilityCode: z.string().min(1).max(64),
  elevateEntityId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  districtCode: z.string().min(1).max(32),
  level: z.enum(['district', 'sub-district', 'community']),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict().optional(),
  status: z.enum(['active', 'inactive']),
  wards: z.array(z.object({
    wardCode: z.string().min(1).max(32), elevateEntityId: z.string().min(1).max(64), name: z.string().min(1).max(200),
    wardType: z.string().min(1).max(32), active: z.boolean(),
  }).strict()).max(200),
  reason: z.string().max(500).optional(),
}).strict();
const staffRow = z.object({
  userId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  role,
  status: z.enum(['active', 'left']),
  scope: z.object({
    level: z.enum(SCOPE_LEVELS),
    districtCode: z.string().max(32).optional(),
    facilityCode: z.string().max(64).optional(),
    facilityCodes: z.array(z.string().max(64)).optional(),
    wardCodes: z.array(z.string().max(32)).optional(),
  }).strict(),
  validFrom: ts.optional(),
  reason: z.string().max(500).optional(),
}).strict();

/** Writes from the adapters' importers (service JWT, issuer ipc-adapters; acting STATE_ADMIN in `act`). */
export class RegisterController {
  constructor(private readonly admin: AdminService) {}

  upsertFacility = async (req: Request, res: Response) => {
    const actor = actorOf(res, ADMIN);
    const { reason, ...row } = parseOrThrow(facilityRow, req.body);
    res.json(await this.admin.upsertFacility(row, actor, reason ?? 'facility import'));
  };
  applyStaff = async (req: Request, res: Response) => {
    const actor = actorOf(res, ADMIN);
    const { reason, ...row } = parseOrThrow(staffRow, req.body);
    res.json(await this.admin.applyStaff(row, actor, reason ?? 'HR import'));
  };
}
