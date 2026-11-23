/**
 * Result log for the SC-002 report: every case writes what happened through the Edge and directly
 * against ELEVATE to `tests/security/results/<target>/<case>.json`; `scripts/security-report.ts`
 * turns the latest files into `docs/security-report.md`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './direct.js';

export const RESULTS_DIR = join(ROOT, 'tests/security/results');

export interface Side {
  /** Short outcome, e.g. `403 SCOPE_DENIED` or `200, 4 solutions`. */
  result: string;
  /** Edge: the attack was refused (or neutralised). Direct: ELEVATE let it through. */
  refused: boolean;
  /** live = measured in this run; cited = taken from the dated validation log; not_run = skipped. */
  source: 'live' | 'cited' | 'not_run';
  note?: string;
}

export interface CaseResult {
  id: string;
  title: string;
  target: string;
  edge?: Side;
  direct?: Side;
  recordedAt: string;
}

const pending = new Map<string, CaseResult>();

/** Records one side of a case; the file is rewritten on every call so a crash keeps what was seen. */
export function record(id: string, title: string, target: string, side: 'edge' | 'direct', value: Side): void {
  const r = pending.get(id) ?? { id, title, target, recordedAt: new Date().toISOString() };
  r[side] = value;
  r.recordedAt = new Date().toISOString();
  pending.set(id, r);
  const dir = join(RESULTS_DIR, target);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(r, null, 2)}\n`);
}

/** `403 SCOPE_DENIED` style summary of a problem+json answer. */
export const outcome = (res: { status: number; body?: { code?: unknown } }) =>
  `${res.status}${typeof res.body?.code === 'string' ? ` ${res.body.code}` : ''}`;

/**
 * Runs the Edge side of a case; a fixture the target cannot provide records `not_run` and skips
 * the test (never a silent pass).
 */
export async function edgeSide(
  id: string,
  title: string,
  target: { name: string },
  skip: () => void,
  run: () => Promise<Side>,
): Promise<void> {
  try {
    record(id, title, target.name, 'edge', await run());
  } catch (e) {
    if ((e as Error).name === 'NotRunnable' || (e as Error).constructor?.name === 'NotRunnable') {
      record(id, title, target.name, 'edge', { result: 'not run', refused: false, source: 'not_run', note: (e as Error).message });
      skip();
      return;
    }
    throw e;
  }
}
