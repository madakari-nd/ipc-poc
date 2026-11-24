import { Button, ConfirmWithReason, Dialog, Field, RiskChip, Select, StateBoundary, StatusChip, useToast } from '@ipc/design-system';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import type { Role } from '../../lib/types.js';
import { useDate, useLocalized } from '../plans/format.js';
import { ACCEPT_REASONS, RETURN_REASONS, reviewErrorKey, useTask, useTaskHistory, useTaskWrite, useWardPeople, type Task, type TaskWrite } from './api.js';
import { EvidenceCard } from './EvidenceViewer.js';
import { useReasonLabels, useReasonOptions } from './labels.js';

type Confirm = null | 'accept' | 'return' | 'validate' | 'validation_return';

function History({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation();
  const q = useTaskHistory(taskId);
  const messages = useStateMessages();
  const fmt = (iso: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  const entries = q.data?.entries ?? [];
  return (
    <section aria-labelledby="task-history" className="flex flex-col gap-2">
      <h3 id="task-history" className="text-lg font-semibold text-text">{t('review.history.title')}</h3>
      <StateBoundary status={boundaryStatus(q, entries.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
        <ol className="flex flex-col gap-2" aria-label={t('review.history.title')}>
          {entries.map((e) => (
            <li key={e.ledgerSeq} className="rounded-md border border-border-subtle p-2 text-sm">
              <span className="font-semibold">{t(`review.history.actions.${e.action.replace(/\./g, '_')}`, { defaultValue: e.action })}</span>
              {' · '}{fmt(e.at)}{' · '}{t(`roles.${e.actor.role}`, { defaultValue: e.actor.role })} {e.actor.userId}
              {e.fromState && e.toState && e.fromState !== e.toState && <> · {t(`taskState.${e.fromState}`)} → {t(`taskState.${e.toState}`)}</>}
              {e.reasonCode && <> · {t(`review.reasons.${e.reasonCode}`)}</>}
              {e.reason && <> · {e.reason}</>}
              {e.previousOwnerUserId && <> · {t('review.history.owner', { from: e.previousOwnerUserId, to: e.newOwnerUserId })}</>}
            </li>
          ))}
        </ol>
      </StateBoundary>
    </section>
  );
}

function ReassignDialog({ task, open, onOpenChange, onDone }: { task: Task; open: boolean; onOpenChange: (o: boolean) => void; onDone: (w: TaskWrite) => Promise<void> }) {
  const { t } = useTranslation();
  const people = (useWardPeople(task.wardId).data?.items ?? []).filter((p) => p.active && p.userId !== task.ownerUserId && p.roles.some((r) => r === 'FRONTLINE' || r === 'WARD_SUPERVISOR'));
  const [owner, setOwner] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const [error, setError] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('review.reassign.title')}
      description={t('review.reassign.description')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => {
            if (!owner || !reason.trim()) return setError(true);
            void onDone({ kind: 'reassign', newOwnerUserId: owner, reason: reason.trim() });
          }}>{t('review.reassign.confirm')}</Button>
        </>
      }
    >
      <Select label={t('review.reassign.owner')} placeholder={t('review.reassign.choose')} options={people.map((p) => ({ value: p.userId, label: p.name }))} value={owner} onValueChange={setOwner} error={error && !owner ? t('review.reassign.ownerRequired') : undefined} />
      <Field label={t('review.reassign.reason')} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} error={error && !reason.trim() ? t('review.reasonTextRequired') : undefined} />
    </Dialog>
  );
}

function BlockDialog({ task, open, onOpenChange, onDone }: { task: Task; open: boolean; onOpenChange: (o: boolean) => void; onDone: (w: TaskWrite) => Promise<void> }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [error, setError] = useState(false);
  const blocking = !task.blocked;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={blocking ? t('review.block.title') : t('review.block.clearTitle')}
      description={blocking ? t('review.block.description') : t('review.block.clearDescription')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => {
            if (blocking && !reason.trim()) return setError(true);
            void onDone({ kind: 'block', blocked: blocking, reason: reason.trim() || undefined });
          }}>{blocking ? t('review.block.confirm') : t('review.block.clear')}</Button>
        </>
      }
    >
      <Field label={t('review.block.reason')} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} error={error ? t('review.reasonTextRequired') : undefined} />
    </Dialog>
  );
}

/**
 * Review of one task (US4): details, the proof with its metadata and signed-URL viewer, the
 * supervisor's Accept / Return, the IPC officer's or DQM's Validate / Return (FR-014 reason list),
 * Reassign and the blocked flag for the ward supervisor, and the full history.
 */
