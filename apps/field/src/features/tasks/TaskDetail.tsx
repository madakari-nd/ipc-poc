import { Button, Field, RiskChip, StateBoundary, StatusChip, useToast } from '@ipc/design-system';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '../../lib/api.js';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { PhotoCapture } from '../capture/PhotoCapture.js';
import type { CapturedPhoto } from '../capture/capture.js';
import { OUTBOX_KEY, useSession, useSignedIn } from '../session/SessionProvider.js';
import { MY_TASKS_KEY, loadTask, queueProof, rememberLocal, startTask, taskKey, type Task } from './api.js';

const evidenceNeed = (r: Task['evidenceRule']) => (r.photoRequired ? Math.max(1, r.minPhotos) : r.minPhotos);

/**
 * US4 task detail for the owner: state, the "returned: reason" banner, Start (dependencies are
 * checked by the server, the blocking task is named), and proof photos queued in the outbox and
 * submitted with the task version (a conflict is reviewed in the sync queue, FR-016).
 */
export function TaskDetail({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation();
  const { db, key, outbox, me } = useSignedIn();
  const { requestSync } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: taskKey(taskId), queryFn: () => loadTask(db, key, taskId), retry: false });
  const messages = useStateMessages();
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const task = q.data?.task;
  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: taskKey(taskId) }), qc.invalidateQueries({ queryKey: MY_TASKS_KEY }), qc.invalidateQueries({ queryKey: OUTBOX_KEY })]);
  };
  const title = task ? ((task.title as Record<string, string | undefined>)[i18n.language] ?? task.title.en) : '';
  const fmt = (iso: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(iso));
  const mineToAct = task?.ownerUserId === me.userId;

  const onStart = async () => {
    if (!task) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await startTask(outbox, task, t('tasks.queue.start', { title }));
      if (r.queued) {
        // The server will be at v+1 after the queued start; later queued changes use that version.
        await rememberLocal(db, key, { ...task, state: 'IN_PROGRESS', v: task.v + 1 });
        requestSync();
        toast.show({ tone: 'info', title: t('tasks.startQueued') });
      } else {
        toast.show({ tone: 'success', title: t('tasks.started') });
      }
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DEPENDENCY_OPEN') {
        const names = ((e.problem.blockingTasks as { title: { en: string } }[] | undefined) ?? []).map((b) => b.title.en).join(', ');
        setProblem(t('tasks.dependencyOpen', { tasks: names }));
      } else if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setProblem(t('tasks.conflict'));
        await refresh();
      } else {
        setProblem(t('tasks.actionFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async () => {
    if (!task) return;
    setBusy(true);
    try {
      await queueProof(outbox, task, photos, note.trim() || undefined, { photo: t('tasks.queue.photo', { title }), submit: t('tasks.queue.submit', { title }) });
      await rememberLocal(db, key, { ...task, state: 'EVIDENCE_SUBMITTED', v: task.v + 1 });
      setPhotos([]);
      setNote('');
      requestSync();
      toast.show({ tone: 'success', title: t('tasks.proofQueued') });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <StateBoundary status={boundaryStatus(q, !task)} messages={messages} onRetry={() => void q.refetch()}>
      {task && (
        <article className="flex flex-col gap-4" aria-labelledby="task-title">
          <h2 id="task-title" className="text-xl font-semibold text-text">{title}</h2>
          <div className="flex flex-wrap gap-2">
            <StatusChip state={task.state} label={t(`taskState.${task.state}`)} />
            <RiskChip level={task.riskLevel} label={t(`risk.${task.riskLevel}`)} />
          </div>
          {q.data?.offline && <p role="status" className="rounded-md bg-feedback-warning p-3 text-feedback-warning-fg">{t('tasks.offlineTask')}</p>}
          {task.state === 'CHANGES_REQUESTED' && task.lastReturnReason && (
            <div role="alert" className="rounded-md bg-feedback-error p-3 text-feedback-error-fg">
              <p className="font-semibold">{t('tasks.returned', { reason: t(`reasons.${task.lastReturnReason.reasonCode}`) })}</p>
              {task.lastReturnReason.reasonText && <p>{task.lastReturnReason.reasonText}</p>}
            </div>
          )}
          {task.blocked && <p className="rounded-md bg-feedback-warning p-3 text-feedback-warning-fg">{t('tasks.blockedBecause', { reason: task.blocked.reason })}</p>}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
            <dt className="font-semibold">{t('tasks.dueLabel')}</dt>
            <dd>{fmt(task.dueAt)}{task.overdue ? ` · ${t('tasks.overdueTag')}` : ''}</dd>
            <dt className="font-semibold">{t('tasks.proofLabel')}</dt>
            <dd>{task.evidenceRule.photoRequired ? t('tasks.photosNeeded', { count: evidenceNeed(task.evidenceRule) }) : t('tasks.noPhotoNeeded')}</dd>
            <dt className="font-semibold">{t('tasks.validationLabel')}</dt>
            <dd>{task.secondValidation ? t('tasks.secondValidation') : t('tasks.supervisorOnly')}</dd>
            {task.rejectionCount > 0 && (
              <>
                <dt className="font-semibold">{t('tasks.returnsLabel')}</dt>
                <dd>{task.rejectionCount}</dd>
              </>
            )}
          </dl>

          {problem && <p role="alert" className="rounded-md bg-feedback-error p-3 text-feedback-error-fg">{problem}</p>}

          {mineToAct && task.state === 'ASSIGNED' && (
            <div><Button onClick={() => void onStart()} busy={busy}>{t('tasks.start')}</Button></div>
          )}

          {mineToAct && (task.state === 'IN_PROGRESS' || task.state === 'CHANGES_REQUESTED') && (
            <section className="flex flex-col gap-3" aria-labelledby="proof-title">
              <h3 id="proof-title" className="text-lg font-semibold text-text">{t('tasks.proofTitle')}</h3>
              <PhotoCapture key={photos.length} onCapture={(p) => setPhotos((list) => [...list, p])} />
              {photos.length > 0 && (
                <ul aria-label={t('tasks.photosReady')} className="flex flex-col gap-1">
                  {photos.map((p, i) => (
                    <li key={p.sha256} className="flex items-center justify-between gap-2">
                      <span className="break-all font-mono text-sm">{t('tasks.photoN', { n: i + 1 })} · {p.sha256.slice(0, 12)}</span>
                      <Button variant="secondary" onClick={() => setPhotos((l) => l.filter((x) => x !== p))}>{t('tasks.removePhoto')}</Button>
                    </li>
                  ))}
                </ul>
              )}
              <Field multiline label={t('tasks.note')} maxLength={500} showCount value={note} onChange={(e) => setNote(e.target.value)} />
              <div>
                <Button onClick={() => void onSubmit()} busy={busy} disabled={photos.length < evidenceNeed(task.evidenceRule)}>
                  {t('tasks.submitProof')}
                </Button>
              </div>
            </section>
          )}

          {(task.state === 'EVIDENCE_SUBMITTED' || task.state === 'PENDING_VALIDATION') && <p className="text-base text-text-muted">{t(`tasks.waiting.${task.state}`)}</p>}

          <Link to="/queue" className="inline-flex min-h-touch items-center font-semibold text-action-primary underline">{t('tasks.openQueue')}</Link>
        </article>
      )}
    </StateBoundary>
  );
}
