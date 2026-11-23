import * as RadixSelect from '@radix-ui/react-select';
import { useId } from 'react';
import { cn } from '../cn.js';
import { controlClass } from './Field.js';
import { IconCheck } from './icons.js';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label: string;
  options: SelectOption[];
  value?: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string;
  disabled?: boolean;
  id?: string;
  /** Hide the visible label (it stays available to assistive tech). */
  hideLabel?: boolean;
}

/** Accessible select built on Radix Select (keyboard, typeahead, screen-reader support). */
export function Select({
  label,
  options,
  value,
  onValueChange,
  placeholder,
  hint,
  error,
  disabled,
  id: givenId,
  hideLabel,
}: SelectProps) {
  const autoId = useId();
  const id = givenId ?? autoId;
  const labelId = `${id}-label`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className={cn('text-sm font-semibold text-text', hideLabel && 'sr-only')}>
        {label}
      </span>
      {hint && (
        <p id={hintId} className="text-sm text-text-muted">
          {hint}
        </p>
      )}
      <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
        <RadixSelect.Trigger
          id={id}
          aria-labelledby={labelId}
          aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
          aria-invalid={error ? true : undefined}
          className={cn(controlClass, 'flex items-center justify-between gap-2 text-left')}
        >
          <RadixSelect.Value placeholder={placeholder} />
          <RadixSelect.Icon aria-hidden="true">▾</RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            position="popper"
            sideOffset={4}
            className="z-50 max-h-[60vh] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-surface shadow-2"
          >
            <RadixSelect.Viewport className="p-1">
              {options.map((o) => (
                <RadixSelect.Item
                  key={o.value}
                  value={o.value}
                  className="flex min-h-touch cursor-pointer select-none items-center gap-2 rounded-sm px-3 text-base text-text outline-none data-[highlighted]:bg-action-secondary data-[highlighted]:text-action-secondary-fg"
                >
                  <RadixSelect.ItemIndicator>
                    <IconCheck />
                  </RadixSelect.ItemIndicator>
                  <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
      {error && (
        <p id={errorId} className="text-sm font-semibold text-feedback-error-fg">
          {error}
        </p>
      )}
    </div>
  );
}
