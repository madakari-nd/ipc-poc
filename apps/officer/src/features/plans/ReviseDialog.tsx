import { useState } from 'react';
import { Button, Dialog, Field, Select, useToast } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { PlanError } from './PlanError.js';
import { fromDateInput, useRevise, useWardPeople, type PlanDetail, type RiskLevel } from './api.js';
import { useLocalized } from './format.js';

type Op = 'add' | 'remove' | 'update';
export interface ReviseSeed { op: Op; sourceQuestionKey?: string; riskLevel?: RiskLevel; title?: string }

/** One change to an active plan with a reason; recorded as the next numbered revision (FR-017, US3 AS6/AS7). */
export function ReviseDialog({ plan, seed, onClose }: { plan: PlanDetail; seed: ReviseSeed | null; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const title = useLocalized();
  const revise = useRevise(plan.id);
  const people = useWardPeople(plan.wardId).data?.items ?? [];
  const [op, setOp] = useState<Op>(seed?.op ?? 'add');
  const [reason, setReason] = useState('');
  const [taskId, setTaskId] = useState<string>();
  const [name, setName] = useState(seed?.title ?? '');
  const [risk, setRisk] = useState<RiskLevel>(seed?.riskLevel ?? 'normal');
  const [owner, setOwner] = useState<string>();
  const [due, setDue] = useState('');
  const open = seed !== null;
  const editable = (plan.tasks ?? []).filter((x) => x.state !== 'CLOSED');
  const ready = reason.trim() && (op === 'add' ? name.trim() && owner : taskId && (op === 'remove' || due));

  const submit = () => {
    const change =
      op === 'add'
        ? { op, task: { title: { en: name.trim() }, riskLevel: risk, ownerUserId: owner!, ...(seed?.sourceQuestionKey ? { sourceQuestionKey: seed.sourceQuestionKey } : {}), ...(due ? { dueAt: fromDateInput(due) } : {}) } }
        : op === 'remove' ? { op, taskId: taskId! } : { op, taskId: taskId!, set: { dueAt: fromDateInput(due) } };
    revise.mutate({ v: plan.v, body: { reason: reason.trim(), changes: [change] } }, {
      onSuccess: () => {
        toast.show({ tone: 'success', title: t('plans.revise.done') });
        onClose();
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title={t('plans.revise.title')}
      description={t('plans.revise.description', { n: plan.revision + 1 })}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={submit} busy={revise.isPending} disabled={!ready}>{t('plans.revise.confirm')}</Button>
        </>
      }
    >
      <Select label={t('plans.revise.kind')} value={op} onValueChange={(v) => setOp(v as Op)} options={(['add', 'remove', 'update'] as const).map((o) => ({ value: o, label: t(`plans.revise.ops.${o}`) }))} />
      {op === 'add' ? (
        <>
          <Field label={t('plans.revise.taskTitle')} maxLength={500} value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Select label={t('plans.revise.risk')} value={risk} onValueChange={(v) => setRisk(v as RiskLevel)} options={(['critical', 'high', 'normal'] as const).map((r) => ({ value: r, label: t(`risk.${r}`) }))} />
          <Select label={t('plans.editor.owner')} placeholder={t('plans.editor.chooseOwner')} value={owner} onValueChange={setOwner} options={people.map((p) => ({ value: p.userId, label: p.name }))} />
        </>
      ) : (
        <Select label={t('plans.revise.task')} placeholder={t('plans.revise.chooseTask')} value={taskId} onValueChange={setTaskId} options={editable.map((x) => ({ value: x.id, label: title(x.title) }))} />
      )}
      {op !== 'remove' && <Field label={op === 'add' ? t('plans.revise.dueOptional') : t('plans.editor.due')} type="date" value={due} onChange={(e) => setDue(e.currentTarget.value)} />}
      <Field label={t('plans.revise.reason')} hint={t('plans.revise.reasonHint')} multiline maxLength={500} showCount value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
      <PlanError error={revise.error} />
    </Dialog>
  );
}
