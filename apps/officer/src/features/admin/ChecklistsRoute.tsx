import { useState } from 'react';
import { Button, ConfirmWithReason, DataTable, PageHeader, RiskChip, StateBoundary, useToast } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { useMe } from '../auth/useMe.js';
import { KEYS, useAdminWrite, useChecklist, useChecklists, type ChecklistVersion } from './api.js';
import { Panel, WriteError, useFormatDate } from './common.js';
import { useConfirmLabels } from './ScopesPanel.js';

/**
 * Checklists (FR-005): versions with status and grace period, a new draft from the current
 * version, publication with a confirm step, and any version's questions (old versions stay readable).
 */
export function ChecklistsRoute() {
  const { t } = useTranslation();
  const fmt = useFormatDate();
  const toast = useToast();
  const me = useMe().data!;
  const isAdmin = me.activeRole === 'STATE_ADMIN';
  const q = useChecklists();
  const [openId, setOpenId] = useState<string>();
  const [publishing, setPublishing] = useState<ChecklistVersion>();
  const messages = useStateMessages({ empty: { title: t('checklists.empty'), description: t('checklists.emptyHelp') } });
  const draft = useAdminWrite<ChecklistVersion, ChecklistVersion>(
    (base) => ({ path: '/ipc/v1/admin/checklists', method: 'POST', body: { checklistCode: base.checklistCode, basedOnVersionId: base.id } }),
    [KEYS.checklists],
  );
  const publish = useAdminWrite<{ v: ChecklistVersion; reason?: string }, ChecklistVersion>(
    ({ v, reason }) => ({ path: `/ipc/v1/admin/checklists/${v.id}/publication`, method: 'POST', body: reason ? { reason } : {}, ifMatch: v.v }),
    [KEYS.checklists],
  );
  const items = [...(q.data?.items ?? [])].sort((a, b) => a.checklistCode.localeCompare(b.checklistCode) || b.version - a.version);
  const current = items.find((v) => v.status === 'published' && !v.graceUntil);
  const hasDraft = items.some((v) => v.status === 'draft');
  return (
    <>
      <PageHeader
        title={t('checklists.title')}
        description={t('checklists.intro')}
        actions={isAdmin && current && !hasDraft ? (
          <Button busy={draft.isPending} onClick={() => draft.mutate(current, { onSuccess: (d) => toast.show({ tone: 'success', title: t('checklists.draftCreated', { version: d.version }) }) })}>
            {t('checklists.newDraft', { version: current.version })}
          </Button>
        ) : undefined}
      />
      <WriteError error={draft.error ?? publish.error} />
      <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
        <DataTable
          caption={t('checklists.versions')}
          columns={[
            { key: 'code', header: t('checklists.code'), cell: (v) => v.checklistCode },
            { key: 'version', header: t('checklists.version'), cell: (v) => `v${v.version}` },
            { key: 'status', header: t('checklists.status'), cell: (v) => <span data-testid={`status-v${v.version}`}>{t(`checklists.statuses.${v.status}`)}</span> },
            { key: 'published', header: t('checklists.publishedAt'), cell: (v) => fmt(v.publishedAt) },
            { key: 'grace', header: t('checklists.graceUntil'), cell: (v) => (v.graceUntil ? fmt(v.graceUntil) : '—') },
            { key: 'questions', header: t('checklists.questionCount'), cell: (v) => v.questions.length },
            {
              key: 'act', header: t('admin.actions'),
              cell: (v) => (
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" aria-expanded={openId === v.id} onClick={() => setOpenId(openId === v.id ? undefined : v.id)}>
                    {t(openId === v.id ? 'checklists.hideQuestions' : 'checklists.showQuestions', { version: v.version })}
                  </Button>
                  {isAdmin && v.status === 'draft' && <Button onClick={() => setPublishing(v)}>{t('checklists.publish', { version: v.version })}</Button>}
                  {isAdmin && v.status !== 'draft' && (
                    <Button asChild variant="ghost"><Link to={`/history/checklist_version/${v.id}`}>{t('checklists.history')}</Link></Button>
                  )}
                </div>
              ),
            },
          ]}
          rows={items}
          getRowId={(v) => v.id}
        />
      </StateBoundary>
      {openId && <VersionQuestions id={openId} />}
      <ConfirmWithReason
        open={!!publishing}
        onOpenChange={(o) => !o && setPublishing(undefined)}
        title={t('checklists.publishTitle', { version: publishing?.version })}
        description={t('checklists.publishBody', { previous: current ? `v${current.version}` : t('checklists.noPrevious') })}
        reasons={[]}
        variant="primary"
        labels={{ ...useConfirmLabels(), confirm: t('checklists.publishConfirm') }}
        busy={publish.isPending}
        onConfirm={({ reasonText }) =>
          publish.mutate({ v: publishing!, reason: reasonText }, {
            onSuccess: (v) => {
              setPublishing(undefined);
              toast.show({ tone: 'success', title: t('checklists.published', { version: v.version }) });
            },
            onError: () => setPublishing(undefined),
          })}
      />
    </>
  );
}

function VersionQuestions({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const q = useChecklist(id);
  const messages = useStateMessages();
  const v = q.data;
  const lang = i18n.language as 'en' | 'hi' | 'kn';
  return (
    <Panel title={v ? t('checklists.questionsOf', { version: v.version }) : t('checklists.questions')}>
      <StateBoundary status={boundaryStatus(q)} messages={messages} onRetry={() => void q.refetch()}>
        {v && (
          <>
            {v.status !== 'draft' && <p className="text-sm text-text-muted">{t('checklists.readOnly')}</p>}
            <DataTable
              caption={t('checklists.questionsOf', { version: v.version })}
              hideCaption
              columns={[
                { key: 'key', header: t('checklists.questionKey'), cell: (x) => <code>{x.questionKey}</code> },
                { key: 'text', header: t('checklists.question'), cell: (x) => x.text[lang] ?? x.text.en },
                { key: 'section', header: t('checklists.section'), cell: (x) => { const s = v.sections.find((y) => y.sectionKey === x.sectionKey); return s ? (s.title[lang] ?? s.title.en) : x.sectionKey; } },
                { key: 'risk', header: t('checklists.risk'), cell: (x) => <RiskChip level={x.riskLevel} label={t(`risk.${x.riskLevel}`)} /> },
                { key: 'pass', header: t('checklists.passMark'), cell: (x) => `${x.passMark} / ${x.maxScore}` },
              ]}
              rows={v.questions}
              getRowId={(x) => x.questionKey}
            />
          </>
        )}
      </StateBoundary>
    </Panel>
  );
}
