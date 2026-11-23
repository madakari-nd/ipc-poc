import { PageHeader } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { HomeCards } from '../features/home/HomeCards.js';

export function HomeRoute() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('home.title')} />
      <HomeCards />
    </>
  );
}
