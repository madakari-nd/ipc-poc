import { Button, DataTable, type Column } from '@ipc/design-system';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { diffChangeSet, reapplyBody, type DiffRow } from './diff.js';

export interface DiffReviewProps {
  /** The user's change set that the server refused as out of date. */
  mine: Record<string, unknown>;
  /** The server's current version (409 VERSION_CONFLICT `current`). */
  current: Record<string, unknown>;
  currentVersion?: number;
  /** Re-apply the kept changes on top of `currentVersion`. */
  onReapply: (body: Record<string, unknown>, currentVersion?: number) => void | Promise<void>;
  /** Give up the change and keep the server version. */
  onKeepServer: () => void | Promise<void>;
  fieldLabel?: (field: string) => string;
  busy?: boolean;
}

/** FR-016 / Constitution VII: nothing is silently overwritten; the user sees and chooses. */
export function DiffReview({ mine, current, currentVersion, onReapply, onKeepServer, fieldLabel, busy }: DiffReviewProps) {
  const { t } = useTranslation();
  const rows = useMemo(() => diffChangeSet(mine, current), [mine, current]);
  const [keep, setKeep] = useState<Set<string>>(() => new Set(rows.map((r) => r.field)));

  const show = (v: unknown) => (v === undefined || v === null || v === '' ? t('diff.none') : typeof v === 'string' ? v : JSON.stringify(v));
  const toggle = (field: string, on: boolean) =>
    setKeep((prev) => {
      const next = new Set(prev);
      if (on) next.add(field);
      else next.delete(field);
      return next;
    });

  const columns: Column<DiffRow>[] = [
    { key: 'field', header: t('diff.field'), cell: (r) => <span className="font-semibold">{fieldLabel ? fieldLabel(r.field) : r.field}</span> },
    { key: 'mine', header: t('diff.mine'), cell: (r) => <span className="break-words">{show(r.mine)}</span> },
    { key: 'server', header: t('diff.server'), cell: (r) => <span className="break-words">{show(r.server)}</span> },
    {
      key: 'keep',
      header: t('diff.keepMine'),
      cell: (r) =>
        r.differs ? (
          <label className="inline-flex min-h-touch items-center gap-2">
            <input type="checkbox" className="h-6 w-6" checked={keep.has(r.field)} onChange={(e) => toggle(r.field, e.target.checked)} />
            <span>{t('diff.keep')}</span>
          </label>
        ) : (
          <span className="text-text-muted">{t('diff.same')}</span>
        ),
    },
  ];

  const changed = rows.filter((r) => r.differs).length;
  const body = reapplyBody(mine, keep);

  return (
    <section className="flex flex-col gap-4">
      <p role="status" className="rounded-md bg-feedback-warning p-3 text-feedback-warning-fg">
        {t('diff.explain', { count: changed })}
      </p>
      <DataTable caption={t('diff.caption')} columns={columns} rows={rows} getRowId={(r) => r.field} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void onReapply(body, currentVersion)} busy={busy} disabled={Object.keys(body).length === 0}>
          {t('diff.reapply')}
        </Button>
        <Button variant="secondary" onClick={() => void onKeepServer()} disabled={busy}>
          {t('diff.keepServer')}
        </Button>
      </div>
    </section>
  );
}
