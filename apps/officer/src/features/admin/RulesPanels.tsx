import { useEffect, useState } from 'react';
import { Button, DataTable, Field, RiskChip, Select, StateBoundary, useToast } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { KEYS, useAdminWrite, useEscalationRules, useRiskDefaults, type EscalationRule, type RiskDefault, type RiskLevel, type Role } from './api.js';
import { Check, Panel, WriteError } from './common.js';

const LEVELS: RiskLevel[] = ['critical', 'high', 'normal'];

/** Risk defaults per level (FR-006): they apply to findings from the next assessment. */
export function RiskDefaultsPanel() {
  const { t } = useTranslation();
  const q = useRiskDefaults();
  const messages = useStateMessages();
  return (
    <Panel title={t('admin.risk.title')}>
      <p className="text-base text-text-muted">{t('admin.risk.help')}</p>
      <StateBoundary status={boundaryStatus(q)} messages={messages} onRetry={() => void q.refetch()}>
        <div className="grid gap-4 lg:grid-cols-3">
          {LEVELS.map((level) => <RiskLevelForm key={level} level={level} current={q.data?.items.find((r) => r.riskLevel === level)} />)}
        </div>
      </StateBoundary>
    </Panel>
  );
}

function RiskLevelForm({ level, current }: { level: RiskLevel; current?: RiskDefault }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [dueDays, setDueDays] = useState(String(current?.dueDays ?? ''));
  const [photo, setPhoto] = useState(current?.evidenceRule.photoRequired ?? false);
  const [minPhotos, setMinPhotos] = useState(String(current?.evidenceRule.minPhotos ?? 0));
  const [second, setSecond] = useState(current?.secondValidation ?? false);
  useEffect(() => {
    setDueDays(String(current?.dueDays ?? ''));
    setPhoto(current?.evidenceRule.photoRequired ?? false);
    setMinPhotos(String(current?.evidenceRule.minPhotos ?? 0));
    setSecond(current?.secondValidation ?? false);
  }, [current]);
  const save = useAdminWrite<void, RiskDefault>(() => ({
    path: `/ipc/v1/admin/risk-defaults/${level}`,
    method: 'PUT',
    body: { dueDays: Number(dueDays), evidenceRule: { photoRequired: photo, minPhotos: photo ? Math.max(1, Number(minPhotos)) : Number(minPhotos) }, secondValidation: second },
    ifMatch: current?.v ?? 0,
  }), [KEYS.risk]);
  return (
    <form
      className="flex flex-col gap-3 rounded-md border border-border-subtle p-3"
      aria-label={t(`risk.${level}`)}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: () => toast.show({ tone: 'success', title: t('admin.risk.saved', { level: t(`risk.${level}`) }) }) });
      }}
    >
      <RiskChip level={level} label={t(`risk.${level}`)} />
      <Field label={t('admin.risk.dueDays')} type="number" min={1} max={365} required value={dueDays} onChange={(e) => setDueDays(e.target.value)} />
      <Check id={`photo-${level}`} label={t('admin.risk.photoRequired')} checked={photo} onChange={setPhoto} />
      <Field label={t('admin.risk.minPhotos')} type="number" min={0} max={10} value={minPhotos} onChange={(e) => setMinPhotos(e.target.value)} />
      <Check id={`second-${level}`} label={t('admin.risk.secondValidation')} checked={second} onChange={setSecond} />
      <Button type="submit" busy={save.isPending}>{t('admin.save')}</Button>
      <WriteError error={save.error} />
    </form>
  );
}

const TARGET_ROLES: Role[] = ['IPC_OFFICER', 'DISTRICT_QM', 'STATE_ADMIN', 'WARD_SUPERVISOR'];

