#!/usr/bin/env node
/**
 * gate-lines: count the seat words and the waits the seat caused, from GATE lines (card coord-seat-gate-line).
 *
 * THE FORM (the one source; the seat writes one line for each seat word, in the seat log, next to the prose bullet):
 *
 *   GATE <time> kind=<KIND> to=<receiver> head=<sha|-> ask=<time|->
 *   GATE 2026-11-22T18:22-06:00 kind=LAND-WORD to=Coord_hooks head=c40558c4 ask=2026-11-22T18:08-06:00
 *
 *   time     ISO 8601 with an offset (Z or +hh:mm), minutes or seconds. Read as an instant.
 *   kind     GO, RULING, LAND-WORD, LAND-HOLD, LAND-DONE, RECHECK or NEXT-CARD.
 *   to       the receiver: the session name with spaces as "_" (Coord_hooks), or "all" for a broadcast.
 *   head     7 to 40 hex characters of the head the word is about, or "-" when there is none.
 *   ask      the time the builder's request ARRIVED in the seat's inbox (not when the seat began to read it), or "-" when the
 *            word answers no request (a HOLD broadcast, a DONE, a card word). A wait is ask to time.
 *
 * Rules. One line at column 0 for each word, never inside a bullet. Fields in this order, one space between them. No PR number
 * and no lane id in the line. A word with no line is not counted: `count` prints how many lines it read. A line that starts
 * with "GATE " and a four-digit year is a line to count; any other "GATE ..." text is prose and is ignored.
 *
 *   node scripts/coordination/gate-lines.mjs count [--file <log>] [--since 200m | --from <time> --to <time>] [--json]
 *                                                  [--strict] [--allow-empty]
 *   node scripts/coordination/gate-lines.mjs line --kind K --to R [--head H] [--ask T] [--at T]
 *
 * `count` reads the log and never writes it. The default log is the seat log in the primary checkout. The default window is
 * the last 24 hours. Exit: 0 counted; 1 a bad line with --strict; 2 usage or an unreadable file; 3 no GATE line in the window
 * (a zero is an error, never "0 words": read the count before the verdict).
 * `line` PRINTS one line and writes no file. --at and --ask take a full time or HH:mm; HH:mm is the latest such clock time
 * that is not after now, in the local offset. Without --at the time is the clock now.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const KINDS = ['GO', 'RULING', 'LAND-WORD', 'LAND-HOLD', 'LAND-DONE', 'RECHECK', 'NEXT-CARD'];
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;
const CLOCK_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const HEAD_RE = /^[0-9a-f]{7,40}$/i;
const TO_RE = /^[A-Za-z0-9_.#-]+$/;
const ATTEMPT_RE = /^GATE \d{4}-/;
const MIN = 60_000;
const DAY = 86_400_000;
const round1 = (n) => Math.round(n * 10) / 10;

/** { ok: true, line } or { ok: false, reason } for one line that starts with "GATE ". */
export function parseGateLine(text) {
  const tokens = String(text).replace(/\s+$/, '').split(' ');
  if (tokens[0] !== 'GATE') return { ok: false, reason: 'does not start with GATE' };
  if (tokens.length !== 6) return { ok: false, reason: `expected 6 fields, found ${tokens.length}` };
  const [, time, kindF, toF, headF, askF] = tokens;
  const timeMs = TIME_RE.test(time) ? Date.parse(time) : NaN;
  if (Number.isNaN(timeMs)) return { ok: false, reason: `bad time "${time.slice(0, 30)}": use ISO 8601 with an offset` };
  const field = (f, key) => (f.startsWith(`${key}=`) ? f.slice(key.length + 1) : null);
  const kind = field(kindF, 'kind');
  if (kind === null) return { ok: false, reason: 'field 2 must be kind=' };
  if (!KINDS.includes(kind)) return { ok: false, reason: `unknown kind "${kind.slice(0, 20)}"` };
  const to = field(toF, 'to');
  if (to === null) return { ok: false, reason: 'field 3 must be to=' };
  if (!TO_RE.test(to)) return { ok: false, reason: 'bad receiver: letters, digits and _ . # - only' };
  const head = field(headF, 'head');
  if (head === null) return { ok: false, reason: 'field 4 must be head=' };
  if (head !== '-' && !HEAD_RE.test(head)) return { ok: false, reason: 'bad head: 7 to 40 hex characters or -' };
  const ask = field(askF, 'ask');
  if (ask === null) return { ok: false, reason: 'field 5 must be ask=' };
  let askMs = null;
  if (ask !== '-') {
    askMs = TIME_RE.test(ask) ? Date.parse(ask) : NaN;
    if (Number.isNaN(askMs)) return { ok: false, reason: `bad ask "${ask.slice(0, 30)}": use ISO 8601 with an offset or -` };
    if (askMs > timeMs) return { ok: false, reason: 'ask is after the time' };
  }
  return { ok: true, line: { timeMs, kind, to, head: head === '-' ? '-' : head.toLowerCase(), askMs } };
}

