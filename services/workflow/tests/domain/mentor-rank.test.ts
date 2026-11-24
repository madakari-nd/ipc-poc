import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY_WINDOW_DAYS,
  candidateSlotDays,
  fromElevateSessionStatus,
  isOpenWithin,
  rankMentors,
  sessionWindow,
  supportTransitionAllowed,
  type MentorProfile,
} from '../../src/domain/mentor-rank.js';

const NOW = new Date('2026-11-23T10:00:00.000Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

const HH_HI: MentorProfile = { mentorId: '69', skills: ['hand_hygiene'], languages: ['hi', 'en'], nextOpenSlotAt: at(2) };
const WASTE_EN: MentorProfile = { mentorId: '70', skills: ['waste'], languages: ['en'], nextOpenSlotAt: at(1) };
const PPE_KN: MentorProfile = { mentorId: '71', skills: ['ppe', 'cleaning'], languages: ['kn', 'en'] };

const ids = (r: { mentorId: string }[]) => r.map((x) => x.mentorId);

describe('rankMentors (FR-022: skill, then language, then availability)', () => {
  it('US6 AS1: {hand hygiene, Hindi} ranks first for a hand hygiene request in Hindi', () => {
    const r = rankMentors([WASTE_EN, PPE_KN, HH_HI], { skill: 'hand_hygiene', language: 'hi' }, NOW);
    expect(r[0]).toMatchObject({ mentorId: '69', rank: 1, skillMatch: true, languageMatch: true, available: true });
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3]);
  });

  it('skill outranks language: a skill match without the language beats a language match without the skill', () => {
    const skillOnly: MentorProfile = { mentorId: 'a', skills: ['waste'], languages: ['kn'] };
    const langOnly: MentorProfile = { mentorId: 'b', skills: ['ppe'], languages: ['en'], nextOpenSlotAt: at(1) };
    expect(ids(rankMentors([langOnly, skillOnly], { skill: 'waste', language: 'en' }, NOW))).toEqual(['a', 'b']);
  });

  it('language outranks availability', () => {
    const langNoSlot: MentorProfile = { mentorId: 'a', skills: ['waste'], languages: ['hi'] };
    const slotNoLang: MentorProfile = { mentorId: 'b', skills: ['waste'], languages: ['en'], nextOpenSlotAt: at(1) };
    expect(ids(rankMentors([slotNoLang, langNoSlot], { skill: 'waste', language: 'hi' }, NOW))).toEqual(['a', 'b']);
  });

  it('availability breaks a skill+language tie', () => {
    const noSlot: MentorProfile = { mentorId: 'a', skills: ['ppe'], languages: ['en'] };
    const slot: MentorProfile = { mentorId: 'b', skills: ['ppe'], languages: ['en'], nextOpenSlotAt: at(3) };
    const r = rankMentors([noSlot, slot], { skill: 'ppe', language: 'en' }, NOW);
    expect(ids(r)).toEqual(['b', 'a']);
    expect(r.map((x) => x.available)).toEqual([true, false]);
  });

  it('ties keep the input order (stable)', () => {
    const list: MentorProfile[] = ['m1', 'm2', 'm3', 'm4'].map((mentorId) => ({ mentorId, skills: ['ppe'], languages: ['en'] }));
    expect(ids(rankMentors(list, { skill: 'ppe', language: 'en' }, NOW))).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(ids(rankMentors([...list].reverse(), { skill: 'ppe', language: 'en' }, NOW))).toEqual(['m4', 'm3', 'm2', 'm1']);
  });

  it('an open slot counts only inside the 14 programme days ahead (not past, not later)', () => {
    const past: MentorProfile = { mentorId: 'past', skills: [], languages: [], nextOpenSlotAt: at(-1) };
    const edge: MentorProfile = { mentorId: 'edge', skills: [], languages: [], nextOpenSlotAt: at(13.9) };
    const late: MentorProfile = { mentorId: 'late', skills: [], languages: [], nextOpenSlotAt: at(14.1) };
    const r = rankMentors([past, late, edge], { skill: 'ppe', language: 'en' }, NOW);
    expect(Object.fromEntries(r.map((x) => [x.mentorId, x.available]))).toEqual({ past: false, late: false, edge: true });
    expect(ids(r)).toEqual(['edge', 'past', 'late']);
  });

  it('does not mutate its input and keeps the profile fields', () => {
    const input = [WASTE_EN, HH_HI];
    const copy = structuredClone(input);
    const r = rankMentors(input, { skill: 'hand_hygiene', language: 'hi' }, NOW);
    expect(input).toEqual(copy);
    expect(r[0]).toMatchObject({ skills: ['hand_hygiene'], languages: ['hi', 'en'], nextOpenSlotAt: at(2) });
  });

  it('returns an empty shortlist for no mentors', () => {
    expect(rankMentors([], { skill: 'ppe', language: 'en' }, NOW)).toEqual([]);
  });
});

