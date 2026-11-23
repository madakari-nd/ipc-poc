import { z } from 'zod';
import { csvCell, parseCsv, type ElevateHttp } from './http.js';

const Envelope = <T extends z.ZodTypeAny>(result: T) => z.object({ result }).passthrough();

export const ProjectTaskSchema = z.object({
  _id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  status: z.string().optional(),
  isDeleted: z.boolean().optional(),
  externalId: z.string().optional(),
}).passthrough();
export type ProjectTask = z.infer<typeof ProjectTaskSchema>;

export const ProjectSchema = z.object({
  _id: z.string(),
  status: z.string().optional(),
  lastDownloadedAt: z.string(),
  solutionId: z.string().optional(),
  tasks: z.array(ProjectTaskSchema),
}).passthrough();
export type Project = z.infer<typeof ProjectSchema>;

/** Task as sent to userProjects/sync (VAL/v4b_add_task.py). */
export interface SyncTask {
  _id: string;
  name: string;
  type?: string;
  status?: string;
  isNew?: boolean;
  isDeleted?: boolean;
  isDeletable?: boolean;
  children?: unknown[];
  attachments?: unknown[];
  [k: string]: unknown;
}

/** Project submission event on `sl-improvement-project-submission-<env>` (E2). */
export const ProjectSubmissionEventSchema = z.object({
  _id: z.string(),
  status: z.string().optional(),
  userId: z.string().optional(),
  solutionId: z.string().optional(),
  tasks: z.array(ProjectTaskSchema).optional(),
}).passthrough();

/** ELEVATE project service (research E9; register f1–f5). */
export class ProjectClient {
  constructor(private readonly http: ElevateHttp) {}

  /**
   * f2: copy a reusable template onto a cycle solution. Internal path; acting user's token.
   * Fails if the solution already has a template or the source is not isReusable.
   */
  async importProjectTemplate(userToken: string, templateExternalId: string, solutionId: string): Promise<unknown> {
    const r = await this.http.call({
      operation: 'templates.importProjectTemplate', method: 'POST',
      path: `/project/v1/project/templates/importProjectTemplate/${encodeURIComponent(templateExternalId)}`,
      query: { solutionId }, json: {}, auth: { userToken, internal: true },
    });
    return (r as { result?: unknown })?.result;
  }

  /** f3: ward plan; owner = caller (ward service account). One per user per solution (f3b). */
  async importFromLibrary(
    serviceToken: string, templateId: string, opts: { targeted?: boolean; body?: Record<string, unknown> } = {},
  ): Promise<Project> {
    const r = await this.http.call({
      operation: 'userProjects.importFromLibrary', method: 'POST',
      path: `/project/v1/userProjects/importFromLibrary/${encodeURIComponent(templateId)}`,
      query: { isATargetedSolution: opts.targeted ?? false }, json: opts.body ?? {},
      auth: { userToken: serviceToken }, schema: Envelope(ProjectSchema),
    });
    return r.result;
  }

  /** f4: owner token only (others get an empty result). */
  async details(serviceToken: string, projectId: string): Promise<Project> {
    const r = await this.http.call({
      operation: 'userProjects.details', method: 'POST', path: `/project/v1/userProjects/details/${encodeURIComponent(projectId)}`,
      json: {}, auth: { userToken: serviceToken }, schema: Envelope(ProjectSchema),
    });
    return r.result;
  }

  /**
   * f5: add / update / remove (isDeleted) tasks. `lastDownloadedAt` must be the exact stored
   * value. ELEVATE is last-write-wins with no conflict check (V4): the Workflow is the single
   * writer and keeps its own version check.
   */
  async sync(serviceToken: string, projectId: string, lastDownloadedAt: string, tasks: SyncTask[], extra: Record<string, unknown> = {}): Promise<void> {
    await this.http.call({
      operation: 'userProjects.sync', method: 'POST', path: `/project/v1/userProjects/sync/${encodeURIComponent(projectId)}`,
      query: { lastDownloadedAt },
      json: { ...extra, tasks: tasks.map((t) => ({ type: 'simple', children: [], attachments: [], isDeletable: true, ...t })) },
      auth: { userToken: serviceToken },
    });
  }

  /**
   * f1 (CONFIGURE): reusable project templates from CSV rows. Internal route; the caller's token
   * must be an org_admin (its org becomes the template org). Columns listed in `_arrayFields` are
   * split on commas. Returns ELEVATE's CSV echo with `_SYSTEM_ID` per row (an id, or
   * "PROJECT_TEMPLATE_EXISTS"-style text when the externalId is already taken).
   */
  async bulkCreateTemplates(orgAdminToken: string, rows: Record<string, unknown>[]): Promise<Record<string, string>[]> {
    return this.csvUpload('templates.bulkCreate', '/project/v1/project/templates/bulkCreate', 'projectTemplates', orgAdminToken, rows);
  }

  /** f1: tasks of a template (CSV, internal + org_admin token). Echo rows carry `_SYSTEM_ID` and `STATUS`. */
  async bulkCreateTemplateTasks(orgAdminToken: string, templateId: string, rows: Record<string, unknown>[]): Promise<Record<string, string>[]> {
    return this.csvUpload('templateTasks.bulkCreate', `/project/v1/project/templateTasks/bulkCreate/${encodeURIComponent(templateId)}`,
      'projectTemplateTasks', orgAdminToken, rows);
  }

  /** f2 step 1: programme container for the cycle plan solutions (internal + org_admin token). */
  async createProgram(orgAdminToken: string, input: {
    externalId: string; name: string; description?: string; scope: Record<string, unknown>;
  }): Promise<{ _id: string; externalId: string }> {
    const r = await this.http.call({
      operation: 'programs.create', method: 'POST', path: '/project/v1/programs/create',
      json: { description: input.name, requestForPIIConsent: false, isAPrivateProgram: false, ...input },
      auth: { userToken: orgAdminToken, internal: true },
      schema: Envelope(z.object({ _id: z.string(), externalId: z.string() }).passthrough()),
    });
    return r.result;
  }

  /** f2 step 2: one improvement-project solution per cycle (FR-018a). */
  async createSolution(orgAdminToken: string, input: {
    programExternalId: string; externalId: string; name: string; description?: string; scope: Record<string, unknown>;
  }): Promise<{ _id: string }> {
    const r = await this.http.call({
      operation: 'solutions.create', method: 'POST', path: '/project/v1/solutions/create',
      json: { description: input.name, type: 'improvementProject', subType: 'improvementProject', isReusable: false, ...input },
      auth: { userToken: orgAdminToken, internal: true }, schema: Envelope(z.object({ _id: z.string() }).passthrough()),
    });
    return r.result;
  }

  private async csvUpload(operation: string, path: string, field: string, userToken: string, rows: Record<string, unknown>[]) {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
    const form = new FormData();
    form.append(field, new Blob([csv], { type: 'text/csv' }), `${field}.csv`);
    const text = await this.http.call({ operation, method: 'POST', path, form, auth: { userToken, internal: true }, text: true });
    return parseCsv(String(text ?? ''));
  }
}
