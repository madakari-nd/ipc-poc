import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useWardName } from '../plans/api.js';
import type { SupportRequest } from './api.js';

/** One support request: ward, problem, skill/language, status and the chosen mentor. */
export function RequestCard({ request, children }: { request: SupportRequest; children?: ReactNode }) {
  const { t } = useTranslation();
  const ward = useWardName();
  const mentor = request.shortlist.find((m) => m.mentorId === request.chosenMentorId);
  return (
    <li aria-label={t('support.card.label', { ward: ward(request.wardId) })} className="flex flex-col gap-3 rounded-lg border border-border-subtle p-4 shadow-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-text">{ward(request.wardId)}</h3>
        <span className="rounded-full bg-surface-muted px-3 py-1 text-sm font-semibold text-text" data-status={request.status}>
          {t(`support.status.${request.status}`)}
        </span>
      </div>
      <p className="text-base text-text">{request.problem}</p>
      <p className="text-sm text-text-muted">
        {t('support.card.need', { skill: t(`support.skills.${request.skill}`), language: t(`support.languages.${request.language}`) })}
        {mentor ? ` · ${t('support.card.mentor', { name: mentor.name ?? mentor.mentorId })}` : ''}
        {request.planRevision ? ` · ${t('support.card.revision', { n: request.planRevision })}` : ''}
      </p>
      {children}
    </li>
  );
}
