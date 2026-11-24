import { z } from 'zod';
import type { ElevateHttp } from './http.js';
import type { UserClient } from './user.js';

const Envelope = <T extends z.ZodTypeAny>(result: T) => z.object({ result }).passthrough();

export const SessionRequestSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  requestor_id: z.union([z.string(), z.number()]).transform(String),
  requestee_id: z.union([z.string(), z.number()]).transform(String),
  status: z.string(),
  title: z.string().nullish(),
  start_date: z.number().nullish(),
  end_date: z.number().nullish(),
  session_id: z.union([z.string(), z.number()]).nullish(),
  reject_reason: z.string().nullish(),
}).passthrough();
export type SessionRequest = z.infer<typeof SessionRequestSchema>;

export interface CreateSessionRequest {
  requesteeId: string;
  title: string;
  agenda: string;
  /** epoch seconds */
  startDate: number;
  endDate: number;
  timeZone?: string;
}

/** Role id of `mentor` in the user service (role list, observed 2026-11-23). */
export const MENTOR_ROLE_TITLE = 'mentor';

/** ELEVATE mentoring (research E3, E10, E11; register g1–g6). */
export class MentoringClient {
  constructor(private readonly http: ElevateHttp, private readonly user?: UserClient) {}

  /** g4: is the mentor free in [start, end] (epoch seconds)? */
  async isAvailable(userToken: string, mentorId: string, startEpoch: number, endEpoch: number): Promise<boolean> {
    const r = await this.http.call({
      operation: 'availability.isAvailable', method: 'GET',
      path: `/mentoring/v1/availability/isAvailable/${encodeURIComponent(mentorId)}`, query: { startEpoch, endEpoch },
      auth: { userToken }, schema: Envelope(z.object({ is_available: z.boolean() }).passthrough()),
    });
    return r.result.is_available;
  }

  /**
   * g4: the mentor publishes an availability window (mentor token). `isAvailable` answers true only
   * for a slot inside one window; a daily recurring window gives open slots every day (US6).
   */
  async createAvailability(mentorToken: string, input: { eventName: string; startTime: number; endTime: number; repeatUnit?: 'DAY' | 'WEEK' }): Promise<{ id: string }> {
    const r = await this.http.call({
      operation: 'availability.create', method: 'POST', path: '/mentoring/v1/availability/create',
      json: {
        event_name: input.eventName, start_time: input.startTime, end_time: input.endTime,
        ...(input.repeatUnit ? { repeat_unit: input.repeatUnit, repeat_increment: 1 } : {}),
      },
      auth: { userToken: mentorToken }, schema: Envelope(z.object({ id: z.union([z.string(), z.number()]).transform(String) }).passthrough()),
    });
    return { id: r.result.id };
  }

  /** g3: BROKEN on this stack (500); kept so preflight can record whether it recovered. */
  async listMentors(userToken: string, filters: Record<string, string> = {}): Promise<unknown> {
    const r = await this.http.call({
      operation: 'mentors.list', method: 'GET', path: '/mentoring/v1/mentors/list',
      query: { pageNo: 1, pageSize: 50, ...filters }, auth: { userToken },
    });
    return (r as { result?: unknown })?.result;
  }

  async mentorDetails(userToken: string, mentorId: string): Promise<unknown> {
    const r = await this.http.call({
      operation: 'mentors.details', method: 'GET', path: `/mentoring/v1/mentors/details/${encodeURIComponent(mentorId)}`,
      auth: { userToken },
    });
    return (r as { result?: unknown })?.result;
  }

  /** g5: officer asks a mentor for a session. ELEVATE rejects self, duplicate pending, bad duration. */
  async createSessionRequest(userToken: string, input: CreateSessionRequest): Promise<SessionRequest> {
    const r = await this.http.call({
      operation: 'requestSessions.create', method: 'POST', path: '/mentoring/v1/requestSessions/create',
      json: {
        requestee_id: input.requesteeId, title: input.title, agenda: input.agenda,
        start_date: input.startDate, end_date: input.endDate, time_zone: input.timeZone ?? 'Asia/Calcutta',
      },
      auth: { userToken }, schema: Envelope(SessionRequestSchema),
    });
    return r.result;
  }

  /** g5: mentor accepts (mentor token; `timezone` header). */
  async acceptSessionRequest(mentorToken: string, requestId: string, timeZone = 'Asia/Calcutta'): Promise<unknown> {
    const r = await this.http.call({
      operation: 'requestSessions.accept', method: 'POST', path: '/mentoring/v1/requestSessions/accept',
      json: { request_session_id: String(requestId) }, headers: { timezone: timeZone }, auth: { userToken: mentorToken },
    });
    return (r as { result?: unknown })?.result;
  }

  /** g5: mentor rejects with a reason. */
  async rejectSessionRequest(mentorToken: string, requestId: string, reason: string): Promise<unknown> {
    const r = await this.http.call({
      operation: 'requestSessions.reject', method: 'POST', path: '/mentoring/v1/requestSessions/reject',
      json: { request_session_id: String(requestId), reason }, auth: { userToken: mentorToken },
    });
    return (r as { result?: unknown })?.result;
  }

  /** g5: requests visible to the caller (requester or mentor). */
  async listSessionRequests(userToken: string, status?: string): Promise<{ data: SessionRequest[]; count: number }> {
    const r = await this.http.call({
      operation: 'requestSessions.list', method: 'GET', path: '/mentoring/v1/requestSessions/list',
      query: { status }, auth: { userToken },
      schema: Envelope(z.object({ data: z.array(SessionRequestSchema), count: z.number() })),
    });
    return r.result;
  }

  /**
   * E3 / g6: mentor onboarding goes through the user service role request, because assignRole
   * does not tell mentoring. Step 1 (user) → requestOrgRole; step 2 (org admin) → approve.
   */
  async requestMentorRole(userToken: string, mentorRoleId: number, about: string, experienceYears?: number) {
    if (!this.user) throw new Error('MentoringClient needs a UserClient for role requests');
    return this.user.requestOrgRole(userToken, mentorRoleId, {
      about, ...(experienceYears !== undefined ? { experience: String(experienceYears) } : {}),
    });
  }

  /**
   * g6 step 3: creates the mentoring user extension through mentoring's internal `users/add`, the
   * same path its user-create event consumer takes. Needed on this stack because the role-change
   * callback fails with MENTEE_EXTENSION_NOT_FOUND when no extension exists yet, and `users/create`
   * cannot read the profile without a token (observed 2026-11-23).
   */
  async addUserExtension(input: { id: number; name: string; email: string; organizationId: number | string; roles: string[] }): Promise<unknown> {
    const r = await this.http.call({
      operation: 'users.add', method: 'POST', path: '/mentoring/v1/users/add',
      json: { id: input.id, name: input.name, email: input.email, organization_id: String(input.organizationId), roles: input.roles.map((title) => ({ title })) },
      headers: { internal_access_token: this.internalToken() },
    });
    return (r as { result?: unknown })?.result;
  }

  private internalToken(): string {
    const h = this.http.buildHeaders({ internal: true });
    return h['internal-access-token'] ?? h.internal_access_token ?? '';
  }

  async approveMentorRole(orgAdminToken: string, requestId: number) {
    if (!this.user) throw new Error('MentoringClient needs a UserClient for role requests');
    return this.user.updateRoleRequest(orgAdminToken, requestId, 'APPROVED');
  }
}
