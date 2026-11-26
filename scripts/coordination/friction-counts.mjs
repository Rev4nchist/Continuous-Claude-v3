#!/usr/bin/env node
/**
 * friction-counts -- one line of counts for the seat (card seat-friction-counts). The seat reads friction as counts, never as raw log rows.
 * Pattern: stall-alarm-log.mjs (pure functions, run(argv) returns { code, out, err }, a listed-id guard on the output).
 *
 * Reads two logs, read only (it writes nothing, not even a cache):
 *   decision log  ~/.claude/state/ccv3-mods/decision-log.jsonl   one row per tap of Dave on the questions that ship-ask and pr_checkpoint build
 *                                                                 (the steps ship, open-pr, review, land, paid-round and cli-skip; the line names land, open-pr and review
 *                                                                 first, then every other step in name order). A tap is "recommended" when its label ends with "(Recommended)".
 *   runs log      ~/.claude/state/run-locks/runs.jsonl           one row per pre-pr start and end (result PASS, FAIL or ERROR, the failing step, minutes).
 * The line, for the last N days (default 1):
 *   taps (land, open-pr, review) 1d recommended/all: land: 3/3 open-pr: 2/2 review: 0/0 | pre-pr (1d): starts 6 ends 5 FAIL 2 (evidence 1, summary 1) FAIL<1min 1 (evidence 1) ERROR 0
 * An ERROR end (a run that died; pre-pr.mjs writes result ERROR) counts in "ends" and prints as "ERROR n", apart from FAIL.
 * FAIL<1min counts a FAIL whose written minutes is under 1. pre-pr.mjs rounds minutes to 0.1, so a FAIL of 57 to 59.9 seconds is written as 1 and is not counted.
 * A step with no row prints 0/0, so the line keeps one shape. A log that is missing prints "no log" for its half.
 * No number sits right after "pr " in the line (hence "open-pr: 2/2" and "pre-pr (1d):"): the listed-id matcher reads "pr 19" as PR number 19.
 *
 * No PR number, sha or id: the reader keeps only step, the label ending, event, result, failing step and minutes. A step or failing-step name must be a
 * plain name (letters, digits, ":" and "-", up to 40, no hex run of 7 or more); anything else counts as "other". The whole line then goes through
 * countListed of board-mask.mjs: a hit exits 3 with nothing on stdout, and stderr names the FIELD that collided, never its value.
 *
 * Usage: node scripts/coordination/friction-counts.mjs [--days N] [--decisions <file>] [--runs <file>] [--now <iso>] [--root <repo root of the id list>]
 * Exit: 0 ok | 1 usage | 2 no readable log, or no row in the window | 3 the listed-id list is unreadable, or a listed id is in the line | 4 internal error.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { countListed, readIdList } from './board-mask.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const DAY = 86_400_000;
const FIXED_STEPS = ['land', 'open-pr', 'review'];
const NAME = /^[a-z0-9][a-z0-9:-]{0,39}$/;
const MSG_LIST = 'friction-counts: the listed-id list could not be read; no output';
const MSG_NOTE = 'friction-counts: note: no listed-id list in this root; the output holds no free text';

class Usage extends Error {}

/** A step or failing-step name that may be printed: a plain gate name with no hex run of 7 or more (the run set of the listed-id matcher). */
export const plainName = (s) => typeof s === 'string' && NAME.test(s) && !/[0-9a-f]{7,}/i.test(s);
const nameOf = (s) => (plainName(s) ? s : 'other');

/** The tap rows of the decision log as { at, step, rec }. A line that is not a tap of the known shape is skipped (counted, never read further). */
export function parseDecisions(text) {
  const rows = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r = null;
    try { r = JSON.parse(line); } catch { /* counted below */ }
    const at = r && typeof r.at === 'string' ? Date.parse(r.at) : NaN;
    if (!r || r.kind !== 'tap' || typeof r.step !== 'string' || typeof r.label !== 'string' || !Number.isFinite(at)) { skipped += 1; continue; }
    rows.push({ at, step: nameOf(r.step), rec: r.label.endsWith('(Recommended)') });
  }
  return { rows, skipped };
}

