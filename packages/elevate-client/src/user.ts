import { z } from 'zod';
import type { ElevateHttp } from './http.js';
import { userOrgHeaders } from './http.js';

const Role = z.object({ id: z.number(), title: z.string() }).passthrough();
const Organization = z.object({
  id: z.number(), code: z.string(), name: z.string().optional(), roles: z.array(Role).optional(),
}).passthrough();
export const ElevateUserSchema = z.object({
  id: z.number(),
  name: z.string(),
  tenant_code: z.string().optional(),
  organizations: z.array(Organization).optional(),
}).passthrough();
export type ElevateUser = z.infer<typeof ElevateUserSchema>;

const Envelope = <T extends z.ZodTypeAny>(result: T) => z.object({ result }).passthrough();

const LoginResult = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  user: ElevateUserSchema,
});
export type LoginResult = z.infer<typeof LoginResult>;

/** Claims ELEVATE puts in the access JWT (img:user/services/account.js:500-509). */
export const TokenClaimsSchema = z.object({
  data: z.object({
    id: z.union([z.number(), z.string()]),
    name: z.string().optional(),
    session_id: z.union([z.number(), z.string()]).optional(),
    organization_ids: z.array(z.string()).optional(),
    organization_codes: z.array(z.string()).optional(),
    tenant_code: z.string().optional(),
    organizations: z.array(Organization).optional(),
  }).passthrough(),
  iat: z.number(),
  exp: z.number(),
});
export type TokenClaims = z.infer<typeof TokenClaimsSchema>;

/** Decodes (does NOT verify) an ELEVATE access token. Verification is ELEVATE's job. */
export function decodeToken(token: string): TokenClaims {
  const part = token.split('.')[1];
  if (!part) throw new Error('not a JWT');
  return TokenClaimsSchema.parse(JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));
}

const RoleList = Envelope(z.object({ data: z.array(Role.extend({ user_type: z.number().optional() })) }));
const RoleRequest = Envelope(z.object({ id: z.number(), status: z.string(), role: z.number() }).passthrough());

export interface CreateAccountInput {
  name: string;
  email: string;
  password: string;
  /** org registration code (b1); omitted → default org */
  registration_code?: string;
}

/** ELEVATE user service (research E1, E2, E3; register a1–b5, g6). */
export class UserClient {
  constructor(private readonly http: ElevateHttp) {}

  /** a1: password login. Needs an Origin whose hostname maps to the tenant domain. */
  async login(identifier: string, password: string): Promise<LoginResult> {
    const r = await this.http.call({
      operation: 'account.login', method: 'POST', path: '/user/v1/account/login',
      json: { identifier, password }, auth: { origin: true }, schema: Envelope(LoginResult),
    });
    return r.result;
  }

  /** Lab/platform admin login (`admin` role). The body key is `identifier`; `email` is rejected. */
  async adminLogin(identifier: string, password: string): Promise<LoginResult> {
    const r = await this.http.call({
      operation: 'admin.login', method: 'POST', path: '/user/v1/admin/login',
      json: { identifier, password }, auth: { origin: true }, schema: Envelope(LoginResult),
    });
    return r.result;
  }

  /** New access token from a refresh token (returns only access_token in image 3.4.0). */
  async refresh(refreshToken: string): Promise<{ access_token: string }> {
    const r = await this.http.call({
      operation: 'account.generateToken', method: 'POST', path: '/user/v1/account/generateToken',
      json: { refresh_token: refreshToken }, auth: { origin: true },
      schema: Envelope(z.object({ access_token: z.string() }).passthrough()),
    });
    return r.result;
  }

  /** Profile of the token's user. */
  async profile(userToken: string): Promise<ElevateUser> {
    const r = await this.http.call({
      operation: 'user.read', method: 'GET', path: '/user/v1/user/read',
      auth: { userToken }, schema: Envelope(ElevateUserSchema),
    });
    return r.result;
  }

  async listRoles(userToken: string): Promise<{ id: number; title: string }[]> {
    const r = await this.http.call({
      operation: 'user-role.list', method: 'GET', path: '/user/v1/user-role/list',
      auth: { userToken }, schema: RoleList,
    });
    return r.result.data;
  }

  /** b2: creates ONE user (self sign-up path; default role mentee). Not idempotent: callers
   * try login first and create only when it fails (adapter upsert). */
  async createAccount(input: CreateAccountInput): Promise<LoginResult> {
    const r = await this.http.call({
      operation: 'account.create', method: 'POST', path: '/user/v1/account/create',
      json: input, auth: { origin: true }, schema: Envelope(LoginResult),
    });
    return r.result;
  }

  /** b3: admin token required. Does NOT notify mentoring (use requestMentorRole for mentors). */
  async assignRole(
    adminToken: string, input: { user_id: number; role_id: number; organization_id?: number },
  ): Promise<unknown> {
    const r = await this.http.call({
      operation: 'admin.assignRole', method: 'POST', path: '/user/v1/admin/assignRole',
      json: input, auth: { userToken: adminToken },
    });
    return (r as { result?: unknown })?.result;
  }

  /** b5: org_admin / tenant_admin token. */
  async deactivateUsers(
    orgAdminToken: string, by: { ids?: number[]; emails?: string[] }, org?: { orgCode: string; tenantCode: string },
  ): Promise<unknown> {
    const r = await this.http.call({
      operation: 'org-admin.deactivateUser', method: 'POST', path: '/user/v1/org-admin/deactivateUser',
      json: by, auth: { userToken: orgAdminToken },
      headers: org ? userOrgHeaders(org.orgCode, org.tenantCode) : undefined,
    });
    return (r as { result?: unknown })?.result;
  }

  /** g6 step 1: the user asks for a role (mentor). Org admin approves with approveRoleRequest. */
  async requestOrgRole(
    userToken: string, roleId: number, formData: { about?: string; experience?: string } = {},
  ): Promise<{ id: number; status: string; role: number }> {
    const r = await this.http.call({
      operation: 'organization.requestOrgRole', method: 'POST', path: '/user/v1/organization/requestOrgRole',
      json: { role: roleId, form_data: formData }, auth: { userToken }, schema: RoleRequest,
    });
    return r.result;
  }

  /** g6 step 2: org admin approves/rejects; approval emits `roleChange` that mentoring consumes. */
  async updateRoleRequest(
    orgAdminToken: string, requestId: number, status: 'APPROVED' | 'REJECTED', comments?: string,
  ): Promise<unknown> {
    const r = await this.http.call({
      operation: 'org-admin.updateRequestStatus', method: 'POST', path: '/user/v1/org-admin/updateRequestStatus',
      json: { request_id: requestId, status, ...(comments ? { comments } : {}) }, auth: { userToken: orgAdminToken },
    });
    return (r as { result?: unknown })?.result;
  }

  async health(): Promise<boolean> {
    await this.http.call({ operation: 'health', method: 'GET', path: '/health' });
    return true;
  }
}
