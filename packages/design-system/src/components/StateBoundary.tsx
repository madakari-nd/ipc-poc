import type { ReactNode } from 'react';
import { cn } from '../cn.js';
import { Button } from './Button.js';
import { EmptyState } from './EmptyState.js';
import { IconAlert, IconLock, IconWifiOff } from './icons.js';

export type BoundaryStatus = 'loading' | 'empty' | 'error' | 'offline' | 'denied' | 'ready';

export interface StateMessage {
  title: string;
  description?: string;
}

export interface StateBoundaryMessages {
  loading: string;
  empty: StateMessage;
  error: StateMessage;
  offline: StateMessage;
  denied: StateMessage;
  retry: string;
}

export interface StateBoundaryProps {
  status: BoundaryStatus;
  messages: StateBoundaryMessages;
  children?: ReactNode;
  onRetry?: () => void;
  /** Next step shown with the empty state (e.g. "Go to home"). */
  emptyAction?: ReactNode;
  /** Next step shown with the denied state (e.g. "Back to home"). */
  deniedAction?: ReactNode;
  /** Extra detail for the error state, e.g. a reference id. */
  errorDetail?: ReactNode;
}

/**
 * Every screen renders through this (Constitution VIII): loading, empty, error, offline and
 * permission-denied are explicit, and each non-ready state states what happened and the next step.
 */
export function StateBoundary({ status, messages, children, onRetry, emptyAction, deniedAction, errorDetail }: StateBoundaryProps) {
  if (status === 'ready') return <>{children}</>;
  if (status === 'loading') {
    return (
      <div role="status" className="flex items-center gap-3 p-8 text-text-muted">
        <span className="inline-block h-6 w-6 animate-spin rounded-full border-[3px] border-border-subtle border-t-focus" aria-hidden="true" />
        <span>{messages.loading}</span>
      </div>
    );
  }
  if (status === 'empty') {
    return <EmptyState title={messages.empty.title} description={messages.empty.description} action={emptyAction} />;
  }
  const retry = onRetry ? (
    <Button variant="secondary" onClick={onRetry}>
      {messages.retry}
    </Button>
  ) : null;
  const tone = {
    error: { msg: messages.error, icon: <IconAlert />, cls: 'bg-feedback-error text-feedback-error-fg', role: 'alert' as const, action: retry },
    offline: { msg: messages.offline, icon: <IconWifiOff />, cls: 'bg-feedback-offline text-feedback-offline-fg', role: 'status' as const, action: retry },
    denied: { msg: messages.denied, icon: <IconLock />, cls: 'bg-feedback-warning text-feedback-warning-fg', role: 'alert' as const, action: deniedAction },
  }[status];
  return (
    <div role={tone.role} className={cn('flex flex-col gap-3 rounded-lg p-6', tone.cls)} data-boundary={status}>
      <div className="flex items-center gap-2">
        {tone.icon}
        <h2 className="text-lg font-semibold">{tone.msg.title}</h2>
      </div>
      {tone.msg.description && <p className="text-base">{tone.msg.description}</p>}
      {status === 'error' && errorDetail && <p className="text-sm">{errorDetail}</p>}
      {tone.action && <div className="flex flex-wrap gap-2">{tone.action}</div>}
    </div>
  );
}
