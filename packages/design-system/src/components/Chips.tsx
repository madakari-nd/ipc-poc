import type { ComponentType, SVGProps } from 'react';
import { cn } from '../cn.js';
import type { LegendKind, RiskLevel, TaskState } from '../tokens.js';
import {
  IconAlert,
  IconArrowUp,
  IconCheck,
  IconCircle,
  IconLayers,
  IconLock,
  IconMinus,
  IconPlay,
  IconShield,
  IconUndo,
  IconUpload,
} from './icons.js';

const chipBase = 'inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-semibold whitespace-nowrap';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

// Full class strings (not template literals) so Tailwind's content scan keeps them.
const stateStyle: Record<TaskState, { cls: string; icon: Icon }> = {
  ASSIGNED: { cls: 'bg-state-assigned text-state-assigned-fg', icon: IconCircle },
  IN_PROGRESS: { cls: 'bg-state-in-progress text-state-in-progress-fg', icon: IconPlay },
  EVIDENCE_SUBMITTED: { cls: 'bg-state-evidence-submitted text-state-evidence-submitted-fg', icon: IconUpload },
  CHANGES_REQUESTED: { cls: 'bg-state-changes-requested text-state-changes-requested-fg', icon: IconUndo },
  VERIFIED: { cls: 'bg-state-verified text-state-verified-fg', icon: IconCheck },
  PENDING_VALIDATION: { cls: 'bg-state-pending-validation text-state-pending-validation-fg', icon: IconShield },
  CLOSED: { cls: 'bg-state-closed text-state-closed-fg', icon: IconLock },
};

const riskStyle: Record<RiskLevel, { cls: string; icon: Icon }> = {
  critical: { cls: 'bg-risk-critical text-risk-critical-fg', icon: IconAlert },
  high: { cls: 'bg-risk-high text-risk-high-fg', icon: IconArrowUp },
  normal: { cls: 'bg-risk-normal text-risk-normal-fg', icon: IconMinus },
};

const legendStyle: Record<LegendKind, string> = {
  reused: 'bg-legend-reused text-legend-reused-fg',
  customised: 'bg-legend-customised text-legend-customised-fg',
  'built-on-top': 'bg-legend-built-on-top text-legend-built-on-top-fg',
};

/** Task state chip: always text + icon, never colour alone. `label` is the translated state name. */
export function StatusChip({ state, label, className }: { state: TaskState; label: string; className?: string }) {
  const { cls, icon: I } = stateStyle[state];
  return (
    <span className={cn(chipBase, cls, className)} data-state={state}>
      <I />
      {label}
    </span>
  );
}

/** Risk chip (critical / high / normal) with text + icon. */
export function RiskChip({ level, label, className }: { level: RiskLevel; label: string; className?: string }) {
  const { cls, icon: I } = riskStyle[level];
  return (
    <span className={cn(chipBase, cls, className)} data-risk={level}>
      <I />
      {label}
    </span>
  );
}

/** Proposal legend chip (ELEVATE reused / customised / built on top). */
export function LegendChip({ kind, label, className }: { kind: LegendKind; label: string; className?: string }) {
  return (
    <span className={cn(chipBase, legendStyle[kind], className)} data-legend={kind}>
      <IconLayers />
      {label}
    </span>
  );
}
