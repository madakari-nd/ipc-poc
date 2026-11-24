import { describe, expect, it } from 'vitest';
import type { Outbox, RequestInput } from '../src/offline/outbox.js';
import { queueProof, type Task } from '../src/features/tasks/api.js';

const task = { id: 't1', v: 4, wardId: 'w1' } as Task;
const photo = (n: number) => ({
  bytes: new Uint8Array([n]), sha256: String(n).repeat(64), sizeBytes: 1, mime: 'image/jpeg' as const, capturedAt: '2026-11-24T00:00:00.000Z', gps: null, gpsUnavailable: true,
});

describe('queueProof (US4): photos first, then the submission with If-Match and evidence markers', () => {
  it('queues each photo linked to the task, then the submission depending on them', async () => {
    const calls: { kind: string; input: unknown }[] = [];
    let n = 0;
    const outbox = {
      addEvidence: async (input: unknown) => { calls.push({ kind: 'evidence', input }); return `local-${++n}`; },
      addRecord: async (input: RequestInput) => { calls.push({ kind: 'record', input }); return 'rec'; },
    } as unknown as Outbox;
    await queueProof(outbox, task, [photo(1), photo(2)], 'Bed 1', { photo: 'Photo', submit: 'Proof' });
    expect(calls.map((c) => c.kind)).toEqual(['evidence', 'evidence', 'record']);
    expect(calls[0]!.input).toMatchObject({ meta: { sha256: '1'.repeat(64), wardId: 'w1', link: { type: 'task', id: 't1' }, gpsUnavailable: true } });
    expect(calls[2]!.input).toEqual({
      label: 'Proof', method: 'POST', path: '/ipc/v1/tasks/t1/evidence-submission', ifMatch: '4', dependsOn: ['local-1', 'local-2'],
      body: { evidenceIds: [{ $evidence: 'local-1' }, { $evidence: 'local-2' }], note: 'Bed 1' },
    });
  });
});
