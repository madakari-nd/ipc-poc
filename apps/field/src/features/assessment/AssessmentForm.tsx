import { Button, Field, IconAlert, IconCheck, IconUpload, RiskChip, StateBoundary, cn, useToast } from '@ipc/design-system';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { deviceId } from '../../lib/device.js';
import { useStateMessages } from '../../lib/boundary.js';
import type { OutboxItemView } from '../../offline/outbox.js';
import { PhotoCapture } from '../capture/PhotoCapture.js';
import { OUTBOX_KEY, useSession, useSignedIn } from '../session/SessionProvider.js';
import { fetchBundle } from './api.js';
import {
  DraftNotReady,
  FREE_TEXT_MAX,
  addPhoto,
  applyRefusal,
  draftProblems,
  queueSubmission,
  removePhoto,
  setAnswer,
  versionStatus,
  type BundleQuestion,
  type Draft,
  type DraftProblem,
} from './draft.js';
import { loadDraft, saveDraft } from './store.js';

const loc = (text: Record<string, string | undefined> | undefined, lang: string) => text?.[lang] ?? text?.en ?? '';

/** Answer control for the question's type: options, a score, or meets / does not meet. */
function AnswerControl({ q, value, disabled, onChange }: { q: BundleQuestion; value: Draft['answers'][string]['value']; disabled: boolean; onChange: (v: boolean | number | string) => void }) {
  const { t, i18n } = useTranslation();
  const name = useId();
  if (q.answerType === 'score') {
    return (
      <Field
        label={t('assessment.form.score', { max: q.maxScore })}
        type="number"
        min={0}
        max={q.maxScore}
        disabled={disabled}
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(Number((e.target as HTMLInputElement).value))}
      />
    );
  }
  const options: { value: boolean | string; label: string }[] = q.options?.length
    ? q.options.map((o) => ({ value: o.value, label: loc(o.label, i18n.language) }))
    : [
        { value: true, label: t('assessment.form.meets') },
        { value: false, label: t('assessment.form.doesNotMeet') },
      ];
  return (
    <fieldset className="flex flex-wrap gap-2" disabled={disabled}>
      <legend className="sr-only">{t('assessment.form.answer')}</legend>
      {options.map((o) => (
        <label key={String(o.value)} className={cn('inline-flex min-h-touch cursor-pointer items-center gap-2 rounded-md border border-border px-3', value === o.value && 'bg-action-secondary text-action-secondary-fg')}>
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} className="h-5 w-5" />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

function PhotoList({ draft, q, editable, onRemove }: { draft: Draft; q: BundleQuestion; editable: boolean; onRemove: (outboxId: string) => void }) {
  const { t, i18n } = useTranslation();
  const photos = draft.answers[q.questionKey]?.photos ?? [];
  if (!photos.length) return null;
  const time = (iso: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  return (
    <ul className="flex flex-col gap-2" aria-label={t('assessment.form.photos')}>
      {photos.map((p, i) => (
        <li key={p.outboxId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle p-2 text-sm" data-testid="draft-photo">
          <span>
            {t('assessment.form.photoN', { n: i + 1 })} · {time(p.capturedAt)} ·{' '}
            {p.gps ? t('assessment.form.gpsShort', { lat: p.gps.lat.toFixed(4), lng: p.gps.lng.toFixed(4) }) : t('capture.gpsUnavailable')} ·{' '}
            <span className="font-mono" data-testid="photo-sha">{p.sha256.slice(0, 12)}</span>
          </span>
          {editable && (
            <Button variant="secondary" onClick={() => onRemove(p.outboxId)}>
              {t('assessment.form.removePhoto')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

const statusIcon = { pending: IconUpload, sent: IconCheck, needs_attention: IconAlert } as const;

/** Per-item sync status for this assessment: its photos, then the assessment record (FR-037). */
function SubmissionStatus({ draft, items }: { draft: Draft; items: OutboxItemView[] }) {
  const { t } = useTranslation();
  const photoIds = new Set(Object.values(draft.answers).flatMap((a) => a.photos.map((p) => p.outboxId)));
  const mine = items.filter((i) => photoIds.has(i.id) || i.id === draft.submissionItemId);
  if (!mine.length) return null;
  return (
    <section aria-labelledby="sync-status" className="flex flex-col gap-2">
      <h2 id="sync-status" className="text-lg font-semibold">
        {t('assessment.status.title')}
      </h2>
      <ul className="flex flex-col gap-1" data-testid="sync-items">
        {mine.map((i) => {
          const Icon = statusIcon[i.status];
          return (
            <li key={i.id} className="flex flex-wrap items-center gap-2 text-sm" data-status={i.status} data-kind={i.kind}>
              <Icon />
              <span>{i.kind === 'evidence' ? t('assessment.status.photo') : t('assessment.status.record')}</span>
              <span className="font-semibold">{t(`queue.status.${i.status}`)}</span>
              {i.status === 'needs_attention' && i.attention && <span>{t(`queue.attention.${i.attention}`, { code: i.problemCode ?? '' })}</span>}
              {i.status === 'pending' && i.blockedBy.length > 0 && <span>{t('queue.waitingFor')}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** US2 form: sections for the ward type, answers, observations, photos, notes, declaration, submit. */
export function AssessmentForm({ assessmentId }: { assessmentId: string }) {
  const { t, i18n } = useTranslation();
  const { db, key, outbox, offline } = useSignedIn();
  const { requestSync } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const loaded = useQuery({ queryKey: ['assessment', 'draft', assessmentId], queryFn: async () => (await loadDraft(db, key, assessmentId)) ?? null });
  const items = useQuery({ queryKey: OUTBOX_KEY, queryFn: () => outbox.list() });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problems, setProblems] = useState<DraftProblem[]>([]);
  const [camera, setCamera] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const messages = useStateMessages({ empty: { title: t('assessment.form.notDownloaded.title'), description: t('assessment.form.notDownloaded.description') } });

  useEffect(() => {
    if (loaded.data && !draft) setDraft(loaded.data);
  }, [loaded.data, draft]);

  const update = useCallback(
    async (next: Draft) => {
      setDraft(next);
      await saveDraft(db, key, next);
      qc.setQueryData(['assessment', 'draft', assessmentId], next);
    },
    [db, key, qc, assessmentId],
  );

  // Back online: refresh the grace date of this version (a newer version may have been published).
  useEffect(() => {
    if (offline || !draft || draft.state !== 'editing') return;
    let stop = false;
    fetchBundle(assessmentId)
      .then((b) => {
        if (!stop && b.graceUntil !== draft.bundle.graceUntil) void update({ ...draft, bundle: { ...draft.bundle, graceUntil: b.graceUntil } });
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per draft / connectivity change
  }, [offline, assessmentId, draft?.state]);

  // A refusal that ends the draft (retired version) keeps it read-only (US2 AS6).
  const record = items.data?.find((i) => i.id === draft?.submissionItemId);
  useEffect(() => {
    if (draft && record?.status === 'needs_attention' && record.problemCode === 'CHECKLIST_VERSION_RETIRED' && draft.state !== 'read_only') {
      void update(applyRefusal(draft, record.problemCode));
    }
  }, [record?.status, record?.problemCode, draft, update]);

  const status = loaded.isPending ? 'loading' : loaded.isError ? 'error' : !loaded.data ? 'empty' : 'ready';
  const back = (
    <Button asChild variant="secondary">
      <Link to="/assessments">{t('assessment.form.backToList')}</Link>
    </Button>
  );
  if (status !== 'ready' || !draft) {
    return <StateBoundary status={status === 'ready' ? 'loading' : status} messages={messages} onRetry={() => void loaded.refetch()} emptyAction={back} />;
  }

  const editable = draft.state === 'editing' && versionStatus(draft.bundle) !== 'retired';
  const version = versionStatus(draft.bundle);
  const problemFor = (field: string) => problems.find((p) => p.field === field);
  const problemText = (p: DraftProblem) => t(`assessment.problem.${p.code}`, { max: FREE_TEXT_MAX });

  const submit = async () => {
    const found = draftProblems(draft);
    setProblems(found);
    if (found.length) return;
    setBusy(true);
    try {
      const next = await queueSubmission(outbox, draft, { now: Date.now(), deviceId: deviceId() });
      await update(next);
      await qc.invalidateQueries({ queryKey: OUTBOX_KEY });
      requestSync();
      toast.show({ tone: 'success', title: offline ? t('assessment.form.queuedOffline') : t('assessment.form.queued') });
    } catch (e) {
      if (e instanceof DraftNotReady) setProblems(e.problems);
      else throw e;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {version === 'grace' && draft.state === 'editing' && (
        <p role="status" className="rounded-md bg-feedback-info p-3 text-feedback-info-fg">
          {t('assessment.form.grace', { date: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(draft.bundle.graceUntil!)) })}
        </p>
      )}
      {(draft.state === 'read_only' || version === 'retired') && (
        <p role="alert" className="rounded-md bg-feedback-warning p-3 font-semibold text-feedback-warning-fg">
          {t('assessment.form.retired')}
        </p>
      )}
      {draft.state === 'queued' && (
        <p role="status" className="rounded-md bg-feedback-success p-3 text-feedback-success-fg">
          {t('assessment.form.queuedInfo')}
        </p>
      )}

      {draft.bundle.sections.map((s) => (
        <fieldset key={s.sectionKey} className="flex flex-col gap-4 rounded-lg border border-border-subtle p-4" disabled={!editable}>
          <legend className="px-1 text-xl font-semibold">{loc(s.title, i18n.language)}</legend>
          {draft.bundle.questions
            .filter((q) => q.sectionKey === s.sectionKey)
            .map((q) => {
              const a = draft.answers[q.questionKey];
              const unanswered = problemFor(`answers.${q.questionKey}`);
              const long = problemFor(`answers.${q.questionKey}.observation`);
              return (
                <div key={q.questionKey} className="flex flex-col gap-3 border-t border-border-subtle pt-3 first:border-t-0 first:pt-0" data-question={q.questionKey}>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold">{loc(q.text, i18n.language)}</h3>
                    <RiskChip level={q.riskLevel} label={t(`risk.${q.riskLevel}`)} />
                  </div>
                  <AnswerControl q={q} value={a?.value} disabled={!editable} onChange={(v) => void update(setAnswer(draft, q.questionKey, { value: v }))} />
                  {unanswered && <p className="text-sm font-semibold text-feedback-error-fg">{problemText(unanswered)}</p>}
                  <Field
                    multiline
                    label={t('assessment.form.observation')}
                    hint={t('assessment.form.noPatientText')}
                    maxLength={FREE_TEXT_MAX}
                    showCount
                    disabled={!editable}
                    value={a?.observation ?? ''}
                    error={long ? problemText(long) : undefined}
                    onChange={(e) => void update(setAnswer(draft, q.questionKey, { observation: (e.target as HTMLTextAreaElement).value }))}
                  />
                  <PhotoList draft={draft} q={q} editable={editable} onRemove={(id) => void removePhoto(outbox, draft, q.questionKey, id).then(update)} />
                  {editable &&
                    (camera === q.questionKey ? (
                      <div className="rounded-md border border-border-subtle p-3">
                        <PhotoCapture
                          onCapture={(p) => {
                            setCamera(null);
                            void addPhoto(outbox, draft, q.questionKey, p, `${draft.wardName}: ${loc(q.text, 'en')}`).then(async (next) => {
                              await update(next);
                              await qc.invalidateQueries({ queryKey: OUTBOX_KEY });
                            });
                          }}
                        />
                        <Button variant="secondary" className="mt-2" onClick={() => setCamera(null)}>
                          {t('assessment.form.closeCamera')}
                        </Button>
                      </div>
                    ) : (
                      <Button variant="secondary" onClick={() => setCamera(q.questionKey)} aria-label={t('assessment.form.addPhotoFor', { question: loc(q.text, i18n.language) })}>
                        {t('assessment.form.addPhoto')}
                      </Button>
                    ))}
                </div>
              );
            })}
        </fieldset>
      ))}

      <fieldset className="flex flex-col gap-4" disabled={!editable}>
        <legend className="sr-only">{t('assessment.form.finish')}</legend>
        <Field
          multiline
          label={t('assessment.form.notes')}
          hint={t('assessment.form.noPatientText')}
          maxLength={FREE_TEXT_MAX}
          showCount
          value={draft.notes}
          error={problemFor('notes') ? problemText(problemFor('notes')!) : undefined}
          onChange={(e) => void update({ ...draft, notes: (e.target as HTMLTextAreaElement).value })}
        />
        <label className="flex min-h-touch items-start gap-3 text-base">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5"
            checked={draft.declaration.accepted}
            aria-describedby={problemFor('declaration') ? 'declaration-error' : undefined}
            onChange={(e) => void update({ ...draft, declaration: e.target.checked ? { accepted: true, at: new Date().toISOString() } : { accepted: false } })}
          />
          <span>{t('assessment.form.declaration')}</span>
        </label>
        {problemFor('declaration') && (
          <p id="declaration-error" role="alert" className="rounded-md bg-feedback-error p-3 font-semibold text-feedback-error-fg">
            {t('assessment.problem.declaration_required')}
          </p>
        )}
        {problems.length > 0 && !problemFor('declaration') && (
          <p role="alert" className="text-sm font-semibold text-feedback-error-fg">
            {t('assessment.form.fixProblems', { count: problems.length })}
          </p>
        )}
        {editable && (
          <div>
            <Button busy={busy} onClick={() => void submit()}>
              {t('assessment.form.submit')}
            </Button>
          </div>
        )}
      </fieldset>

      <SubmissionStatus draft={draft} items={items.data ?? []} />
    </div>
  );
}
