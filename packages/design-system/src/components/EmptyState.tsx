import type { ReactNode } from 'react';
import { IconInbox } from './icons.js';

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  /** The next step (a Button or link); every empty state should offer one. */
  action?: ReactNode;
}

export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-border-subtle bg-surface p-8 text-center">
      <div className="text-text-muted">{icon ?? <IconInbox width={32} height={32} />}</div>
      <h2 className="text-xl font-semibold text-text">{title}</h2>
      {description && <p className="max-w-[480px] text-base text-text-muted">{description}</p>}
      {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
