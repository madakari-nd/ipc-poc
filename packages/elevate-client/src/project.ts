import { z } from 'zod';
import type { ElevateHttp } from './http.js';

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
}
