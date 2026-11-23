import { Button, Dialog, useToast } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { PlanError } from './PlanError.js';
import { useApprove, type PlanDetail } from './api.js';
import { useLocalized } from './format.js';

/**
 * Approval confirmation (T088, FR-012/FR-018a): lists what will be created, then creates the ward's
 * plan in ELEVATE (as the ward service account) and the programme tasks with revision 1.
 */
export function ApproveDialog({ plan, open, onOpenChange }: { plan: PlanDetail; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const title = useLocalized();
  const approve = useApprove(plan.id);
  const included = (plan.draftTasks ?? []).filter((x) => x.included);
  const close = (v: boolean) => {
    if (!v) approve.reset();
    onOpenChange(v);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={t('plans.approve.title')}
      description={t('plans.approve.description', { count: included.length })}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>{t('common.cancel')}</Button>
          <Button
            busy={approve.isPending}
            onClick={() =>
              approve.mutate({ v: plan.v }, {
                onSuccess: () => {
                  toast.show({ tone: 'success', title: t('plans.approve.done') });
                  onOpenChange(false);
                },
              })
            }
          >
            {t('plans.approve.confirm')}
          </Button>
        </>
      }
    >
      <ul className="list-disc pl-6 text-base text-text">
        {included.map((x) => <li key={x.taskKey}>{title(x.title)}</li>)}
      </ul>
      <PlanError error={approve.error} />
    </Dialog>
  );
}
