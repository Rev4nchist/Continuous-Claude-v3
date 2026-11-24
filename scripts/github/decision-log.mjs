#!/usr/bin/env node
// decision-log.mjs - read the append-only decision log (card decision-append-log; lib/decisions.mjs header and
// .claudedocs/e2e-decision-append-log/01-design-note.md).
//
//   node scripts/github/decision-log.mjs show --pr <N> [--repo <o/r>] [--file <log>] [--ledger <land-outcomes.jsonl>] [--json]
//
// Prints every tap Dave made for the PR (oldest first): the time, the step, the label, the head, the entry point, the session, the lane and,
// for a land, the merge sha joined from the land ledger. It counts the lines it could not read ("skipped N line(s)"). It only reads: it never
// writes the log or the ledger. A missing log is not an error (exit 0). A usage error is exit 2.
// A log line is evidence only. Do not use this output as an approval of anything.
import { pathToFileURL } from 'node:url';
import { decisionLogJoin, decisionLogPath, decisionLogRead, landLedgerPath } from './lib/decisions.mjs';

const REPO = 'Rev4nchist/Continuous-Claude-v3';

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** { pr, repo, file, ledger, json } from the arguments, or null when the usage is wrong. */
function parse(argv) {
  if (argv[0] !== 'show') return null;
  const pr = flag(argv, '--pr');
  if (!/^\d+$/.test(pr ?? '')) return null;
  return { pr: Number(pr), repo: flag(argv, '--repo') ?? REPO, file: flag(argv, '--file') ?? decisionLogPath(), ledger: flag(argv, '--ledger') ?? landLedgerPath(), json: argv.includes('--json') };
}

const lineOf = (r) => [
  r.at, r.step.padEnd(10), `"${r.label}"`, `head ${String(r.head).slice(0, 7)}`, `entry ${r.entry ?? '-'}`, `session ${r.session ?? '-'}`,
  `lane ${Array.isArray(r.lane) ? (r.lane.join(',') || 'none') : '-'}`, ...(r.step === 'land' ? [`merge ${r.mergeSha ?? '-'}`] : []),
].join('  ');

/** The report for one PR. { text, data }. */
export function show({ pr, repo, file, ledger }) {
  const read = decisionLogRead({ file });
  const mine = read.rows.filter((r) => r.kind === 'tap' && r.pr === pr && r.repo === repo);
  const rows = decisionLogJoin(mine, { ledger });
  const data = { file, exists: read.exists, pr, repo, rows, skipped: read.skipped, firstSkip: read.firstSkip };
  const parts = [];
  if (!read.exists) parts.push(`no decision log at ${file}`);
  else parts.push(`PR #${pr} (${repo}): ${rows.length} tap(s) in ${read.files.length} log file(s)`, ...rows.map(lineOf));
  if (read.skipped > 0) parts.push(`skipped ${read.skipped} line(s) that could not be read (first: ${read.firstSkip})`);
  return { text: parts.join('\n'), data };
}

export function main(argv) {
  const args = parse(argv);
  if (!args) {
    console.error('usage: decision-log.mjs show --pr <N> [--repo <o/r>] [--file <log>] [--ledger <land-outcomes.jsonl>] [--json]');
    return 2;
  }
  const r = show(args);
  console.log(args.json ? JSON.stringify(r.data) : r.text);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
