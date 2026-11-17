#!/usr/bin/env node
/**
 * stall-alarm-log -- an append-only log of the seat's stall alarms, and a counts-only report (card coord-seat-counts, part A).
 * Design note: .claudedocs/coordination/2026-11-16-coord-seat-counts-design.md.
 *
 * stall-watch.mjs (the seat's one runner, never edited here) keeps no history: its state file holds each alarm key and its time for 6 hours.
 * --append reads that file (read-only) and adds each new alarm to .claude/cache/stall-log/alarms.jsonl: kind, lane id or PR number, time.
 * Never a note text, never a note time, never more than 8 hex of a head. A line is written once (kind, subject, time) and never rewritten.
 * --report grades each alarm from LATER events, with no mark by the seat: a lane event (any kind but "seeded") on the lane within the window,
 * or the PR merged inside it. "none" is the no-action count. It is NOT a false-alarm count: no action can also be a stall that is still stuck.
 * Output is counts. A listed id in any output stops the run (exit 3, nothing written).
 *
 * Usage: node scripts/coordination/stall-alarm-log.mjs --append [--state <file>] [--log <file>] [--root <repo root of the id list>]
 *        node scripts/coordination/stall-alarm-log.mjs --report [--days N] [--window MIN] [--log <file>] [--now <iso>] [--root <dir>]
 *             [--events-file <json>] [--prs-file <json>]   (the two files replace the live reads: tests)
 * Live reads of --report: lane events (READ ONLY transaction, openReadOnly of export-dash-data.mjs) and `gh api` pulls of the PR alarms.
 * Exit: 0 ok | 1 usage | 2 nothing to read | 3 listed-id list unreadable or an id in the output | 4 a fact could not be read, or internal error.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { countListed, readIdList } from './board-mask.mjs';
import { connString, openReadOnly } from './export-dash-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const REPO_SLUG = 'Rev4nchist/Continuous-Claude-v3';
const MIN = 60_000;
const LANE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const MSG_LIST = 'stall-alarm-log: the listed-id list could not be read; no output';
const MSG_LEFT = 'stall-alarm-log: a listed id reached the output; no output';
const MSG_NOTE = 'stall-alarm-log: note: no listed-id list in this root; the output holds no free text';

class Usage extends Error {}

/** One state key of stall-watch.mjs -> { kind, sub, subject, head8 }, or null for a key this script does not know (never stored). */
export function parseKey(key) {
  let m = /^(ci-failed|pr-green) (\d{1,7})@([0-9a-f]{7,40})$/.exec(key);
  if (m) return { kind: m[1], sub: null, subject: m[2], head8: m[1] === 'ci-failed' ? m[3].slice(0, 8) : null };
  m = /^waits (\S+) \S+$/.exec(key);
  if (m && LANE.test(m[1])) return { kind: 'waits-on-seat', sub: null, subject: m[1], head8: null };
  m = /^start (PRE-PR|HOOK BUILD) (\S+) \S+$/.exec(key);
  if (m && LANE.test(m[2])) return { kind: 'start-no-end', sub: m[1], subject: m[2], head8: null };
  m = /^error (github|lane board)$/.exec(key);
  if (m) return { kind: 'watch-error', sub: null, subject: m[1], head8: null };
  return null;
}

/** { rows, skipped } of a stall-watch state object. */
export function rowsFromState(state) {
  const rows = [];
  let skipped = 0;
  for (const [key, at] of Object.entries((state && state.said) || {})) {
    const p = typeof at === 'number' && Number.isFinite(at) ? parseKey(key) : null;
    if (!p) { skipped++; continue; }
    rows.push({ kind: p.kind, sub: p.sub, subject: p.subject, head8: p.head8, alarmAt: at });
  }
  rows.sort((a, b) => a.alarmAt - b.alarmAt || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.subject < b.subject ? -1 : 1));
  return { rows, skipped };
}

const dedupeKey = (r) => `${r.kind}|${r.sub || ''}|${r.subject}|${r.alarmAt}`;

/**
 * The outcome of each row from later facts: facts = { events: [{ laneId, kind, at }], prs: { <number>: { mergedAt, closedAt, head8, headAt } } }.
 * acted: a fact inside (alarmAt, alarmAt + window]. open: no fact yet and the window is still running. none: the window ended with no fact.
 * na: a watch-error has no outcome.
 */
