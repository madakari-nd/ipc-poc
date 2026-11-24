import { Router, type Request, type Response } from 'express';
import { Problem, type Logger } from '@ipc/platform';
import type { ElevateTransport } from '../proxy/elevate.proxy.js';
import type { Auditor } from '../scope/audit.js';
import type { ScopeService } from '../scope/scope.service.js';
import type { Actor } from '../scope/types.js';
import type { SessionService } from '../session/session.service.js';
import { unavailable } from '../workflow/workflow.client.js';
import type { Forwarded, Forwarder } from './admin.routes.js';

export interface SupportRouteDeps {
  /** Mirrored support routes on workflow. */
  workflow: Forwarder;
  /** ELEVATE mentoring through the allow-list proxy, with the caller's own token (E10, E11). */
  mentoring: ElevateTransport;
}

interface Ctx {
  sessions: SessionService;
  audit: Auditor;
  scopes: ScopeService;
  logger: Logger;
}

interface SessionPlan { requesteeId: string; title: string; agenda: string; startEpoch: number; endEpoch: number; startAt: string }
interface ProbePlan { mentorIds: string[]; slotDays: string[][] }
interface ElevateSessionFact { id: string; status: string }

/**
 * ELEVATE answers an unfiltered list with nothing for the mentor's side (its mapping query treats
 * a missing status as a filter), so every status is asked for explicitly (observed 2026-11-24).
 */
const ALL_STATUSES = 'ACCEPTED,REQUESTED,REJECTED,EXPIRED';
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
const result = (b: unknown): unknown => (b && typeof b === 'object' ? (b as { result?: unknown }).result : undefined);

/**
 * Expert support (T107; US6, FR-022, FR-023, research E10/E11). Roles and bodies were checked
 * against the contract by the earlier stages; workflow enforces ward scope (officer/QM) and the
 * mentor's own requests (MENTOR: only requests addressed to them; a mentor's facility scope comes
 * from accepted requests). ELEVATE mentoring is called here only, with the caller's own token:
 * - `isAvailable` probes for the shortlist's open slots (create, and `refresh=true`);
 * - `requestSessions/create` with the OFFICER's token between workflow's plan and commit phases;
 * - `requestSessions/list` with the caller's token, so workflow learns which requests the mentor
 *   accepted in ELEVATE (list, outcome). What ELEVATE said reaches workflow as facts.
 */
