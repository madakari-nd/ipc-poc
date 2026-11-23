import { contentHash } from '../domain/canonical.js';
import {
  assertDemoClockAllowed,
  isDemoClockAllowed,
  planClockChange,
  programmeTime,
  type ClockPolicy,
} from '../domain/clock.js';
import type { LedgerActor } from '../domain/ledger-chain.js';
import { ClockSettingModel, type ClockSettingDoc } from '../domain/models/index.js';
import { withTx } from '../repositories/tx.js';
import type { LedgerService } from '../ledger/ledger.service.js';

export interface ClockChange {
  actor: LedgerActor;
  programmeNow?: Date;
  advanceBy?: string;
  reason?: string;
}

/** DemoClock contract shape. */
export interface DemoClockView {
  v: number; realNow: string; programmeNow: string; offsetMs: number; isRealTime: boolean; demoMode: boolean;
  setBy?: string; setAt?: string;
}

/**
 * Programme clock (FR-038, research T20). `programmeNow()` is synchronous for hot paths and uses a
 * cached offset; `refresh()` reloads it (on start and on a timer, so every instance converges).
 * Shifts are allowed only in demo mode on dev/test/uat and every change is written to the ledger
 * (`clock.shifted`) in the same transaction as the setting.
 */
export class ClockService {
  private offsetMs = 0;
  private ledger: LedgerService | undefined;

  constructor(
    private readonly policy: ClockPolicy,
    private readonly realNow: () => number = Date.now,
  ) {}

  /** The ledger needs programmeNow() and the clock needs the ledger: wire after both exist. */
  attachLedger(ledger: LedgerService): void {
    this.ledger = ledger;
  }

  get allowed(): boolean {
    return isDemoClockAllowed(this.policy);
  }

  programmeNow(): Date {
    return programmeTime(this.realNow(), this.offsetMs, this.allowed);
  }

  async refresh(): Promise<void> {
    const doc = await ClockSettingModel.findOne({ profile: this.policy.profile }).lean<ClockSettingDoc>();
    this.offsetMs = this.allowed ? (doc?.offsetMs ?? 0) : 0;
  }

  async view(): Promise<DemoClockView> {
    const doc = await ClockSettingModel.findOne({ profile: this.policy.profile }).lean<ClockSettingDoc>();
    const offsetMs = this.allowed ? (doc?.offsetMs ?? 0) : 0;
    const real = this.realNow();
    return {
      v: doc?.v ?? 0,
      realNow: new Date(real).toISOString(),
      programmeNow: programmeTime(real, offsetMs).toISOString(),
      offsetMs,
      isRealTime: offsetMs === 0,
      demoMode: this.allowed,
      ...(doc?.setBy ? { setBy: doc.setBy } : {}),
      ...(doc?.setAt ? { setAt: doc.setAt.toISOString() } : {}),
    };
  }

  /** Shift forward (absolute `programmeNow` or relative `advanceBy`). */
  async set(change: ClockChange): Promise<DemoClockView> {
    assertDemoClockAllowed(this.policy);
    return this.write(change.actor, change.reason, (current, real) =>
      planClockChange({ currentOffsetMs: current, realNowMs: real, programmeNow: change.programmeNow, advanceBy: change.advanceBy }),
    );
  }

  /** Back to real time (offset 0). */
  async reset(actor: LedgerActor, reason?: string): Promise<DemoClockView> {
    assertDemoClockAllowed(this.policy);
    return this.write(actor, reason, () => 0);
  }

  private async write(actor: LedgerActor, reason: string | undefined, next: (current: number, real: number) => number) {
    const ledger = this.ledger;
    if (!ledger) throw new Error('ClockService: ledger not attached');
    const profile = this.policy.profile;
    const newOffset = await withTx(async (session) => {
      const doc = await ClockSettingModel.findOne({ profile }, null, { session }).lean<ClockSettingDoc>();
      const current = doc?.offsetMs ?? 0;
      const real = this.realNow();
      const offset = next(current, real);
      const setAt = new Date(real);
      await ClockSettingModel.updateOne(
        { profile },
        { $set: { offsetMs: offset, setBy: actor.userId, setAt }, $inc: { v: 1 } },
        { upsert: true, session },
      );
      await ledger.append(
        {
          actor,
          action: 'clock.shifted',
          subject: { type: 'clock', id: profile },
          reason,
          beforeHash: contentHash({ offsetMs: current }),
          afterHash: contentHash({ offsetMs: offset }),
        },
        session,
      );
      return offset;
    });
    this.offsetMs = newOffset;
    return this.view();
  }
}
