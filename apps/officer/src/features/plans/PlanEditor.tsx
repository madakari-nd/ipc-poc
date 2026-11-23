import { useEffect, useMemo, useState } from 'react';
import { Button, Field, RiskChip, Select, useToast } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { ApproveDialog } from './ApproveDialog.js';
import { PlanError } from './PlanError.js';
import { fromDateInput, toLocalInput, useUpdateDraft, useWardPeople, type DraftTask, type PlanDetail } from './api.js';
import { useLocalized } from './format.js';

interface Goal { key: string; text: string }
interface Milestone { key: string; text: string; dueAt: string }

const newKey = (prefix: string) => `${prefix}${Date.now().toString(36)}`;

/**
 * Draft editor (T088, FR-012): owners, due dates, dependencies, which tasks to include, goals and
 * milestones. Saves with If-Match (the plan version); approval opens the confirmation dialog.
 */
export function PlanEditor({ plan }: { plan: PlanDetail }) {
  const { t } = useTranslation();
  const toast = useToast();
  const title = useLocalized();
  const people = useWardPeople(plan.wardId).data?.items ?? [];
  const save = useUpdateDraft(plan.id);
  const [tasks, setTasks] = useState<DraftTask[]>(plan.draftTasks ?? []);
  const [goals, setGoals] = useState<Goal[]>(plan.goals ?? []);
  const [milestones, setMilestones] = useState<Milestone[]>(plan.milestones ?? []);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    setTasks(plan.draftTasks ?? []);
    setGoals(plan.goals ?? []);
    setMilestones(plan.milestones ?? []);
  }, [plan.v]); // eslint-disable-line react-hooks/exhaustive-deps -- reset only when the server version changes

  const dirty = useMemo(
    () => JSON.stringify([tasks, goals, milestones]) !== JSON.stringify([plan.draftTasks ?? [], plan.goals ?? [], plan.milestones ?? []]),
    [tasks, goals, milestones, plan],
  );
  const setTask = (key: string, patch: Partial<DraftTask>) => setTasks((ts) => ts.map((x) => (x.taskKey === key ? { ...x, ...patch } : x)));
  const ownerOptions = people.map((p) => ({ value: p.userId, label: p.name }));
  const missingOwner = tasks.some((x) => x.included && !x.ownerUserId);

  const onSave = () =>
    save.mutate(
      {
        v: plan.v,
        body: {
          goals: goals.filter((g) => g.text.trim()),
          milestones: milestones.filter((m) => m.text.trim() && m.dueAt),
          tasks: tasks.map((x) => ({
            taskKey: x.taskKey, included: x.included, dueAt: x.dueAt, dependsOnTaskKeys: x.dependsOnTaskKeys ?? [],
            ...(x.ownerUserId ? { ownerUserId: x.ownerUserId } : {}),
          })),
        },
      },
      { onSuccess: () => toast.show({ tone: 'success', title: t('plans.editor.saved') }) },
    );

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="draft-tasks" className="flex flex-col gap-3">
        <h2 id="draft-tasks" className="text-xl font-semibold text-text">{t('plans.editor.tasks')}</h2>
        <ul className="flex flex-col gap-4">
          {tasks.map((x) => {
            const others = tasks.filter((o) => o.taskKey !== x.taskKey && o.included);
            return (
              <li key={x.taskKey} className="flex flex-col gap-3 rounded-lg border border-border-subtle p-4" aria-label={title(x.title)}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-lg font-semibold text-text">{title(x.title)}</h3>
                  <RiskChip level={x.riskLevel} label={t(`risk.${x.riskLevel}`)} />
                </div>
                <p className="text-sm text-text-muted">
                  {t('plans.editor.rules', {
                    evidence: x.evidenceRule.photoRequired ? t('plans.editor.photo', { count: x.evidenceRule.minPhotos }) : t('plans.editor.noPhoto'),
                    validation: x.secondValidation ? t('plans.editor.secondValidation') : t('plans.editor.supervisorOnly'),
                  })}
                </p>
                <label className="flex min-h-touch items-center gap-2 text-base text-text">
                  <input type="checkbox" className="h-5 w-5" checked={x.included} onChange={(e) => setTask(x.taskKey, { included: e.target.checked })} />
                  {t('plans.editor.include')}
                </label>
                {x.included && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select
                      label={t('plans.editor.owner')}
                      placeholder={t('plans.editor.chooseOwner')}
                      options={ownerOptions}
                      value={x.ownerUserId}
                      onValueChange={(v) => setTask(x.taskKey, { ownerUserId: v })}
                      error={!x.ownerUserId ? t('plans.editor.ownerNeeded') : undefined}
                    />
                    <Field
                      label={t('plans.editor.due')}
                      type="date"
                      value={toLocalInput(x.dueAt)}
                      onChange={(e) => {
                        const iso = fromDateInput(e.currentTarget.value);
                        if (iso) setTask(x.taskKey, { dueAt: iso });
                      }}
                    />
                  </div>
                )}
                {x.included && others.length > 0 && (
                  <fieldset className="flex flex-col gap-1">
                    <legend className="text-sm font-semibold text-text">{t('plans.editor.dependsOn')}</legend>
                    {others.map((o) => (
                      <label key={o.taskKey} className="flex min-h-touch items-center gap-2 text-base text-text">
                        <input
                          type="checkbox"
                          className="h-5 w-5"
                          checked={(x.dependsOnTaskKeys ?? []).includes(o.taskKey)}
                          onChange={(e) => setTask(x.taskKey, {
                            dependsOnTaskKeys: e.target.checked
                              ? [...(x.dependsOnTaskKeys ?? []), o.taskKey]
                              : (x.dependsOnTaskKeys ?? []).filter((k) => k !== o.taskKey),
                          })}
                        />
                        {title(o.title)}
                      </label>
                    ))}
                  </fieldset>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="plan-goals" className="flex flex-col gap-3">
        <h2 id="plan-goals" className="text-xl font-semibold text-text">{t('plans.editor.goals')}</h2>
        {goals.map((g, i) => (
          <div key={g.key} className="flex items-end gap-2">
            <div className="flex-1">
              <Field label={t('plans.editor.goalN', { n: i + 1 })} maxLength={500} value={g.text} onChange={(e) => {
                const v = e.currentTarget.value;
                setGoals((gs) => gs.map((x) => (x.key === g.key ? { ...x, text: v } : x)));
              }} />
            </div>
            <Button variant="ghost" onClick={() => setGoals((gs) => gs.filter((x) => x.key !== g.key))}>{t('plans.editor.remove')}</Button>
          </div>
        ))}
        <div><Button variant="secondary" onClick={() => setGoals((gs) => [...gs, { key: newKey('g'), text: '' }])}>{t('plans.editor.addGoal')}</Button></div>
      </section>

      <section aria-labelledby="plan-milestones" className="flex flex-col gap-3">
        <h2 id="plan-milestones" className="text-xl font-semibold text-text">{t('plans.editor.milestones')}</h2>
        {milestones.map((m, i) => (
          <div key={m.key} className="grid items-end gap-2 sm:grid-cols-[1fr_12rem_auto]">
            <Field label={t('plans.editor.milestoneN', { n: i + 1 })} maxLength={500} value={m.text} onChange={(e) => {
              const v = e.currentTarget.value;
              setMilestones((ms) => ms.map((x) => (x.key === m.key ? { ...x, text: v } : x)));
            }} />
            <Field label={t('plans.editor.milestoneDue')} type="date" value={toLocalInput(m.dueAt)} onChange={(e) => {
              const v = fromDateInput(e.currentTarget.value) ?? '';
              setMilestones((ms) => ms.map((x) => (x.key === m.key ? { ...x, dueAt: v } : x)));
            }} />
            <Button variant="ghost" onClick={() => setMilestones((ms) => ms.filter((x) => x.key !== m.key))}>{t('plans.editor.remove')}</Button>
          </div>
        ))}
        <div><Button variant="secondary" onClick={() => setMilestones((ms) => [...ms, { key: newKey('m'), text: '', dueAt: '' }])}>{t('plans.editor.addMilestone')}</Button></div>
      </section>

      <PlanError error={save.error} />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onSave} busy={save.isPending} disabled={!dirty || save.isPending}>{t('plans.editor.save')}</Button>
        <Button onClick={() => setApproving(true)} disabled={dirty || missingOwner}>{t('plans.approve.open')}</Button>
      </div>
      {(dirty || missingOwner) && <p className="text-sm text-text-muted">{dirty ? t('plans.editor.saveFirst') : t('plans.editor.ownersFirst')}</p>}
      <ApproveDialog plan={plan} open={approving} onOpenChange={setApproving} />
    </div>
  );
}
