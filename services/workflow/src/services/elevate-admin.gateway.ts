import { Problem } from '@ipc/platform';
import {
  ElevateError,
  ElevateHttp,
  EntityClient,
  ProjectClient,
  SamikshaClient,
  UserClient,
  decodeToken,
} from '@ipc/elevate-client';
import type { WorkflowConfig } from '../config/index.js';

/**
 * ELEVATE calls the programme setup needs (research E5, E19, FR-018a). Behind an interface so the
 * workflow tests can stub it (Constitution I: only the project's own client interfaces are stubbed).
 */
export interface ElevateAdminPort {
  /**
   * New checklist solution: samiksha `importFromSolution` from `sourceSolutionId`, then
   * `solutions/update {entityType:'ward', entityTypeId}` as org admin (E19).
   */
  copyChecklistSolution(input: { sourceSolutionId: string; externalId: string; name: string }): Promise<{ _id: string; externalId: string }>;
  /** One improvement-project solution per cycle (FR-018a), with the plan template copied into it when configured. */
  createCyclePlanSolution(input: { cycleCode: string }): Promise<{ solutionId: string; templateCopied: boolean }>;
  /** Template solution for checklist v1 when a draft has none (config). */
  readonly checklistTemplateSolutionId?: string;
}

/** Maps ELEVATE failures to the contract: 503 ELEVATE_UNAVAILABLE (5xx, timeouts) or 422 (refused). */
export function elevateProblem(err: unknown, fn: string): Problem {
  if (err instanceof Problem) return err;
  if (err instanceof ElevateError && !err.isServerError) {
    const p = Problem.unprocessable('VALIDATION_FAILED', `ELEVATE refused ${fn}: ${err.message.slice(0, 300)}`);
    p.cause = err;
    return p;
  }
  const p = new Problem(503, 'ELEVATE_UNAVAILABLE', `ELEVATE is unavailable for ${fn}; try again shortly`, { unavailable: [fn] });
  p.cause = err;
  return p;
}

export class ElevateAdminGateway implements ElevateAdminPort {
  private token: { value: string; userId: string; exp: number } | undefined;
  private wardTypeId: string | undefined;
  private programReady = false;
  readonly checklistTemplateSolutionId?: string;

  constructor(
    private readonly c: { user: UserClient; entity: EntityClient; samiksha: SamikshaClient; project?: ProjectClient },
    private readonly o: {
      orgAdmin: { identifier: string; password: string };
      orgCode: string;
      prefix: string;
      checklistTemplateSolutionId?: string;
      planTemplateExternalId?: string;
      now?: () => number;
    },
  ) {
    this.checklistTemplateSolutionId = o.checklistTemplateSolutionId;
  }

  /** Builds the gateway from config, or explains which settings are missing. */
  static fromConfig(cfg: WorkflowConfig): ElevateAdminGateway | { missing: string[] } {
    const need = ['ELEVATE_USER_URL', 'ELEVATE_ENTITY_URL', 'ELEVATE_SAMIKSHA_URL', 'ELEVATE_INTERNAL_ACCESS_TOKEN', 'ELEVATE_ADMIN_TOKEN_ENTITY', 'ELEVATE_ORG_ADMIN_EMAIL', 'ELEVATE_ORG_ADMIN_PASSWORD'] as const;
    const missing = need.filter((k) => !cfg[k]);
    if (missing.length) return { missing };
    const http = (service: 'user' | 'entity' | 'samiksha' | 'project', baseUrl: string) =>
      new ElevateHttp({
        service, baseUrl, internalAccessToken: cfg.ELEVATE_INTERNAL_ACCESS_TOKEN, tenantCode: cfg.ELEVATE_TENANT_CODE, origin: cfg.ELEVATE_ORIGIN,
        ...(service === 'entity' && cfg.ELEVATE_ADMIN_TOKEN_ENTITY ? { adminToken: cfg.ELEVATE_ADMIN_TOKEN_ENTITY } : {}),
      });
    return new ElevateAdminGateway(
      {
        user: new UserClient(http('user', cfg.ELEVATE_USER_URL!)),
        entity: new EntityClient(http('entity', cfg.ELEVATE_ENTITY_URL!)),
        samiksha: new SamikshaClient(http('samiksha', cfg.ELEVATE_SAMIKSHA_URL!)),
        ...(cfg.ELEVATE_PROJECT_URL ? { project: new ProjectClient(http('project', cfg.ELEVATE_PROJECT_URL)) } : {}),
      },
      {
        orgAdmin: { identifier: cfg.ELEVATE_ORG_ADMIN_EMAIL!, password: cfg.ELEVATE_ORG_ADMIN_PASSWORD! },
        orgCode: cfg.ELEVATE_ORG_CODE,
        prefix: cfg.IPC_CODE_PREFIX,
        checklistTemplateSolutionId: cfg.IPC_CHECKLIST_TEMPLATE_SOLUTION_ID,
        planTemplateExternalId: cfg.IPC_PLAN_TEMPLATE_EXTERNAL_ID,
      },
    );
  }