/** The GATE lines of a log text: { lines, bad: [{ n, reason }], duplicates, read }. Exact duplicates count once. */
export function readGateLines(text) {
  const lines = [];
  const bad = [];
  const seen = new Set();
  let duplicates = 0;
  let read = 0;
  String(text).split(/\r?\n/).forEach((raw, i) => {
    if (!ATTEMPT_RE.test(raw)) return;
    read++;
    const key = raw.replace(/\s+$/, '');
    if (seen.has(key)) { duplicates++; return; }
    seen.add(key);
    const r = parseGateLine(key);
    if (r.ok) lines.push(r.line); else bad.push({ n: i + 1, reason: r.reason });
  });
  return { lines, bad, duplicates, read };
}

/** Total minutes covered by a set of [start, end] intervals (ms), overlaps counted once. */
function unionMinutes(intervals) {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = null;
  let curE = null;
  for (const [s, e] of sorted) {
    if (curE === null || s > curE) {
      if (curE !== null) total += curE - curS;
      curS = s;
      curE = e;
    } else if (e > curE) curE = e;
  }
  if (curE !== null) total += curE - curS;
  return total / MIN;
}

/** The counts of a log text in the window [fromMs, toMs]. */
export function countText(text, { fromMs, toMs }) {
  const { lines, bad, duplicates, read } = readGateLines(text);
  const inWin = lines.filter((l) => l.timeMs >= fromMs && l.timeMs <= toMs);
  const windowMin = (toMs - fromMs) / MIN;
  const hours = windowMin / 60;
  const byKind = {};
  for (const l of inWin) byKind[l.kind] = (byKind[l.kind] ?? 0) + 1;
  const withoutNextCard = inWin.filter((l) => l.kind !== 'NEXT-CARD').length;
  const asked = inWin.filter((l) => l.askMs !== null);
  // An ask before the window starts is cut at the window start: only the minutes inside the window count.
  const spans = asked.map((l) => [Math.max(l.askMs, fromMs), l.timeMs]);
  const sumMin = spans.reduce((a, [s, e]) => a + Math.max(0, e - s) / MIN, 0);
  const unionMin = unionMinutes(spans);
  return {
    read,
    bad,
    duplicates,
    inWindow: inWin.length,
    windowMin: round1(windowMin),
    perHour: hours > 0 ? round1(inWin.length / hours) : 0,
    withoutNextCard,
    perHourWithoutNextCard: hours > 0 ? round1(withoutNextCard / hours) : 0,
    byKind,
    waits: {
      count: asked.length,
      sumMin: round1(sumMin),
      unionMin: round1(unionMin),
      per112: windowMin > 0 ? round1((unionMin * 112) / windowMin) : 0,
    },
  };
}

/** { ms, text } of a full time (kept as written) or an HH:mm clock time (the latest one not after now, in the offset). */
export function resolveTime(input, nowMs, offsetMin) {
  const s = String(input).trim();
  if (TIME_RE.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return { ms, text: s };
  } else {
    const m = CLOCK_RE.exec(s);
    if (m) {
      const localNow = nowMs + offsetMin * MIN;
      const dayStart = Math.floor(localNow / DAY) * DAY;
      let ms = dayStart + (Number(m[1]) * 60 + Number(m[2])) * MIN - offsetMin * MIN;
      if (ms > nowMs) ms -= DAY;
      return { ms, text: formatTime(ms, offsetMin) };
    }
  }
  throw new Error(`bad time "${s.slice(0, 30)}": use HH:mm or an ISO time with an offset`);
}

export const resolveClock = (input, nowMs, offsetMin) => resolveTime(input, nowMs, offsetMin).ms;

