import { Select } from './Select.js';

export interface LanguageOption {
  code: string;
  /** Name in its own script, e.g. "हिन्दी". */
  label: string;
}

export interface LanguageSwitchProps {
  label: string;
  languages: LanguageOption[];
  value: string;
  onChange: (code: string) => void;
}

/** Language picker (FR-035) on the Radix-based Select; labels are shown in each language's own script. */
export function LanguageSwitch({ label, languages, value, onChange }: LanguageSwitchProps) {
  return (
    <div className="w-[180px]">
      <Select
        label={label}
        hideLabel
        options={languages.map((l) => ({ value: l.code, label: l.label }))}
        value={value}
        onValueChange={onChange}
      />
    </div>
  );
}
