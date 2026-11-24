import { useState } from 'react';
import { Button, Field, useToast } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { useRecordOutcome, type SupportRequest } from './api.js';
import { SupportError } from './SupportError.js';

const today = () => new Date().toISOString().slice(0, 10);

/** OutcomeForm (mentor): the session was held, with the agreed actions (no meeting link needed). */
export function OutcomeForm({ request }: { request: SupportRequest }) {
  const { t } = useTranslation();
  const toast = useToast();
  const record = useRecordOutcome(request.id);
  const [heldOn, setHeldOn] = useState(today());
  const [actions, setActions] = useState<string[]>(['']);
  const filled = actions.map((a) => a.trim()).filter(Boolean);
  const ready = heldOn && filled.length > 0;

  const submit = () => {
    // A date only: the start of that day (UTC), never later than now.
    const heldAt = new Date(Math.min(Date.parse(`${heldOn}T00:00:00.000Z`), Date.now())).toISOString();
    record.mutate({ v: request.v, body: { held: true, heldAt, agreedActions: filled.map((text) => ({ text })) } }, {
      onSuccess: () => toast.show({ tone: 'success', title: t('support.outcome.done') }),
    });
  };

  return (
    <section aria-label={t('support.outcome.title')} className="flex flex-col gap-3">
      <h3 className="text-lg font-semibold text-text">{t('support.outcome.title')}</h3>
      <Field label={t('support.outcome.heldOn')} type="date" max={today()} value={heldOn} onChange={(e) => setHeldOn(e.currentTarget.value)} />
      {actions.map((a, i) => (
        <Field key={i} label={t('support.outcome.action', { n: i + 1 })} maxLength={500} value={a} onChange={(e) => setActions(actions.map((x, j) => (j === i ? e.currentTarget.value : x)))} />
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setActions([...actions, ''])} disabled={actions.length >= 20}>{t('support.outcome.addAction')}</Button>
        <Button onClick={submit} busy={record.isPending} disabled={!ready}>{t('support.outcome.submit')}</Button>
      </div>
      <SupportError error={record.error} />
    </section>
  );
}
