import { Button, StateBoundary } from '@ipc/design-system';
import type { components } from '@ipc/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiRequest } from '../../lib/api.js';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';

export type LedgerRecord = components['schemas']['LedgerRecord'];
export type LedgerSubjectType = components['schemas']['LedgerSubjectType'];
interface LedgerPage { items: LedgerRecord[]; nextCursor: string | null }

const PAGE = 50;

/** Short, readable fingerprint; the full SHA-256 stays available (title + screen readers). */
function Fingerprint({ label, hash }: { label: string; hash: string }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1">
      <span className="text-sm text-text-muted">{label}</span>
      <code className="break-all rounded-sm bg-surface-muted px-1 font-mono text-sm text-text" title={hash} aria-label={`${label} ${hash}`}>
        {`${hash.slice(0, 12)}…`}
      </code>
    </span>
  );
}

/**
 * One screen with every recorded change of an entity (T066, SC-005, US9 AS5): who (actor and
 * role), when (real and programme time), what, why (reason) and the evidence fingerprints
 * (before/after SHA-256). Data: `getEntityLedger`, oldest first, scope-checked by the Edge.
 */
export function HistoryTimeline({ subjectType, subjectId }: { subjectType: LedgerSubjectType; subjectId: string }) {
  const { t, i18n } = useTranslation();
  const q = useInfiniteQuery({
    queryKey: ['ledger', subjectType, subjectId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: String(PAGE) });
      if (pageParam) p.set('cursor', pageParam);
      return apiRequest<LedgerPage>(`/ipc/v1/ledger/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}?${p.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const messages = useStateMessages({ empty: { title: t('history.empty.title'), description: t('history.empty.description') } });
  const when = (iso: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso));
  const action = (a: string) => t(`history.actions.${a.replace('.', '_')}`, { defaultValue: a });
  const role = (r: string) => t(r === 'SYSTEM' ? 'history.system' : `roles.${r}`);

  return (
    <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
      <ol aria-label={t('history.listLabel')} className="flex flex-col gap-3 border-l-2 border-border-subtle pl-4">
        {items.map((r) => (
          <li key={r.seq} className="relative flex flex-col gap-2 rounded-lg border border-border-subtle p-4 shadow-1">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold text-text">{action(r.action)}</h2>
              <span className="text-sm text-text-muted">{t('history.seq', { seq: r.seq })}</span>
            </div>
            <dl className="grid gap-x-4 gap-y-1 text-base sm:grid-cols-[max-content_1fr]">
              <dt className="font-semibold text-text-muted">{t('history.who')}</dt>
              <dd className="flex flex-wrap gap-2">
                <span>{r.actor.userId}</span>
                <span className="text-text-muted">{role(r.actor.role)}</span>
              </dd>
              <dt className="font-semibold text-text-muted">{t('history.when')}</dt>
              <dd>
                <time dateTime={r.at}>{when(r.at)}</time>
                {r.programmeAt !== r.at && (
                  <span className="ml-2 text-sm text-text-muted">{t('history.programmeTime', { time: when(r.programmeAt) })}</span>
                )}
              </dd>
              <dt className="font-semibold text-text-muted">{t('history.reason')}</dt>
              <dd>{r.reason ? r.reason : <span className="text-text-muted">{t('history.noReason')}</span>}</dd>
              <dt className="font-semibold text-text-muted">{t('history.fingerprints')}</dt>
              <dd className="flex flex-col gap-1">
                {r.beforeHash && <Fingerprint label={t('history.before')} hash={r.beforeHash} />}
                {r.afterHash && <Fingerprint label={t('history.after')} hash={r.afterHash} />}
                {!r.beforeHash && !r.afterHash && <span className="text-text-muted">{t('history.noFingerprint')}</span>}
                <Fingerprint label={t('history.recordHash')} hash={r.hash} />
              </dd>
            </dl>
          </li>
        ))}
      </ol>
      {q.hasNextPage && (
        <div className="mt-4">
          <Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t('history.more')}
          </Button>
        </div>
      )}
    </StateBoundary>
  );
}
