import { request } from 'undici';
import { DEFAULT_RESILIENCE, Problem, createResilience, currentTraceparent, type Resilience } from '@ipc/platform';
import type { ElevateTransport } from '../proxy/elevate.proxy.js';
import type { Actor } from '../scope/types.js';
import { signServiceJwt } from '../workflow/service-jwt.js';
import { unavailable } from '../workflow/workflow.client.js';

export interface Upstream {
  status: number;
  body: unknown;
}

/** Workflow side of the assessment journey (US2): mirrored reads/baseline and the internal context upsert. */
export interface AssessmentWorkflow {
  /** Mirrored GET as the acting user (listAssessments, getAssessment, getFormBundle, listFacilities, listCycles, listChecklistVersions). */
  get(actor: Actor, path: string): Promise<Upstream>;
  /** Mirrored PUT as the acting user (setAssessmentBaseline). */
  put(actor: Actor, path: string, body: unknown, o: { ifMatch?: string; idempotencyKey: string }): Promise<Upstream>;
  /** `internalUpsertAssessmentContext` (service identity only). */
  upsertContext(elevateSubmissionId: string, body: unknown, idempotencyKey: string): Promise<Upstream>;
}

/** undici + service JWT; GETs and the idempotent internal upsert are retried, the baseline PUT is sent once. */
export class HttpAssessmentWorkflow implements AssessmentWorkflow {
  private readonly resilience: Resilience;

  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    resilience?: Resilience,
  ) {
    this.resilience = resilience ?? createResilience('edge-assessments', { ...DEFAULT_RESILIENCE });
  }

  private async call(method: 'GET' | 'PUT', path: string, o: { actor?: Actor; body?: unknown; headers?: Record<string, string>; retry: boolean }): Promise<Upstream> {
    const token = await signServiceJwt(this.secret, o.actor);
    try {
      return await this.resilience.execute(
        async (signal) => {
          const tp = currentTraceparent();
          const res = await request(new URL(path, this.baseUrl), {
            method,
            signal,
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/json',
              ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
              ...(tp ? { traceparent: tp } : {}),
              ...o.headers,
            },
            body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
          });
          const text = await res.body.text();
          if (o.retry && res.statusCode >= 500) throw new Error(`workflow ${res.statusCode}`);
          let body: unknown = null;
          try {
            body = text ? (JSON.parse(text) as unknown) : null;
          } catch {
            body = null;
          }
          return { status: res.statusCode, body };
        },
        { idempotent: o.retry },
      );
    } catch (err) {
      if (err instanceof Problem) throw err;
      throw unavailable('workflow', err);
    }
  }

  get(actor: Actor, path: string) {
    return this.call('GET', path, { actor, retry: true });
  }

  put(actor: Actor, path: string, body: unknown, o: { ifMatch?: string; idempotencyKey: string }) {
    return this.call('PUT', path, { actor, body, retry: false, headers: { 'idempotency-key': o.idempotencyKey, ...(o.ifMatch ? { 'if-match': o.ifMatch } : {}) } });
  }

  upsertContext(elevateSubmissionId: string, body: unknown, idempotencyKey: string) {
    return this.call('PUT', `/internal/assessments/${encodeURIComponent(elevateSubmissionId)}/context`, {
      body,
      retry: true, // keyed: a replay returns the stored answer
      headers: { 'idempotency-key': idempotencyKey },
    });
  }
}

// ------------------------------------------------------------------------------------------------
// ELEVATE samiksha, with the user's own token, through the allow-list proxy (E6, E7)

export interface ElevateQuestion {
  _id: string;
  externalId?: string;
  responseType: string;
  question?: unknown;
  options?: { value: string; label?: string }[];
  criteriaId?: string;
  evidenceMethod?: string;
  payload?: { criteriaId?: string } | null;
  pageQuestions?: ElevateQuestion[];
}

export interface ElevateEvidence {
  externalId: string;
  isSubmitted?: boolean;
  sections: { questions: ElevateQuestion[] }[];
}

export interface ElevateSubmissionSummary {
  _id: string;
  status: string;
  submissionNumber?: number;
}

