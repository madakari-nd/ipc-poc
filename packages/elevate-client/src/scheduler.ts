import { z } from 'zod';
import { ElevateError, type ElevateHttp } from './http.js';

export interface CreateJobInput {
  jobId: string;
  jobName?: string;
  /** contact email ELEVATE stores on the job (required by its validator) */
  email: string;
  url: string;
  method?: 'post' | 'get';
  /** Custom headers sent verbatim on the callback (e.g. X-Scheduler-Secret). */
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  repeat?: { pattern?: string; every?: number; limit?: number };
  delayMs?: number;
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
}

/**
 * ELEVATE scheduler (research E12; register h1–h2). It has NO auth, so it is never exposed through
 * the Edge (V2). It calls back once with the given headers and does not retry non-200 answers.
 */
export class SchedulerClient {
  constructor(private readonly http: ElevateHttp) {}

  async createJob(input: CreateJobInput): Promise<unknown> {
    const r = await this.http.call({
      operation: 'jobs.create', method: 'POST', path: '/scheduler/jobs/create',
      json: {
        jobName: input.jobName ?? input.jobId,
        email: input.email,
        request: {
          url: input.url,
          method: input.method ?? 'post',
          // ELEVATE's validator requires this header even though the callee ignores it. The
          // callback body is form-encoded unless content-type says JSON (observed 2026-11-23).
          header: { internal_access_token: 'scheduler', 'content-type': 'application/json', ...input.headers },
          reqBody: input.body ?? {},
        },
        jobOptions: {
          jobId: input.jobId,
          ...(input.repeat ? { repeat: input.repeat } : {}),
          ...(input.delayMs !== undefined ? { delay: input.delayMs } : {}),
          removeOnComplete: input.removeOnComplete ?? true,
          removeOnFail: input.removeOnFail ?? 50,
        },
      },
      schema: z.object({ result: z.unknown() }).passthrough(),
    });
    return r.result;
  }

  /**
   * Lists jobs. Filters are bullmq states: `delayed`, `completed`, `failed`, `active`, `waiting`.
   * Observed 2026-11-23: `filter=repeat` answers 500 and an empty list answers 500 "No jobs found",
   * so an empty list is returned for that case.
   */
  async listJobs(filter?: string[]): Promise<{ id?: string; name?: string }[]> {
    try {
      const r = await this.http.call({
        operation: 'jobs.list', method: 'GET', path: '/scheduler/jobs/list',
        query: { filter: filter?.join(',') },
        schema: z.object({ result: z.array(z.object({ id: z.string().optional(), name: z.string().optional() }).passthrough()) }).passthrough(),
      });
      return r.result;
    } catch (e) {
      if (e instanceof ElevateError && /no jobs found/i.test(e.message)) return [];
      throw e;
    }
  }

  /** Removes a job; returns false when ELEVATE no longer has it (e.g. removed on completion). */
  async removeJob(jobId: string): Promise<boolean> {
    try {
      await this.http.call({ operation: 'jobs.remove', method: 'POST', path: '/scheduler/jobs/remove', json: { jobId } });
      return true;
    } catch (e) {
      if (e instanceof ElevateError && /no job found/i.test(e.message)) return false;
      throw e;
    }
  }
}
