import { useState } from 'react';
import { Button, Field, Select, useToast } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { useFacilities, type Facility } from '../plans/api.js';
import { LANGUAGES, SKILLS, useCreateRequest, type Language, type Skill, type SupportRequest } from './api.js';
import { SupportError } from './SupportError.js';

type FacilityWithWards = Facility & { wards?: { id: string; wardCode: string; name?: string; active?: boolean }[] };

/** NewRequest (FR-022): ward, problem, IPC skill and preferred language → a ranked shortlist. */
export function NewRequest({ onCreated }: { onCreated: (r: SupportRequest) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const facilities = (useFacilities().data?.items ?? []) as FacilityWithWards[];
  const create = useCreateRequest();
  const [wardId, setWardId] = useState<string>();
  const [problem, setProblem] = useState('');
  const [skill, setSkill] = useState<Skill>();
  const [language, setLanguage] = useState<Language>();
  const wards = facilities.flatMap((f) => (f.wards ?? []).filter((w) => w.active !== false).map((w) => ({ value: w.id, label: `${f.name} · ${w.name ?? w.wardCode}` })));
  const ready = wardId && problem.trim() && skill && language;

  const submit = () => {
    create.mutate({ wardId: wardId!, problem: problem.trim(), skill: skill!, language: language! }, {
      onSuccess: (r) => {
        toast.show({ tone: 'success', title: t('support.new.done') });
        setProblem('');
        onCreated(r);
      },
    });
  };

  return (
    <section aria-labelledby="support-new" className="flex flex-col gap-4 rounded-lg border border-border-subtle p-4 shadow-1">
      <h2 id="support-new" className="text-xl font-semibold text-text">{t('support.new.title')}</h2>
      <Select label={t('support.new.ward')} placeholder={t('support.new.chooseWard')} value={wardId} onValueChange={setWardId} options={wards} />
      <Field label={t('support.new.problem')} hint={t('support.new.problemHint')} multiline maxLength={500} showCount value={problem} onChange={(e) => setProblem(e.currentTarget.value)} />
      <Select label={t('support.new.skill')} placeholder={t('support.new.chooseSkill')} value={skill} onValueChange={(v) => setSkill(v as Skill)} options={SKILLS.map((s) => ({ value: s, label: t(`support.skills.${s}`) }))} />
      <Select label={t('support.new.language')} placeholder={t('support.new.chooseLanguage')} value={language} onValueChange={(v) => setLanguage(v as Language)} options={LANGUAGES.map((l) => ({ value: l, label: t(`support.languages.${l}`) }))} />
      <SupportError error={create.error} />
      <div>
        <Button onClick={submit} busy={create.isPending} disabled={!ready}>{t('support.new.submit')}</Button>
      </div>
    </section>
  );
}
