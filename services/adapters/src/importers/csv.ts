import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';

/** At most 5 MB per file (contract ImportUpload). */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export interface CsvRow {
  /** 1-based data row number (header excluded), as reported in rowErrors. */
  row: number;
  cells: Record<string, string>;
}

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
  }
}

/** Header names are matched case-insensitively with spaces/dashes as underscores (`Facility Code` = `facility_code`). */
export const normaliseHeader = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** Parses a CSV with a header row. Blank lines are skipped; every value is trimmed. */
export function parseCsv(text: string, required: readonly string[]): CsvRow[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw new CsvError('The file is larger than 5 MB');
  let records: string[][];
  try {
    records = parse(text.replace(/^\uFEFF/, ''), { skip_empty_lines: true, trim: true, relax_column_count: true }) as string[][];
  } catch (e) {
    throw new CsvError(`The file is not valid CSV: ${(e as Error).message.slice(0, 200)}`);
  }
  const [header, ...rows] = records;
  if (!header) throw new CsvError('The file is empty');
  const cols = header.map(normaliseHeader);
  const missing = required.filter((r) => !cols.includes(r));
  if (missing.length) throw new CsvError(`Missing column(s): ${missing.join(', ')}`);
  return rows.map((cells, i) => ({
    row: i + 1,
    cells: Object.fromEntries(cols.map((c, j) => [c, (cells[j] ?? '').trim()])),
  }));
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** `a;b , c` → ['a','b','c'] (semicolons or pipes; commas only when the cell was quoted). */
export const splitList = (v: string | undefined) =>
  (v ?? '').split(/[;|,]/).map((s) => s.trim()).filter(Boolean);
