import type { Logger } from '@ipc/platform';
import { sha256 } from './csv.js';
import { runFacilityImport } from './facility.importer.js';
import { runHrImport } from './hr.importer.js';
import { toImportJobDto, type ImportJobDto, type ImportKind, type ImportModels, type ImportReport } from './job.js';
import type { ElevateImportPort, RegisterPort } from './ports.js';

export interface ImportServiceDeps {
  models: ImportModels;
  elevate: ElevateImportPort;
  /** Register client acting as the user who started the import. */
  registerFor: (actorUserId: string) => RegisterPort;
  initialPassword: string;
  logger: Logger;
}

/**
 * Import jobs (createImport / getImport): accepted at once (202) and run in the background, one at
 * a time per process so ELEVATE sees a steady per-record stream. Status, counts, row errors and
 * capability substitutions are stored on the job; the finished job is written to the ledger.
 */
export class ImportService {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: ImportServiceDeps) {}

  async start(input: { kind: ImportKind; csv: string; dryRun: boolean; actorUserId: string }): Promise<ImportJobDto> {
    const [job] = await this.d.models.Job.create([{
      kind: input.kind, status: 'queued', dryRun: input.dryRun, fileSha256: sha256(input.csv), requestedBy: input.actorUserId,
    }]);
    const id = String(job!._id);
    this.chain = this.chain.then(() => this.run(id, input)).catch((err: unknown) => this.d.logger.error({ err, jobId: id }, 'import job crashed'));
    return toImportJobDto(job!.toObject());
  }

  /** Resolves when every queued job has finished (tests, graceful shutdown). */
  idle(): Promise<unknown> {
    return this.chain;
  }

  async get(id: string): Promise<ImportJobDto | null> {
    if (!/^[a-f0-9]{24}$/.test(id)) return null;
    const j = await this.d.models.Job.findById(id).lean();
    return j ? toImportJobDto(j) : null;
  }

  private async run(id: string, input: { kind: ImportKind; csv: string; dryRun: boolean; actorUserId: string }) {
    const { Job } = this.d.models;
    await Job.updateOne({ _id: id }, { $set: { status: 'running', startedAt: new Date() }, $inc: { v: 1 } });
    const register = this.d.registerFor(input.actorUserId);
    let report: ImportReport | undefined;
    let crash: unknown;
    try {
      report = input.kind === 'facility'
        ? await runFacilityImport(input.csv, { elevate: this.d.elevate, register, dryRun: input.dryRun })
        : await runHrImport(input.csv, { elevate: this.d.elevate, register, staff: this.d.models.Staff, initialPassword: this.d.initialPassword, dryRun: input.dryRun });
    } catch (err) {
      crash = err;
    }
    const status = report ? report.status() : 'failed';
    await Job.updateOne({ _id: id }, {
      $set: {
        status,
        finishedAt: new Date(),
        ...(report
          ? { counts: report.counts, rowErrors: report.rowErrors, substitutions: [...report.substitutions] }
          : { rowErrors: [{ row: 1, code: 'INTERNAL_ERROR', message: String((crash as Error)?.message ?? crash).slice(0, 300) }] }),
      },
      $inc: { v: 1 },
    });
    this.d.logger.info({ jobId: id, kind: input.kind, status, counts: report?.counts }, 'import job finished');
    if (!input.dryRun) {
      const c = report?.counts;
      await register.appendLedger({
        action: 'import.completed', subject: { type: 'import_job', id },
        reason: `${input.kind} import ${status}${c ? `: rows ${c.rows}, created ${c.created}, updated ${c.updated}, deactivated ${c.deactivated}, failed ${c.failed}` : ''}`.slice(0, 500),
        afterHash: sha256(input.csv),
      }).catch((err: unknown) => this.d.logger.error({ err, jobId: id }, 'import ledger record failed'));
    }
  }
}