export function inferOutcomes(rows, facts, { windowMin = 30, now = Date.now() } = {}) {
  const end = (r) => r.alarmAt + windowMin * MIN;
  return rows.map((r) => {
    if (r.kind === 'watch-error') return { ...r, outcome: 'na' };
    const inWindow = (t) => Number.isFinite(t) && t > r.alarmAt && t <= end(r);
    let acted = false;
    if (r.kind === 'waits-on-seat' || r.kind === 'start-no-end') {
      acted = ((facts && facts.events) || []).some((e) => e.laneId === r.subject && e.kind !== 'seeded' && inWindow(e.at));
    } else {
      const p = ((facts && facts.prs) || {})[r.subject];
      // ci-failed: the PR closed, or a new head was pushed (its commit time headAt), inside the window.
      if (p) acted = inWindow(p.mergedAt) || (r.kind === 'ci-failed' && (inWindow(p.closedAt) || Boolean(p.head8 && r.head8 && p.head8 !== r.head8 && inWindow(p.headAt))));
    }
    return { ...r, outcome: acted ? 'acted' : now < end(r) ? 'open' : 'none' };
  });
}

const chicagoDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const cell = () => ({ rows: 0, acted: 0, none: 0, open: 0, na: 0 });

/** Counts per Chicago day and kind, and totals per kind (noAction = the "none" count). No subject and no time of day. */
export function report(rows) {
  const days = new Map();
  const totals = {};
  for (const r of rows) {
    const d = chicagoDay(r.alarmAt);
    const kinds = days.get(d) || days.set(d, {}).get(d);
    for (const bucket of [kinds[r.kind] || (kinds[r.kind] = cell()), totals[r.kind] || (totals[r.kind] = { ...cell(), noAction: 0 })]) {
      bucket.rows++;
      bucket[r.outcome]++;
    }
    if (r.outcome === 'none') totals[r.kind].noAction++;
  }
  return { days: [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, kinds]) => ({ day, kinds })), totals };
}

export function parseArgs(argv) {
  const a = { mode: null, state: null, log: null, root: null, days: 7, window: 30, now: null, eventsFile: null, prsFile: null };
  const val = (i, name) => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Usage(`${name} needs a value`); return argv[i + 1]; };
  const num = (v, name) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Usage(`${name} is not a whole number from 1 to 3650`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--append' || k === '--report') { if (a.mode) throw new Usage('use one of --append and --report'); a.mode = k.slice(2); }
    else if (['--state', '--log', '--root', '--now', '--events-file', '--prs-file'].includes(k)) { a[k.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = val(i, k); i++; }
    else if (k === '--days' || k === '--window') { a[k.slice(2)] = num(val(i, k), k); i++; }
    else throw new Usage(`unknown argument ${k}`);
  }
  if (!a.mode) throw new Usage('use --append or --report');
  if (a.now !== null && !Number.isFinite(Date.parse(a.now))) throw new Usage('--now is not a time');
  return a;
}

function primaryRoot() {
  try {
    return path.dirname(execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { return REPO; }
}

const KINDS = ['ci-failed', 'pr-green', 'waits-on-seat', 'start-no-end', 'watch-error'];
// A log line is read only when it has the exact shape this script writes: an edited or foreign line cannot put text in a report.
function validRow(r) {
  return Boolean(r) && KINDS.includes(r.kind) && Number.isFinite(r.alarmAt) && (r.sub === null || r.sub === 'PRE-PR' || r.sub === 'HOOK BUILD')
    && typeof r.subject === 'string' && (LANE.test(r.subject) || /^\d{1,7}$/.test(r.subject) || r.subject === 'github' || r.subject === 'lane board')
    && (r.head8 === null || /^[0-9a-f]{8}$/.test(String(r.head8)));
}

function readLog(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { text: null, rows: [] }; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (validRow(r)) rows.push(r); } catch { /* an odd line stays in the file and is not read */ }
  }
  return { text, rows };
}

async function liveEvents(rows) {
  const lanes = [...new Set(rows.filter((r) => r.kind === 'waits-on-seat' || r.kind === 'start-no-end').map((r) => r.subject))];
  if (!lanes.length) return [];
  const since = new Date(Math.min(...rows.map((r) => r.alarmAt)));
  const client = await openReadOnly(connString());
  try {
    const r = await client.query('SELECT lane_id, kind, occurred_at FROM agentic_os.lane_event WHERE lane_id = ANY($1) AND occurred_at >= $2', [lanes, since]);
    return r.rows.map((x) => ({ laneId: x.lane_id, kind: x.kind, at: new Date(x.occurred_at).getTime() }));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

function livePrs(rows) {
  const prs = {};
  for (const n of new Set(rows.filter((r) => r.kind === 'pr-green' || r.kind === 'ci-failed').map((r) => r.subject))) {
    const j = JSON.parse(execFileSync('gh', ['api', `repos/${REPO_SLUG}/pulls/${n}`], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }));
    const sha = String((j.head && j.head.sha) || '');
    let headAt = null;
    if (rows.some((r) => r.kind === 'ci-failed' && r.subject === n)) { // the head commit time, to see WHEN a new head came
      const c = JSON.parse(execFileSync('gh', ['api', `repos/${REPO_SLUG}/commits/${sha}`], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }));
      headAt = c.commit && c.commit.committer && c.commit.committer.date ? Date.parse(c.commit.committer.date) : null;
    }
    prs[n] = { mergedAt: j.merged_at ? Date.parse(j.merged_at) : null, closedAt: j.closed_at ? Date.parse(j.closed_at) : null, head8: sha.slice(0, 8), headAt };
  }
  return prs;
}

