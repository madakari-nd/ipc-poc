import { RiskChip, StateBoundary } from '@ipc/design-system';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { apiRequest } from '../../lib/api.js';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { CARD_SECTION, canSee } from '../../lib/nav.js';
import type { HomeSummary, Role } from '../../lib/types.js';

/** "What needs me now" (FR-036): only cards for actions the active role may take. */
export function HomeCards({ role }: { role: Role }) {
  const { t, i18n } = useTranslation();
  const home = useQuery({ queryKey: ['home', role], queryFn: () => apiRequest<HomeSummary>('/ipc/v1/me/home') });
  const cards = (home.data?.cards ?? []).filter((c) => c.count > 0);
  const messages = useStateMessages({ empty: { title: t('home.nothing.title'), description: t('home.nothing.description') } });
  const fmtDate = (iso: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(iso));

  return (
    <StateBoundary status={boundaryStatus(home, cards.length === 0)} messages={messages} onRetry={() => void home.refetch()}>
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((c) => {
          const section = CARD_SECTION[c.kind];
          const target = section && canSee(role, section) ? `/${section}` : undefined;
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
                      {p.dueAt && <span className="text-sm text-text-muted">{t('home.due', { date: fmtDate(p.dueAt) })}</span>}
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
  );
}
