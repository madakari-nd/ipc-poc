import { request } from 'undici';
import { Problem, createResilience, currentTraceparent, type Resilience } from '@ipc/platform';
import type { Actor } from '../scope/types.js';
import type { LedgerAppend, WorkflowClient } from '../workflow/workflow.client.js';

export type ElevateService = 'user' | 'samiksha' | 'mentoring';

interface AllowRule {
  id: string;
  service: ElevateService;
  method: 'GET' | 'POST';
  pattern: RegExp;
}

const SEG = '[A-Za-z0-9_-]{1,64}';

/**
 * The ONLY ELEVATE routes the edge will ever call on a user's behalf (T043, FR-034):
 * research E6 (observation per ward + its form), E7 (submit / repeat submission), E11 (mentoring
 * request sessions), plus the user-service login/refresh/logout the BFF session needs (E1).
 * Everything else, including the scheduler (V2), `files/*` (V1) and every admin/internal route,
 * is refused with 404 before any network call.
 */
export const ELEVATE_ALLOW_LIST: readonly AllowRule[] = [
  { id: 'E1.login', service: 'user', method: 'POST', pattern: /^\/user\/v1\/account\/login$/ },
  { id: 'E1.refresh', service: 'user', method: 'POST', pattern: /^\/user\/v1\/account\/generateToken$/ },
  { id: 'E1.logout', service: 'user', method: 'POST', pattern: /^\/user\/v1\/account\/logout$/ },
  { id: 'E6.observation.create', service: 'samiksha', method: 'POST', pattern: /^\/survey\/v1\/observations\/create$/ },
  {
    id: 'E6.observation.assessment',
    service: 'samiksha',
    method: 'POST',
    pattern: new RegExp(`^/survey/v1/observations/assessment/${SEG}$`),
  },
  {
    id: 'E7.submission.update',
    service: 'samiksha',
    method: 'POST',
    pattern: new RegExp(`^/survey/v1/observationSubmissions/update/${SEG}$`),
  },
  {
    id: 'E7.submission.create',
    service: 'samiksha',
    method: 'POST',
    pattern: new RegExp(`^/survey/v1/observationSubmissions/create/${SEG}$`),
  },
  // US2 (E6 revised): read-only lookups of the caller's own observation and submission status (d7).
  { id: 'E6.observation.list', service: 'samiksha', method: 'GET', pattern: /^\/survey\/v1\/observations\/list$/ },
  {
    id: 'E7.submission.list',
    service: 'samiksha',
    method: 'GET',
    pattern: new RegExp(`^/survey/v1/observationSubmissions/list/${SEG}$`),
  },
  { id: 'E11.session.create', service: 'mentoring', method: 'POST', pattern: /^\/mentoring\/v1\/requestSessions\/create$/ },
  { id: 'E11.session.accept', service: 'mentoring', method: 'POST', pattern: /^\/mentoring\/v1\/requestSessions\/accept$/ },
  { id: 'E11.session.reject', service: 'mentoring', method: 'POST', pattern: /^\/mentoring\/v1\/requestSessions\/reject$/ },
  { id: 'E11.session.list', service: 'mentoring', method: 'GET', pattern: /^\/mentoring\/v1\/requestSessions\/list$/ },
  // US6 (E10): mentor open-slot probe for the shortlist (mentors/list is broken on this stack).
  {
    id: 'E10.availability.isAvailable',
    service: 'mentoring',
    method: 'GET',
    pattern: new RegExp(`^/mentoring/v1/availability/isAvailable/${SEG}$`),
  },
  // US6 (E10): the mentor's display name for the shortlist (read-only profile).
  {
    id: 'E10.mentor.details',
    service: 'mentoring',
    method: 'GET',
    pattern: new RegExp(`^/mentoring/v1/mentors/details/${SEG}$`),
  },
];

/** Returns the matching allow-list rule, or null (→ 404). Paths with dot-segments never match. */
export function matchAllowList(method: string, path: string): AllowRule | null {
  if (path.includes('..') || path.includes('//') || /%2e|%2f/i.test(path)) return null;
  return ELEVATE_ALLOW_LIST.find((r) => r.method === method.toUpperCase() && r.pattern.test(path)) ?? null;
}

