import { useState } from 'react';
import { Button, Dialog, Field, useToast } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { useRequestSession, type ShortlistEntry, type SupportRequest } from './api.js';
import { SupportError } from './SupportError.js';

/** `datetime-local` (IST wall clock) → ISO. */
const fromIst = (v: string) => (v ? new Date(`${v}:00+05:30`).toISOString() : undefined);

/** RequestSession: sends the session request to the chosen mentor in ELEVATE mentoring (officer's own account). */
export function RequestSession({ request, mentor, onClose }: { request: SupportRequest; mentor: ShortlistEntry | null; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const send = useRequestSession(request.id);
  const [message, setMessage] = useState('');
  const [start, setStart] = useState('');
  const needsTime = !!mentor && !mentor.available;

  const submit = () => {
    const proposedStartAt = fromIst(start);
    send.mutate({ v: request.v, body: { mentorId: mentor!.mentorId, ...(message.trim() ? { message: message.trim() } : {}), ...(proposedStartAt ? { proposedStartAt } : {}) } }, {
      onSuccess: () => {
        toast.show({ tone: 'success', title: t('support.session.done') });
        onClose();
      },
    });
  };

  return (
    <Dialog
      open={mentor !== null}
      onOpenChange={(v) => !v && onClose()}
      title={t('support.session.title', { name: mentor?.name ?? mentor?.mentorId ?? '' })}
      description={mentor?.available ? t('support.session.descriptionSlot') : t('support.session.descriptionNoSlot')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={submit} busy={send.isPending} disabled={needsTime && !start}>{t('support.session.confirm')}</Button>
        </>
      }
    >
      <Field label={needsTime ? t('support.session.start') : t('support.session.startOptional')} hint={t('support.session.startHint')} type="datetime-local" value={start} onChange={(e) => setStart(e.currentTarget.value)} />
      <Field label={t('support.session.message')} multiline maxLength={500} showCount value={message} onChange={(e) => setMessage(e.currentTarget.value)} />
      <SupportError error={send.error} />
    </Dialog>
  );
}
