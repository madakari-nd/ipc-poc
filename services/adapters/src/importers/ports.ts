import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import {
  ElevateError,
  ElevateHttp,
  EntityClient,
  UserClient,
  decodeToken,
  type Entity,
  type LoginResult,
} from '@ipc/elevate-client';

/** The ELEVATE calls the importers make (research E2–E4). Stubbed in unit tests only. */
export interface ElevateImportPort {
  findEntity(externalId: string): Promise<Entity | undefined>;
  bulkCreateEntities(type: 'hospital' | 'ward', rows: { externalId: string; name: string }[]): Promise<Record<string, string>[]>;
  mapChildren(pairs: { parentId: string; childId: string }[]): Promise<void>;
  renameEntity(entityId: string, externalId: string, name: string): Promise<void>;
  createAccount(input: { name: string; email: string; password: string }): Promise<LoginResult>;
  login(email: string, password: string): Promise<LoginResult>;
  /** Admin token (assignRole); org-admin token (deactivate, approve). Cached by the implementation. */
  assignRole(userId: number, roleTitle: string): Promise<void>;
  requestRole(userToken: string, roleTitle: string, about: string): Promise<{ id: number; status: string }>;
  approveRoleRequest(requestId: number): Promise<void>;
  deactivate(userId: number): Promise<void>;
}

/** Programme register in workflow (`/internal/register/*`): the single writer of facilities, wards and scopes. */
export interface RegisterPort {
  upsertFacility(row: Record<string, unknown>): Promise<{ facilityId: string; created: boolean; changed: boolean; wards: { wardCode: string; wardId: string; created: boolean; changed: boolean }[] }>;
  applyStaff(row: Record<string, unknown>): Promise<{ outcome: 'created' | 'updated' | 'unchanged' | 'deactivated'; assignmentIds: string[]; tasksNeedingReassignment: number }>;
  appendLedger(entry: { action: string; subject: { type: string; id: string }; reason?: string; afterHash?: string }): Promise<void>;
}

/** A row-level refusal from the register (4xx): reported on the row, the import continues. */
export class RegisterRowError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'RegisterRowError';
  }
}

export interface ElevateCredentials {
  admin: { identifier: string; password: string };
  orgAdmin: { identifier: string; password: string };
}

type Token = { value: string; exp: number };

/** Real ELEVATE implementation (user + entity-management clients from @ipc/elevate-client). */
export class ElevateImportClient implements ElevateImportPort {
  private tokens = new Map<'admin' | 'org', Token>();
  private roleIds: Map<string, number> | undefined;

  constructor(
    private readonly c: { user: UserClient; entity: EntityClient },
    private readonly creds: ElevateCredentials,
  ) {}

  static create(o: { userUrl: string; entityUrl: string; internalAccessToken: string; entityAdminToken: string; tenantCode: string; origin: string }, creds: ElevateCredentials) {
    const http = (service: 'user' | 'entity', baseUrl: string) => new ElevateHttp({
      service, baseUrl, internalAccessToken: o.internalAccessToken, tenantCode: o.tenantCode, origin: o.origin,
      ...(service === 'entity' ? { adminToken: o.entityAdminToken } : {}),
    });
    return new ElevateImportClient({ user: new UserClient(http('user', o.userUrl)), entity: new EntityClient(http('entity', o.entityUrl)) }, creds);
  }