/** A time as ISO 8601 minutes with the offset, e.g. 2026-11-22T18:22-06:00. */
export function formatTime(ms, offsetMin) {
  const local = new Date(ms + offsetMin * MIN).toISOString().slice(0, 16);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** One GATE line. Throws on a bad field. Prints no file and reads none. */
export function formatLine(spec, { nowMs, offsetMin }) {
  const kind = String(spec.kind ?? '');
  if (!KINDS.includes(kind)) throw new Error(`unknown kind "${kind.slice(0, 20)}": ${KINDS.join(', ')}`);
  const to = String(spec.to ?? '').trim().replace(/\s+/g, '_');
  if (!TO_RE.test(to)) throw new Error('bad receiver: give a session name, or all');
  const head = spec.head === undefined || spec.head === '' ? '-' : String(spec.head).toLowerCase();
  if (head !== '-' && !HEAD_RE.test(head)) throw new Error('bad head: 7 to 40 hex characters');
  const minuteNow = Math.floor(nowMs / MIN) * MIN;
  const at = spec.at ? resolveTime(spec.at, nowMs, offsetMin) : { ms: minuteNow, text: formatTime(minuteNow, offsetMin) };
  let ask = '-';
  if (spec.ask && spec.ask !== '-') {
    const a = resolveTime(spec.ask, nowMs, offsetMin);
    if (a.ms > at.ms) throw new Error('the ask is after the time');
    ask = a.text;
  }
  return `GATE ${at.text} kind=${kind} to=${to} head=${head} ask=${ask}`;
}

function parseArgs(argv) {
  const out = { _: [] };
  const flags = new Set(['json', 'strict', 'allow-empty']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (flags.has(k)) { out[k] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`--${k} needs a value`);
    out[k] = v;
    i++;
  }
  return out;
}

/** The seat log of the primary checkout (the log is in .claudedocs, which a worktree does not hold). */
function defaultLog() {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', windowsHide: true });
  const common = r.status === 0 ? r.stdout.trim().replace(/\\/g, '/') : '';
  const top = common ? common.replace(/\/\.git\/?$/, '') : process.cwd();
  return join(top, '.claudedocs', 'coordination', 'milestones', 're-program.md');
}

function sinceMs(text) {
  const m = /^(\d+)([mhd])$/.exec(text);
  if (!m) throw new Error(`bad --since "${text.slice(0, 20)}": use 90m, 3h or 2d`);
  return Number(m[1]) * { m: MIN, h: 60 * MIN, d: DAY }[m[2]];
}

function windowOf(args, nowMs, offsetMin) {
  if (args.since && (args.from || args.to)) throw new Error('give --since, or --from and --to, not both');
  if (args.from || args.to) {
    const toMs = args.to ? resolveTime(args.to, nowMs, offsetMin).ms : nowMs;
    if (!args.from) throw new Error('--to needs --from');
    return { fromMs: resolveTime(args.from, nowMs, offsetMin).ms, toMs };
  }
  return { fromMs: nowMs - sinceMs(args.since ?? '24h'), toMs: nowMs };
}

function render(c, win, file, offsetMin) {
  const kinds = Object.entries(c.byKind).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  const out = [
    `log: ${file}`,
    `GATE lines: read ${c.read} (bad ${c.bad.length}, duplicates dropped ${c.duplicates}), in the window ${c.inWindow}`,
    `window: ${formatTime(win.fromMs, offsetMin)} to ${formatTime(win.toMs, offsetMin)} (${c.windowMin} min)`,
    `words: ${c.inWindow} (${c.perHour} an hour); without NEXT-CARD: ${c.withoutNextCard} (${c.perHourWithoutNextCard} an hour)`,
    `by kind: ${kinds}`,
    `waits: ${c.waits.count} words with an ask; sum ${c.waits.sumMin} min; union ${c.waits.unionMin} min; union per 112 min: ${c.waits.per112}`,
  ];
  for (const b of c.bad) out.push(`bad line ${b.n}: ${b.reason}`);
  return out.join('\n');
}

function main(argv) {
  const err = (m) => { console.error(`gate-lines: ${m}`); return 2; };
  let args;
  try { args = parseArgs(argv); } catch (e) { return err(e.message); }
  const cmd = args._[0];
  const nowMs = Date.now();
  const offsetMin = -new Date(nowMs).getTimezoneOffset();
  if (cmd === 'line') {
    try {
      console.log(formatLine({ kind: args.kind, to: args.to, head: args.head, at: args.at, ask: args.ask }, { nowMs, offsetMin }));
      return 0;
    } catch (e) { return err(e.message); }
  }
  if (cmd !== 'count') return err('usage: gate-lines.mjs count|line (see the header of this file)');
  let win;
  let text;
  const file = args.file ?? defaultLog();
  try {
    win = windowOf(args, nowMs, offsetMin);
    if (!(win.toMs > win.fromMs)) throw new Error('the window is empty: --to must be after --from');
    text = readFileSync(file, 'utf8');
  } catch (e) { return err(e.code === 'ENOENT' ? `cannot read the log ${basename(file)}` : e.message); }
  const c = countText(text, win);
  // A zero prints no counts: "0 words" must never be read as a result. Only the error line, and exit 3.
  if (c.inWindow === 0 && !args['allow-empty']) {
    console.error(c.read === 0 ? '0 GATE lines read: no count' : `0 GATE lines in the window (${c.read} read): no count`);
    return 3;
  }
  console.log(args.json ? JSON.stringify({ log: basename(file), ...c }) : render(c, win, basename(file), offsetMin));
  return args.strict && c.bad.length > 0 ? 1 : 0;
}

// Run only as the entry file: an import (the test) must not start it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
