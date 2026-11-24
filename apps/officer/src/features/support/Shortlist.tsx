import { Button, StateBoundary } from '@ipc/design-system';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { useShortlist, type ShortlistEntry, type SupportRequest } from './api.js';

/** Why a mentor is where it is (FR-022 order: skill, then language, then an open slot in 14 days). */
export function useReasons() {
  const { t, i18n } = useTranslation();
  const when = (iso: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(iso));
  return (m: ShortlistEntry, r: SupportRequest) => [
    m.skillMatch ? t('support.reasons.skill', { skill: t(`support.skills.${r.skill}`) }) : t('support.reasons.noSkill', { skill: t(`support.skills.${r.skill}`) }),
    m.languageMatch ? t('support.reasons.language', { language: t(`support.languages.${r.language}`) }) : t('support.reasons.noLanguage', { language: t(`support.languages.${r.language}`) }),
    m.available && m.nextOpenSlotAt ? t('support.reasons.available', { when: when(m.nextOpenSlotAt) }) : t('support.reasons.notAvailable'),
  ];
}

/** Shortlist (with ranking reasons). Choosing a mentor opens RequestSession. */
export function Shortlist({ request, onChoose }: { request: SupportRequest; onChoose?: (m: ShortlistEntry) => void }) {
  const { t } = useTranslation();
  const [refresh, setRefresh] = useState(false);
  const q = useShortlist(request.id, refresh);
  const reasons = useReasons();
  const items = q.data?.items ?? request.shortlist;
  const messages = useStateMessages({ empty: { title: t('support.shortlist.emptyTitle'), description: t('support.shortlist.emptyDescription') } });
  return (
    <section aria-labelledby="support-shortlist" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="support-shortlist" className="text-xl font-semibold text-text">{t('support.shortlist.title')}</h2>
        <Button variant="secondary" busy={q.isFetching} onClick={() => (refresh ? void q.refetch() : setRefresh(true))}>{t('support.shortlist.refresh')}</Button>
      </div>
      <p className="text-sm text-text-muted">{t('support.shortlist.order')}</p>
      <StateBoundary status={boundaryStatus({ ...q, isPending: q.isPending && !request.shortlist.length }, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
        <ol className="flex flex-col gap-3" aria-label={t('support.shortlist.title')}>
          {items.map((m) => (
            <li key={m.mentorId} aria-label={m.name ?? m.mentorId} className="flex flex-col gap-2 rounded-lg border border-border-subtle p-4 shadow-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-lg font-semibold text-text">{t('support.shortlist.rank', { rank: m.rank, name: m.name ?? m.mentorId })}</h3>
                {onChoose && <Button variant={m.rank === 1 ? 'primary' : 'secondary'} onClick={() => onChoose(m)}>{t('support.shortlist.choose')}</Button>}
              </div>
              <ul className="flex flex-col gap-1 text-sm text-text" aria-label={t('support.shortlist.why')}>
                {reasons(m, request).map((x) => <li key={x}>{x}</li>)}
              </ul>
            </li>
          ))}
        </ol>
      </StateBoundary>
    </section>
  );
}
