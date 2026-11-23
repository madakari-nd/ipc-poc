import { RiskChip, StatusChip } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import type { PlanTask } from './api.js';
import { useDate, useLocalized } from './format.js';

/** Still-open tasks of the previous cycle's plan, linked (not copied) into this plan (FR-018, US3 AS5). */
export function CarriedOverTasks({ tasks }: { tasks: PlanTask[] }) {
  const { t } = useTranslation();
  const title = useLocalized();
  const date = useDate();
  if (tasks.length === 0) return null;
  return (
    <section aria-labelledby="carried-over" className="flex flex-col gap-3">
      <h2 id="carried-over" className="text-xl font-semibold text-text">{t('plans.carried.title')}</h2>
      <p className="text-base text-text-muted">{t('plans.carried.description')}</p>
      <ul className="flex flex-col gap-2">
        {tasks.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border-subtle p-3">
            <span className="font-semibold text-text">{title(x.title)}</span>
            <RiskChip level={x.riskLevel} label={t(`risk.${x.riskLevel}`)} />
            <StatusChip state={x.state} label={t(`taskState.${x.state}`)} />
            <span className="text-sm text-text-muted">{t('plans.task.due', { date: date(x.dueAt) })}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
