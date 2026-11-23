import { Button, PageHeader, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useStateMessages } from '../lib/boundary.js';

export function NotFoundRoute() {
  const { t } = useTranslation();
  const messages = useStateMessages({ empty: { title: t('notFound.title'), description: t('notFound.description') } });
  return (
    <>
      <PageHeader title={t('notFound.title')} />
      <StateBoundary
        status="empty"
        messages={messages}
        emptyAction={
          <Button asChild>
            <Link to="/">{t('section.backHome')}</Link>
          </Button>
        }
      />
    </>
  );
}
