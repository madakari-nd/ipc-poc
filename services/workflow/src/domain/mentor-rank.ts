/**
 * Expert support (US6, FR-022, research E10/E11): pure ranking of the mentor shortlist and the
 * support-request lifecycle. No I/O: the service feeds profiles from MentorProfileCache and open
 * slots probed with ELEVATE `availability/isAvailable` (mentors/list is broken on this stack).
 */

/** "Available" = at least one open slot in the next 14 days of programme time (FR-022). */
export const AVAILABILITY_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface MentorProfile {
  mentorId: string;
  name?: string;
  skills: string[];
  languages: string[];
  nextOpenSlotAt?: Date | null;
}

export interface RankedMentor extends MentorProfile {
  rank: number;
  skillMatch: boolean;
  languageMatch: boolean;
  available: boolean;
}

/** Is `slot` an open slot inside [now, now + windowDays)? */
export function isOpenWithin(slot: Date | null | undefined, now: Date, windowDays = AVAILABILITY_WINDOW_DAYS): boolean {
  if (!slot) return false;
  const t = slot.getTime();
  return t >= now.getTime() && t < now.getTime() + windowDays * DAY_MS;
}

/**
 * Orders mentors by skill match, then language match, then availability. Ties keep the input
 * order (Array.prototype.sort is stable), so callers pass a deterministic order.
 */
export function rankMentors(
  profiles: readonly MentorProfile[],
  need: { skill: string; language: string },
  now: Date,
  windowDays = AVAILABILITY_WINDOW_DAYS,
): RankedMentor[] {
  const scored = profiles.map((p) => ({
    ...p,
    skillMatch: p.skills.includes(need.skill),
    languageMatch: p.languages.includes(need.language),
    available: isOpenWithin(p.nextOpenSlotAt, now, windowDays),
  }));
  const key = (m: (typeof scored)[number]) => (m.skillMatch ? 4 : 0) + (m.languageMatch ? 2 : 0) + (m.available ? 1 : 0);
  return [...scored].sort((a, b) => key(b) - key(a)).map((m, i) => ({ ...m, rank: i + 1 }));
}

export interface SlotOptions {
  days?: number;
  /** First and last-exclusive start hour in the local zone (default 09–17, i.e. starts 09:00…16:00). */
  fromHour?: number;
  toHour?: number;
  /** Local zone offset in minutes (default IST, +330). */
  tzOffsetMin?: number;
}

/**
 * Candidate one-hour slots to probe with `isAvailable`, grouped per programme day: hourly starts
 * in working hours, strictly after `now`, for `days` days. ELEVATE answers "free" only when the
 * whole slot sits inside one of the mentor's availability windows, so probing working-hour slots
 * finds the next open slot without listing availabilities.
 */
export function candidateSlotDays(now: Date, o: SlotOptions = {}): Date[][] {
  const days = o.days ?? AVAILABILITY_WINDOW_DAYS;
  const from = o.fromHour ?? 9;
  const to = o.toHour ?? 17;
  const tz = (o.tzOffsetMin ?? 330) * 60_000;
  const localMidnight = Math.floor((now.getTime() + tz) / DAY_MS) * DAY_MS - tz;
  const end = now.getTime() + days * DAY_MS;
  const out: Date[][] = [];
  for (let d = 0; d < days; d++) {
    const slots: Date[] = [];
    for (let h = from; h < to; h++) {
      const t = localMidnight + d * DAY_MS + h * HOUR_MS;
      if (t > now.getTime() && t < end) slots.push(new Date(t));
    }
    out.push(slots);
  }
  return out;
}

/** ELEVATE session window in epoch seconds. */
export function sessionWindow(start: Date, durationMin = 60): { startEpoch: number; endEpoch: number } {
  const startEpoch = Math.floor(start.getTime() / 1000);
  return { startEpoch, endEpoch: startEpoch + durationMin * 60 };
}

// ------------------------------------------------------------------------------------ lifecycle

export type SupportStatus = 'open' | 'requested' | 'accepted' | 'rejected' | 'held' | 'closed';

/** data-model §6. A rejected request may be sent to another mentor. */
const NEXT: Record<SupportStatus, readonly SupportStatus[]> = {
  open: ['requested'],
  requested: ['accepted', 'rejected'],
  rejected: ['requested'],
  accepted: ['held'],
  held: ['closed'],
  closed: [],
};

export function supportTransitionAllowed(from: SupportStatus, to: SupportStatus): boolean {
  return NEXT[from].includes(to);
}

/** ELEVATE request-session status → programme status (unknown/blocked → undefined: no change). */
export function fromElevateSessionStatus(status: string): 'requested' | 'accepted' | 'rejected' | undefined {
  switch (status.toUpperCase()) {
    case 'ACCEPTED':
      return 'accepted';
    case 'REJECTED':
    case 'EXPIRED':
      return 'rejected';
    case 'REQUESTED':
    case 'PENDING':
      return 'requested';
    default:
      return undefined;
  }
}
