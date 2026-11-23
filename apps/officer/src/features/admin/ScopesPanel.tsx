import { useState } from 'react';
import { Button, ConfirmWithReason, DataTable, Field, Select, StateBoundary, useToast } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { KEYS, useAdminWrite, useFacilities, useScopeAssignments, type Role, type ScopeAssignment } from './api.js';
import { Check, Panel, WriteError, toIso, useFormatDate } from './common.js';

const ROLES: Role[] = ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR', 'FRONTLINE', 'MENTOR', 'EXTERNAL_AUDITOR'];
/** Scope level each role takes (data-model §1); FRONTLINE uses wards here, own tasks when no ward is picked. */
const LEVEL: Record<Role, 'state' | 'district' | 'facility' | 'wards' | 'own_tasks'> = {
  STATE_ADMIN: 'state', DISTRICT_QM: 'district', IPC_OFFICER: 'facility', WARD_SUPERVISOR: 'wards', FRONTLINE: 'wards', MENTOR: 'own_tasks', EXTERNAL_AUDITOR: 'facility',
};

/** Users and scopes: who holds which role where, with validity; end or add an assignment. */
export function ScopesPanel() {
  const { t } = useTranslation();
  const fmt = useFormatDate();
  const toast = useToast();
  const [role, setRole] = useState<string>('all');
  const q = useScopeAssignments(role === 'all' ? undefined : role);
  const facilities = useFacilities();
  const messages = useStateMessages({ empty: { title: t('admin.scopes.empty'), description: t('admin.scopes.emptyHelp') } });
  const [ending, setEnding] = useState<ScopeAssignment>();
  const end = useAdminWrite<{ a: ScopeAssignment; reason: string }, ScopeAssignment>(
    ({ a, reason }) => ({ path: `/ipc/v1/admin/scope-assignments/${a.id}`, method: 'PATCH', body: { validTo: new Date().toISOString(), reason }, ifMatch: a.v }),
    [KEYS.scopes],
  );
  const facilityName = (id?: string) => facilities.data?.items.find((f) => f.id === id)?.name ?? id ?? '';
  const describe = (a: ScopeAssignment) => {
    const s = a.scope;
    switch (s.level) {
      case 'state': return t('admin.scopes.levels.state');
      case 'district': return `${t('admin.scopes.levels.district')} ${s.districtCode ?? ''}`;
      case 'facility': return (s.facilityIds ?? [s.facilityId]).map(facilityName).join(', ');
      case 'wards': return `${facilityName(s.facilityId)} · ${t('admin.scopes.wardCount', { count: s.wardIds?.length ?? 0 })}`;
      default: return t('admin.scopes.levels.own_tasks');
    }
  };
  const items = q.data?.items ?? [];
  return (
    <>
      <Panel
        title={t('admin.scopes.title')}
        actions={
          <div className="w-64">
            <Select label={t('admin.scopes.filterRole')} value={role} onValueChange={setRole}
              options={[{ value: 'all', label: t('admin.scopes.allRoles') }, ...ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) }))]} />
          </div>
        }
      >
        <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
          <DataTable
            caption={t('admin.scopes.title')}
            hideCaption
            columns={[
              { key: 'user', header: t('admin.scopes.user'), cell: (a) => a.userId },
              { key: 'role', header: t('admin.scopes.role'), cell: (a) => t(`roles.${a.role}`) },
              { key: 'scope', header: t('admin.scopes.scope'), cell: describe },
              { key: 'from', header: t('admin.scopes.validFrom'), cell: (a) => fmt(a.validFrom) },
              { key: 'to', header: t('admin.scopes.validTo'), cell: (a) => (a.validTo ? fmt(a.validTo) : t('admin.scopes.open')) },
              { key: 'source', header: t('admin.scopes.source'), cell: (a) => t(`admin.scopes.sources.${a.source}`) },
              {
                key: 'act', header: t('admin.actions'),
                cell: (a) => (!a.validTo || Date.parse(a.validTo) > Date.now()
                  ? <Button variant="secondary" onClick={() => setEnding(a)}>{t('admin.scopes.end')}</Button>
                  : null),
              },
            ]}
            rows={items}
            getRowId={(a) => a.id}
          />
        </StateBoundary>
        <WriteError error={end.error} />
      </Panel>
      <NewAssignment facilities={facilities.data?.items ?? []} />
      <ConfirmWithReason
        open={!!ending}
        onOpenChange={(o) => !o && setEnding(undefined)}
        title={t('admin.scopes.endTitle')}
        description={ending ? t('admin.scopes.endBody', { user: ending.userId, role: t(`roles.${ending.role}`) }) : undefined}
        reasons={[{ value: 'left', label: t('admin.scopes.reasons.left') }, { value: 'moved', label: t('admin.scopes.reasons.moved') }, { value: 'error', label: t('admin.scopes.reasons.error') }]}
        labels={useConfirmLabels()}
        busy={end.isPending}
        onConfirm={({ reasonCode, reasonText }) =>
          end.mutate({ a: ending!, reason: [t(`admin.scopes.reasons.${reasonCode}`), reasonText].filter(Boolean).join(': ') }, {
            onSuccess: () => {
              setEnding(undefined);
              toast.show({ tone: 'success', title: t('admin.scopes.ended') });
            },
          })}
      />
    </>
  );
}