export interface AssessmentElevate {
  listObservations(token: string): Promise<{ _id: string; solutionId?: string }[]>;
  createObservation(token: string, solutionId: string, data: { name: string; entities: string[] }): Promise<string>;
  listSubmissions(token: string, observationId: string, entityId: string): Promise<ElevateSubmissionSummary[]>;
  createSubmission(token: string, observationId: string, entityId: string): Promise<void>;
  assessmentForm(token: string, observationId: string, entityId: string, submissionNumber: number): Promise<{ submissionId: string; evidences: ElevateEvidence[] }>;
  updateSubmission(token: string, submissionId: string, evidence: Record<string, unknown>): Promise<{ status: string }>;
}

type Envelope = { result?: unknown; message?: string };
const result = (b: unknown): unknown => (b && typeof b === 'object' ? (b as Envelope).result : undefined);

/** Implementation over the Edge allow-list proxy (FR-034): nothing outside the allow-list can be called. */
export class ProxiedAssessmentElevate implements AssessmentElevate {
  constructor(private readonly t: ElevateTransport) {}

  private ok(r: { status: number; body: unknown }, what: string): unknown {
    if (r.status === 401) throw new Problem(401, 'SESSION_EXPIRED', 'Please sign in again');
    if (r.status < 200 || r.status >= 300) {
      throw new Problem(503, 'ELEVATE_UNAVAILABLE', `ELEVATE refused ${what} (${r.status})`, { unavailable: ['elevate-samiksha'] });
    }
    return result(r.body);
  }

  async listObservations(token: string) {
    const r = await this.t.forward({ method: 'GET', path: '/survey/v1/observations/list', accessToken: token });
    const list = this.ok(r, 'observation list');
    return Array.isArray(list) ? (list as { _id: string; solutionId?: string }[]) : [];
  }

  async createObservation(token: string, solutionId: string, data: { name: string; entities: string[] }) {
    // d3: no userRoleAndProfileInformation, so the client can never steer targeting (V3).
    const r = await this.t.forward({
      method: 'POST',
      path: '/survey/v1/observations/create',
      query: { solutionId },
      accessToken: token,
      body: { data: { name: data.name, description: data.name, status: 'published', entities: data.entities } },
    });
    const res = this.ok(r, 'observation create') as { _id?: string } | undefined;
    return String(res?._id ?? '');
  }

  async listSubmissions(token: string, observationId: string, entityId: string) {
    const r = await this.t.forward({ method: 'GET', path: `/survey/v1/observationSubmissions/list/${observationId}`, query: { entityId }, accessToken: token });
    const list = this.ok(r, 'submission list');
    return Array.isArray(list) ? (list as ElevateSubmissionSummary[]) : [];
  }

  async createSubmission(token: string, observationId: string, entityId: string) {
    const r = await this.t.forward({ method: 'POST', path: `/survey/v1/observationSubmissions/create/${observationId}`, query: { entityId }, accessToken: token, body: {} });
    this.ok(r, 'submission create');
  }

  async assessmentForm(token: string, observationId: string, entityId: string, submissionNumber: number) {
    const r = await this.t.forward({
      method: 'POST',
      path: `/survey/v1/observations/assessment/${observationId}`,
      query: { entityId, submissionNumber: String(submissionNumber), ecmMethod: '' },
      accessToken: token,
    });
    const res = this.ok(r, 'assessment form') as { assessment?: { submissionId?: string; evidences?: ElevateEvidence[] } } | undefined;
    if (!res?.assessment?.submissionId) throw new Problem(503, 'ELEVATE_UNAVAILABLE', 'ELEVATE returned no submission', { unavailable: ['elevate-samiksha'] });
    return { submissionId: res.assessment.submissionId, evidences: res.assessment.evidences ?? [] };
  }

  async updateSubmission(token: string, submissionId: string, evidence: Record<string, unknown>) {
    const r = await this.t.forward({ method: 'POST', path: `/survey/v1/observationSubmissions/update/${submissionId}`, accessToken: token, body: { evidence } });
    const res = this.ok(r, 'submission') as { status?: string } | undefined;
    return { status: String(res?.status ?? '') };
  }
}
