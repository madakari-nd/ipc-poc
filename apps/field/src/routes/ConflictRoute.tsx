import { Button, PageHeader, StateBoundary, useToast } from '@ipc/design-system';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DiffReview } from '../features/conflict/DiffReview.js';
import { asRecord } from '../features/conflict/diff.js';
import { OUTBOX_KEY, useSession, useSignedIn } from '../features/session/SessionProvider.js';
import { boundaryStatus, useStateMessages } from '../lib/boundary.js';

/** "Review differences" for a queued change refused with 409 VERSION_CONFLICT (FR-016). */
export function ConflictRoute() {
  const { t } = useTranslation();
  const { itemId = '' } = useParams();
  const { outbox } = useSignedIn();
  const { requestSync } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const conflict = useQuery({ queryKey: ['conflict', itemId], queryFn: async () => (await outbox.getConflict(itemId)) ?? null });
  const messages = useStateMessages({ empty: { title: t('diff.gone.title'), description: t('diff.gone.description') } });

  const done = async (title: string) => {
    await qc.invalidateQueries({ queryKey: OUTBOX_KEY });
    requestSync();
    toast.show({ tone: 'success', title });
    navigate('/queue');
  };

  return (
    <>
      <PageHeader
        title={t('diff.title')}
        description={conflict.data?.label}
        back={
          <Link to="/queue" className="inline-flex min-h-touch items-center font-semibold text-action-primary underline">
            {t('diff.back')}
          </Link>
        }
      />
      <StateBoundary
        status={boundaryStatus(conflict, !conflict.data)}
        messages={messages}
        onRetry={() => void conflict.refetch()}
        emptyAction={
          <Button asChild variant="secondary">
            <Link to="/queue">{t('diff.back')}</Link>
          </Button>
        }
      >
        {conflict.data && (
          <DiffReview
            mine={asRecord(conflict.data.mine)}
            current={asRecord(conflict.data.current)}
            currentVersion={conflict.data.currentVersion}
            busy={busy}
            onReapply={async (body, v) => {
              setBusy(true);
              try {
                await outbox.reapply(itemId, { body, ifMatch: v === undefined ? undefined : String(v) });
                await done(t('diff.reapplied'));
              } finally {
                setBusy(false);
              }
            }}
            onKeepServer={async () => {
              await outbox.discard(itemId);
              await done(t('diff.discarded'));
            }}
          />
        )}
      </StateBoundary>
    </>
  );
}
