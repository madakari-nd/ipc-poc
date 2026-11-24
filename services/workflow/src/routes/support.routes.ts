import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Problem } from '@ipc/platform';
import { serviceJwtAuth, type ServiceJwtOptions } from '../auth/service-jwt.js';
import { actorOf, ifMatchOf } from '../controllers/admin.controller.js';
import { parseOrThrow } from '../controllers/validate.js';
import { RISK_LEVELS, SKILLS, SUPPORT_REQUEST_STATUSES } from '../domain/models/index.js';
import type { Role } from '../domain/scope.js';
import type { ScopeService } from '../services/scope.service.js';
import type { SupportActor, SupportService } from '../services/support.service.js';

export interface SupportRoutesDeps {
  jwt: ServiceJwtOptions;
  support: SupportService;
  scope: ScopeService;
}

const LIST_ROLES: Role[] = ['DISTRICT_QM', 'IPC_OFFICER', 'MENTOR', 'STATE_ADMIN'];
const RAISERS: Role[] = ['IPC_OFFICER', 'DISTRICT_QM'];

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const ts = z.string().datetime({ offset: true });
const free = z.string().min(1).max(500);
const ref = z.string().min(1).max(64);
const lang = z.enum(['en', 'hi', 'kn']);

/** Facts the Edge read from ELEVATE mentoring with the caller's own token (never client input). */
const sessionFacts = z.array(z.object({ id: ref, status: z.string().min(1).max(32) }).strict()).max(500);
const availabilityFacts = z.array(z.object({ mentorId: ref, nextOpenSlotAt: ts.nullable(), name: z.string().min(1).max(200).optional() }).strict()).max(200);
/** Facts travel in the query of GETs as base64url JSON (Edge-built URL; the public contract has no such parameter). */
const decodeFacts = <T>(schema: z.ZodType<T>, raw: unknown): T | undefined => {
  if (typeof raw !== 'string' || !raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw Problem.badRequest('VALIDATION_FAILED', 'facts are not valid');
  }
  return parseOrThrow(schema, parsed);
};

const listQuery = z.object({
  status: z.enum(SUPPORT_REQUEST_STATUSES).optional(), wardId: oid.optional(),
  cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
  elevateSessions: z.string().max(40_000).optional(),
}).strict();
const shortlistQuery = z.object({
  refresh: z.enum(['true', 'false']).optional(), availability: z.string().max(40_000).optional(),
}).strict();
const create = z.object({ wardId: oid, problem: free, skill: z.enum(SKILLS), language: lang }).strict();
const session = z.object({
  mentorId: ref, message: free.optional(), proposedStartAt: ts.optional(),
  /** Edge-only: phase 1 plans the ELEVATE call, phase 2 records its result. */
  phase: z.enum(['plan', 'commit']),
  elevateRequestSessionId: ref.optional(), startAt: ts.optional(),
}).strict().refine((b) => b.phase === 'plan' || !!b.elevateRequestSessionId, 'commit needs elevateRequestSessionId');
const outcome = z.object({
  held: z.literal(true), heldAt: ts, agreedActions: z.array(z.object({ text: free }).strict()).min(1).max(20),
  elevateSessions: sessionFacts.optional(),
}).strict();
const toPlan = z.object({
  reason: free.optional(),
  actions: z.array(z.object({ index: z.number().int().min(0), ownerUserId: ref, riskLevel: z.enum(RISK_LEVELS), dueAt: ts.optional() }).strict()).min(1).max(20),
}).strict();

/**
 * Mirrored public support routes (US6, T106/T107): `listSupportRequests`, `createSupportRequest`,
 * `getMentorShortlist`, `requestMentorSession`, `recordSupportOutcome`, `addAgreedActionsToPlan`.
 * Reached only through the Edge (service JWT, acting user in `act`), which calls ELEVATE mentoring
 * with the user's token and passes what it saw as facts; scope is always server-derived.
 */
export function supportRoutes(d: SupportRoutesDeps): Router {
  const r = Router();
  const auth = serviceJwtAuth(d.jwt);

  const scoped = async (res: Response, roles: Role[]): Promise<SupportActor> => {
    const actor = actorOf(res, roles);
    try {
      const eff = await d.scope.effective(actor.userId);
      return { userId: actor.userId, role: actor.role, assignments: eff.assignments.map((a) => ({ role: a.role, scope: a.scope })), mentorFacilityIds: eff.mentorFacilityIds };
    } catch (err) {
      if (err instanceof Problem && err.status === 404) return { userId: actor.userId, role: actor.role, assignments: [] };
      throw err;
    }
  };
  const send = (res: Response, status: number, body: object & { v?: number }) => {
    if (typeof body.v === 'number') res.setHeader('ETag', `"${body.v}"`);
    res.status(status).json(body);
  };
  const id = (req: Request) => parseOrThrow(oid, req.params.supportRequestId);

  r.get('/ipc/v1/support-requests', auth, async (req, res) => {
    const a = await scoped(res, LIST_ROLES);
    const q = parseOrThrow(listQuery, req.query);
    res.json(await d.support.list(a, q, decodeFacts(sessionFacts, q.elevateSessions)));
  });
  r.post('/ipc/v1/support-requests', auth, async (req, res) => {
    send(res, 201, await d.support.create(parseOrThrow(create, req.body), await scoped(res, RAISERS)));
  });
  /** Edge-only helper for the availability probe: which mentors and slots to try (no request data). */
  r.get('/ipc/v1/support-requests/:supportRequestId/shortlist', auth, async (req, res) => {
    const a = await scoped(res, RAISERS);
    const q = parseOrThrow(shortlistQuery, req.query);
    if (q.refresh === 'true' && !q.availability) {
      // Phase 1 of a refresh: the Edge asks what to probe, after the request passed the scope check.
      await d.support.shortlist(id(req), a);
      res.json(await d.support.probePlan());
      return;
    }
    res.json(await d.support.shortlist(id(req), a, decodeFacts(availabilityFacts, q.availability)));
  });
  r.post('/ipc/v1/support-requests/:supportRequestId/session-request', auth, async (req, res) => {
    const a = await scoped(res, RAISERS);
    const b = parseOrThrow(session, req.body);
    if (b.phase === 'plan') {
      res.json(await d.support.planSession(id(req), b, ifMatchOf(req), a));
      return;
    }
    send(res, 200, await d.support.commitSession(id(req), { mentorId: b.mentorId, elevateRequestSessionId: b.elevateRequestSessionId!, ...(b.startAt ? { startAt: b.startAt } : {}) }, ifMatchOf(req), a));
  });
  r.post('/ipc/v1/support-requests/:supportRequestId/outcome', auth, async (req, res) => {
    const a = await scoped(res, ['MENTOR']);
    const { elevateSessions, ...b } = parseOrThrow(outcome, req.body);
    send(res, 200, await d.support.outcome(id(req), b, ifMatchOf(req), a, elevateSessions ?? []));
  });
  r.post('/ipc/v1/support-requests/:supportRequestId/plan-actions', auth, async (req, res) => {
    const a = await scoped(res, RAISERS);
    send(res, 201, await d.support.addToPlan(id(req), parseOrThrow(toPlan, req.body), ifMatchOf(req), a));
  });
  return r;
}
