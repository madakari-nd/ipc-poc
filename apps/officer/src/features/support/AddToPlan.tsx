import { useState } from 'react';
import { Button, Select, useToast } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { useWardPeople, type RiskLevel } from '../plans/api.js';
import { useAddToPlan, type SupportRequest } from './api.js';
import { SupportError } from './SupportError.js';

/** The officer turns the mentor's agreed actions into plan tasks with owners (FR-023: a plan revision). */
export function AddToPlan({ request }: { request: SupportRequest }) {
  const { t } = useTranslation();
  const toast = useToast();
  const add = useAddToPlan(request.id);
  const people = useWardPeople(request.wardId).data?.items ?? [];
  const actions = request.agreedActions ?? [];
  const [owners, setOwners] = useState<Record<number, string>>({});
  const [risks, setRisks] = useState<Record<number, RiskLevel>>({});
  const ready = actions.length > 0 && actions.every((_, i) => owners[i]);

  const submit = () => {
    add.mutate({ v: request.v, body: { actions: actions.map((_, i) => ({ index: i, ownerUserId: owners[i]!, riskLevel: risks[i] ?? 'normal' })) } }, {
      onSuccess: (rev) => toast.show({ tone: 'success', title: t('support.plan.done', { n: rev.revision }) }),
    });
  };

  return (
    <section aria-labelledby="support-plan" className="flex flex-col gap-3">
      <h2 id="support-plan" className="text-xl font-semibold text-text">{t('support.plan.title')}</h2>
      <p className="text-sm text-text-muted">{t('support.plan.intro')}</p>
      <ol className="flex flex-col gap-3" aria-label={t('support.plan.actions')}>
        {actions.map((a, i) => (
          <li key={i} aria-label={a.text} className="flex flex-col gap-2 rounded-lg border border-border-subtle p-4">
            <p className="font-semibold text-text">{a.text}</p>
            <Select label={t('plans.editor.owner')} placeholder={t('plans.editor.chooseOwner')} value={owners[i]} onValueChange={(v) => setOwners({ ...owners, [i]: v })} options={people.map((p) => ({ value: p.userId, label: p.name }))} />
            <Select label={t('plans.revise.risk')} value={risks[i] ?? 'normal'} onValueChange={(v) => setRisks({ ...risks, [i]: v as RiskLevel })} options={(['critical', 'high', 'normal'] as const).map((r) => ({ value: r, label: t(`risk.${r}`) }))} />
          </li>
        ))}
      </ol>
      <SupportError error={add.error} />
      <div>
        <Button onClick={submit} busy={add.isPending} disabled={!ready}>{t('support.plan.submit')}</Button>
      </div>
    </section>
  );
}
