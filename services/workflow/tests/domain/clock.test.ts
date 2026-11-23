import { describe, expect, it } from 'vitest';
import {
  assertDemoClockAllowed,
  isDemoClockAllowed,
  parseIsoDuration,
  planClockChange,
  programmeTime,
} from '../../src/domain/clock.js';

const REAL = Date.UTC(2026, 10, 23, 9, 0, 0);
const DAY = 86_400_000;

describe('isDemoClockAllowed (FR-038)', () => {
  it.each([
    ['dev', true, true],
    ['test', true, true],
    ['uat', true, true],
    ['prod', true, false],
    ['dev', false, false],
    ['uat', false, false],
  ] as const)('profile %s, DEMO_MODE=%s -> %s', (profile, demoMode, allowed) => {
    expect(isDemoClockAllowed({ profile, demoMode })).toBe(allowed);
  });

  it('throws 403 DEMO_MODE_DISABLED when not allowed', () => {
    expect(() => assertDemoClockAllowed({ profile: 'prod', demoMode: true })).toThrowError(
      expect.objectContaining({ status: 403, code: 'DEMO_MODE_DISABLED' }) as Error,
    );
    expect(() => assertDemoClockAllowed({ profile: 'dev', demoMode: true })).not.toThrow();
  });
});

describe('programmeTime', () => {
  it('is real time plus the offset', () => {
    expect(programmeTime(REAL, 0).getTime()).toBe(REAL);
    expect(programmeTime(REAL, 7 * DAY).getTime()).toBe(REAL + 7 * DAY);
  });
  it('ignores the stored offset when the demo clock is not allowed', () => {
    expect(programmeTime(REAL, 7 * DAY, false).getTime()).toBe(REAL);
  });
});

describe('parseIsoDuration', () => {
  it.each([
    ['P7D', 7 * DAY],
    ['PT48H', 48 * 3_600_000],
    ['P1W', 7 * DAY],
    ['P1DT2H30M15S', DAY + 2 * 3_600_000 + 30 * 60_000 + 15_000],
    ['PT0.5S', 500],
  ])('%s', (s, ms) => expect(parseIsoDuration(s)).toBe(ms));

  it.each(['', 'P', 'PT', '7D', 'P1M', 'P1Y', 'P-1D', 'nonsense'])('rejects %j', (s) => {
    expect(() => parseIsoDuration(s)).toThrowError(expect.objectContaining({ status: 422 }) as Error);
  });
});

describe('planClockChange', () => {
  it('advances by a duration on top of the current offset', () => {
    expect(planClockChange({ currentOffsetMs: DAY, realNowMs: REAL, advanceBy: 'P7D' })).toBe(8 * DAY);
  });

  it('jumps to an absolute programme time', () => {
    expect(
      planClockChange({ currentOffsetMs: 0, realNowMs: REAL, programmeNow: new Date(REAL + 30 * DAY) }),
    ).toBe(30 * DAY);
  });

  it('refuses to move programme time backwards', () => {
    expect(() =>
      planClockChange({ currentOffsetMs: 10 * DAY, realNowMs: REAL, programmeNow: new Date(REAL + DAY) }),
    ).toThrowError(expect.objectContaining({ status: 422, code: 'VALIDATION_FAILED' }) as Error);
    expect(() =>
      planClockChange({ currentOffsetMs: 0, realNowMs: REAL, programmeNow: new Date(REAL - DAY) }),
    ).toThrowError(expect.objectContaining({ status: 422 }) as Error);
  });

  it('requires exactly one of programmeNow / advanceBy', () => {
    expect(() => planClockChange({ currentOffsetMs: 0, realNowMs: REAL })).toThrow();
    expect(() =>
      planClockChange({ currentOffsetMs: 0, realNowMs: REAL, advanceBy: 'P1D', programmeNow: new Date(REAL) }),
    ).toThrow();
  });

  it('rejects an invalid date', () => {
    expect(() =>
      planClockChange({ currentOffsetMs: 0, realNowMs: REAL, programmeNow: new Date('nope') }),
    ).toThrow();
  });
});
