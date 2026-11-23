import {
  Button,
  ConfirmWithReason,
  DataTable,
  EmptyState,
  Field,
  LEGEND_KINDS,
  LegendChip,
  PageHeader,
  RISK_LEVELS,
  RiskChip,
  Select,
  StateBoundary,
  StatusChip,
  TASK_STATES,
  contrastRatio,
  tokens,
  useToast,
  type BoundaryStatus,
  type Column,
} from '@ipc/design-system';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStateMessages } from '../../lib/boundary.js';

interface Swatch {
  token: string;
  fg: string;
  bg: string;
}

function swatches(group: 'state' | 'risk' | 'legend' | 'action' | 'feedback'): Swatch[] {
  return Object.entries(tokens.color[group] as Record<string, { fg: string; bg: string }>).map(([k, v]) => ({ token: `${group}.${k}`, fg: v.fg, bg: v.bg }));
}

function Section({ id, title, usage, children }: { id: string; title: string; usage?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 border-b border-border-subtle py-8">
      <h2 id={id} className="text-xl font-bold text-text">
        {title}
      </h2>
      {children}
      {usage && (
        <pre className="overflow-x-auto rounded-md bg-surface-muted p-3 font-mono text-sm text-text">
          <code>{usage}</code>
        </pre>
      )}
    </section>
  );
}

