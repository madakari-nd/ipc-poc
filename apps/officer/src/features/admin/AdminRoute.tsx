import { Button, PageHeader, StateBoundary, cn } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useParams } from 'react-router-dom';
import { useStateMessages } from '../../lib/boundary.js';
import { NotFoundRoute } from '../../routes/NotFoundRoute.js';
import { useMe } from '../auth/useMe.js';
import { CyclesPanel } from './CyclesPanel.js';
import { DemoClockPanel } from './DemoClock.js';
import { ImportsPanel } from './ImportsPanel.js';
import { EscalationRulesPanel, RiskDefaultsPanel } from './RulesPanels.js';
import { ScopesPanel } from './ScopesPanel.js';

export const ADMIN_TABS = ['imports', 'users', 'cycles', 'risk-defaults', 'escalation-rules', 'demo-clock'] as const;
type Tab = (typeof ADMIN_TABS)[number];

const PANELS: Record<Tab, () => JSX.Element> = {
  imports: ImportsPanel,
  users: ScopesPanel,
  cycles: CyclesPanel,
  'risk-defaults': RiskDefaultsPanel,
  'escalation-rules': EscalationRulesPanel,
  'demo-clock': DemoClockPanel,
};

/** `/admin/:tab`: programme setup for the state administrator (US1). Other roles get a clear refusal. */
export function AdminRoute() {
  const { t } = useTranslation();
  const { tab = 'imports' } = useParams();
  const me = useMe().data;
  const messages = useStateMessages();
  if (!me || !ADMIN_TABS.includes(tab as Tab)) return <NotFoundRoute />;
  const header = <PageHeader title={t('nav.admin')} description={t('admin.intro')} />;
  if (me.activeRole !== 'STATE_ADMIN') {
    return (
      <>
        {header}
        <StateBoundary status="denied" messages={messages} deniedAction={<Button asChild variant="secondary"><Link to="/">{t('section.backHome')}</Link></Button>} />
      </>
    );
  }
  const Panel = PANELS[tab as Tab];
  return (
    <>
      {header}
      <nav aria-label={t('admin.tabsLabel')} className="mb-6">
        <ul className="flex flex-wrap gap-2">
          {ADMIN_TABS.map((k) => (
            <li key={k}>
              <NavLink
                to={`/admin/${k}`}
                className={({ isActive }) => cn(
                  'flex min-h-touch items-center rounded-md border border-border px-3 font-semibold text-text no-underline',
                  'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-focus',
                  isActive || (k === 'imports' && tab === 'imports') ? 'bg-action-secondary text-action-secondary-fg' : 'hover:bg-surface-muted',
                )}
              >
                {t(`admin.tabs.${k}`)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Panel />
    </>
  );
}
