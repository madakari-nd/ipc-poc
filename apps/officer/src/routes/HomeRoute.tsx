import { PageHeader } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { useMe } from '../features/auth/useMe.js';
import { HomeCards } from '../features/home/HomeCards.js';

export function HomeRoute() {
  const { t } = useTranslation();
  const me = useMe().data;
  if (!me) return null;
  return (
    <>
      <PageHeader title={t('home.title')} description={t(`home.intro.${me.activeRole}`)} />
      <HomeCards role={me.activeRole} />
    </>
  );
}
