import { Router } from 'express';
import type { EvidenceDoc } from '../db/models.js';
import type { OwnershipGuard } from '../scope/ownership.guard.js';
import { etag } from '../middleware/version.js';
import { toApi, type EvidenceService, type IntentBody } from './evidence.service.js';

const doc = (req: { resource?: { doc?: unknown } }) => req.resource!.doc as EvidenceDoc;

/**
 * Evidence routes (T044). Every id goes through the ownership guard first:
 * reads need the item in scope; renew and confirm need the uploader (else NOT_OWNER).
 */
export function evidenceRoutes(svc: EvidenceService, guard: OwnershipGuard): Router {
  const r = Router();

  r.post('/evidence/intents', async (req, res) => {
    const out = await svc.createIntent(req, req.body as IntentBody);
    res.setHeader('ETag', etag(out.evidence.v));
    res.status(201).json(out);
  });

  r.post('/evidence/:evidenceId/upload-url', guard.require('evidence', 'evidenceId', 'owner'), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await svc.renewUploadUrl(doc(req)));
  });

  r.post('/evidence/:evidenceId/confirmation', guard.require('evidence', 'evidenceId', 'owner'), async (req, res) => {
    const item = await svc.confirm(req, doc(req));
    res.setHeader('ETag', etag(item.v));
    res.json(item);
  });

  r.get('/evidence/:evidenceId', guard.require('evidence', 'evidenceId', 'read'), (req, res) => {
    const d = doc(req);
    res.setHeader('ETag', etag(d.v));
    res.json(toApi(d));
  });

  r.get('/evidence/:evidenceId/download-link', guard.require('evidence', 'evidenceId', 'read'), async (req, res) => {
    const link = await svc.downloadLink(req, doc(req));
    res.setHeader('Cache-Control', 'no-store');
    res.json(link);
  });

  r.post('/evidence/:evidenceId/patient-data-deletion', guard.require('evidence', 'evidenceId', 'read'), async (req, res) => {
    const item = await svc.deletePatientData(req, doc(req), (req.body as { reasonCode: string }).reasonCode);
    res.setHeader('ETag', etag(item.v));
    res.json(item);
  });

  return r;
}