export function supportRoutes(deps: SupportRouteDeps | undefined, c: Ctx): Router {
  const r = Router();
  const need = (): SupportRouteDeps => {
    if (!deps) throw Problem.unavailable('ELEVATE_UNAVAILABLE', 'Expert support is not configured');
    return deps;
  };
  const actorOf = (req: Request): Actor => {
    const role = req.scope?.activeRole;
    if (!req.scope || !role) throw Problem.forbidden('ROLE_DENIED', 'You have no programme role.');
    return { userId: req.scope.userId, role };
  };
  const token = (req: Request) => c.sessions.elevateAccessToken(req.session!);
  const sid = (req: Request) => String(req.params.supportRequestId);
  const base = (req: Request) => `/ipc/v1/support-requests/${encodeURIComponent(sid(req))}`;
  const ifMatch = (req: Request) => (req.ifMatch !== undefined ? { ifMatch: `"${req.ifMatch}"` } : {});

  /** Relays workflow's answer; a workflow scope refusal is ledgered like the Edge's own. */
  const reply = async (req: Request, res: Response, f: Forwarded, body: unknown = f.body) => {
    if (f.status === 403) {
      const code = (f.body as { code?: string } | null)?.code;
      await c.audit.record(req, code === 'ROLE_DENIED' ? 'role.denied' : 'scope.denied', req.params.supportRequestId ? { type: 'support_request', id: sid(req) } : undefined);
    }
    if (f.status >= 500 && (f.body as { code?: string } | null)?.code === undefined) throw unavailable('workflow');
    for (const [k, v] of Object.entries(f.headers)) res.setHeader(k, v);
    if (f.status >= 400) res.type('application/problem+json');
    if (body === null || body === undefined) return res.status(f.status).end();
    return res.status(f.status).json(body);
  };

  const elevateFailure = (status: number, what: string, body: unknown): Problem => {
    if (status === 401) return new Problem(401, 'SESSION_EXPIRED', 'Please sign in again');
    const msg = (body as { message?: string } | null)?.message;
    if (status >= 400 && status < 500) return Problem.unprocessable('VALIDATION_FAILED', `ELEVATE mentoring refused the ${what}${msg ? `: ${msg}` : ''}`);
    return new Problem(503, 'ELEVATE_UNAVAILABLE', `ELEVATE mentoring could not ${what}`, { unavailable: ['elevate-mentoring'] });
  };

  /** The caller's request sessions as ELEVATE sees them (requester or mentor). */
  const sessionFacts = async (req: Request): Promise<ElevateSessionFact[]> => {
    const t = await token(req);
    const out = await need().mentoring.forward({ method: 'GET', path: '/mentoring/v1/requestSessions/list', query: { pageNo: '1', pageSize: '100', status: ALL_STATUSES }, accessToken: t });
    if (out.status !== 200) throw elevateFailure(out.status, 'list session requests', out.body);
    const data = (result(out.body) as { data?: { id: unknown; status: unknown }[] } | undefined)?.data ?? [];
    return data.filter((x) => x.id !== undefined && typeof x.status === 'string').map((x) => ({ id: String(x.id), status: String(x.status) }));
  };

  /** First open one-hour slot per mentor: days in order, the day's slots in parallel (ELEVATE `isAvailable`). */
  const probe = async (req: Request, plan: ProbePlan) => {
    const t = await token(req);
    const free = async (mentorId: string, startIso: string) => {
      const start = Math.floor(Date.parse(startIso) / 1000);
      const out = await need().mentoring.forward({
        method: 'GET', path: `/mentoring/v1/availability/isAvailable/${encodeURIComponent(mentorId)}`,
        query: { startEpoch: String(start), endEpoch: String(start + 3600) }, accessToken: t,
      });
      if (out.status !== 200) throw elevateFailure(out.status, 'check mentor availability', out.body);
      return (result(out.body) as { is_available?: boolean } | undefined)?.is_available === true;
    };
    /** Display name from the mentor's ELEVATE profile; optional (the shortlist falls back to the id). */
    const name = async (mentorId: string) => {
      const out = await need().mentoring.forward({ method: 'GET', path: `/mentoring/v1/mentors/details/${encodeURIComponent(mentorId)}`, accessToken: t }).catch(() => undefined);
      const n = out?.status === 200 ? (result(out.body) as { name?: unknown } | undefined)?.name : undefined;
      return typeof n === 'string' && n.trim() ? { name: n.trim().slice(0, 200) } : {};
    };
    return Promise.all(plan.mentorIds.map(async (mentorId) => {
      const who = await name(mentorId);
      for (const day of plan.slotDays) {
        const hits = await Promise.all(day.map((s) => free(mentorId, s)));
        const i = hits.indexOf(true);
        if (i >= 0) return { mentorId, nextOpenSlotAt: day[i]!, ...who };
      }
      return { mentorId, nextOpenSlotAt: null, ...who };
    }));
  };

  /** Refreshes availability from ELEVATE and returns workflow's re-ranked shortlist (or its refusal). */
  const refreshedShortlist = async (req: Request, id: string): Promise<Forwarded> => {
    const { workflow } = need();
    const actor = actorOf(req);
    const path = `/ipc/v1/support-requests/${encodeURIComponent(id)}/shortlist`;
    const plan = await workflow.forward(actor, { method: 'GET', path: `${path}?refresh=true` });
    if (plan.status !== 200) return plan;
    const facts = await probe(req, plan.body as ProbePlan);
    return workflow.forward(actor, { method: 'GET', path: `${path}?refresh=true&availability=${b64(facts)}` });
  };

  // listSupportRequests: ELEVATE statuses first, so an acceptance in ELEVATE shows (and grants scope).
  r.get('/support-requests', async (req, res) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) q.set(k, String(v));
    let facts: ElevateSessionFact[] = [];
    try {
      facts = await sessionFacts(req);
    } catch (err) {
      // Reading the list must not fail because mentoring is down: statuses stay as last seen.
      c.logger.warn({ err }, 'ELEVATE requestSessions/list failed; listing without a status refresh');
    }
    if (facts.length) q.set('elevateSessions', b64(facts));
    const f = await need().workflow.forward(actorOf(req), { method: 'GET', path: `/ipc/v1/support-requests${q.size ? `?${q}` : ''}` });
    if (req.scope?.activeRole === 'MENTOR') c.scopes.invalidate(req.scope.userId);
    await reply(req, res, f);
  });

  // createSupportRequest: create (ranked from the register), then refresh availability from ELEVATE.
  r.post('/support-requests', async (req, res) => {
    const created = await need().workflow.forward(actorOf(req), { method: 'POST', path: '/ipc/v1/support-requests', body: req.body });
    if (created.status !== 201) return reply(req, res, created);
    const doc = created.body as { id: string; shortlist: unknown[] };
    try {
      const s = await refreshedShortlist(req, doc.id);
      if (s.status === 200) doc.shortlist = (s.body as { items: unknown[] }).items;
    } catch (err) {
      c.logger.warn({ err }, 'mentor availability refresh failed; shortlist uses cached availability');
    }
    return reply(req, res, created, doc);
  });

  r.get('/support-requests/:supportRequestId/shortlist', async (req, res) => {
    if (req.query.refresh === 'true' || (req.query.refresh as unknown) === true) return reply(req, res, await refreshedShortlist(req, sid(req)));
    return reply(req, res, await need().workflow.forward(actorOf(req), { method: 'GET', path: `${base(req)}/shortlist` }));
  });

  // requestMentorSession: workflow plans → ELEVATE requestSessions/create (officer token) → workflow commits.
  r.post('/support-requests/:supportRequestId/session-request', async (req, res) => {
    const { workflow, mentoring } = need();
    const actor = actorOf(req);
    const body = req.body as { mentorId: string; message?: string; proposedStartAt?: string };
    const planned = await workflow.forward(actor, { method: 'POST', path: `${base(req)}/session-request`, body: { ...body, phase: 'plan' }, ...ifMatch(req) });
    if (planned.status !== 200) return reply(req, res, planned);
    const p = planned.body as SessionPlan;
    const out = await mentoring.forward({
      method: 'POST', path: '/mentoring/v1/requestSessions/create', accessToken: await token(req),
      body: { requestee_id: p.requesteeId, title: p.title, agenda: p.agenda, start_date: p.startEpoch, end_date: p.endEpoch, time_zone: 'Asia/Calcutta' },
    });
    const made = result(out.body) as { id?: unknown } | undefined;
    if (out.status < 200 || out.status >= 300 || made?.id === undefined) throw elevateFailure(out.status >= 300 ? out.status : 503, 'create the session request', out.body);
    const committed = await workflow.forward(actor, {
      method: 'POST', path: `${base(req)}/session-request`,
      body: { mentorId: body.mentorId, phase: 'commit', elevateRequestSessionId: String(made.id), startAt: p.startAt }, ...ifMatch(req),
    });
    return reply(req, res, committed);
  });

  // recordSupportOutcome (mentor): workflow needs ELEVATE's word that the request was accepted.
  r.post('/support-requests/:supportRequestId/outcome', async (req, res) => {
    const facts = await sessionFacts(req);
    const f = await need().workflow.forward(actorOf(req), { method: 'POST', path: `${base(req)}/outcome`, body: { ...(req.body as object), elevateSessions: facts }, ...ifMatch(req) });
    c.scopes.invalidate(req.scope!.userId);
    return reply(req, res, f);
  });

  r.post('/support-requests/:supportRequestId/plan-actions', async (req, res) => {
    return reply(req, res, await need().workflow.forward(actorOf(req), { method: 'POST', path: `${base(req)}/plan-actions`, body: req.body, ...ifMatch(req) }));
  });

  return r;
}