  private async token(kind: 'admin' | 'org'): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const t = this.tokens.get(kind);
    if (t && t.exp - 60 > now) return t.value;
    // E18: the lab admin logs in on the admin route with `identifier`; the org admin on the account route.
    const r = kind === 'admin'
      ? await this.c.user.adminLogin(this.creds.admin.identifier, this.creds.admin.password)
      : await this.c.user.login(this.creds.orgAdmin.identifier, this.creds.orgAdmin.password);
    const fresh = { value: r.access_token, exp: decodeToken(r.access_token).exp };
    this.tokens.set(kind, fresh);
    return fresh.value;
  }

  private async roleId(title: string): Promise<number> {
    if (!this.roleIds) this.roleIds = new Map((await this.c.user.listRoles(await this.token('org'))).map((r) => [r.title, r.id]));
    const id = this.roleIds.get(title);
    if (id === undefined) throw new Error(`ELEVATE has no role "${title}"`);
    return id;
  }

  findEntity(externalId: string) {
    return this.c.entity.findByExternalId(externalId);
  }
  async bulkCreateEntities(type: 'hospital' | 'ward', rows: { externalId: string; name: string }[]) {
    return this.c.entity.bulkCreate({ userToken: await this.token('org') }, type, rows);
  }
  async mapChildren(pairs: { parentId: string; childId: string }[]) {
    if (pairs.length) await this.c.entity.mappingUpload({ userToken: await this.token('org') }, pairs);
  }
  async renameEntity(entityId: string, externalId: string, name: string) {
    await this.c.entity.update({ userToken: await this.token('org') }, entityId, { metaInformation: { externalId, name } });
  }
  createAccount(input: { name: string; email: string; password: string }) {
    return this.c.user.createAccount(input);
  }
  login(email: string, password: string) {
    return this.c.user.login(email, password);
  }
  async assignRole(userId: number, roleTitle: string) {
    await this.c.user.assignRole(await this.token('admin'), { user_id: userId, role_id: await this.roleId(roleTitle) });
  }
  async requestRole(userToken: string, roleTitle: string, about: string) {
    return this.c.user.requestOrgRole(userToken, await this.roleId(roleTitle), { about });
  }
  async approveRoleRequest(requestId: number) {
    await this.c.user.updateRoleRequest(await this.token('org'), requestId, 'APPROVED');
  }
  async deactivate(userId: number) {
    await this.c.user.deactivateUsers(await this.token('org'), { ids: [userId] });
  }
}

/** True when ELEVATE says the account already exists (account/create answers 406). */
export function isUserExists(e: unknown): boolean {
  return e instanceof ElevateError && (e.status === 406 || /already exists/i.test(e.message));
}

/** Workflow register over HTTP with a service JWT (issuer ipc-adapters, acting user in `act`). */
export class HttpRegisterClient implements RegisterPort {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly actor: { userId: string; role: 'STATE_ADMIN' },
    private readonly timeoutMs = 10_000,
  ) {}

  private async jwt(): Promise<string> {
    return new SignJWT({ act: { sub: this.actor.userId, role: this.actor.role } })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer('ipc-adapters').setAudience('ipc-workflow').setSubject('ipc-adapters')
      .setJti(randomUUID()).setIssuedAt().setExpirationTime('60s').sign(new TextEncoder().encode(this.secret));
  }

  private async post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(new URL(path, this.baseUrl), {
          method: 'POST',
          headers: { authorization: `Bearer ${await this.jwt()}`, 'content-type': 'application/json', accept: 'application/json', ...headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.status >= 400 && res.status < 500) {
          const errors = Array.isArray(json.errors) ? `: ${(json.errors as { message?: string }[]).map((e) => e.message).join('; ')}` : '';
          throw new RegisterRowError(res.status, String(json.code ?? 'REFUSED'), `${String(json.detail ?? res.statusText)}${errors}`);
        }
        if (res.status >= 500) throw new Error(`workflow ${res.status}`);
        return json as T;
      } catch (e) {
        if (e instanceof RegisterRowError) throw e;
        lastErr = e;
        // register writes are idempotent upserts, so a retry after a 5xx/timeout is safe
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt + Math.random() * 100));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('workflow unavailable');
  }

  upsertFacility(row: Record<string, unknown>) {
    return this.post<Awaited<ReturnType<RegisterPort['upsertFacility']>>>('/internal/register/facilities', row);
  }
  applyStaff(row: Record<string, unknown>) {
    return this.post<Awaited<ReturnType<RegisterPort['applyStaff']>>>('/internal/register/staff', row);
  }
  async appendLedger(entry: { action: string; subject: { type: string; id: string }; reason?: string; afterHash?: string }) {
    await this.post('/internal/ledger/records', { actor: this.actor, correlationId: randomUUID().replace(/-/g, ''), ...entry }, { 'idempotency-key': randomUUID() });
  }
}
