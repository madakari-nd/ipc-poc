import { randomUUID } from 'node:crypto';
import { request } from 'undici';
import { Problem, createResilience, currentTraceparent, type Resilience } from '@ipc/platform';
import type { Actor, EffectiveScopeResponse } from '../scope/types.js';
import { signServiceJwt } from './service-jwt.js';

/** Contract `LedgerAppendRequest`. */
export interface LedgerAppend {
  actor: { userId: string; role: string };
  action: string;
  subject: { type: string; id: string };
  reason?: string;
  beforeHash?: string;
  afterHash?: string;
  correlationId: string;
}

/** Contract `Facility` (subset the edge reads). */
export interface FacilityView {
  id: string;
  facilityCode: string;
  districtCode: string;
  location: { lat: number; lng: number };
  wards?: { id: string; wardCode: string; facilityId: string; active: boolean }[];
}

export interface HomeSummary {
  role: string;
  programmeNow: string;
  cards: { kind: string; count: number; href?: string; preview?: unknown[] }[];
}

/**
 * The edge's only door to workflow: its `/internal` operations and the mirrored public routes
 * (same shapes as `/ipc/v1`, acting user in the service JWT). Stubbed behind this interface in tests.
 */
export interface WorkflowClient {
  /** `internalGetEffectiveScope`. A 404 means the user has no assignment. */
  getEffectiveScope(userId: string): Promise<EffectiveScopeResponse>;
  /** `internalAppendLedger`. */
  appendLedger(entry: LedgerAppend): Promise<void>;
  /** Mirrored `listFacilities` (scope-filtered by workflow for the actor). */
  listFacilities(actor: Actor): Promise<FacilityView[]>;
  /** Mirrored `getHome`. */
  getHome(actor: Actor): Promise<HomeSummary>;
  /** Mirrored GET of a governed resource (task, plan, assessment, support request); null on 403/404. */
  getResource(actor: Actor, path: string): Promise<Record<string, unknown> | null>;
  ping(): Promise<boolean>;
}

/** 503 STORAGE_UNAVAILABLE naming the unavailable function (contract `Problem.unavailable`). */
export function unavailable(fn: string, cause?: unknown): Problem {
  const p = new Problem(503, 'STORAGE_UNAVAILABLE', `${fn} is unavailable, try again shortly`, { unavailable: [fn] });
  if (cause) p.cause = cause;
  return p;
}

export class HttpWorkflowClient implements WorkflowClient {
  private readonly resilience: Resilience;

  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    resilience?: Resilience,
  ) {
    this.resilience = resilience ?? createResilience('workflow');
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    o: { actor?: Actor; body?: unknown; idempotent: boolean; headers?: Record<string, string> },
  ): Promise<{ status: number; body: unknown }> {
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
          if (res.statusCode >= 500) throw new Error(`workflow ${res.statusCode}`);
          return { status: res.statusCode, body: text ? (JSON.parse(text) as unknown) : null };
        },
        { idempotent: o.idempotent },
      );
    } catch (err) {
      if (err instanceof Problem) throw err;
      throw unavailable('workflow', err);
    }
  }

  async getEffectiveScope(userId: string): Promise<EffectiveScopeResponse> {
    const r = await this.call('GET', `/internal/scopes/${encodeURIComponent(userId)}`, { idempotent: true });
    if (r.status === 404) return { userId, resolvedAt: new Date().toISOString(), assignments: [] };
    if (r.status !== 200) throw unavailable('workflow');
    return r.body as EffectiveScopeResponse;
  }

  async appendLedger(entry: LedgerAppend): Promise<void> {
    const r = await this.call('POST', '/internal/ledger/records', {
      body: entry,
      idempotent: true,
      headers: { 'idempotency-key': randomUUID() },
    });
    if (r.status !== 201 && r.status !== 200) throw new Error(`ledger append refused (${r.status})`);
  }

  async listFacilities(actor: Actor): Promise<FacilityView[]> {
    const items: FacilityView[] = [];
    let cursor: string | null = null;
    do {
      const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const r = await this.call('GET', `/ipc/v1/facilities?limit=100${q}`, { actor, idempotent: true });
      if (r.status === 403 || r.status === 404) return items;
      if (r.status !== 200) throw unavailable('workflow');
      const page = r.body as { items: FacilityView[]; nextCursor: string | null };
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  async getHome(actor: Actor): Promise<HomeSummary> {
    const r = await this.call('GET', '/ipc/v1/me/home', { actor, idempotent: true });
    if (r.status !== 200) throw unavailable('workflow');
    return r.body as HomeSummary;
  }

  async getResource(actor: Actor, path: string): Promise<Record<string, unknown> | null> {
    const r = await this.call('GET', path, { actor, idempotent: true });
    if (r.status === 200) return r.body as Record<string, unknown>;
    if (r.status === 403 || r.status === 404) return null;
    throw unavailable('workflow');
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.call('GET', '/internal/healthz', { idempotent: false });
      return r.status === 200;
    } catch {
      return false;
    }
  }
}