describe('isOpenWithin', () => {
  it('is false without a slot and true for now ≤ slot < now + window', () => {
    expect(isOpenWithin(undefined, NOW)).toBe(false);
    expect(isOpenWithin(null, NOW)).toBe(false);
    expect(isOpenWithin(NOW, NOW)).toBe(true);
    expect(isOpenWithin(at(AVAILABILITY_WINDOW_DAYS), NOW)).toBe(false);
    expect(isOpenWithin(at(5), NOW, 3)).toBe(false);
  });
});

describe('candidateSlotDays (probe slots for ELEVATE isAvailable)', () => {
  it('gives one group per programme day, hourly 09:00–16:00 IST starts, all after now', () => {
    const days = candidateSlotDays(NOW);
    expect(days).toHaveLength(14);
    const all = days.flat();
    expect(all.every((s) => s.getTime() > NOW.getTime() && s.getTime() < NOW.getTime() + 14 * DAY)).toBe(true);
    // 10:00 UTC = 15:30 IST: today only 16:00 IST is left (10:30 UTC)
    expect(days[0]!.map((d) => d.toISOString())).toEqual(['2026-11-23T10:30:00.000Z']);
    expect(days[1]!.map((d) => d.toISOString().slice(11, 16))).toEqual(['03:30', '04:30', '05:30', '06:30', '07:30', '08:30', '09:30', '10:30']);
  });

  it('honours a custom window', () => {
    const days = candidateSlotDays(new Date('2026-11-23T00:00:00.000Z'), { days: 2, fromHour: 10, toHour: 12 });
    expect(days.flat().map((d) => d.toISOString())).toEqual([
      '2026-11-23T04:30:00.000Z', '2026-11-23T05:30:00.000Z', '2026-11-24T04:30:00.000Z', '2026-11-24T05:30:00.000Z',
    ]);
  });
});

describe('sessionWindow', () => {
  it('is [start, start + 60 min] in epoch seconds', () => {
    expect(sessionWindow(new Date('2026-11-24T04:30:00.000Z'))).toEqual({ startEpoch: 1795494600, endEpoch: 1795498200 });
    expect(sessionWindow(new Date('2026-11-24T04:30:00.900Z'), 30).endEpoch - sessionWindow(new Date('2026-11-24T04:30:00.000Z')).startEpoch).toBe(1800);
  });
});

describe('support request lifecycle', () => {
  it('allows only the documented transitions', () => {
    expect(supportTransitionAllowed('open', 'requested')).toBe(true);
    expect(supportTransitionAllowed('requested', 'accepted')).toBe(true);
    expect(supportTransitionAllowed('requested', 'rejected')).toBe(true);
    expect(supportTransitionAllowed('rejected', 'requested')).toBe(true);
    expect(supportTransitionAllowed('accepted', 'held')).toBe(true);
    expect(supportTransitionAllowed('held', 'closed')).toBe(true);
    expect(supportTransitionAllowed('open', 'held')).toBe(false);
    expect(supportTransitionAllowed('requested', 'held')).toBe(false);
    expect(supportTransitionAllowed('closed', 'open')).toBe(false);
    expect(supportTransitionAllowed('accepted', 'requested')).toBe(false);
  });

  it('maps ELEVATE request-session statuses', () => {
    expect(fromElevateSessionStatus('ACCEPTED')).toBe('accepted');
    expect(fromElevateSessionStatus('accepted')).toBe('accepted');
    expect(fromElevateSessionStatus('REJECTED')).toBe('rejected');
    expect(fromElevateSessionStatus('EXPIRED')).toBe('rejected');
    expect(fromElevateSessionStatus('REQUESTED')).toBe('requested');
    expect(fromElevateSessionStatus('PENDING')).toBe('requested');
    expect(fromElevateSessionStatus('BLOCKED')).toBeUndefined();
  });
});
