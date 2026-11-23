/**
 * T058 / V1 (US9 AS1, FR-028, FR-029): Hospital B asks for a download URL of Hospital A's evidence.
 * Edge: 403 SCOPE_DENIED and the attempt is recorded (ledger `evidence.denied`).
 * Direct ELEVATE: storage is not configured on the local stack, so the result is cited from the
 * 2026-10-23 validation log (research §4).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { VALIDATION_DIR } from './helpers/direct.js';
import { edgeSide, outcome, record } from './helpers/record.js';
import { openTarget } from './helpers/target.js';

const ID = 'V1';
const TITLE = 'V1: Hospital B requests a URL for Hospital A evidence';
const t = await openTarget();
afterAll(() => t.close());

describe.skipIf(!!t.skip)(`${TITLE} — through the Edge (${t.name})`, () => {
  it('403 SCOPE_DENIED for the link, the metadata and an unknown id; the attempt is in the ledger', async (ctx) => {
    await edgeSide(ID, TITLE, t, () => ctx.skip(), async () => {
      const evidence = await t.evidenceA();
      const b = await t.login('hospB');
      const link = await b.get(`/ipc/v1/evidence/${evidence.id}/download-link`);
      expect(link.status).toBe(403);
      expect(link.body.code).toBe('SCOPE_DENIED');
      expect(link.body.url).toBeUndefined();
      expect(JSON.stringify(link.body)).not.toContain('X-Amz-Signature');
      expect((await b.get(`/ipc/v1/evidence/${evidence.id}`)).body.code).toBe('SCOPE_DENIED');
      // An id that does not exist gets the same answer, so existence is not disclosed.
      expect((await b.get('/ipc/v1/evidence/65f0000000000000000000ff/download-link')).body.code).toBe('SCOPE_DENIED');
      if (t.ledger) {
        expect(t.ledger).toContainEqual(
          expect.objectContaining({ action: 'evidence.denied', subject: { type: 'evidence', id: evidence.id }, actor: { userId: 'officerB', role: 'IPC_OFFICER' } }),
        );
      }
      // Control: Hospital A's own officer gets a link valid for at most 300 s.
      const a = await t.login('hospA');
      const own = await a.get(`/ipc/v1/evidence/${evidence.id}/download-link`);
      expect(own.status).toBe(200);
      expect(own.body.ttlSec).toBeLessThanOrEqual(300);
      return { result: `${outcome(link)}, no URL issued; attempt recorded (evidence.denied)`, refused: true, source: 'live' };
    });
  });
});

if (t.skip) record(ID, TITLE, t.name, 'edge', { result: 'not run', refused: false, source: 'not_run', note: t.skip });

describe(`${TITLE} — directly against ELEVATE (cited)`, () => {
  it('cites the 2026-10-23 validation run: Hospital B got a signed READ URL for A\'s object and fetched it', () => {
    const log = join(VALIDATION_DIR, 'v1_results.log');
    let result = '200: Hospital B signed a READ URL for Hospital A\'s object key and fetched the file (HTTP 200)';
    let note = 'ELEVATE storage is not configured on the local stack; cited from research §4 (2026-10-23 log not found on this machine)';
    if (existsSync(log)) {
      const text = readFileSync(log, 'utf8');
      const signed = /Step 3: Hospital B[\s\S]*?"status": (\d{3})/.exec(text)?.[1];
      const fetched = /Hospital B fetches the signed URL -> HTTP (\d{3})/.exec(text)?.[1];
      const anon = /Step 4: Anonymous caller[\s\S]*?HTTP (\d{3})/.exec(text)?.[1];
      const run = /=== V1 run (\S+) ===/.exec(text)?.[1];
      expect(signed).toBeDefined();
      result = `${signed}: Hospital B was signed a READ URL for Hospital A's object and fetched it (HTTP ${fetched}); anonymous files/download accepted (HTTP ${anon})`;
      note = `cited from VAL/v1_results.log, run ${run}; ELEVATE storage is not configured on the local stack`;
    }
    record(ID, TITLE, t.name, 'direct', { result, refused: false, source: 'cited', note });
  });
});