export function useConfirmLabels() {
  const { t } = useTranslation();
  return {
    confirm: t('admin.confirm.confirm'), cancel: t('common.cancel'), close: t('common.close'), reason: t('admin.confirm.reason'),
    reasonPlaceholder: t('admin.confirm.reasonPlaceholder'), reasonRequired: t('admin.confirm.reasonRequired'), note: t('admin.confirm.note'), noteHint: t('admin.confirm.noteHint'),
  };
}

function NewAssignment({ facilities }: { facilities: { id: string; name: string; wards?: { id: string; name: string; wardCode: string }[] }[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<Role>('WARD_SUPERVISOR');
  const [district, setDistrict] = useState('');
  const [facilityId, setFacilityId] = useState<string>();
  const [wardIds, setWardIds] = useState<string[]>([]);
  const [validFrom, setValidFrom] = useState('');
  const create = useAdminWrite<void, ScopeAssignment>(() => {
    const level = LEVEL[role] === 'wards' && role === 'FRONTLINE' && wardIds.length === 0 ? 'own_tasks' : LEVEL[role];
    const scope =
      level === 'state' ? { level } :
      level === 'district' ? { level, districtCode: district } :
      level === 'facility' ? (role === 'EXTERNAL_AUDITOR' ? { level, facilityIds: facilityId ? [facilityId] : [] } : { level, facilityId }) :
      level === 'wards' ? { level, facilityId, wardIds } : { level };
    return { path: '/ipc/v1/admin/scope-assignments', method: 'POST', body: { userId: userId.trim(), role, scope, validFrom: toIso(validFrom) ?? new Date().toISOString() } };
  }, [KEYS.scopes]);
  const level = LEVEL[role];
  const wards = facilities.find((f) => f.id === facilityId)?.wards ?? [];
  return (
    <Panel title={t('admin.scopes.newTitle')}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('admin.scopes.user')} hint={t('admin.scopes.userHint')} value={userId} maxLength={64} onChange={(e) => setUserId(e.target.value)} />
        <Select label={t('admin.scopes.role')} value={role} onValueChange={(v) => setRole(v as Role)} options={ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) }))} />
        {level === 'district' && <Field label={t('admin.scopes.district')} value={district} maxLength={32} onChange={(e) => setDistrict(e.target.value)} />}
        {(level === 'facility' || level === 'wards') && (
          <Select label={t('admin.scopes.facility')} value={facilityId} placeholder={t('admin.scopes.pickFacility')} onValueChange={(v) => { setFacilityId(v); setWardIds([]); }}
            options={facilities.map((f) => ({ value: f.id, label: f.name }))} />
        )}
        <Field label={t('admin.scopes.validFrom')} type="datetime-local" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
      </div>
      {level === 'wards' && wards.length > 0 && (
        <fieldset className="flex flex-wrap gap-4">
          <legend className="text-sm font-semibold">{t('admin.scopes.wards')}</legend>
          {wards.map((w) => (
            <Check key={w.id} id={`ward-${w.id}`} label={`${w.name} (${w.wardCode})`} checked={wardIds.includes(w.id)}
              onChange={(on) => setWardIds((ids) => (on ? [...ids, w.id] : ids.filter((x) => x !== w.id)))} />
          ))}
        </fieldset>
      )}
      <div>
        <Button busy={create.isPending} disabled={!userId.trim()} onClick={() => create.mutate(undefined, { onSuccess: () => { toast.show({ tone: 'success', title: t('admin.scopes.created') }); setUserId(''); } })}>
          {t('admin.scopes.add')}
        </Button>
      </div>
      <WriteError error={create.error} />
    </Panel>
  );
}