/** Escalation rules (FR-020): seeded R1–R3; switch on/off or add a rule. */
export function EscalationRulesPanel() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useEscalationRules();
  const messages = useStateMessages({ empty: { title: t('admin.rules.empty'), description: t('admin.rules.emptyHelp') } });
  const toggle = useAdminWrite<EscalationRule, EscalationRule>(
    (r) => ({ path: `/ipc/v1/admin/escalation-rules/${r.code}`, method: 'PATCH', body: { active: !r.active }, ifMatch: r.v }),
    [KEYS.rules],
  );
  const [form, setForm] = useState({ code: '', type: 'overdue', hours: '48', count: '2', mode: 'role', role: 'IPC_OFFICER' as Role, critical: true, high: false, normal: false, email: true });
  const create = useAdminWrite<void, EscalationRule>(() => ({
    path: '/ipc/v1/admin/escalation-rules',
    method: 'POST',
    body: {
      code: form.code.trim().toUpperCase(),
      condition: {
        type: form.type,
        riskLevels: LEVELS.filter((l) => form[l]),
        ...(form.type === 'overdue' ? { thresholdHours: Number(form.hours) } : { thresholdCount: Number(form.count) }),
      },
      target: form.mode === 'role' ? { mode: 'role', role: form.role } : { mode: 'level_above_decider' },
      channels: form.email ? ['inapp', 'email'] : ['inapp'],
    },
  }), [KEYS.rules]);
  const describe = (r: EscalationRule) => {
    const levels = r.condition.riskLevels.map((l) => t(`risk.${l}`)).join(', ');
    const when = r.condition.type === 'overdue'
      ? t('admin.rules.overdueText', { hours: r.condition.thresholdHours, levels: levels || t('admin.rules.anyLevel') })
      : t('admin.rules.rejectionsText', { count: r.condition.thresholdCount });
    const to = r.target.mode === 'role' ? t(`roles.${r.target.role}`) : t('admin.rules.levelAbove');
    return `${when} → ${to}`;
  };
  const items = q.data?.items ?? [];
  return (
    <>
      <Panel title={t('admin.rules.title')}>
        <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
          <DataTable
            caption={t('admin.rules.title')}
            hideCaption
            columns={[
              { key: 'code', header: t('admin.rules.code'), cell: (r) => r.code },
              { key: 'rule', header: t('admin.rules.rule'), cell: describe },
              { key: 'channels', header: t('admin.rules.channels'), cell: (r) => r.channels.map((c) => t(`admin.rules.channelNames.${c}`)).join(', ') },
              { key: 'active', header: t('admin.rules.state'), cell: (r) => t(r.active ? 'admin.rules.on' : 'admin.rules.off') },
              {
                key: 'act', header: t('admin.actions'),
                cell: (r) => <Button variant="secondary" busy={toggle.isPending} onClick={() => toggle.mutate(r)}>{t(r.active ? 'admin.rules.turnOff' : 'admin.rules.turnOn')}</Button>,
              },
            ]}
            rows={items}
            getRowId={(r) => r.code}
          />
        </StateBoundary>
        <WriteError error={toggle.error} />
      </Panel>
      <Panel title={t('admin.rules.newTitle')}>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label={t('admin.rules.code')} hint={t('admin.rules.codeHint')} value={form.code} maxLength={4} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          <Select label={t('admin.rules.when')} value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}
            options={[{ value: 'overdue', label: t('admin.rules.types.overdue') }, { value: 'rejections', label: t('admin.rules.types.rejections') }]} />
          {form.type === 'overdue'
            ? <Field label={t('admin.rules.hours')} type="number" min={1} value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} />
            : <Field label={t('admin.rules.count')} type="number" min={1} value={form.count} onChange={(e) => setForm({ ...form, count: e.target.value })} />}
          <Select label={t('admin.rules.target')} value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v })}
            options={[{ value: 'role', label: t('admin.rules.targetRole') }, { value: 'level_above_decider', label: t('admin.rules.levelAbove') }]} />
          {form.mode === 'role' && (
            <Select label={t('admin.scopes.role')} value={form.role} onValueChange={(v) => setForm({ ...form, role: v as Role })}
              options={TARGET_ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) }))} />
          )}
        </div>
        <fieldset className="flex flex-wrap gap-4">
          <legend className="text-sm font-semibold">{t('admin.rules.levels')}</legend>
          {LEVELS.map((l) => <Check key={l} id={`rule-${l}`} label={t(`risk.${l}`)} checked={form[l]} onChange={(v) => setForm({ ...form, [l]: v })} />)}
          <Check id="rule-email" label={t('admin.rules.alsoEmail')} checked={form.email} onChange={(v) => setForm({ ...form, email: v })} />
        </fieldset>
        <div>
          <Button busy={create.isPending} onClick={() => create.mutate(undefined, { onSuccess: () => toast.show({ tone: 'success', title: t('admin.rules.created') }) })}>
            {t('admin.rules.create')}
          </Button>
        </div>
        <WriteError error={create.error} />
      </Panel>
    </>
  );
}
