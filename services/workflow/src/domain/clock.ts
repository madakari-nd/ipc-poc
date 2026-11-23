import { Problem } from '@ipc/platform';

export type Profile = 'dev' | 'test' | 'uat' | 'prod';

/** Profiles where the demo clock may be shifted (FR-038, data-model §10). */
export const DEMO_CLOCK_PROFILES: readonly Profile[] = ['dev', 'test', 'uat'];

export interface ClockPolicy { profile: Profile; demoMode: boolean }

export function isDemoClockAllowed(p: ClockPolicy): boolean {
  return p.demoMode && DEMO_CLOCK_PROFILES.includes(p.profile);
}

export function assertDemoClockAllowed(p: ClockPolicy): void {
  if (!isDemoClockAllowed(p)) {
    throw Problem.forbidden('DEMO_MODE_DISABLED', 'The demo clock is available only in demo mode on dev, test or uat');
  }
}

/** programmeNow = real now + offset; the offset is ignored when the demo clock is not allowed. */
export function programmeTime(realNowMs: number, offsetMs: number, allowed = true): Date {
  return new Date(realNowMs + (allowed ? offsetMs : 0));
}

const UNIT_MS = { W: 604_800_000, D: 86_400_000, H: 3_600_000, M: 60_000, S: 1000 } as const;
const DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

function invalid(detail: string): Problem {
  return Problem.unprocessable('VALIDATION_FAILED', detail);
}

/**
 * ISO-8601 duration to milliseconds. Weeks, days, hours, minutes and seconds only: months and
 * years have no fixed length, so they are refused rather than guessed.
 */
export function parseIsoDuration(s: string): number {
  const m = DURATION.exec(s);
  if (!m || s === 'P' || s.endsWith('T')) throw invalid(`advanceBy must be an ISO-8601 duration such as P7D or PT48H`);
  const [, w, d, h, min, sec] = m;
  const ms =
    Number(w ?? 0) * UNIT_MS.W + Number(d ?? 0) * UNIT_MS.D + Number(h ?? 0) * UNIT_MS.H +
    Number(min ?? 0) * UNIT_MS.M + Math.round(Number(sec ?? 0) * UNIT_MS.S);
  return ms;
}

export interface ClockChangeRequest {
  currentOffsetMs: number;
  realNowMs: number;
  programmeNow?: Date;
  advanceBy?: string;
}

/**
 * New offset for a setDemoClock request: exactly one of `programmeNow` or `advanceBy`, and
 * programme time only moves forward (DemoClockSet). Reset to real time is a separate operation.
 */
export function planClockChange(r: ClockChangeRequest): number {
  const hasAbs = r.programmeNow !== undefined;
  const hasRel = r.advanceBy !== undefined;
  if (hasAbs === hasRel) throw invalid('Give exactly one of programmeNow or advanceBy');
  const current = r.realNowMs + r.currentOffsetMs;
  let target: number;
  if (hasRel) {
    target = current + parseIsoDuration(r.advanceBy!);
  } else {
    target = r.programmeNow!.getTime();
    if (Number.isNaN(target)) throw invalid('programmeNow is not a valid date-time');
  }
  if (target < current) throw invalid('Programme time only moves forward; use reset to return to real time');
  const offset = target - r.realNowMs;
  if (offset < 0) throw invalid('Programme time cannot be before real time');
  return offset;
}
