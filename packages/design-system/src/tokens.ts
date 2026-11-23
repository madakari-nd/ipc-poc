import rawTokens from '../tokens.json';

export interface ColourPair {
  fg: string;
  bg: string;
  hover?: string;
}

export const tokens = rawTokens;

/** The 7 task states (data-model Task.state) and their token slug. */
export const TASK_STATES = [
  'ASSIGNED',
  'IN_PROGRESS',
  'EVIDENCE_SUBMITTED',
  'CHANGES_REQUESTED',
  'VERIFIED',
  'PENDING_VALIDATION',
  'CLOSED',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const RISK_LEVELS = ['critical', 'high', 'normal'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Proposal legend: ELEVATE reused / customised / built on top. */
export const LEGEND_KINDS = ['reused', 'customised', 'built-on-top'] as const;
export type LegendKind = (typeof LEGEND_KINDS)[number];

export function stateSlug(state: TaskState): keyof typeof rawTokens.color.state {
  return state.toLowerCase().replace(/_/g, '-') as keyof typeof rawTokens.color.state;
}

/** Flattens tokens into CSS custom properties (`--ipc-color-state-assigned-fg`, ...). */
export function cssVariables(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (prefix: string, node: unknown): void => {
    if (typeof node === 'string') {
      out[prefix] = node;
      return;
    }
    if (Array.isArray(node)) {
      out[prefix] = String(node[0]);
      out[`${prefix}-line-height`] = String(node[1]);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith('$')) continue;
        walk(`${prefix}-${k}`, v);
      }
    }
  };
  walk('--ipc', rawTokens);
  return out;
}
