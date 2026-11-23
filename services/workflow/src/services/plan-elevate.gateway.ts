import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { Problem } from '@ipc/platform';
import { ElevateHttp, ProjectClient, UserClient, decodeToken } from '@ipc/elevate-client';
import type { ProjectTaskLike, SyncEntry } from '../domain/plan.js';
import { elevateProblem } from './elevate-admin.gateway.js';

/**
 * ELEVATE project-service calls for ward plans (research E9, FR-018a, FR-019). Every call runs as
 * the ward's programme service account, so ELEVATE's "one plan per user per solution" gives one
 * plan per ward per cycle. Behind an interface so workflow tests can stub it (Constitution I).
 */
export interface PlanElevatePort {
  /** Template copy attached to the cycle's plan solution (importFromLibrary source). */
  templateIdForCycle(cycle: { code: string; elevateSolutionIds?: { plan?: string } }): Promise<string>;
  /**
   * The ward's plan for the cycle: `importFromLibrary` as the service account, or, when a previous
   * attempt already created it (`knownProjectId`, or ELEVATE's per-solution duplicate), that plan.
   */
  ensureWardPlan(serviceAccountUserId: string, templateId: string, knownProjectId?: string): Promise<{ projectId: string; tasks: ProjectTaskLike[] }>;
  projectTasks(serviceAccountUserId: string, projectId: string): Promise<ProjectTaskLike[]>;
  /** `userProjects/sync` with the exact stored `lastDownloadedAt` (read just before). */
  syncTasks(serviceAccountUserId: string, projectId: string, entries: SyncEntry[]): Promise<void>;
}

export interface ServiceAccountDirectory {
  credentials(userId: string): { identifier: string; password: string } | undefined;
  templateCopyForPlanSolution(solutionId: string): string | undefined;
}

const SeedStateSchema = z.object({
  users: z.record(z.object({ id: z.union([z.number(), z.string()]), email: z.string() })),
  cycles: z.record(z.object({ planSolutionId: z.string().optional(), planTemplateCopyId: z.string().optional() })).default({}),
}).passthrough();

/**
 * Service-account logins and per-cycle template copies as provisioned by the seed (FR-018a). The
 * seed state file holds ids and emails only; the shared demo password comes from the environment.
 */
export class SeedStateDirectory implements ServiceAccountDirectory {
  private constructor(private readonly state: z.infer<typeof SeedStateSchema>, private readonly password: string) {}

  static fromFile(path: string, password: string): SeedStateDirectory {
    return new SeedStateDirectory(SeedStateSchema.parse(JSON.parse(readFileSync(path, 'utf8'))), password);
  }

  /** `IPC_SEED_STATE_FILE`, else `infra/compose/.seed-state.<profile>.json` above the working directory. */
  static locate(profile: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (env.IPC_SEED_STATE_FILE) return env.IPC_SEED_STATE_FILE;
    let dir = resolve(process.cwd());
    for (let i = 0; i < 6; i++) {
      const p = join(dir, 'infra/compose', `.seed-state.${profile}.json`);
      if (existsSync(p)) return p;
      dir = dirname(dir);
    }
    return undefined;
  }

  credentials(userId: string) {
    const u = Object.entries(this.state.users).find(([slug, x]) => slug.startsWith('svc-') && String(x.id) === userId);
    return u ? { identifier: u[1].email, password: this.password } : undefined;
  }

  templateCopyForPlanSolution(solutionId: string) {
    return Object.values(this.state.cycles).find((c) => c.planSolutionId === solutionId)?.planTemplateCopyId;
  }
}

const ListResult = z.object({
  result: z.object({ data: z.array(z.object({ _id: z.string(), projectTemplateId: z.string().optional() }).passthrough()) }).passthrough(),
}).passthrough();

export class ElevatePlanGateway implements PlanElevatePort {
  private readonly tokens = new Map<string, { value: string; exp: number }>();

  constructor(
    private readonly c: { user: UserClient; project: ProjectClient; projectHttp: ElevateHttp },
    private readonly dir: ServiceAccountDirectory,
    private readonly now: () => number = Date.now,
  ) {}