export function TaskReview({ taskId, role }: { taskId: string; role: Role }) {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useTask(taskId);
  const task = q.data;
  const write = useTaskWrite(task);
  const date = useDate();
  const loc = useLocalized();
  const labels = useReasonLabels();
  const options = useReasonOptions();
  const messages = useStateMessages();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [reassign, setReassign] = useState(false);
  const [block, setBlock] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (w: TaskWrite, done: string) => {
    setProblem(null);
    try {
      await write.mutateAsync(w);
      setConfirm(null);
      setReassign(false);
      setBlock(false);
      toast.show({ tone: 'success', title: done });
    } catch (e) {
      setConfirm(null);
      setProblem(t(reviewErrorKey(e)));
    }
  };

  const supervisor = role === 'WARD_SUPERVISOR';
  const validator = role === 'IPC_OFFICER' || role === 'DISTRICT_QM';
  const open = task && task.state !== 'CLOSED';
  const decide = task && ((supervisor && task.state === 'EVIDENCE_SUBMITTED') || (validator && task.state === 'PENDING_VALIDATION'));
  const dialog: Record<Exclude<Confirm, null>, { title: string; confirm: string; reasons: typeof RETURN_REASONS; done: string; danger: boolean }> = {
    accept: { title: t('review.accept.title'), confirm: t('review.accept.confirm'), reasons: ACCEPT_REASONS, done: t('review.accept.done'), danger: false },
    return: { title: t('review.return.title'), confirm: t('review.return.confirm'), reasons: RETURN_REASONS, done: t('review.return.done'), danger: true },
    validate: { title: t('review.validate.title'), confirm: t('review.validate.confirm'), reasons: ACCEPT_REASONS, done: t('review.validate.done'), danger: false },
    validation_return: { title: t('review.return.title'), confirm: t('review.return.confirm'), reasons: RETURN_REASONS, done: t('review.return.done'), danger: true },
  };

  return (
    <StateBoundary status={boundaryStatus(q, !task)} messages={messages} onRetry={() => void q.refetch()}>
      {task && (
        <article className="flex flex-col gap-6" aria-labelledby="review-title">
          <div className="flex flex-col gap-2">
            <h2 id="review-title" className="text-xl font-semibold text-text">{loc(task.title)}</h2>
            <div className="flex flex-wrap gap-2">
              <StatusChip state={task.state} label={t(`taskState.${task.state}`)} />
              <RiskChip level={task.riskLevel} label={t(`risk.${task.riskLevel}`)} />
              {task.blocked && <span className="rounded-full bg-feedback-warning px-3 py-1 text-sm font-semibold text-feedback-warning-fg">{t('review.blocked', { reason: task.blocked.reason })}</span>}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
              <dt className="font-semibold">{t('review.owner')}</dt><dd>{task.ownerUserId}</dd>
              <dt className="font-semibold">{t('review.due')}</dt><dd>{date(task.dueAt)}{task.overdue ? ` · ${t('review.overdue')}` : ''}</dd>
              <dt className="font-semibold">{t('review.returns')}</dt><dd>{task.rejectionCount}</dd>
            </dl>
            {task.lastReturnReason && task.state === 'CHANGES_REQUESTED' && (
              <p className="rounded-md bg-feedback-error p-2 text-feedback-error-fg">{t('review.lastReturn', { reason: t(`review.reasons.${task.lastReturnReason.reasonCode}`) })}</p>
            )}
          </div>

          {problem && <p role="alert" className="rounded-md bg-feedback-error p-3 text-feedback-error-fg">{problem}</p>}

          <section aria-labelledby="proof" className="flex flex-col gap-2">
            <h3 id="proof" className="text-lg font-semibold text-text">{t('review.evidence.title')}</h3>
            {(task.currentEvidenceIds ?? []).length === 0
              ? <p className="text-text-muted">{t('review.evidence.none')}</p>
              : (
                <ul className="flex flex-col gap-3">
                  {(task.currentEvidenceIds ?? []).map((id, i) => <EvidenceCard key={id} id={id} index={i} taskId={task.id} canDelete={!!decide} />)}
                </ul>
              )}
          </section>

          {(decide || (supervisor && open)) && (
            <div className="flex flex-wrap gap-2">
              {decide && supervisor && <Button onClick={() => setConfirm('accept')}>{t('review.accept.open')}</Button>}
              {decide && validator && <Button onClick={() => setConfirm('validate')}>{t('review.validate.open')}</Button>}
              {decide && <Button variant="danger" onClick={() => setConfirm(supervisor ? 'return' : 'validation_return')}>{t('review.return.open')}</Button>}
              {supervisor && open && <Button variant="secondary" onClick={() => setReassign(true)}>{t('review.reassign.open')}</Button>}
              {supervisor && open && <Button variant="secondary" onClick={() => setBlock(true)}>{task.blocked ? t('review.block.clear') : t('review.block.open')}</Button>}
            </div>
          )}

          {confirm && (
            <ConfirmWithReason
              open
              onOpenChange={(o) => !o && setConfirm(null)}
              title={dialog[confirm].title}
              reasons={options(dialog[confirm].reasons)}
              labels={{ ...labels, confirm: dialog[confirm].confirm }}
              variant={dialog[confirm].danger ? 'danger' : 'primary'}
              busy={write.isPending}
              onConfirm={({ reasonCode, reasonText }) => run({ kind: confirm, reasonCode: reasonCode!, reasonText } as TaskWrite, dialog[confirm].done)}
            />
          )}
          <ReassignDialog task={task} open={reassign} onOpenChange={setReassign} onDone={(w) => run(w, t('review.reassign.done'))} />
          <BlockDialog key={String(!!task.blocked)} task={task} open={block} onOpenChange={setBlock} onDone={(w) => run(w, t('review.block.done'))} />

          <History taskId={task.id} />
        </article>
      )}
    </StateBoundary>
  );
}
