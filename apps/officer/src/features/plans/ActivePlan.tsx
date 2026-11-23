import { useState } from 'react';
import { Button, RiskChip, StatusChip } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { CarriedOverTasks } from './CarriedOverTasks.js';
import { PlanHistory } from './PlanHistory.js';
import { ReviseDialog, type ReviseSeed } from './ReviseDialog.js';
import type { PlanDetail } from './api.js';
import { useDate, useLocalized } from './format.js';

/** An approved plan: its tasks, carried-over tasks, later findings, revisions and changes (US3 AS5–AS7). */
export function ActivePlan({ plan, canRevise }: { plan: PlanDetail; canRevise: boolean }) {
  const { t } = useTranslation();
  const title = useLocalized();
  const date = useDate();
  const [seed, setSeed] = useState<ReviseSeed | null>(null);
  const own = (plan.tasks ?? []).filter((x) => x.planId === plan.id);
  const carried = (plan.tasks ?? []).filter((x) => x.planId !== plan.id);
  const findings = plan.unplannedFindings ?? [];
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="plan-tasks" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="plan-tasks" className="text-xl font-semibold text-text">{t('plans.task.title')}</h2>
          {canRevise && <Button variant="secondary" onClick={() => setSeed({ op: 'add' })}>{t('plans.revise.open')}</Button>}
        </div>
        <ul className="flex flex-col gap-2">
          {own.map((x) => (
            <li key={x.id} className="flex flex-col gap-1 rounded-md border border-border-subtle p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-text">{title(x.title)}</span>
                <RiskChip level={x.riskLevel} label={t(`risk.${x.riskLevel}`)} />
                <StatusChip state={x.state} label={t(`taskState.${x.state}`)} />
              </div>
              <p className="text-sm text-text-muted">
                {t('plans.task.owner', { user: x.ownerUserId })} · {t('plans.task.due', { date: date(x.dueAt) })}
                {x.overdue ? ` · ${t('plans.task.overdue')}` : ''}
                {x.syncState !== 'in_sync' ? ` · ${t('plans.task.syncing')}` : ''}
              </p>
            </li>
          ))}
        </ul>
      </section>
      <CarriedOverTasks tasks={carried} />
      {findings.length > 0 && (
        <section aria-labelledby="later-findings" className="flex flex-col gap-3">
          <h2 id="later-findings" className="text-xl font-semibold text-text">{t('plans.findings.title')}</h2>
          <p className="text-base text-text-muted">{t('plans.findings.description')}</p>
          <ul className="flex flex-col gap-2">
            {findings.map((f) => (
              <li key={`${f.assessmentId}:${f.questionKey}`} className="flex flex-wrap items-center gap-2 rounded-md border border-border-subtle p-3">
                <span className="text-text">{f.questionKey}</span>
                <RiskChip level={f.riskLevel} label={t(`risk.${f.riskLevel}`)} />
                {canRevise && (
                  <Button variant="ghost" onClick={() => setSeed({ op: 'add', sourceQuestionKey: f.questionKey, riskLevel: f.riskLevel })}>{t('plans.findings.add')}</Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <PlanHistory planId={plan.id} />
      {seed && <ReviseDialog key={JSON.stringify(seed)} plan={plan} seed={seed} onClose={() => setSeed(null)} />}
    </div>
  );
}
