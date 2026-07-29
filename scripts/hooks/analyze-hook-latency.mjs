#!/usr/bin/env node
/**
 * Analyze hook-latency-sampler.ps1 output. Step 6 of the repair plan.
 *
 * Reports per-hook duration bounds, observed fan-out, and the count exceeding
 * 500ms -- plus, deliberately and prominently, the CAPTURE RATE.
 *
 * The capture rate is not a footnote. This sampler polls (no elevation, so no
 * Win32_ProcessStartTrace), which means any hook that starts and exits between
 * two polls is invisible. If it caught 40 of an expected 500 processes, then
 * "the slowest hook was X" is a statement about the SURVIVORS OF A BIASED
 * FILTER -- polling preferentially catches LONG-lived processes -- and the
 * honest reading is "of the hooks slow enough to be seen", not "of all hooks".
 *
 * Getting this backwards is how the previous latency answer went wrong: it
 * measured no-op payloads and reported the result as per-turn cost.
 */

import { readFileSync } from 'node:fs';

const file = process.argv[2] || `${process.env.TEMP}\\hook-latency-samples.jsonl`;
const EXPECTED_FANOUT_PER_TURN = 13;   // static fan-out for Bash, from settings.json
const TURNS = Number(process.argv[3] || 40);

const raw = readFileSync(file, 'utf-8')
  .split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

/**
 * Classify by PATH, not by "ends in .mjs".
 *
 * The sampler's name regex matched any .mjs/.py, so the first analysis counted
 * my own tooling as hooks -- `measure-fanout`, `vitest`, `update-blocklist`, the
 * embedding daemon -- and reported p50s in the tens of MILLIONS of ms, because
 * those processes started long before the sampler did and their "duration" is
 * really their age. An obviously absurd number is the lucky case; the dangerous
 * one is `launcher` at 581ms, which looks exactly like a plausible hook and is
 * not one.
 *
 * Three buckets, because they answer different questions:
 *   hook    -- registered in settings.json, spawned per turn. The subject.
 *   plugin  -- claude-hud statusline etc. Real per-turn cost, invisible to every
 *              audit that only reads the hook registry. Reported SEPARATELY.
 *   other   -- daemons, my own measurement tools, background work. Excluded.
 */
const classify = (r) => {
  const c = r.cmd || '';
  if (/[\\/]\.claude[\\/]hooks[\\/](dist[\\/])?[A-Za-z0-9._-]+\.(mjs|py)/.test(c)) return 'hook';
  if (/[\\/]\.claude[\\/]plugins[\\/]/.test(c)) return 'plugin';
  return 'other';
};

for (const r of raw) r._class = classify(r);
const rows = raw.filter((r) => r._class === 'hook');
const plugins = raw.filter((r) => r._class === 'plugin');
const excluded = raw.filter((r) => r._class === 'other');

const byHook = new Map();
for (const r of rows) {
  if (!byHook.has(r.hook)) byHook.set(r.hook, []);
  byHook.get(r.hook).push(r);
}

const stat = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { n: s.length, min: s[0], p50: q(0.5), p90: q(0.9), max: s[s.length - 1] };
};

const summary = [...byHook.entries()].map(([hook, rs]) => {
  const lower = stat(rs.map((r) => r.ms_lower));
  const upper = stat(rs.map((r) => r.ms_upper).filter((v) => v != null));
  return { hook, observed: rs.length, lower, upper };
}).sort((a, b) => b.upper.p50 - a.upper.p50 || b.observed - a.observed);

const expected = TURNS * EXPECTED_FANOUT_PER_TURN;
const captureRate = rows.length / expected;

console.log(`=== classification ===`);
console.log(`registered hooks        : ${rows.length}`);
console.log(`plugin processes        : ${plugins.length}  ${plugins.length ? '(' + [...new Set(plugins.map((p) => p.hook))].join(', ') + ') -- per-turn cost OUTSIDE the hook registry' : ''}`);
console.log(`excluded (daemons/tools): ${excluded.length}  ${excluded.length ? '(' + [...new Set(excluded.map((p) => p.hook))].join(', ') + ')' : ''}`);

if (plugins.length) {
  const pl = plugins.map((p) => p.ms_upper ?? p.ms_lower).filter((v) => v != null).sort((a, b) => a - b);
  if (pl.length) {
    console.log(`\n  plugin p50=${pl[Math.floor(pl.length / 2)].toFixed(0)}ms max=${pl[pl.length - 1].toFixed(0)}ms over ${pl.length} spawns`);
    console.log(`  -> every "hook layer cost" audit that reads settings.json misses this entirely.`);
  }
}

console.log(`\n=== capture ===`);
console.log(`observed hook processes : ${rows.length}`);
console.log(`expected (~${EXPECTED_FANOUT_PER_TURN}/turn x ${TURNS} turns) : ~${expected}`);
console.log(`CAPTURE RATE            : ${(captureRate * 100).toFixed(1)}%`);
console.log(`distinct hooks seen     : ${byHook.size}`);
if (captureRate < 0.5) {
  console.log(`
!! Polling missed most hook processes. Two consequences, both load-bearing:
   1. Fan-out counts here are LOWER BOUNDS, never totals.
   2. The sample is BIASED TOWARD SLOW HOOKS -- a fast hook is exactly the one a
      poller misses -- so these durations OVERSTATE the typical hook, and the
      per-hook p50s below describe "hooks slow enough to be caught", not "hooks".
   Fast hooks being under-represented means the TOTAL per-turn cost is
   understated while the PER-HOOK figures are overstated. Do not average them.`);
}

console.log(`\n=== per hook (ms; lower = alive-at-last-poll, upper = confirmed-gone-by) ===`);
console.log(`${'hook'.padEnd(34)} ${'n'.padStart(4)}  ${'p50↓'.padStart(7)} ${'p50↑'.padStart(7)} ${'max↑'.padStart(8)}`);
for (const s of summary) {
  console.log(
    `${String(s.hook).padEnd(34)} ${String(s.observed).padStart(4)}  ` +
    `${String(s.lower.p50 ?? '-').padStart(7)} ${String(s.upper.p50 ?? '-').padStart(7)} ` +
    `${String(s.upper.max ?? '-').padStart(8)}`);
}

const over500 = summary.filter((s) => (s.upper.p50 ?? 0) > 500);
console.log(`\n=== hooks with p50 over 500ms: ${over500.length} ===`);
for (const s of over500) console.log(`  ${s.hook}  p50=${s.upper.p50}ms  max=${s.upper.max}ms  n=${s.observed}`);

console.log(`\n=== concurrency: how many hook processes overlapped ===`);
const events = [];
for (const r of rows) {
  const t0 = Date.parse(r.startIso);
  events.push([t0, 1], [t0 + (r.ms_upper ?? r.ms_lower), -1]);
}
events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
let cur = 0, peak = 0;
for (const [, d] of events) { cur += d; peak = Math.max(peak, cur); }
console.log(`peak simultaneous hook processes: ${peak}`);
console.log(`(dispatch is parallel, so per-turn wall cost is closer to MAX than SUM)`);