/** The start and end rows of the runs log: { ts, event: 'start' } or { ts, event: 'end', error, fail, failing, minutes } (an ERROR end has only ts, event and error: true). Other events (wait) are ignored; a bad start or end is skipped. */
export function parseRuns(text) {
  const rows = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r = null;
    try { r = JSON.parse(line); } catch { /* counted below */ }
    if (!r || typeof r !== 'object' || !Number.isFinite(r.ts)) { skipped += 1; continue; }
    if (r.event === 'start') rows.push({ ts: r.ts, event: 'start' });
    else if (r.event === 'end') {
      const ok = (r.result === 'PASS' || r.result === 'FAIL') && Number.isFinite(r.minutes) && (r.failing === null || typeof r.failing === 'string');
      if (ok) rows.push({ ts: r.ts, event: 'end', error: false, fail: r.result === 'FAIL', failing: nameOf(r.failing), minutes: r.minutes });
      else if (r.result === 'ERROR' && Number.isFinite(r.minutes)) rows.push({ ts: r.ts, event: 'end', error: true }); // a run that died: no failing step, counted apart from FAIL
      else skipped += 1;
    }
  }
  return { rows, skipped };
}

const inWindow = (t, now, days) => t > now - days * DAY && t <= now;

/** { steps: [[name, rec, all]] } for the window: the three fixed steps first (0/0 when empty), then other plain names, then "other". */
export function tapCounts(rows, now, days) {
  const by = new Map(FIXED_STEPS.map((s) => [s, { rec: 0, all: 0 }]));
  for (const r of rows) {
    if (!inWindow(r.at, now, days)) continue;
    const c = by.get(r.step) || by.set(r.step, { rec: 0, all: 0 }).get(r.step);
    c.all += 1;
    if (r.rec) c.rec += 1;
  }
  const rest = [...by.keys()].filter((k) => !FIXED_STEPS.includes(k) && k !== 'other').sort();
  const names = [...FIXED_STEPS, ...rest, ...(by.has('other') ? ['other'] : [])];
  return names.map((n) => [n, by.get(n).rec, by.get(n).all]);
}

/** Starts, ends, FAILs and FAILs under 1 minute in the window, the last two with a count per failing step (most first, then by name), and ERROR ends (counted in ends, never in FAIL). The by-maps have no prototype: a step named "constructor" is a key, not a function. */
export function runCounts(rows, now, days) {
  const out = { starts: 0, ends: 0, fail: 0, failBy: Object.create(null), quick: 0, quickBy: Object.create(null), error: 0 };
  for (const r of rows) {
    if (!inWindow(r.ts, now, days)) continue;
    if (r.event === 'start') { out.starts += 1; continue; }
    out.ends += 1;
    if (r.error) { out.error += 1; continue; }
    if (!r.fail) continue;
    out.fail += 1;
    out.failBy[r.failing] = (out.failBy[r.failing] || 0) + 1;
    if (r.minutes < 1) { out.quick += 1; out.quickBy[r.failing] = (out.quickBy[r.failing] || 0) + 1; }
  }
  return out;
}

const byList = (by) => {
  const items = Object.entries(by).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return items.length ? ` (${items.map(([k, v]) => `${k} ${v}`).join(', ')})` : '';
};

/** { line, fields } of the two halves. `fields` is [{ name, text }]: each printed piece with the name of the field, for the collision message. */
export function buildLine(taps, runs, days) {
  const fields = [];
  const tapText = taps
    ? taps.map(([n, rec, all]) => { fields.push({ name: 'tap step name', text: n }, { name: 'tap count', text: `${rec}/${all}` }); return `${n}: ${rec}/${all}`; }).join(' ')
    : null;
  // No number sits right after "pr " in the line: the listed-id matcher (holdout-ids.mjs CONTEXT) reads "pr 19" as PR number 19, so a count equal to
  // a listed short id would stop the line. A colon or a bracket between "pr" and the number breaks that context.
  let runText = `pre-pr (${days}d): no log`;
  if (runs) {
    const count = (name, label, n) => { fields.push({ name, text: `${label} ${n}` }); return `${label} ${n}`; };
    runText = `pre-pr (${days}d): ${count('pre-pr starts', 'starts', runs.starts)} ${count('pre-pr ends', 'ends', runs.ends)}`
      + ` ${count('pre-pr FAIL count', 'FAIL', runs.fail)}${byList(runs.failBy)} ${count('pre-pr FAIL<1min count', 'FAIL<1min', runs.quick)}${byList(runs.quickBy)} ${count('pre-pr ERROR count', 'ERROR', runs.error)}`;
    for (const k of Object.keys(runs.failBy)) fields.push({ name: 'pre-pr FAIL step name', text: k });
    for (const k of Object.keys(runs.quickBy)) fields.push({ name: 'pre-pr FAIL<1min step name', text: k });
  }
  const head = `taps (land, open-pr, review) ${days}d`;
  const line = `${head}${tapText === null ? ': no log' : ` recommended/all: ${tapText}`} | ${runText}`;
  return { line, fields };
}