export function StyleGuide() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [dialog, setDialog] = useState(false);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<string | undefined>();
  const [boundary, setBoundary] = useState<BoundaryStatus>('empty');
  const messages = useStateMessages();
  const fmt = (n: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(n);

  const colourColumns: Column<Swatch>[] = [
    {
      key: 'sample',
      header: t('style.colours.sample'),
      cell: (s) => (
        <span className="inline-flex min-h-touch items-center rounded-md px-3 font-semibold" style={{ color: s.fg, background: s.bg }}>
          Aa
        </span>
      ),
    },
    { key: 'token', header: t('style.colours.token'), cell: (s) => <code className="font-mono text-sm">{s.token}</code> },
    { key: 'values', header: t('style.colours.values'), cell: (s) => <code className="font-mono text-sm">{`${s.fg} / ${s.bg}`}</code> },
    { key: 'ratio', header: t('style.colours.contrast'), cell: (s) => `${fmt(contrastRatio(s.fg, s.bg))} : 1` },
  ];

  const reasons = [
    { value: 'evidence_unclear', label: t('style.demo.reasonUnclear') },
    { value: 'evidence_missing', label: t('style.demo.reasonMissing') },
  ];

  return (
    <div className="flex flex-col">
      <PageHeader title={t('style.title')} description={t('style.description')} />

      <Section id="colours" title={t('style.colours.title')}>
        <p className="text-base text-text-muted">{t('style.colours.note')}</p>
        <DataTable caption={t('style.colours.caption')} columns={colourColumns} rows={[...swatches('state'), ...swatches('risk'), ...swatches('legend'), ...swatches('action'), ...swatches('feedback')]} getRowId={(s) => s.token} />
      </Section>

      <Section id="chips" title={t('style.chips.title')} usage={`<StatusChip state="PENDING_VALIDATION" label={t('taskState.PENDING_VALIDATION')} />\n<RiskChip level="critical" label={t('risk.critical')} />`}>
        <p className="text-base text-text-muted">{t('style.chips.note')}</p>
        <div className="flex flex-wrap gap-2">
          {TASK_STATES.map((s) => (
            <StatusChip key={s} state={s} label={t(`taskState.${s}`)} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {RISK_LEVELS.map((r) => (
            <RiskChip key={r} level={r} label={t(`risk.${r}`)} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {LEGEND_KINDS.map((l) => (
            <LegendChip key={l} kind={l} label={t(`legend.${l}`)} />
          ))}
        </div>
      </Section>

      <Section id="buttons" title={t('style.buttons.title')} usage={`<Button variant="primary">…</Button>\n<Button asChild><Link to="/">…</Link></Button>`}>
        <div className="flex flex-wrap gap-2">
          <Button>{t('style.buttons.primary')}</Button>
          <Button variant="secondary">{t('style.buttons.secondary')}</Button>
          <Button variant="danger">{t('style.buttons.danger')}</Button>
          <Button variant="ghost">{t('style.buttons.ghost')}</Button>
          <Button busy>{t('style.buttons.busy')}</Button>
        </div>
      </Section>

      <Section id="forms" title={t('style.forms.title')} usage={`<Field label="…" hint="…" maxLength={500} showCount multiline />\n<Select label="…" options={[…]} onValueChange={…} />`}>
        <div className="grid max-w-[560px] gap-4">
          <Field label={t('style.forms.note')} hint={t('style.forms.noteHint')} multiline maxLength={500} showCount value={note} onChange={(e) => setNote(e.target.value)} />
          <Field label={t('style.forms.withError')} error={t('style.forms.errorText')} defaultValue="" />
          <Select label={t('style.forms.reason')} placeholder={t('style.forms.choose')} options={reasons} value={reason} onValueChange={setReason} />
        </div>
      </Section>

      <Section id="dialog" title={t('style.dialog.title')} usage={`<ConfirmWithReason reasons={…} labels={…} onConfirm={({ reasonCode, reasonText }) => …} />`}>
        <p className="text-base text-text-muted">{t('style.dialog.note')}</p>
        <div>
          <Button variant="danger" onClick={() => setDialog(true)}>
            {t('style.demo.returnTask')}
          </Button>
        </div>
        <ConfirmWithReason
          open={dialog}
          onOpenChange={setDialog}
          title={t('style.demo.returnTask')}
          description={t('style.demo.returnDescription')}
          reasons={reasons}
          labels={{
            confirm: t('style.demo.returnTask'),
            cancel: t('common.cancel'),
            close: t('common.close'),
            reason: t('style.forms.reason'),
            reasonPlaceholder: t('style.forms.choose'),
            reasonRequired: t('style.demo.reasonRequired'),
            note: t('style.forms.note'),
            noteHint: t('style.forms.noteHint'),
          }}
          onConfirm={() => {
            setDialog(false);
            toast.show({ tone: 'success', title: t('style.demo.done') });
          }}
        />
      </Section>

      <Section id="toast" title={t('style.toast.title')} usage={`const toast = useToast();\ntoast.show({ tone: 'success', title: '…' });`}>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => toast.show({ tone: 'success', title: t('style.demo.done') })}>
            {t('style.toast.success')}
          </Button>
          <Button variant="secondary" onClick={() => toast.show({ tone: 'error', title: t('state.error.title'), description: t('state.error.description') })}>
            {t('style.toast.error')}
          </Button>
        </div>
      </Section>

      <Section id="boundary" title={t('style.boundary.title')} usage={`<StateBoundary status={boundaryStatus(query, rows.length === 0)} messages={useStateMessages()} onRetry={…}>…</StateBoundary>`}>
        <p className="text-base text-text-muted">{t('style.boundary.note')}</p>
        <div className="max-w-[280px]">
          <Select
            label={t('style.boundary.pick')}
            value={boundary}
            onValueChange={(v) => setBoundary(v as BoundaryStatus)}
            options={(['loading', 'empty', 'error', 'offline', 'denied', 'ready'] as const).map((s) => ({ value: s, label: t(`style.boundary.states.${s}`) }))}
          />
        </div>
        <StateBoundary status={boundary} messages={messages} onRetry={() => toast.show({ tone: 'info', title: t('state.retry') })} deniedAction={<Button variant="secondary">{t('section.backHome')}</Button>}>
          <p className="rounded-md border border-border-subtle p-4">{t('style.boundary.content')}</p>
        </StateBoundary>
      </Section>

      <Section id="empty" title={t('style.empty.title')} usage={`<EmptyState title="…" description="…" action={<Button>…</Button>} />`}>
        <EmptyState title={t('home.nothing.title')} description={t('home.nothing.description')} action={<Button variant="secondary">{t('section.backHome')}</Button>} />
      </Section>

      <Section id="scale" title={t('style.scale.title')}>
        <ul className="flex flex-col gap-2">
          {Object.entries(tokens.space).map(([k, v]) => (
            <li key={k} className="flex items-center gap-3">
              <code className="w-[64px] font-mono text-sm">{`space-${k}`}</code>
              <span className="inline-block h-4 bg-action-primary" style={{ width: v }} />
              <span className="text-sm text-text-muted">{v}</span>
            </li>
          ))}
        </ul>
        <ul className="flex flex-col gap-1">
          {Object.entries(tokens.font.size).map(([k, [size, lh]]) => (
            <li key={k} style={{ fontSize: size, lineHeight: lh }}>
              {`text-${k} · ${size}/${lh}`}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