export interface ProxyRequest {
  method: 'GET' | 'POST';
  /** Acting user (for the checklist-edit guard's ledger record). */
  actor?: Actor;
  correlationId?: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** The user's ELEVATE access token (sent as x-auth-token). */
  accessToken?: string;
  extraHeaders?: Record<string, string>;
}

export interface ProxyResponse {
  status: number;
  body: unknown;
}

export interface ElevateTransport {
  forward(req: ProxyRequest): Promise<ProxyResponse>;
}

/**
 * Allow-list proxy to ELEVATE. Client headers are never forwarded: the edge builds every header
 * itself (no internal or admin token ever leaves through here). Timeouts and breaker per service.
 */
export class ElevateProxy implements ElevateTransport {
  private readonly breakers = new Map<ElevateService, Resilience>();

  constructor(
    private readonly baseUrls: Partial<Record<ElevateService, string>>,
    private readonly origin: string,
    resilienceFactory: (svc: ElevateService) => Resilience = (svc) => createResilience(`elevate-${svc}`),
    /** T073: refuses samiksha solution/question edits on published checklist versions (409 + ledger). */
    private readonly checklistGuard?: ChecklistEditGuard,
  ) {
    for (const svc of ['user', 'samiksha', 'mentoring'] as const) this.breakers.set(svc, resilienceFactory(svc));
  }

  async forward(req: ProxyRequest): Promise<ProxyResponse> {
    await this.checklistGuard?.check(req);
    const rule = matchAllowList(req.method, req.path);
    if (!rule) throw Problem.notFound('No such route');
    const base = this.baseUrls[rule.service];
    if (!base) throw Problem.notFound('No such route');
    const url = new URL(req.path, base);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    const breaker = this.breakers.get(rule.service)!;
    try {
      return await breaker.execute(
        async (signal) => {
          const tp = currentTraceparent();
          const res = await request(url, {
            method: req.method,
            signal,
            headers: {
              accept: 'application/json',
              origin: this.origin,
              ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
              ...(req.accessToken ? { 'x-auth-token': req.accessToken } : {}),
              ...(tp ? { traceparent: tp } : {}),
              ...req.extraHeaders,
            },
            body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
          });
          const text = await res.body.text();
          if (res.statusCode >= 500) throw new Error(`elevate ${rule.service} ${res.statusCode}`);
          let body: unknown = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = null;
          }
          return { status: res.statusCode, body };
        },
        { idempotent: rule.method === 'GET' },
      );
    } catch (err) {
      const p = new Problem(503, 'ELEVATE_UNAVAILABLE', 'ELEVATE is unavailable, try again shortly', {
        unavailable: [`elevate-${rule.service}`],
      });
      p.cause = err;
      throw p;
    }
  }

  circuit(svc: ElevateService): 'closed' | 'open' | 'half_open' {
    const s = this.breakers.get(svc)?.state();
    return s === 'open' || s === 'isolated' ? 'open' : s === 'half-open' ? 'half_open' : 'closed';
  }
}

// ------------------------------------------------------------------------------------------------
// T073: published checklist versions are immutable (FR-005, US1 AS3)

/**
 * samiksha routes that change a solution, its questions or criteria. None is on the allow-list, so
 * they are never forwarded; when one targets a PUBLISHED (or retired) checklist version the Edge
 * answers 409 CHECKLIST_PUBLISHED and records the attempt, instead of a silent 404.
 */
export const CHECKLIST_EDIT_ROUTES: readonly { id: string; pattern: RegExp }[] = [
  { id: 'solutions.update', pattern: new RegExp(`^/survey/v1/solutions/update/(${SEG})$`) },
  { id: 'solutions.importFromSolution', pattern: /^\/survey\/v1\/solutions\/importFromSolution$/ },
  { id: 'solutions.addEntities', pattern: new RegExp(`^/survey/v1/solutions/(?:addEntities|removeEntities|updateEntities)/(${SEG})$`) },
  { id: 'questions.update', pattern: new RegExp(`^/survey/v1/questions/(?:update|delete)/(${SEG})$`) },
  { id: 'questions.bulk', pattern: /^\/survey\/v1\/questions\/(?:bulkCreate|bulkUpdate)$/ },
  { id: 'criteria.update', pattern: new RegExp(`^/survey/v1/criteria/(?:update|upload)(?:/(${SEG}))?$`) },
];

