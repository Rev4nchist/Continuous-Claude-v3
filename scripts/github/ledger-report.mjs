#!/usr/bin/env node
/**
 * ledger-report.mjs: a read-only report on the cursor-review ledger, for the grok concurrency trial.
 *
 * Usage: node scripts/github/ledger-report.mjs --since <ISO time> [--ledger <file>]
 *   --ledger defaults to CURSOR_REVIEW_LEDGER, else ~/.claude/state/cursor-review-ledger.jsonl.
 *
 * The ledger has no concurrency field, so the report derives it. A run is the pair of lines with one id. The agent ran from
 * `spawnedAt` (else end time minus durationMs) to the end line's time. A run is filed under the most runs that were active at
 * once while it ran (itself included, older runs included, touching runs not). It reports, per such concurrency level, for the
 * runs that started since the cutoff: run count, median and p90 duration, time-outs, tool-stall stops, tok/s of the clean runs
 * (output tokens / duration) and the longest single tool call (maxToolMs, only on runs from after the stall guards).
 * Runs that never started (notStarted) and start lines with no end line are counted apart and never timed.
 * A start line with no end line (a crash, or a run still going) is of unknown length. Those from before the cutoff are counted apart, and a run
 * one of them may have overlapped (it started up to 3 h before) is marked as a lower bound: its true concurrency may be higher.
 * It never writes to the ledger. Exit 0 ok, 1 ledger unreadable, 2 bad arguments.
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultLedgerPath, readLedger } from './cursor-review.mjs';

/** The report always lists at least this many concurrency levels, so an empty c=3 row shows. */
export const MIN_LEVELS = 3;

/** Nearest-rank percentile of a list of numbers (p in 0..1), or null for an empty list. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/** The usual median: the middle value, or the mean of the two middle ones. */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One run per id: { id, startRowMs, end }. Lines of other shapes are ignored. */
function pairRuns(entries) {
  const runs = new Map();
  for (const e of entries) {
    if (typeof e?.id !== 'string' || (e.phase !== 'start' && e.phase !== 'end')) continue;
    const r = runs.get(e.id) ?? { id: e.id, startRowMs: null, end: null };
    if (e.phase === 'start') r.startRowMs = Date.parse(e.ts);
    else r.end = e;
    runs.set(e.id, r);
  }
  return [...runs.values()];
}

/** An unresolved start line this much older than a run cannot have overlapped it. */
const UNRESOLVED_MAX_MS = 3 * 3_600_000;

/** { startMs, endMs } of the time the agent ran, or null when the run has no end line or never started. */
function intervalOf(run) {
  const e = run.end;
  if (!e || e.notStarted === true) return null;
  const endMs = Date.parse(e.ts);
  const dur = Number(e.durationMs);
  if (!Number.isFinite(endMs) || !Number.isFinite(dur) || dur < 0) return null;
  const spawned = e.spawnedAt ? Date.parse(e.spawnedAt) : NaN;
  // The end line is written after the agent ends (parsing, files): with spawnedAt the agent ended at spawnedAt + durationMs.
  return Number.isFinite(spawned) ? { startMs: spawned, endMs: spawned + dur } : { startMs: endMs - dur, endMs };
}

/** The most runs (this one included) active at once at any moment of this run. Intervals are [start, end). */
function peakOverlap(me, all) {
  const points = [me.startMs, ...all.filter((o) => o.startMs > me.startMs && o.startMs < me.endMs).map((o) => o.startMs)];
  let peak = 1;
  for (const p of points) peak = Math.max(peak, all.filter((o) => o.startMs <= p && p < o.endMs).length);
  return peak;
}

const isClean = (e) => e.exit === 0 && e.timedOut !== true && !e.error;

function summarize(concurrency, rows) {
  const durations = rows.map((r) => r.durMs);
  const rates = rows.filter((r) => isClean(r.end) && r.durMs > 0 && Number(r.end.usage?.outputTokens) > 0).map((r) => r.end.usage.outputTokens / (r.durMs / 1000));
  const tools = rows.map((r) => r.end.maxToolMs).filter((n) => Number.isFinite(n));
  return {
    concurrency, runs: rows.length, lowerBound: rows.filter((r) => r.lb).length, medianMs: median(durations), p90Ms: percentile(durations, 0.9),
    timeouts: rows.filter((r) => r.end.timedOut === true).length,
    toolStalls: rows.filter((r) => typeof r.end.error === 'string' && r.end.error.startsWith('tool-stall')).length,
    tokPerSec: { n: rates.length, median: median(rates) },
    maxToolMs: tools.length ? Math.max(...tools) : null,
  };
}

