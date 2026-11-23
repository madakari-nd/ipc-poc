// npx tsx scripts/security-report.ts [--run] [--target inprocess|stack]
// T064 (SC-002): writes docs/security-report.md from the security suite's results, one row per case
// with what happened through the Edge and directly against ELEVATE.
// --run       first runs `vitest run --project security` (IPC_SECURITY_TARGET = --target).
// --target    only report that target (default: every target that has results).
// Exit 0 = every case refused through the Edge, 2 = a case was not refused or did not run, 1 = error.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'tests/security/results');
const OUT = join(ROOT, 'docs/security-report.md');

interface Side { result: string; refused: boolean; source: 'live' | 'cited' | 'not_run'; note?: string }
interface CaseResult { id: string; title: string; target: string; edge?: Side; direct?: Side; recordedAt: string }

/** Report order (research §4 first, then T063). */
const ORDER = ['V1', 'V2', 'V3', 'V4-stale', 'V4-replay', 'V5b', 'V5b-owner', 'RATE', 'HEADERS'];

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function side(s: Side | undefined): string {
  if (!s) return '_no result_';
  const tag = s.source === 'cited' ? ' _(cited)_' : s.source === 'not_run' ? ' _(not run)_' : '';
  return cell(`${s.result}${tag}${s.note && s.source !== 'live' ? ` — ${s.note}` : ''}`);
}

function verdict(r: CaseResult): { text: string; ok: boolean } {
  if (!r.edge || r.edge.source === 'not_run') return { text: 'NOT RUN through the Edge', ok: false };
  if (!r.edge.refused) return { text: '**FAIL**: not refused through the Edge', ok: false };
  const gap = r.direct && r.direct.source !== 'not_run' && !r.direct.refused;
  return { text: gap ? 'PASS: refused by the Edge; ELEVATE alone allows it' : 'PASS: refused by the Edge', ok: true };
}

function load(target: string): CaseResult[] {
  const dir = join(RESULTS, target);
  if (!existsSync(dir)) return [];
  const all = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as CaseResult);
  const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
  return all.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

function main(): number {
  const only = arg('--target');
  if (only && only !== 'inprocess' && only !== 'stack') {
    console.error('--target must be inprocess or stack');
    return 1;
  }
  if (process.argv.includes('--run')) {
    const run = spawnSync('npx', ['vitest', 'run', '--project', 'security'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, IPC_SECURITY_TARGET: only ?? process.env.IPC_SECURITY_TARGET ?? 'inprocess' },
    });
    if (run.status !== 0) console.error(`security suite exited with ${run.status}; reporting what was recorded`);
  }

  const targets = (only ? [only] : ['inprocess', 'stack']).filter((t) => load(t).length > 0);
  if (targets.length === 0) {
    console.error(`no results under ${RESULTS}; run with --run or \`npm run test:security\` first`);
    return 1;
  }

  const lines: string[] = [
    '# Security report (SC-002)',
    '',
    `Generated ${new Date().toISOString()} by \`scripts/security-report.ts\` from \`tests/security/results/\`.`,
    '',
    'Each case is sent through the Programme Edge, where it must be refused, and directly to the local',
    'ELEVATE, where the actual answer is recorded (research §4). "Cited" means the direct result comes from',
    'the dated validation log because it cannot be reproduced on the local stack.',
    '',
  ];
  let ok = true;
  for (const target of targets) {
    const rows = load(target);
    const ran = rows.some((r) => r.edge && r.edge.source !== 'not_run');
    if (!ran && !only) {
      // A whole target that could not run (e.g. the stack is down) is reported, not failed.
      lines.push(`## Target: ${target} — not run`, '', `No case ran through this Edge: ${cell(rows[0]?.edge?.note ?? 'no result')}.`, '');
      continue;
    }
    const label = target === 'stack' ? 'dockerised stack' : 'in-process Edge (real MongoDB, workflow stub with two hospitals)';
    lines.push(`## Target: ${target} — ${label}`, '');
    lines.push('| case | through Edge | direct ELEVATE | verdict |', '|------|--------------|----------------|---------|');
    for (const r of rows) {
      const v = verdict(r);
      ok &&= v.ok;
      lines.push(`| ${cell(r.title)} | ${side(r.edge)} | ${side(r.direct)} | ${v.text} |`);
    }
    const latest = rows.map((r) => r.recordedAt).sort().at(-1);
    lines.push('', `Recorded ${latest}. ${rows.filter((r) => verdict(r).ok).length} of ${rows.length} cases refused through the Edge.`, '');
  }
  lines.push(
    '## How to reproduce',
    '',
    '- `npm run test:security` (in-process) or `IPC_SECURITY_TARGET=stack npm run test:security` (stack up, `SEC_STACK_*` fixtures set).',
    '- `npx tsx scripts/security-report.ts` rewrites this file from the latest results.',
    '- Ledger tamper evidence (US9 AS6): `npm run ledger:verify`, then `npx tsx scripts/ledger-tamper-demo.ts` (test profile only), then verify again.',
    '',
  );
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, lines.join('\n'));
  console.log(`wrote ${OUT} (${targets.join(', ')})${ok ? '' : ' — some cases were not refused or not run'}`);
  return ok ? 0 : 2;
}

process.exit(main());
