import { forwardRef, useId, type InputHTMLAttributes, type Ref, type TextareaHTMLAttributes } from 'react';
import { cn } from '../cn.js';

interface BaseProps {
  label: string;
  hint?: string;
  error?: string;
  /** Shows "used / max" for free text (FR-032 limits free text to 500 characters). */
  showCount?: boolean;
}

export type FieldProps =
  | (BaseProps & { multiline?: false } & InputHTMLAttributes<HTMLInputElement>)
  | (BaseProps & { multiline: true } & TextareaHTMLAttributes<HTMLTextAreaElement>);

export const controlClass = cn(
  'block w-full min-h-touch rounded-md border border-border bg-surface px-3 py-2 text-base text-text',
  'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-focus',
  'aria-[invalid=true]:border-feedback-error-fg',
);

/** Labelled text input or textarea with hint, error and optional character count. */
export const Field = forwardRef<HTMLInputElement | HTMLTextAreaElement, FieldProps>(function Field(props, ref) {
  const { label, hint, error, showCount, id: givenId, className, multiline, ...rest } = props;
  const autoId = useId();
  const id = givenId ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const value = (rest as { value?: unknown }).value;
  const max = (rest as { maxLength?: number }).maxLength;
  const common = {
    id,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : undefined,
    className: cn(controlClass, className),
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold text-text">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="text-sm text-text-muted">
          {hint}
        </p>
      )}
      {multiline ? (
        <textarea
          ref={ref as Ref<HTMLTextAreaElement>}
          rows={4}
          {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)}
          {...common}
        />
      ) : (
        <input ref={ref as Ref<HTMLInputElement>} {...(rest as InputHTMLAttributes<HTMLInputElement>)} {...common} />
      )}
      {showCount && max !== undefined && (
        <p className="text-xs text-text-muted" aria-live="polite">
          {typeof value === 'string' ? value.length : 0} / {max}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm font-semibold text-feedback-error-fg">
          {error}
        </p>
      )}
    </div>
  );
});
