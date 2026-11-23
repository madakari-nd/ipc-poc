import { Button, PageHeader } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { QueueList } from '../features/queue/QueueList.js';
import { useSession } from '../features/session/SessionProvider.js';

export function QueueRoute() {
  const { t } = useTranslation();
  const { requestSync } = useSession();
  return (
    <>
      <PageHeader title={t('queue.title')} description={t('queue.description')} actions={<Button onClick={requestSync}>{t('queue.sendNow')}</Button>} />
      <QueueList />
    </>
  );
}
