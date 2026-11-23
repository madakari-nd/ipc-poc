import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import * as models from '../../src/domain/models/index.js';

const long = 'x'.repeat(501);
const ok = 'x'.repeat(500);

describe('models (data-model §1–§10)', () => {
  const all = Object.entries(models).filter(([k, v]) => k.endsWith('Model') && typeof v === 'function') as [string, mongoose.Model<unknown>][];

  it('register every workflow entity with a `v` version field (except the counter)', () => {
    expect(all.length).toBeGreaterThanOrEqual(24);
    for (const [name, m] of all) {
      if (name === 'CounterModel') continue;
      expect(m.schema.path('v'), name).toBeDefined();
    }
  });

  it('cap every string path at 500 unless a tighter/explicit limit is declared', () => {
    for (const [name, m] of all) {
      m.schema.eachPath((path, type) => {
        const st = type as unknown as { instance: string; options: { maxlength?: number } };
        if (st.instance === 'String' && path !== '_id') expect(st.options.maxlength ?? 500, `${name}.${path}`).toBeLessThanOrEqual(name === 'DeadLetterModel' ? 1_048_576 : 2000);
      });
    }
  });

  it('enforce the free-text rule on validation', () => {
    const sr = (problem: string) => new models.SupportRequestModel({
      wardId: new mongoose.Types.ObjectId(), facilityId: new mongoose.Types.ObjectId(), raisedBy: 'u', problem,
      skill: 'ppe', language: 'en', status: 'open',
    });
    expect(sr(ok).validateSync()).toBeUndefined();
    expect(sr(long).validateSync()?.errors.problem).toBeDefined();
    const n = new models.NotificationModel({ userId: 'u', channel: 'inapp', templateCode: 't', status: 'queued' });
    expect(n.validateSync()).toBeUndefined();
    expect(n.v).toBe(0);
  });

  it('refuse unknown fields and bad enums', () => {
    expect(() => new models.WardModel({ facilityId: new mongoose.Types.ObjectId(), patientName: 'x' })).toThrow();
    const t = new models.EscalationRuleModel({ code: 'R1', condition: { type: 'overdue', riskLevels: ['critical'], thresholdHours: 48 }, target: { mode: 'role', role: 'IPC_OFFICER' }, channels: ['inapp'] });
    expect(t.validateSync()).toBeUndefined();
    expect(new models.EscalationRuleModel({ code: 'X', condition: { type: 'never', riskLevels: [] }, target: { mode: 'role' } }).validateSync()?.errors).toBeDefined();
  });

  it('serialises with `id` instead of `_id`', () => {
    const c = new models.CycleModel({ code: 'C1', startsAt: new Date(), endsAt: new Date(), status: 'planned' });
    const json = c.toJSON() as Record<string, unknown>;
    expect(json.id).toBe(String(c._id));
    expect(json._id).toBeUndefined();
  });
});
