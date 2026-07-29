#!/usr/bin/env node
/**
 * Time the full per-tool hook fan-out with REALISTIC payloads. Step 6, part 2.
 *
 * WHY THIS EXISTS ALONGSIDE THE SAMPLER
 * -------------------------------------
 * The sampler watches real turns but, without elevation, has to poll -- so it
 * only catches processes that live longer than a poll interval. It captured ~10%
 * of the fan-out, and that 10% is biased toward SLOW hooks by construction. It
 * answers "what dominates a turn" well and "what does a typical hook cost"
 * not at all.
 *
 * This does the complement: it runs EVERY registered hook for a tool, so nothing
 * is missed, and reports each one's cost.
 *
 * THE PAYLOAD IS THE WHOLE POINT
 * ------------------------------
 * The measurement this replaces used `tool_name:"__probe__"`, which trips each
 * hook's first guard -- so it timed hooks DECIDING NOT TO RUN and reported that
 * as per-turn cost. The payloads here name the real tool, a real session id, a
 * real cwd and a real file path that exists in this repo, so a hook that
 * inspects its input does its actual work.
 *
 * It is still not identical to a live turn: the transcript path is absent, and a
 * hook keying off transcript content will take a shorter path than it would in
 * anger. Every number here is therefore a LOWER BOUND, and it is labelled as one
 * rather than presented as the truth.
 *
 * USAGE
 *   node scripts/hooks/measure-fanout.mjs [iterations]
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ITER = Number(process.argv[2] || 3);
const LIVE = 'C:/Users/david.hayes/.claude/settings.json';
const REPO = 'C:/Users/david.hayes/continuous-claude';
const REAL_FILE = `${REPO}/.claude/hooks/src/shared/output.ts`;
const SID = 'step6-fanout-probe';

const settings = JSON.parse(readFileSync(LIVE, 'utf-8'));

/** Does this matcher fire for this tool? Empty/absent matcher = all tools. */
function matches(matcher, tool) {
  if (matcher === undefined || matcher === null || matcher === '') return true;
  if (matcher === '*') return true;
  try { return new RegExp(`^(?:${matcher})$`).test(tool); } catch { return matcher === tool; }
}

function registrationsFor(event, tool) {
  const out = [];
  for (const group of settings.hooks?.[event] || []) {
    if (tool !== null && !matches(group.matcher, tool)) continue;
    for (const h of group.hooks || []) {
      const line = [h.command, ...(h.args || [])].filter(Boolean).join(' ');
      const m = line.match(/([A-Za-z0-9._-]+)\.(mjs|py)/);
      out.push({ name: m ? m[1] : line.slice(0, 40), command: h.command, args: h.args || [] });
    }
  }
  return out;
}

const SCENARIOS = [
  {
    label: 'PreToolUse:Bash',
    event: 'PreToolUse',
    tool: 'Bash',
    payload: { session_id: SID, cwd: REPO, tool_name: 'Bash',
               tool_input: { command: 'git status --porcelain', description: 'check status' } },
  },
  {
    label: 'PostToolUse:Edit',
    event: 'PostToolUse',
    tool: 'Edit',
    payload: { session_id: SID, cwd: REPO, tool_name: 'Edit',
               tool_input: { file_path: REAL_FILE, old_string: 'a', new_string: 'b' },
               tool_response: { success: true, filePath: REAL_FILE } },
  },
];

const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return { min: s[0], p50: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
};

for (const sc of SCENARIOS) {
  const regs = registrationsFor(sc.event, sc.tool);
  console.log(`\n=== ${sc.label} — ${regs.length} registered hooks fire ===`);
  const input = JSON.stringify(sc.payload);
  const rows = [];

  for (const r of regs) {
    const times = [];
    let rc = null;
    for (let i = 0; i < ITER; i++) {
      const t0 = process.hrtime.bigint();
      const res = spawnSync(r.command, r.args, { input, encoding: 'utf-8', timeout: 60000, windowsHide: true });
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      rc = res.status;
    }
    rows.push({ name: r.name, rc, ...stat(times) });
  }

  rows.sort((a, b) => b.p50 - a.p50);
  console.log(`${'hook'.padEnd(34)} ${'rc'.padStart(3)} ${'min'.padStart(8)} ${'p50'.padStart(8)} ${'max'.padStart(9)}`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(34)} ${String(r.rc).padStart(3)} ${r.min.toFixed(0).padStart(8)} ${r.p50.toFixed(0).padStart(8)} ${r.max.toFixed(0).padStart(9)}`);
  }
  const sum = rows.reduce((a, r) => a + r.p50, 0);
  const max = Math.max(...rows.map((r) => r.p50));
  const over = rows.filter((r) => r.p50 > 500);
  console.log(`\n  sum of p50 (if SERIAL)      : ${sum.toFixed(0)} ms`);
  console.log(`  max p50   (if FULLY PARALLEL): ${max.toFixed(0)} ms   <- dispatch is parallel, so nearer this`);
  console.log(`  hooks over 500ms            : ${over.length}${over.length ? ' -> ' + over.map((r) => r.name).join(', ') : ''}`);
}
