import { Router } from 'express';
import type { AdminController, RegisterController } from '../controllers/admin.controller.js';

/**
 * Mirrored public admin/catalogue/demo operations (T072). The Edge serves them at `/ipc/v1` for the
 * roles in each operation's `x-roles` and forwards here with the acting user in the service JWT;
 * the controller re-checks the role (defence in depth). Shapes are the contract's.
 */
export function adminRoutes(c: AdminController): Router {
  const r = Router();
  r.get('/admin/programme', c.getProgramme);
  r.patch('/admin/programme', c.updateProgramme);
  r.get('/facilities', c.listFacilities);
  r.get('/users', c.listUsers);
  r.get('/cycles', c.listCycles);
  r.post('/admin/cycles', c.createCycle);
  r.patch('/admin/cycles/:cycleId', c.updateCycle);
  r.get('/admin/scope-assignments', c.listScopeAssignments);
  r.post('/admin/scope-assignments', c.createScopeAssignment);
  r.patch('/admin/scope-assignments/:assignmentId', c.updateScopeAssignment);
  r.get('/checklists', c.listChecklists);
  r.get('/checklists/:checklistVersionId', c.getChecklist);
  r.post('/admin/checklists', c.createDraft);
  r.patch('/admin/checklists/:checklistVersionId', c.updateDraft);
  r.post('/admin/checklists/:checklistVersionId/publication', c.publish);
  r.get('/admin/risk-defaults', c.listRiskDefaults);
  r.put('/admin/risk-defaults/:riskLevel', c.setRiskDefault);
  r.get('/admin/escalation-rules', c.listEscalationRules);
  r.post('/admin/escalation-rules', c.createEscalationRule);
  r.patch('/admin/escalation-rules/:ruleCode', c.updateEscalationRule);
  r.get('/admin/retention-policy', c.getRetentionPolicy);
  r.put('/admin/retention-policy', c.setRetentionPolicy);
  r.get('/demo/clock', c.getClock);
  r.put('/demo/clock', c.setClock);
  r.post('/demo/clock/reset', c.resetClock);
  return r;
}

/** `/internal/register/*`: facility and staff rows from the adapters' importers (T069/T070). */
export function registerRoutes(c: RegisterController): Router {
  const r = Router();
  r.post('/register/facilities', c.upsertFacility);
  r.post('/register/staff', c.applyStaff);
  return r;
}