  /** Org-admin token, re-used until a minute before it expires (ELEVATE tokens last 30 min). */
  private async orgAdmin(): Promise<{ value: string; userId: string }> {
    const now = Math.floor((this.o.now?.() ?? Date.now()) / 1000);
    if (this.token && this.token.exp - 60 > now) return this.token;
    const r = await this.c.user.login(this.o.orgAdmin.identifier, this.o.orgAdmin.password);
    const claims = decodeToken(r.access_token);
    this.token = { value: r.access_token, userId: String(claims.data.id), exp: claims.exp };
    return this.token;
  }

  private async wardType(token: string): Promise<string> {
    if (this.wardTypeId) return this.wardTypeId;
    const types = await this.c.entity.entityTypeDocs({ userToken: token });
    const ward = types.find((t) => t.name === 'ward');
    if (!ward) throw Problem.unprocessable('VALIDATION_FAILED', 'ELEVATE has no `ward` entity type; run the seed first');
    this.wardTypeId = ward._id;
    return ward._id;
  }

  async copyChecklistSolution(input: { sourceSolutionId: string; externalId: string; name: string }) {
    try {
      const admin = await this.orgAdmin();
      const src = await this.c.samiksha.solutionDetails(admin.value, input.sourceSolutionId);
      const srcExternalId = src.solution.externalId;
      if (!srcExternalId) throw Problem.unprocessable('VALIDATION_FAILED', 'The source checklist solution has no externalId');
      const copy = await this.c.samiksha.importFromSolution({
        sourceSolutionExternalId: srcExternalId,
        externalId: input.externalId,
        name: input.name,
        userId: admin.userId,
        orgId: this.o.orgCode,
      });
      // E19: samiksha checks entities against the solution's entity type, so point the copy at wards.
      await this.c.samiksha.updateSolution(admin.value, copy._id, { entityType: 'ward', entityTypeId: await this.wardType(admin.value) });
      return copy;
    } catch (err) {
      throw elevateProblem(err, 'checklist publication');
    }
  }

  async createCyclePlanSolution(input: { cycleCode: string }) {
    const project = this.c.project;
    if (!project) throw new Problem(503, 'ELEVATE_UNAVAILABLE', 'ELEVATE_PROJECT_URL is not configured', { unavailable: ['cycle plan solution'] });
    try {
      const admin = await this.orgAdmin();
      const scope = { organizations: [this.o.orgCode], state: ['ALL'] };
      const programExternalId = `${this.o.prefix}IPC-PROGRAMME`;
      if (!this.programReady) {
        // The seed usually created it; ELEVATE refuses a duplicate externalId, which is fine here.
        await project.createProgram(admin.value, { externalId: programExternalId, name: `${this.o.prefix}IPC programme`, scope }).catch((e: unknown) => {
          if (!(e instanceof ElevateError) || e.isServerError) throw e;
        });
        this.programReady = true;
      }
      const sol = await project.createSolution(admin.value, {
        programExternalId,
        externalId: `${this.o.prefix}IPC-PLAN-${input.cycleCode}-${Date.now()}`,
        name: `${this.o.prefix}IPC ward plans ${input.cycleCode}`,
        scope,
      });
      let templateCopied = false;
      if (this.o.planTemplateExternalId) {
        await project.importProjectTemplate(admin.value, this.o.planTemplateExternalId, sol._id);
        templateCopied = true;
      }
      return { solutionId: sol._id, templateCopied };
    } catch (err) {
      throw elevateProblem(err, 'cycle plan solution');
    }
  }
}

/** Stand-in used when ELEVATE settings are missing: every call answers 503 naming the settings. */
export class UnconfiguredElevateAdmin implements ElevateAdminPort {
  constructor(private readonly missing: string[]) {}
  private fail(): never {
    throw new Problem(503, 'ELEVATE_UNAVAILABLE', `ELEVATE admin calls are not configured (${this.missing.join(', ')})`, { unavailable: ['elevate-admin'] });
  }
  async copyChecklistSolution(): Promise<{ _id: string; externalId: string }> {
    return this.fail();
  }
  async createCyclePlanSolution(): Promise<{ solutionId: string; templateCopied: boolean }> {
    return this.fail();
  }
}
