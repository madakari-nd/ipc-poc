import type { Logger } from '@ipc/platform';
import type { LedgerActor } from '../domain/ledger-chain.js';
import { PlanModel, TaskModel, WardModel, type Plan, type Task, type Ward } from '../domain/models/index.js';
import { diffProjectTasks, type Correction } from '../domain/plan.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { withTx } from '../repositories/tx.js';
import type { PlanElevatePort } from '../services/plan-elevate.gateway.js';

const SYSTEM: LedgerActor = { userId: 'system', role: 'SYSTEM' };
export const RECONCILE_INTERVAL_MS = 5 * 60_000;

export interface ReconcileResult { plans: number; corrections: number; failed: number }

function describe(c: Correction): string {
  switch (c.kind) {
    case 'status': return `ELEVATE task ${c.elevateTaskId} status ${c.from ?? 'unset'} → ${c.to}`;
    case 'missing': return `ELEVATE task ${c.elevateTaskId} was missing; added with status ${c.to}`;
    case 'extra': return `ELEVATE task ${c.elevateTaskId} is not in the programme plan; removed`;
  }
}

/**
 * One-way reconciliation workflow → ELEVATE project-service (T086, FR-019). The programme task
 * state is the truth: every 5 minutes, and after each plan or task transition (`trigger`), each
 * active plan's ELEVATE copy is compared and corrected with `userProjects/sync` as the ward
 * service account. Every correction is a `reconcile.corrected` ledger record. ELEVATE is never read
 * back into the programme (single writer, Constitution II).
 */
export class ReconcileJob {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;
  private readonly pending = new Set<string>();
  private draining: Promise<void> | undefined;

  constructor(private readonly d: { elevate: PlanElevatePort; ledger: LedgerService; logger: Logger }) {}

  /** Reconciles one plan; returns the number of corrections recorded. */
  async reconcilePlan(planId: string): Promise<number> {
    const plan = await PlanModel.findById(planId).lean<Plan>();
    if (!plan || plan.status !== 'active' || !plan.elevateProjectId) return 0;
    const ward = await WardModel.findById(plan.wardId).lean<Ward>();
    if (!ward?.serviceAccountUserId) return 0;
    const tasks = await TaskModel.find({ planId: plan._id }).sort({ _id: 1 }).lean<Task[]>();
    const project = await this.d.elevate.projectTasks(ward.serviceAccountUserId, plan.elevateProjectId);
    const diff = diffProjectTasks(
      tasks.map((t) => ({ id: String(t._id), taskKey: t.taskKey, title: t.title.en ?? t.taskKey, state: t.state, ...(t.elevateTaskId ? { elevateTaskId: t.elevateTaskId } : {}) })),
      project,
    );
    await this.d.elevate.syncTasks(ward.serviceAccountUserId, plan.elevateProjectId, diff.sync);
    const stale = tasks.filter((t) => t.syncState !== 'in_sync' || t.elevateTaskId !== diff.links[String(t._id)]);
    if (diff.corrections.length === 0 && stale.length === 0) return 0;
    await withTx(async (s) => {
      for (const t of stale) {
        await TaskModel.updateOne({ _id: t._id }, { $set: { syncState: 'in_sync', elevateTaskId: diff.links[String(t._id)] }, $inc: { v: 1 } }, { session: s });
      }
      for (const c of diff.corrections) {
        await this.d.ledger.append({
          actor: SYSTEM, action: 'reconcile.corrected',
          subject: c.taskId ? { type: 'task', id: c.taskId } : { type: 'plan', id: String(plan._id) },
          reason: describe(c),
        }, s);
      }
    });
    if (diff.corrections.length) this.d.logger.info({ planId, corrections: diff.corrections.length }, 'ELEVATE plan corrected');
    return diff.corrections.length;
  }

  async runAll(): Promise<ReconcileResult> {
    const plans = await PlanModel.find({ status: 'active', elevateProjectId: { $exists: true } }, { _id: 1 }).lean<{ _id: unknown }[]>();
    const out: ReconcileResult = { plans: plans.length, corrections: 0, failed: 0 };
    for (const p of plans) {
      try {
        out.corrections += await this.reconcilePlan(String(p._id));
      } catch (err) {
        out.failed += 1;
        // ELEVATE down: retried on the next run; the programme state is unaffected.
        this.d.logger.warn({ planId: String(p._id), err }, 'plan reconciliation failed');
      }
    }
    return out;
  }

  /** After a transition: reconcile that plan soon (coalesced, never blocks the caller). */
  trigger(planId: string): void {
    this.pending.add(planId);
    this.draining ??= (async () => {
      await new Promise((r) => setImmediate(r));
      while (this.pending.size) {
        const [id] = this.pending;
        this.pending.delete(id!);
        await this.reconcilePlan(id!).catch((err: unknown) => this.d.logger.warn({ planId: id, err }, 'plan reconciliation failed'));
      }
      this.draining = undefined;
    })();
  }

  /** Resolves when triggered reconciliations have finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  start(intervalMs = RECONCILE_INTERVAL_MS): void {
    const tick = () => {
      this.running = this.runAll()
        .catch((err: unknown) => this.d.logger.error({ err }, 'reconcile run failed'))
        .finally(() => {
          if (this.timer !== undefined) this.timer = setTimeout(tick, intervalMs);
        });
    };
    this.timer = setTimeout(tick, intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    const t = this.timer;
    this.timer = undefined;
    if (t) clearTimeout(t);
    await this.running;
    await this.idle();
  }
}
