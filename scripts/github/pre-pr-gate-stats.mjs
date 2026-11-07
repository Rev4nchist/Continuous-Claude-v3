#!/usr/bin/env node
/**
 * pre-pr-gate-stats.mjs: reads the gate-outcome log that pre-pr.mjs appends to and prints, per step: runs, fails, p50 and p90 ms.
 *
 * Usage: node scripts/github/pre-pr-gate-stats.mjs [--days N] [--file <path>]
 * The log is ~/.claude/logs/pre-pr-gates.jsonl, or PRE_PR_GATE_LOG. A step with no timed run shows "-" for ms.
 * Percentiles use nearest rank over the rows that have a ms number. A bad line is skipped.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateLogPath } from './lib/gate-log.mjs';

const USAGE = 'usage: node scripts/github/pre-pr-gate-stats.mjs [--days N] [--file <path>]';
const DAY_MS = 86_400_000;

/** The rows of the log file. A missing file, or a line that is not a JSON object, adds nothing. */
export function readRows(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try { const row = JSON.parse(line); return row && typeof row === 'object' && typeof row.step === 'string' ? [row] : []; } catch { return []; }
  });
}

/** Nearest-rank percentile (p in 1..100) of numbers; null for an empty list. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
}

/** Per step: { gate, runs, fails, p50, p90 }, most runs first. `days` keeps rows no older than N days before `now`. */
export function gateStats(rows, { days = null, now = new Date() } = {}) {
  const since = days === null ? -Infinity : now.getTime() - days * DAY_MS;
  const by = new Map();
  for (const row of rows) {
    if (Date.parse(row.ts) < since) continue;
    const g = by.get(row.step) ?? { gate: row.step, runs: 0, fails: 0, times: [] };
    g.runs += 1;
    if (row.status === 'FAIL') g.fails += 1;
    if (Number.isFinite(row.ms)) g.times.push(row.ms);
    by.set(row.step, g);
  }
  return [...by.values()].map(({ times, ...g }) => ({ ...g, p50: percentile(times, 50), p90: percentile(times, 90) }))
    .sort((a, b) => b.runs - a.runs || a.gate.localeCompare(b.gate));
}

/** The table as text. */
export function formatStats(stats) {
  if (stats.length === 0) return 'no gate rows found';
  const width = Math.max(4, ...stats.map((s) => s.gate.length));
  const cell = (v) => String(v ?? '-').padStart(8);
  const head = `${'gate'.padEnd(width)}${cell('runs')}${cell('fails')}${cell('p50 ms')}${cell('p90 ms')}`;
  return [head, ...stats.map((s) => `${s.gate.padEnd(width)}${cell(s.runs)}${cell(s.fails)}${cell(s.p50)}${cell(s.p90)}`)].join('\n');
}

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const daysText = option(args, '--days');
  const days = daysText === null ? null : Number(daysText);
  if (days !== null && !(days > 0)) { console.error(`pre-pr-gate-stats: --days needs a number above 0\n${USAGE}`); return 2; }
  const file = option(args, '--file') ?? gateLogPath();
  console.log(formatStats(gateStats(readRows(file), { days })));
  return 0;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) process.exit(main());
