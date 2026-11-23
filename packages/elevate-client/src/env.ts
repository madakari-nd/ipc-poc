import { readFileSync } from 'node:fs';

/**
 * Reads a `.env.<profile>` file (KEY=VALUE, `#` comments, optional quotes) without touching
 * process.env. Used by preflight and the integration tests; services get env from compose.
 */
export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    const q = /^(["'])(.*)\1(\s+#.*)?$/.exec(v);
    if (q) v = q[2]!;
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]!] = v;
  }
  return out;
}
