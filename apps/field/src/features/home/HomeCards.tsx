import { RiskChip, StateBoundary } from '@ipc/design-system';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { NetworkError, apiRequest } from '../../lib/api.js';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { CARD_SECTION, canSee } from '../../lib/nav.js';
import type { HomeSummary } from '../../lib/types.js';
import { getCached, putCached } from '../../offline/cache.js';
import { loadOfflineSession } from '../../offline/session.js';
import { OUTBOX_KEY, useSignedIn } from '../session/SessionProvider.js';

/** "What needs me now" (FR-036), served from the Edge and kept encrypted on the phone for offline use. */
export function HomeCards() {
  const { t, i18n } = useTranslation();
  const { me, outbox, db } = useSignedIn();
  const home = useQuery({
    queryKey: ['home', me.userId],
    queryFn: async (): Promise<{ summary: HomeSummary; savedAt?: number }> => {
      const local = await loadOfflineSession(db);
      try {
        const summary = await apiRequest<HomeSummary>('/ipc/v1/me/home');
        if (local) await putCached(db, local.key, 'home', summary);
        return { summary };
      } catch (e) {
        const cached = e instanceof NetworkError && local ? await getCached<HomeSummary>(db, local.key, 'home') : undefined;
        if (cached) return { summary: cached.value, savedAt: cached.updatedAt };
        throw e;
      }
    },
  });
  const queue = useQuery({ queryKey: OUTBOX_KEY, queryFn: () => outbox.list() });
  const unsent = (queue.data ?? []).filter((i) => i.status !== 'sent').length;
  const cards = (home.data?.summary.cards ?? []).filter((c) => c.count > 0);
  const messages = useStateMessages({ empty: { title: t('home.nothing.title'), description: t('home.nothing.description') } });

  return (
    <div className="flex flex-col gap-4">
      {unsent > 0 && (
        <Link to="/queue" className="rounded-md border border-border bg-feedback-info p-4 text-feedback-info-fg underline-offset-2 hover:underline">
          {t('home.unsent', { count: unsent })}
        </Link>
      )}
      {home.data?.savedAt && (
        <p role="status" className="text-sm text-text-muted">
          {t('home.offlineNote', { time: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(home.data.savedAt) })}
        </p>
      )}
      <StateBoundary status={boundaryStatus(home, cards.length === 0)} messages={messages} onRetry={() => void home.refetch()} emptyAction={<Link to="/queue">{t('nav.queue')}</Link>}>
        <ul className="grid gap-4 sm:grid-cols-2">
          {cards.map((c) => {
            const section = CARD_SECTION[c.kind];
            const target = section && canSee(me.activeRole, section) ? `/${section}` : undefined;
            return (
              <li key={c.kind} className="flex flex-col gap-2 rounded-lg border border-border-subtle p-4 shadow-1">
                <h2 className="text-lg font-semibold text-text">
                  {t(`home.cards.${c.kind}`)} <span className="text-text-muted">({new Intl.NumberFormat(i18n.language).format(c.count)})</span>
                </h2>
                {c.preview && c.preview.length > 0 && (
                  <ul className="flex flex-col gap-1">
                    {c.preview.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-center gap-2 text-base">
                        {p.riskLevel && <RiskChip level={p.riskLevel} label={t(`risk.${p.riskLevel}`)} />}
                        <span>{p.label}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {target && (
                  <Link to={target} className="inline-flex min-h-touch items-center font-semibold text-action-primary underline">
                    {t('home.open')}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </StateBoundary>
    </div>
  );
}