export function matchChecklistEdit(method: string, path: string): { id: string; pathId?: string } | null {
  if (method.toUpperCase() !== 'POST' && method.toUpperCase() !== 'PATCH' && method.toUpperCase() !== 'PUT' && method.toUpperCase() !== 'DELETE') return null;
  for (const r of CHECKLIST_EDIT_ROUTES) {
    const m = r.pattern.exec(path);
    if (m) return { id: r.id, ...(m[1] ? { pathId: m[1] } : {}) };
  }
  return null;
}

/** A published/retired checklist version as the guard sees it. */
export interface LockedChecklist {
  checklistVersionId: string;
  /** ELEVATE solution _id and externalId. */
  solutionIds: string[];
  /** ROOT question externalIds (copies are `<root>-<epoch>`). */
  questionRoots: string[];
}

const COPY_SUFFIX = /(?:-\d{10,13})+$/;

export class ChecklistEditGuard {
  private cache: { at: number; locked: LockedChecklist[] } | undefined;

  constructor(
    private readonly lookup: () => Promise<LockedChecklist[]>,
    private readonly ledger: (entry: LedgerAppend) => Promise<void>,
    private readonly o: { ttlMs?: number; now?: () => number } = {},
  ) {}

  private async locked(): Promise<LockedChecklist[]> {
    const now = this.o.now?.() ?? Date.now();
    if (this.cache && now - this.cache.at < (this.o.ttlMs ?? 60_000)) return this.cache.locked;
    const locked = await this.lookup();
    this.cache = { at: now, locked };
    return locked;
  }

  /** Ids in the path, query or body that may name a solution or a question. */
  private candidates(req: ProxyRequest, pathId?: string): string[] {
    const out = new Set<string>();
    if (pathId) out.add(pathId);
    const add = (v: unknown) => {
      if (typeof v === 'string' && v.length <= 128) out.add(v);
    };
    for (const k of ['solutionId', 'solutionExternalId', 'externalId', 'questionId', 'questionExternalId']) add(req.query?.[k]);
    if (req.body && typeof req.body === 'object') {
      const b = req.body as Record<string, unknown>;
      for (const k of ['solutionId', 'solutionExternalId', 'externalId', 'questionId', 'questionExternalId']) add(b[k]);
    }
    return [...out];
  }

  async check(req: ProxyRequest): Promise<void> {
    const edit = matchChecklistEdit(req.method, req.path.split('?')[0]!);
    if (!edit) return;
    const ids = this.candidates(req, edit.pathId);
    if (!ids.length) return;
    const hit = (await this.locked()).find((l) =>
      ids.some((id) => l.solutionIds.includes(id) || l.questionRoots.includes(id.replace(COPY_SUFFIX, ''))),
    );
    if (!hit) return;
    await this.ledger({
      actor: req.actor ? { userId: req.actor.userId.slice(0, 64), role: req.actor.role } : { userId: 'unknown', role: 'SYSTEM' },
      action: 'checklist.edit_refused',
      subject: { type: 'checklist_version', id: hit.checklistVersionId },
      reason: `ELEVATE ${edit.id} on a published checklist version refused at the Edge`,
      correlationId: (req.correlationId ?? 'none').slice(0, 64),
    });
    throw Problem.conflict('CHECKLIST_PUBLISHED', 'This checklist version is published and cannot be changed. Create a new draft instead.');
  }
}

/** Published/retired versions from workflow's catalogue (`listChecklistVersions`, all pages). */
export function workflowLockedChecklists(workflow: WorkflowClient): () => Promise<LockedChecklist[]> {
  const system: Actor = { userId: 'ipc-edge', role: 'SYSTEM' };
  return async () => {
    const out: LockedChecklist[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const body = (await workflow.getResource(system, `/ipc/v1/checklists?limit=100${q}`)) as
        | { items: { id: string; status: string; elevateSolutionId?: string; elevateObservationTemplateId?: string; questions?: { elevateQuestionExternalId?: string }[] }[]; nextCursor: string | null }
        | null;
      if (!body) break;
      for (const v of body.items) {
        if (v.status === 'draft') continue;
        out.push({
          checklistVersionId: v.id,
          solutionIds: [v.elevateSolutionId, v.elevateObservationTemplateId].filter((x): x is string => !!x),
          questionRoots: (v.questions ?? []).map((q) => q.elevateQuestionExternalId?.replace(COPY_SUFFIX, '')).filter((x): x is string => !!x),
        });
      }
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    return out;
  };
}
