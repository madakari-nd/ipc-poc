import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '../cn.js';
import { Button } from './Button.js';
import { IconAlert, IconCheck, IconX } from './icons.js';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface ToastMessage {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastApi {
  show: (t: Omit<ToastMessage, 'id'>) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const toneClass: Record<ToastTone, string> = {
  info: 'bg-feedback-info text-feedback-info-fg',
  success: 'bg-feedback-success text-feedback-success-fg',
  warning: 'bg-feedback-warning text-feedback-warning-fg',
  error: 'bg-feedback-error text-feedback-error-fg',
};

/**
 * Toast region: a persistent polite live region (errors use an assertive alert) so screen readers
 * announce messages. Toasts stay 6 s; errors stay until dismissed.
 */
export function ToastProvider({ children, dismissLabel }: { children: ReactNode; dismissLabel: string }) {
  const [items, setItems] = useState<ToastMessage[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback((t: Omit<ToastMessage, 'id'>) => {
    counter.current += 1;
    const id = `toast-${counter.current}`;
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4" aria-live="polite">
        {items.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} dismissLabel={dismissLabel} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss, dismissLabel }: { toast: ToastMessage; onDismiss: (id: string) => void; dismissLabel: string }) {
  useEffect(() => {
    if (toast.tone === 'error') return;
    const timer = setTimeout(() => onDismiss(toast.id), 6000);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);
  const Icon = toast.tone === 'success' ? IconCheck : IconAlert;
  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      className={cn('pointer-events-auto flex w-full max-w-[480px] items-start gap-3 rounded-md p-4 shadow-2', toneClass[toast.tone])}
    >
      <Icon />
      <div className="flex-1">
        <p className="font-semibold">{toast.title}</p>
        {toast.description && <p className="text-sm">{toast.description}</p>}
      </div>
      <Button variant="ghost" aria-label={dismissLabel} onClick={() => onDismiss(toast.id)} className="bg-transparent text-current">
        <IconX />
      </Button>
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
