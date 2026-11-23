import { useEffect, useState } from 'react';
import { Button, type ButtonVariant } from './Button.js';
import { Dialog } from './Dialog.js';
import { Field } from './Field.js';
import { Select, type SelectOption } from './Select.js';

export interface ConfirmWithReasonLabels {
  confirm: string;
  cancel: string;
  close: string;
  reason: string;
  reasonPlaceholder: string;
  reasonRequired: string;
  note: string;
  noteHint: string;
}

export interface ConfirmWithReasonProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Reason list (FR-014). When empty, no reason is asked for. */
  reasons: SelectOption[];
  labels: ConfirmWithReasonLabels;
  onConfirm: (result: { reasonCode?: string; reasonText?: string }) => void | Promise<void>;
  variant?: ButtonVariant;
  busy?: boolean;
  /** Free text limit (FR-032). */
  maxNoteLength?: number;
}

/** Confirm step for destructive/irreversible actions with a coded reason and optional note. */
export function ConfirmWithReason({
  open,
  onOpenChange,
  title,
  description,
  reasons,
  labels,
  onConfirm,
  variant = 'danger',
  busy,
  maxNoteLength = 500,
}: ConfirmWithReasonProps) {
  const [reasonCode, setReasonCode] = useState<string | undefined>();
  const [reasonText, setReasonText] = useState('');
  const [showError, setShowError] = useState(false);

  useEffect(() => {
    if (!open) {
      setReasonCode(undefined);
      setReasonText('');
      setShowError(false);
    }
  }, [open]);

  const needsReason = reasons.length > 0;

  const submit = () => {
    if (needsReason && !reasonCode) {
      setShowError(true);
      return;
    }
    void onConfirm({ reasonCode, reasonText: reasonText.trim() || undefined });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      closeLabel={labels.close}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {labels.cancel}
          </Button>
          <Button variant={variant} onClick={submit} busy={busy}>
            {labels.confirm}
          </Button>
        </>
      }
    >
      {needsReason && (
        <Select
          label={labels.reason}
          placeholder={labels.reasonPlaceholder}
          options={reasons}
          value={reasonCode}
          onValueChange={(v) => {
            setReasonCode(v);
            setShowError(false);
          }}
          error={showError ? labels.reasonRequired : undefined}
        />
      )}
      <Field
        multiline
        label={labels.note}
        hint={labels.noteHint}
        maxLength={maxNoteLength}
        showCount
        value={reasonText}
        onChange={(e) => setReasonText(e.target.value)}
      />
    </Dialog>
  );
}