/** { ids } of the listed-id list: null when the root has none (a note), a thrown 'bad' when it cannot be read. */
function idList(root, err) {
  try { return readIdList(root); } catch (e) {
    if (e && e.kind === 'absent') { err.push(MSG_NOTE); return null; }
    throw Object.assign(new Error('list'), { exit: 3 });
  }
}

async function doAppend(a, root, out, err) {
  const stateFile = a.state || path.join(root, '.claudedocs', 're-execution', '.stall-watch-state.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { err.push('stall-alarm-log: no readable stall-watch state file'); return 2; }
  const logFile = a.log || path.join(root, '.claude', 'cache', 'stall-log', 'alarms.jsonl');
  const { rows, skipped } = rowsFromState(state);
  const have = readLog(logFile);
  const seen = new Set(have.rows.map(dedupeKey));
  const fresh = rows.filter((r) => !seen.has(dedupeKey(r)));
  const text = fresh.map((r) => JSON.stringify(r)).join('\n');
  const ids = idList(root, err);
  if (ids && countListed(text, ids) > 0) { err.push(MSG_LEFT); return 3; }
  if (fresh.length) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const lead = have.text && !have.text.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(logFile, `${lead}${text}\n`);
  }
  out.push(JSON.stringify({ appended: fresh.length, skipped, total: have.rows.length + fresh.length }));
  return 0;
}

async function doReport(a, root, out, err) {
  const logFile = a.log || path.join(root, '.claude', 'cache', 'stall-log', 'alarms.jsonl');
  const now = a.now ? Date.parse(a.now) : Date.now();
  const seen = new Set(); // two runs of --append at the same time can write one alarm twice: count it once
  const rows = readLog(logFile).rows.filter((r) => r.alarmAt >= now - a.days * 86_400_000 && r.alarmAt <= now && !seen.has(dedupeKey(r)) && seen.add(dedupeKey(r)));
  if (!rows.length) { err.push(`stall-alarm-log: no alarm in the log for the last ${a.days} days`); return 2; }
  let facts;
  try {
    facts = {
      events: a.eventsFile ? JSON.parse(fs.readFileSync(a.eventsFile, 'utf8')) : await liveEvents(rows),
      prs: a.prsFile ? JSON.parse(fs.readFileSync(a.prsFile, 'utf8')) : livePrs(rows),
    };
  } catch { err.push('stall-alarm-log: the lane events or the pull request facts could not be read; no output'); return 4; }
  const text = JSON.stringify({ window: { days: a.days, windowMin: a.window }, ...report(inferOutcomes(rows, facts, { windowMin: a.window, now })) }, null, 1);
  const ids = idList(root, err);
  if (ids && countListed(text, ids) > 0) { err.push(MSG_LEFT); return 3; }
  out.push(text);
  return 0;
}

/** { code, out, err } of one run. Prints nothing itself: main prints. */
export async function run(argv) {
  const out = [];
  const err = [];
  let code;
  try {
    const a = parseArgs(argv);
    const root = a.root || primaryRoot();
    code = a.mode === 'append' ? await doAppend(a, a.root ? root : primaryRoot(), out, err) : await doReport(a, root, out, err);
  } catch (e) {
    if (e instanceof Usage) { err.push(`stall-alarm-log: ${e.message}`); code = 1; }
    else if (e && e.exit === 3) { err.push(MSG_LIST); code = 3; }
    else { err.push('stall-alarm-log: internal error; no output'); code = 4; }
  }
  return { code, out: out.length ? `${out.join('\n')}\n` : '', err: err.length ? `${err.join('\n')}\n` : '' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await run(process.argv.slice(2));
  process.stdout.write(r.out);
  process.stderr.write(r.err);
  process.exitCode = r.code;
}