  static fromSettings(s: {
    userUrl?: string; projectUrl?: string; internalToken?: string; tenantCode: string; origin: string; dir?: ServiceAccountDirectory;
  }): ElevatePlanGateway | { missing: string[] } {
    const missing = [
      ...(!s.userUrl ? ['ELEVATE_USER_URL'] : []), ...(!s.projectUrl ? ['ELEVATE_PROJECT_URL'] : []),
      ...(!s.internalToken ? ['ELEVATE_INTERNAL_ACCESS_TOKEN'] : []), ...(!s.dir ? ['IPC_SEED_STATE_FILE / WARD_SERVICE_ACCOUNT_PASSWORD'] : []),
    ];
    if (missing.length) return { missing };
    const http = (service: 'user' | 'project', baseUrl: string) =>
      new ElevateHttp({ service, baseUrl, internalAccessToken: s.internalToken!, tenantCode: s.tenantCode, origin: s.origin });
    const projectHttp = http('project', s.projectUrl!);
    return new ElevatePlanGateway({ user: new UserClient(http('user', s.userUrl!)), project: new ProjectClient(projectHttp), projectHttp }, s.dir!);
  }

  /** Service-account token, re-used until a minute before expiry (ELEVATE tokens last 30 min). */
  private async token(userId: string): Promise<string> {
    const cached = this.tokens.get(userId);
    const nowS = Math.floor(this.now() / 1000);
    if (cached && cached.exp - 60 > nowS) return cached.value;
    const cred = this.dir.credentials(userId);
    if (!cred) throw Problem.unprocessable('VALIDATION_FAILED', `The ward's service account ${userId} has no login configured (FR-018a)`);
    const r = await this.c.user.login(cred.identifier, cred.password);
    this.tokens.set(userId, { value: r.access_token, exp: decodeToken(r.access_token).exp });
    return r.access_token;
  }

  async templateIdForCycle(cycle: { code: string; elevateSolutionIds?: { plan?: string } }): Promise<string> {
    const sol = cycle.elevateSolutionIds?.plan;
    const t = sol ? this.dir.templateCopyForPlanSolution(sol) : undefined;
    if (!t) throw Problem.unprocessable('VALIDATION_FAILED', `Cycle ${cycle.code} has no plan template on its ELEVATE plan solution`);
    return t;
  }

  async ensureWardPlan(userId: string, templateId: string, knownProjectId?: string) {
    try {
      const token = await this.token(userId);
      if (knownProjectId) {
        const d = await this.c.project.details(token, knownProjectId);
        return { projectId: d._id, tasks: d.tasks };
      }
      try {
        const p = await this.c.project.importFromLibrary(token, templateId);
        return { projectId: p._id, tasks: p.tasks };
      } catch (err) {
        // One plan per user per solution: a second import answers a non-project body. Find the plan made earlier.
        const existing = await this.findImported(token, templateId);
        if (!existing) throw err;
        const d = await this.c.project.details(token, existing);
        return { projectId: d._id, tasks: d.tasks };
      }
    } catch (err) {
      throw elevateProblem(err, 'plan creation');
    }
  }

  private async findImported(token: string, templateId: string): Promise<string | undefined> {
    const r = await this.c.projectHttp.call({
      operation: 'userProjects.list', method: 'POST', path: '/project/v1/userProjects/list',
      query: { page: 1, limit: 100, search: '' }, json: {}, auth: { userToken: token }, schema: ListResult,
    });
    return r.result.data.find((p) => p.projectTemplateId === templateId)?._id;
  }

  async projectTasks(userId: string, projectId: string): Promise<ProjectTaskLike[]> {
    try {
      return (await this.c.project.details(await this.token(userId), projectId)).tasks;
    } catch (err) {
      throw elevateProblem(err, 'plan details');
    }
  }

  async syncTasks(userId: string, projectId: string, entries: SyncEntry[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      const token = await this.token(userId);
      const d = await this.c.project.details(token, projectId);
      await this.c.project.sync(token, projectId, d.lastDownloadedAt, entries.map((e) => ({ ...e })));
    } catch (err) {
      throw elevateProblem(err, 'plan sync');
    }
  }
}

/** Used when ELEVATE settings are missing: every plan write answers 503 naming them. */
export class UnconfiguredPlanElevate implements PlanElevatePort {
  constructor(private readonly missing: string[]) {}
  private fail(): never {
    throw new Problem(503, 'ELEVATE_UNAVAILABLE', `ELEVATE plan calls are not configured (${this.missing.join(', ')})`, { unavailable: ['plan creation'] });
  }
  async templateIdForCycle(): Promise<string> { return this.fail(); }
  async ensureWardPlan(): Promise<{ projectId: string; tasks: ProjectTaskLike[] }> { return this.fail(); }
  async projectTasks(): Promise<ProjectTaskLike[]> { return this.fail(); }
  async syncTasks(): Promise<void> { return this.fail(); }
}