export function parseArgs(argv) {
  const a = { days: 1, decisions: null, runs: null, now: null, root: null };
  const val = (i, name) => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Usage(`${name} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--days') { const n = Number(val(i, k)); if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Usage('--days is not a whole number from 1 to 3650'); a.days = n; i++; }
    else if (['--decisions', '--runs', '--now', '--root'].includes(k)) { a[k.slice(2)] = val(i, k); i++; }
    else throw new Usage(`unknown argument ${k}`);
  }
  if (a.now !== null && !Number.isFinite(Date.parse(a.now))) throw new Usage('--now is not a time');
  return a;
}

function primaryRoot() {
  try {
    return path.dirname(execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { return REPO; }
}

const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

/** The listed ids of the root: null (and a note) when the root has no list; a thrown { exit: 3 } when it cannot be read. */
function idList(root, err) {
  try { return readIdList(root); } catch (e) {
    if (e && e.kind === 'absent') { err.push(MSG_NOTE); return null; }
    throw Object.assign(new Error('list'), { exit: 3 });
  }
}

/** The names of the fields whose own text holds a listed id; "line" when only the whole line does (a hit across two pieces). */
function collided(line, fields, ids) {
  const names = [...new Set(fields.filter((f) => countListed(f.text, ids) > 0).map((f) => f.name))];
  return names.length ? names : ['line'];
}

function build(a, root, err) {
  const home = os.homedir();
  const dText = readText(a.decisions || path.join(home, '.claude', 'state', 'ccv3-mods', 'decision-log.jsonl'));
  const rText = readText(a.runs || path.join(home, '.claude', 'state', 'run-locks', 'runs.jsonl'));
  if (dText === null && rText === null) { err.push('friction-counts: no readable log'); return { code: 2 }; }
  const now = a.now ? Date.parse(a.now) : Date.now();
  const d = dText === null ? null : parseDecisions(dText);
  const r = rText === null ? null : parseRuns(rText);
  const skipped = (d ? d.skipped : 0) + (r ? r.skipped : 0);
  if (skipped) err.push(`friction-counts: skipped ${skipped} rows (not JSON or not the expected shape)`);
  const taps = d ? tapCounts(d.rows, now, a.days) : null;
  const runs = r ? runCounts(r.rows, now, a.days) : null;
  const any = (taps && taps.some(([, , all]) => all > 0)) || (runs && (runs.starts > 0 || runs.ends > 0));
  if (!any) { err.push(`friction-counts: no row in the log for the last ${a.days} days`); return { code: 2 }; }
  return { code: 0, ...buildLine(taps, runs, a.days) };
}

/** { code, out, err } of one run. Prints nothing itself: main prints. */
export async function run(argv) {
  const out = [];
  const err = [];
  let code;
  try {
    const a = parseArgs(argv);
    const root = a.root || primaryRoot();
    const ids = idList(root, err);
    const b = build(a, root, err);
    code = b.code;
    if (code === 0) {
      const hits = ids && countListed(b.line, ids) > 0 ? collided(b.line, b.fields, ids) : [];
      if (hits.length) { for (const h of hits) err.push(`friction-counts: a listed id collided with field "${h}"; no output`); code = 3; }
      else out.push(b.line);
    }
  } catch (e) {
    if (e instanceof Usage) { err.push(`friction-counts: ${e.message}`); code = 1; }
    else if (e && e.exit === 3) { err.length = 0; err.push(MSG_LIST); code = 3; }
    else { err.push('friction-counts: internal error; no output'); code = 4; }
  }
  return { code, out: out.length ? `${out.join('\n')}\n` : '', err: err.length ? `${err.join('\n')}\n` : '' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await run(process.argv.slice(2));
  process.stdout.write(r.out);
  process.stderr.write(r.err);
  process.exitCode = r.code;
}
