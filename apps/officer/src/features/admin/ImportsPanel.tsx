import { useId, useState } from 'react';
import { Button, DataTable, Select, StateBoundary } from '@ipc/design-system';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { useMe } from '../auth/useMe.js';
import { uploadImport, useImportJob, type ImportJob } from './api.js';
import { Panel, WriteError, useFormatDate } from './common.js';

const MAX_BYTES = 5 * 1024 * 1024;

/** Imports: upload a facility-master or staff file, then follow the job (status, counts, row errors). */
export function ImportsPanel() {
  const { t } = useTranslation();
  const fmt = useFormatDate();
  const me = useMe().data!;
  const fileId = useId();
  const [kind, setKind] = useState<'facility' | 'hr'>('facility');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string>();
  const [jobId, setJobId] = useState<string>();
  const job = useImportJob(jobId);
  const messages = useStateMessages();
  const upload = useMutation({
    mutationFn: () => uploadImport(kind, file!, me.csrfToken),
    onSuccess: (j) => setJobId(j.id),
  });

  const submit = () => {
    if (!file) return setFileError(t('admin.imports.fileRequired'));
    if (file.size > MAX_BYTES) return setFileError(t('admin.imports.tooLarge'));
    setFileError(undefined);
    upload.mutate();
  };

  const j = job.data;
  return (
    <Panel title={t('admin.imports.title')}>
      <p className="text-base text-text-muted">{t('admin.imports.help')}</p>
      <div className="grid gap-4 md:grid-cols-2">
        <Select
          label={t('admin.imports.kind')}
          value={kind}
          onValueChange={(v) => setKind(v as 'facility' | 'hr')}
          options={[{ value: 'facility', label: t('admin.imports.kinds.facility') }, { value: 'hr', label: t('admin.imports.kinds.hr') }]}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={fileId} className="text-sm font-semibold text-text">{t('admin.imports.file')}</label>
          <input
            id={fileId}
            type="file"
            accept=".csv,text/csv"
            aria-invalid={fileError ? true : undefined}
            aria-describedby={fileError ? `${fileId}-error` : undefined}
            className="min-h-touch text-base"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {fileError && <p id={`${fileId}-error`} className="text-sm font-semibold text-feedback-error-fg">{fileError}</p>}
        </div>
      </div>
      <div>
        <Button onClick={submit} busy={upload.isPending}>{t('admin.imports.upload')}</Button>
      </div>
      <WriteError error={upload.error} />
      {jobId && (
        <StateBoundary status={boundaryStatus(job)} messages={messages} onRetry={() => void job.refetch()}>
          {j && <JobView job={j} fmt={fmt} />}
        </StateBoundary>
      )}
    </Panel>
  );
}

function JobView({ job, fmt }: { job: ImportJob; fmt: (iso?: string) => string }) {
  const { t } = useTranslation();
  const c = job.counts;
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <p className="text-lg font-semibold" data-testid="import-status">
        {t('admin.imports.status')}: {t(`admin.imports.statuses.${job.status}`)}
      </p>
      <dl className="grid grid-cols-2 gap-2 md:grid-cols-6">
        {(['rows', 'created', 'updated', 'deactivated', 'failed', 'tasksNeedingReassignment'] as const).map((k) => (
          <div key={k} className="rounded-md bg-surface-muted p-2">
            <dt className="text-sm text-text-muted">{t(`admin.imports.counts.${k}`)}</dt>
            <dd className="text-xl font-bold">{(c[k] ?? 0).toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-text-muted">{t('admin.imports.finished')}: {fmt(job.finishedAt)}</p>
      {!!job.rowErrors?.length && (
        <DataTable
          caption={t('admin.imports.rowErrors')}
          columns={[
            { key: 'row', header: t('admin.imports.row'), cell: (e) => e.row },
            { key: 'code', header: t('admin.imports.code'), cell: (e) => e.code },
            { key: 'message', header: t('admin.imports.message'), cell: (e) => e.message },
          ]}
          rows={job.rowErrors}
          getRowId={(e) => `${e.row}-${e.code}`}
        />
      )}
      {!!job.substitutions?.length && (
        <div>
          <h3 className="text-base font-semibold">{t('admin.imports.substitutions')}</h3>
          <ul className="list-disc pl-6 text-sm">
            {job.substitutions.map((s) => <li key={s}>{s}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
