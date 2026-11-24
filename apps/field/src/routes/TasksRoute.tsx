import { Button, PageHeader, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useSignedIn } from '../features/session/SessionProvider.js';
import { MyTasks } from '../features/tasks/MyTasks.js';
import { TaskDetail } from '../features/tasks/TaskDetail.js';
import { useStateMessages } from '../lib/boundary.js';
import { canSee } from '../lib/nav.js';

function Denied({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={title} />
      <StateBoundary
        status="denied"
        messages={useStateMessages()}
        deniedAction={
          <Button asChild variant="secondary">
            <Link to="/">{t('section.backHome')}</Link>
          </Button>
        }
      />
    </>
  );
}

/** US4: the owner's task list (works offline). */
export function TasksRoute() {
  const { t } = useTranslation();
  const { me } = useSignedIn();
  if (!canSee(me.activeRole, 'tasks')) return <Denied title={t('nav.tasks')} />;
  return (
    <>
      <PageHeader title={t('tasks.title')} description={t('tasks.description')} />
      <MyTasks />
    </>
  );
}

/** US4: one task — start, upload proof, see why it was returned. */
export function TaskRoute() {
  const { t } = useTranslation();
  const { taskId = '' } = useParams();
  const { me } = useSignedIn();
  if (!canSee(me.activeRole, 'tasks')) return <Denied title={t('nav.tasks')} />;
  return (
    <>
      <PageHeader
        title={t('tasks.detailTitle')}
        back={
          <Link to="/tasks" className="inline-flex min-h-touch items-center font-semibold text-action-primary underline">
            {t('tasks.back')}
          </Link>
        }
      />
      <TaskDetail taskId={taskId} />
    </>
  );
}
