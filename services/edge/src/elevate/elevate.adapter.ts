import { Problem } from '@ipc/platform';
import type { ElevateTransport } from '../proxy/elevate.proxy.js';

export interface ElevateLoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; name: string; preferredLanguage?: string };
}

/** ELEVATE user-service calls the BFF session needs (research a1, E1). */
export interface ElevateUserApi {
  login(identifier: string, password: string): Promise<ElevateLoginResult>;
  refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string }>;
  logout(accessToken: string, refreshToken: string): Promise<void>;
}

/** ELEVATE samiksha calls made on the user's behalf after scope + ownership checks (E6, E7). */
export interface ElevateSamikshaApi {
  createObservation(accessToken: string, solutionId: string, data: { name: string; description: string; entities: string[] }): Promise<{ observationId: string }>;
  getAssessment(accessToken: string, observationId: string, entityId: string, submissionNumber?: number): Promise<unknown>;
  updateSubmission(accessToken: string, submissionId: string, evidence: unknown, gpsLocation?: string): Promise<{ status: string }>;
  createSubmission(accessToken: string, observationId: string, entityId: string): Promise<unknown>;
}

type Envelope = { result?: Record<string, unknown>; message?: string };

const asEnvelope = (b: unknown): Envelope => (b && typeof b === 'object' ? (b as Envelope) : {});

/** undici-backed implementation over the allow-list proxy; swappable for `@ipc/elevate-client`. */
export class ProxiedElevateUserApi implements ElevateUserApi {
  constructor(private readonly t: ElevateTransport) {}

  async login(identifier: string, password: string): Promise<ElevateLoginResult> {
    const r = await this.t.forward({ method: 'POST', path: '/user/v1/account/login', body: { identifier, password } });
    if (r.status === 400 || r.status === 401 || r.status === 404 || r.status === 422) {
      throw Problem.unauthorized('Sign-in failed. Check your email or phone and password.');
    }
    const res = asEnvelope(r.body).result ?? {};
    const user = (res.user ?? {}) as Record<string, unknown>;
    const access = res.access_token;
    const refresh = res.refresh_token;
    if (r.status !== 200 || typeof access !== 'string' || typeof refresh !== 'string' || user.id === undefined) {
      throw new Problem(503, 'ELEVATE_UNAVAILABLE', 'Sign-in is unavailable, try again shortly', { unavailable: ['elevate-user'] });
    }
    return {
      accessToken: access,
      refreshToken: refresh,
      user: {
        id: String(user.id),
        name: typeof user.name === 'string' ? user.name : '',
        preferredLanguage: typeof user.preferred_language === 'string' ? user.preferred_language : undefined,
      },
    };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string }> {
    const r = await this.t.forward({ method: 'POST', path: '/user/v1/account/generateToken', body: { refresh_token: refreshToken } });
    const res = asEnvelope(r.body).result ?? {};
    if (r.status !== 200 || typeof res.access_token !== 'string') throw new Problem(401, 'SESSION_EXPIRED', 'Please sign in again');
    return {
      accessToken: res.access_token,
      refreshToken: typeof res.refresh_token === 'string' ? res.refresh_token : undefined,
    };
  }

  async logout(accessToken: string, refreshToken: string): Promise<void> {
    await this.t.forward({ method: 'POST', path: '/user/v1/account/logout', accessToken, body: { refresh_token: refreshToken } });
  }
}

export class ProxiedElevateSamikshaApi implements ElevateSamikshaApi {
  constructor(private readonly t: ElevateTransport) {}

  private ok(r: { status: number; body: unknown }, what: string): Record<string, unknown> {
    if (r.status !== 200) throw Problem.unprocessable('VALIDATION_FAILED', `ELEVATE refused ${what}`);
    return asEnvelope(r.body).result ?? {};
  }

  async createObservation(accessToken: string, solutionId: string, data: { name: string; description: string; entities: string[] }) {
    // d3: omit userRoleAndProfileInformation so the client can never steer targeting (V3).
    const r = await this.t.forward({
      method: 'POST',
      path: '/survey/v1/observations/create',
      query: { solutionId },
      accessToken,
      body: { data: { ...data, status: 'published' } },
    });
    const res = this.ok(r, 'observation create');
    return { observationId: String(res._id ?? res.id ?? '') };
  }

  async getAssessment(accessToken: string, observationId: string, entityId: string, submissionNumber?: number) {
    const r = await this.t.forward({
      method: 'POST',
      path: `/survey/v1/observations/assessment/${observationId}`,
      query: { entityId, ...(submissionNumber ? { submissionNumber: String(submissionNumber) } : {}), ecmMethod: 'OB' },
      accessToken,
    });
    return this.ok(r, 'assessment form');
  }

  async updateSubmission(accessToken: string, submissionId: string, evidence: unknown, gpsLocation?: string) {
    const r = await this.t.forward({
      method: 'POST',
      path: `/survey/v1/observationSubmissions/update/${submissionId}`,
      accessToken,
      body: { evidence },
      extraHeaders: gpsLocation ? { gpslocation: gpsLocation } : undefined,
    });
    const res = this.ok(r, 'submission');
    return { status: String(res.status ?? '') };
  }

  async createSubmission(accessToken: string, observationId: string, entityId: string) {
    const r = await this.t.forward({
      method: 'POST',
      path: `/survey/v1/observationSubmissions/create/${observationId}`,
      query: { entityId },
      accessToken,
    });
    return this.ok(r, 'submission create');
  }
}