/** { total, notStarted, unfinished, buckets: [{ concurrency, runs, medianMs, p90Ms, timeouts, toolStalls, tokPerSec, maxToolMs }] } for the runs that started at or after sinceMs. */
export function analyze(entries, { sinceMs }) {
  const runs = pairRuns(entries);
  const open = runs.filter((r) => !r.end && Number.isFinite(r.startRowMs)).map((r) => r.startRowMs);
  const timed = runs.map((run) => ({ run, iv: intervalOf(run) })).filter((x) => x.iv);
  const all = timed.map((x) => x.iv);
  const mine = timed.filter((x) => x.iv.startMs >= sinceMs).map(({ run, iv }) => ({ end: run.end, durMs: iv.endMs - iv.startMs, c: peakOverlap(iv, all), lb: open.some((s) => s <= iv.endMs && iv.startMs - s < UNRESOLVED_MAX_MS) }));
  const sinceRow = (r) => (r.startRowMs ?? Date.parse(r.end?.ts)) >= sinceMs;
  const notStarted = runs.filter((r) => r.end?.notStarted === true && sinceRow(r)).length;
  const unfinished = runs.filter((r) => !r.end && sinceRow(r)).length;
  const levels = Math.max(MIN_LEVELS, ...mine.map((r) => r.c));
  const buckets = Array.from({ length: levels }, (_, i) => summarize(i + 1, mine.filter((r) => r.c === i + 1)));
  return { total: mine.length, notStarted, unfinished, preCutoffUnresolved: open.filter((s) => s < sinceMs).length, buckets };
}

const minutes = (ms) => (ms === null ? '-' : `${(ms / 60_000).toFixed(1)} min`);
const rate = (t) => (t.n === 0 ? '-' : `${t.median.toFixed(1)} median (n=${t.n})`);
const chicago = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' });

/** The report text. meta: { since (ISO), ledger (path), damaged (count) }. */
export function formatReport(a, meta) {
  const lines = [
    'Grok concurrency trial: cursor-review ledger report (read only)',
    `ledger: ${meta.ledger}${meta.damaged ? ` (${meta.damaged} damaged line(s) skipped)` : ''}`,
    `since: ${meta.since} (${chicago(Date.parse(meta.since))})`,
    'concurrency = the most runs active at once while a run ran, itself included; derived from run times, the ledger stores no concurrency.',
    '',
  ];
  if (a.total === 0) {
    lines.push(`No runs since ${meta.since}.`);
    if (a.notStarted || a.unfinished) lines.push(`(${a.notStarted} run(s) never started, ${a.unfinished} start line(s) without an end line.)`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(`runs started since: ${a.total}   never started: ${a.notStarted}   no end line: ${a.unfinished}`);
  if (a.preCutoffUnresolved) lines.push(`started before the cutoff, no end line: ${a.preCutoffUnresolved} (not counted as running; see "may be higher")`);
  lines.push('');
  for (const b of a.buckets) {
    lines.push(`c=${b.concurrency}   runs ${b.runs}${b.lowerBound ? `   (${b.lowerBound} may be higher: a run with no end line may have overlapped)` : ''}`);
    if (b.runs === 0) { lines.push('  no runs', ''); continue; }
    lines.push(
      `  duration       median ${minutes(b.medianMs)}   p90 ${minutes(b.p90Ms)}`,
      `  timeouts       ${b.timeouts}`,
      `  tool-stall     ${b.toolStalls}`,
      `  tok/s          ${rate(b.tokPerSec)}`,
      `  max tool call  ${b.maxToolMs === null ? '-' : `${b.maxToolMs} ms`}`,
      '',
    );
  }
  return `${lines.join('\n')}`;
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--since') {
      const v = argv[++i];
      const ms = typeof v === 'string' ? Date.parse(v) : NaN;
      if (!Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}/.test(v)) return { error: `--since needs an ISO time such as 2026-11-03T18:00:00Z, got ${JSON.stringify(v)}` };
      out.sinceMs = ms;
    } else if (a === '--ledger') {
      out.ledger = argv[++i];
      if (!out.ledger) return { error: '--ledger needs a file' };
    } else return { error: `unknown argument ${JSON.stringify(a)}` };
  }
  if (out.sinceMs === undefined) return { error: '--since <ISO time> is required' };
  return out;
}

/** Returns the exit code. deps (tests): { stdout, stderr, env }. */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const args = parseArgs(argv);
  if (args.error) { stderr(`ledger-report: ${args.error}`); return 2; }
  const ledger = args.ledger ?? defaultLedgerPath(deps.env ?? process.env);
  try { readFileSync(ledger); } catch (e) { // readLedger reads any error as empty: only a missing file is a valid empty ledger
    if (e?.code !== 'ENOENT') { stderr(`ledger-report: cannot read the ledger ${ledger}: ${e?.message ?? e}`); return 1; }
  }
  const { entries, damaged } = readLedger(ledger);
  stdout(formatReport(analyze(entries, { sinceMs: args.sinceMs }), { since: new Date(args.sinceMs).toISOString(), ledger, damaged }).trimEnd());
  return 0;
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2));
