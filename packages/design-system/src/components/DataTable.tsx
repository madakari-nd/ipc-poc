import type { ReactNode } from 'react';
import { cn } from '../cn.js';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

export interface DataTableProps<T> {
  /** Accessible name for the table (rendered as a caption). */
  caption: string;
  hideCaption?: boolean;
  columns: Column<T>[];
  rows: T[];
  getRowId: (row: T) => string;
}

/**
 * Semantic table; row actions go in a cell as links/buttons so everything is keyboard reachable.
 * Wrap in <StateBoundary> for loading/empty/error states.
 */
export function DataTable<T>({ caption, hideCaption, columns, rows, getRowId }: DataTableProps<T>) {
  return (
    <div className="w-full overflow-x-auto rounded-md border border-border-subtle">
      <table className="w-full border-collapse text-left text-base">
        <caption className={cn('p-3 text-left text-lg font-semibold text-text', hideCaption && 'sr-only')}>{caption}</caption>
        <thead className="bg-surface-muted">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn('border-b border-border-subtle px-3 py-3 text-sm font-semibold text-text', c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={getRowId(r)} className="border-b border-border-subtle last:border-b-0">
              {columns.map((c) => (
                <td key={c.key} className={cn('px-3 py-2 align-middle text-text', c.className)}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
