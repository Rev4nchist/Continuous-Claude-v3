#!/usr/bin/env node
/**
 * hook-trace-report -- p50 and p95 per hook from the trace day files.
 *
 * The tracer (.claude/hooks/src/lib/trace-boot.ts) writes one row per hook process to
 * <dir>/hook-trace-YYYY-MM-DD.jsonl. This script reads the files of the last N days (default 7, by the UTC date in the
 * file name), skips rows whose source is test or probe and rows of kind job, and prints one line per hook:
 *   n, p50, p95 and max of durationMs, p50 of startupMs, error rate (code != 0) and the count of each `out` class.
 *
 * Usage: node scripts/hooks/hook-trace-report.mjs [--dir <dir>] [--days 7] [--by event,tool]
 *   --dir   default ~/.claude/cache
 *   --by    split each hook by these row keys (event, tool)
 * Exit 1 when no live row was found: a table of zero is not a report.
 * Design: .claudedocs/2026-11-09-trace-hook-design.md section 8.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY_FILE = /^hook-trace-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 24 * 3600 * 1000;

/** Nearest-rank percentile of a list of numbers, or null for an empty list. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** The day files (name and UTC date) dated on or after `now - days`, oldest first. */
export function dayFilesInWindow(dir, days, now = Date.now()) {
  if (!existsSync(dir)) return [];
  const cutoff = new Date(now - days * DAY_MS).toISOString().slice(0, 10);
  return readdirSync(dir).map((f) => ({ f, m: DAY_FILE.exec(f) })).filter((x) => x.m && x.m[1] >= cutoff)
    .map((x) => ({ file: x.f, day: x.m[1] })).sort((a, b) => a.day.localeCompare(b.day));
}

/** Rows of the given day files. Lines that are not JSON are skipped. Test, probe and job rows are dropped. */
export function liveRows(dir, files) {
  const rows = [];
  for (const { file } of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r || typeof r.name !== 'string' || r.source === 'test' || r.source === 'probe' || r.kind === 'job') continue;
      rows.push(r);
    }
  }
  return rows;
}

const fmt = (n) => (n === null ? '-' : String(Math.round(n * 10) / 10));

/** One summary object per group of rows (group key: name plus the `by` keys). */
export function summarize(rows, by = []) {
  const groups = new Map();
  for (const r of rows) {
    const key = [r.name, ...by.map((k) => r[k] ?? '-')];
    const id = key.join('\u0000');
    if (!groups.has(id)) groups.set(id, { key, rows: [] });
    groups.get(id).rows.push(r);
  }
  return [...groups.values()].map(({ key, rows: g }) => {
    const dur = g.map((r) => r.durationMs).filter(Number.isFinite);
    const startup = g.map((r) => r.startupMs).filter(Number.isFinite);
    const out = {};
    for (const r of g) out[r.out ?? 'none'] = (out[r.out ?? 'none'] ?? 0) + 1;
    const errors = g.filter((r) => (Number.isFinite(r.code) ? r.code !== 0 : r.exitCode !== 0)).length;
    return { key, n: g.length, p50: percentile(dur, 50), p95: percentile(dur, 95), max: percentile(dur, 100), startupP50: percentile(startup, 50), errPct: Math.round((100 * errors) / g.length), out };
  }).sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0));
}

function render(summary, by) {
  const head = ['name', ...by, 'n', 'p50', 'p95', 'max', 'startup-p50', 'err', 'out'];
  const lines = summary.map((s) => [...s.key, s.n, fmt(s.p50), fmt(s.p95), fmt(s.max), fmt(s.startupP50), `err ${s.errPct}%`,
    Object.entries(s.out).sort().map(([k, v]) => `${k}:${v}`).join(' ')].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const pad = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [pad(head), ...lines.map(pad)].join('\n');
}

function parseArgs(argv) {
  const o = { dir: join(homedir(), '.claude', 'cache'), days: 7, by: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') o.dir = argv[++i];
    else if (argv[i] === '--days') o.days = Number(argv[++i]);
    else if (argv[i] === '--by') o.by = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!o.dir || !(o.days > 0) || o.by.some((k) => !['event', 'tool'].includes(k))) throw new Error('usage: hook-trace-report.mjs [--dir <dir>] [--days 7] [--by event,tool]');
  return o;
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(2); }
  const files = dayFilesInWindow(o.dir, o.days);
  const rows = liveRows(o.dir, files);
  if (!rows.length) {
    console.log(`no live rows in ${o.dir} (${files.length} day file(s) in the last ${o.days} days). A table of zero is not a report.`);
    process.exit(1);
  }
  console.log(`hook-trace report: ${rows.length} live rows from ${files.length} day file(s), ${files[0].day} to ${files.at(-1).day}, in ${o.dir}\n`);
  console.log(render(summarize(rows, o.by), o.by));
  console.log('');
  for (const { day } of files) {
    const f = join(o.dir, `hook-trace-${day}.dropped`);
    if (existsSync(f)) { try { console.log(`dropped ${day}: ${JSON.parse(readFileSync(f, 'utf8')).dropped} row(s) past the day cap`); } catch { console.log(`dropped ${day}: unreadable counter file`); } }
  }
  console.log('note: timeout-killed hooks write no row; p95 is biased low.');
  console.log('note: bundled dependency evaluation is in durationMs, not in startupMs. Wall time is about startupMs + durationMs + 20 ms.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
