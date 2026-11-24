import { Router, type Request, type RequestHandler, type Response } from 'express';
import { Types } from 'mongoose';
import { Problem } from '@ipc/platform';
import type { EdgeModels, EvidenceDoc } from '../db/models.js';
import type { Auditor } from '../scope/audit.js';
import type { Need, OwnershipGuard } from '../scope/ownership.guard.js';
import type { Actor } from '../scope/types.js';
import { unavailable } from '../workflow/workflow.client.js';
import type { Forwarded, Forwarder, ForwardRequest } from './admin.routes.js';

interface TaskDoc { id: string; wardId: string; evidenceRule?: { photoRequired: boolean; minPhotos: number } }

/**
 * Evidence-rule check at submission (FR-008/FR-009, T093). The Edge owns the evidence locker, so it
 * checks every id here: the item exists, is confirmed (hash re-checked on confirm), was uploaded by
 * the submitter for THIS task and ward, and the photo count meets the task's rule. Returns the
 * attested metadata the workflow records (SHA-256 for the Decision and events, GPS flag).
 */
export async function checkSubmissionEvidence(models: EdgeModels, task: TaskDoc, userId: string, evidenceIds: string[]) {
  const errors: { path: string; message: string }[] = [];
  const unique = [...new Set(evidenceIds)];
  if (unique.length !== evidenceIds.length) errors.push({ path: 'evidenceIds', message: 'must not repeat an item' });
  const docs = unique.length
    ? await models.Evidence.find({ _id: { $in: unique.filter((i) => Types.ObjectId.isValid(i)).map((i) => new Types.ObjectId(i)) } }).lean<EvidenceDoc[]>()
    : [];
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  evidenceIds.forEach((id, i) => {
    const d = byId.get(id);
    const path = `evidenceIds[${i}]`;
    if (!d || d.uploadedBy !== userId || d.link.type !== 'task' || d.link.id !== task.id || d.wardId !== task.wardId) {
      errors.push({ path, message: 'is not your evidence for this task' });
    } else if (d.state !== 'confirmed') {
      errors.push({ path, message: d.state === 'deleted_patient_data' ? 'was deleted (patient data)' : 'has not finished uploading' });
    }
  });
  const rule = task.evidenceRule ?? { photoRequired: false, minPhotos: 0 };
  const need = rule.photoRequired ? Math.max(1, rule.minPhotos) : rule.minPhotos;
  const ok = docs.filter((d) => d.state === 'confirmed');
  const counted = rule.photoRequired ? ok.filter((d) => d.mime.startsWith('image/')).length : ok.length;
  if (!errors.length && counted < need) errors.push({ path: 'evidenceIds', message: `needs at least ${need} ${rule.photoRequired ? 'photo(s)' : 'file(s)'}` });
  if (errors.length) {
    throw Problem.unprocessable('EVIDENCE_RULE_NOT_MET', errors.map((e) => `${e.path} ${e.message}`).join('; '), { errors });
  }
  return evidenceIds.map((id) => {
    const d = byId.get(id)!;
    return { id, sha256: d.sha256, mime: d.mime, gpsUnavailable: d.gpsUnavailable };
  });
}

/**
 * Task operations (T093; US4, FR-013..FR-016, FR-028): listTasks, getTask, getTaskHistory,
 * startTask, submitTaskEvidence, acceptTask, returnTask, validateTask, returnTaskFromValidation,
 * reassignTask, setTaskBlockedFlag and reopenTask. Roles were checked against x-roles and the body
 * validated by the scope and schema stages; here every task id goes through the ownership guard
 * (out of scope → SCOPE_DENIED; start/submit by someone else → NOT_OWNER; both ledgered), then the
 * call is forwarded once to workflow as the acting user with If-Match.
 */
export function taskRoutes(workflow: Forwarder, guard: OwnershipGuard, audit: Auditor, models: EdgeModels): Router {
  const r = Router();

  const actorOf = (req: Request): Actor => {
    const role = req.scope?.activeRole;
    if (!req.scope || !role) throw Problem.forbidden('ROLE_DENIED', 'You have no programme role.');
    return { userId: req.scope.userId, role };
  };

  const query = (req: Request) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) q.set(k, String(v));
    const s = q.toString();
    return s ? `?${s}` : '';
  };

  const reply = async (req: Request, res: Response, f: Forwarded, subject?: { type: string; id: string }) => {
    if (f.status === 403) {
      const code = (f.body as { code?: string } | null)?.code;
      await audit.record(req, code === 'ROLE_DENIED' ? 'role.denied' : code === 'NOT_OWNER' ? 'owner.denied' : 'scope.denied', subject);
    }
    if (f.status >= 500 && (f.body as { code?: string } | null)?.code === undefined) throw unavailable('workflow');
    for (const [k, v] of Object.entries(f.headers)) res.setHeader(k, v);
    if (f.status >= 400) res.type('application/problem+json');
    if (f.body === null || f.body === undefined) return res.status(f.status).end();
    return res.status(f.status).json(f.body);
  };

  const send = async (req: Request, res: Response, id: string, method: ForwardRequest['method'], suffix: string, body?: unknown) => {
    const f = await workflow.forward(actorOf(req), {
      method,
      path: `/ipc/v1/tasks/${encodeURIComponent(id)}${suffix}${method === 'GET' ? query(req) : ''}`,
      ...(method !== 'GET' ? { body: body ?? req.body ?? {} } : {}),
      ...(req.ifMatch !== undefined ? { ifMatch: `"${req.ifMatch}"` } : {}),
    });
    await reply(req, res, f, { type: 'task', id });
  };

  const forward = (method: ForwardRequest['method'], suffix: string, need: Need = 'read'): RequestHandler => async (req, res) => {
    const id = String(req.params.taskId);
    await guard.check(req, 'task', id, need);
    await send(req, res, id, method, suffix);
  };

  r.get('/tasks', async (req, res) => {
    await reply(req, res, await workflow.forward(actorOf(req), { method: 'GET', path: `/ipc/v1/tasks${query(req)}` }));
  });
  r.get('/tasks/:taskId', forward('GET', ''));
  r.get('/tasks/:taskId/history', forward('GET', '/history'));
  r.post('/tasks/:taskId/start', forward('POST', '/start', 'owner'));
  r.post('/tasks/:taskId/evidence-submission', async (req, res) => {
    const id = String(req.params.taskId);
    const task = await guard.check(req, 'task', id, 'owner');
    const body = req.body as { evidenceIds: string[]; note?: string };
    const evidence = await checkSubmissionEvidence(models, { id, wardId: task.wardId ?? '', ...(task.doc as Partial<TaskDoc>) }, req.scope!.userId, body.evidenceIds);
    await send(req, res, id, 'POST', '/evidence-submission', { evidenceIds: body.evidenceIds, ...(body.note ? { note: body.note } : {}), evidence });
  });
  r.post('/tasks/:taskId/acceptance', forward('POST', '/acceptance'));
  r.post('/tasks/:taskId/return', forward('POST', '/return'));
  r.post('/tasks/:taskId/validation', forward('POST', '/validation'));
  r.post('/tasks/:taskId/validation-return', forward('POST', '/validation-return'));
  r.post('/tasks/:taskId/reassignment', forward('POST', '/reassignment'));
  r.put('/tasks/:taskId/blocked-flag', forward('PUT', '/blocked-flag'));
  r.post('/tasks/:taskId/reopening', forward('POST', '/reopening'));
  return r;
}
