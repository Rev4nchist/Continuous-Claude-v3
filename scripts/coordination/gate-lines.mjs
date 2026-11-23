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
 * the last 24 hours. A wait counts for the minutes it has inside the window (cut at both ends). Bad lines are listed for the
 * WHOLE file (a bad line has no time to place it in a window), and --strict looks at the whole file too. A GATE line inside a
 * ``` code fence is an example and is skipped. An unknown flag is a usage error.
 * Exit: 0 counted; 1 a bad line with --strict; 2 usage or an unreadable file; 3 no GATE line in the window (a zero is an
 * error, never "0 words": read the count before the verdict; exit 3 lists the bad lines, if any).
 * `line` PRINTS one line and writes no file. --at and --ask take a full time or HH:mm; HH:mm is today's clock time in the local
 * offset. An HH:mm later than the clock now is refused (exit 2): it is never read as yesterday. Use a full time for another day.
 * Without --at the time is the clock now. In `count`, --from and --to keep the old rule: an HH:mm later than now is the day before.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const KINDS = ['GO', 'RULING', 'LAND-WORD', 'LAND-HOLD', 'LAND-DONE', 'RECHECK', 'NEXT-CARD'];
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;
const CLOCK_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const HEAD_RE = /^[0-9a-f]{7,40}$/i;
// A receiver is a name: an all-digit receiver (a PR number) is refused.
const TO_RE = /^(?!\d+$)[A-Za-z0-9_.#-]+$/;
// A line that starts "GATE", any white space, a four-digit year is a line to check. A double space, a tab or a no-break space
// then makes a BAD line (listed), never a silent drop.
const ATTEMPT_RE = /^GATE\s+\d{4}-/u;
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
  // A reason never echoes text of the log (a PR number could stand in a field): it names the field only.
  if (Number.isNaN(timeMs)) return { ok: false, reason: 'bad time: use ISO 8601 with an offset' };
  const field = (f, key) => (f.startsWith(`${key}=`) ? f.slice(key.length + 1) : null);
  const kind = field(kindF, 'kind');
  if (kind === null) return { ok: false, reason: 'field 2 must be kind=' };
  if (!KINDS.includes(kind)) return { ok: false, reason: `unknown kind: use ${KINDS.join(', ')}` };
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
    if (Number.isNaN(askMs)) return { ok: false, reason: 'bad ask: use ISO 8601 with an offset, or -' };
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
  let fenced = false;
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    // A line inside a ``` code fence is an example, not a word (a pasted copy of the form must not count).
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; return; }
    if (fenced || !ATTEMPT_RE.test(raw)) return;
    read++;
    const key = raw.replace(/\s+$/, '');
    const r = parseGateLine(key);
    if (!r.ok) { bad.push({ n: i + 1, reason: r.reason }); return; }
    // The duplicate key is the parsed line, so one instant written with Z and with -06:00 is one word.
    const dup = `${r.line.timeMs}|${r.line.kind}|${r.line.to}|${r.line.head}|${r.line.askMs}`;
    if (seen.has(dup)) { duplicates++; return; }
    seen.add(dup);
    lines.push(r.line);
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
  // A wait counts for the minutes it has inside the window: it is cut at BOTH ends. A word after the window end still
  // counts the minutes of its wait that fall inside the window.
  const asked = lines.filter((l) => l.askMs !== null && l.askMs < toMs && l.timeMs > fromMs);
  const spans = asked.map((l) => [Math.max(l.askMs, fromMs), Math.min(l.timeMs, toMs)]);
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
export function resolveTime(input, nowMs, offsetMin, offsetAt = () => offsetMin) {
  const s = String(input).trim();
  if (TIME_RE.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return { ms, text: s };
  } else {
    const m = CLOCK_RE.exec(s);
    if (m) {
      const clockMin = (Number(m[1]) * 60 + Number(m[2])) * MIN;
      // The clock time is read in the offset of ITS OWN instant, not today's: on a day the offset changes (a DST day), a time
      // before the change has the other offset. offsetAt(ms) is the offset in minutes at that instant (default: the one given).
      const at = (off) => Math.floor((nowMs + off * MIN) / DAY) * DAY + clockMin - off * MIN;
      let ms = at(offsetMin);
      const offAtGuess = offsetAt(ms);
      if (offAtGuess !== offsetMin) ms = at(offAtGuess);
      if (ms > nowMs) {
        ms -= DAY;
        const offBefore = offsetAt(ms);
        if (offBefore !== offAtGuess) ms = at(offBefore) - DAY;
      }
      return { ms, text: formatTime(ms, offsetAt(ms)) };
    }
  }
  throw new Error('bad time: use HH:mm or an ISO time with an offset');
}

export const resolveClock = (input, nowMs, offsetMin, offsetAt) => resolveTime(input, nowMs, offsetMin, offsetAt).ms;

/** A time as ISO 8601 minutes with the offset, e.g. 2026-11-22T18:22-06:00. */
export function formatTime(ms, offsetMin) {
  const local = new Date(ms + offsetMin * MIN).toISOString().slice(0, 16);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** A time for a GATE line: like resolveTime, but an HH:mm later than the clock is refused, never read as the day before. */
function resolveLineTime(input, nowMs, offsetMin, offsetAt) {
  const s = String(input).trim();
  const m = CLOCK_RE.exec(s);
  if (!m) return resolveTime(input, nowMs, offsetMin, offsetAt);
  // Compare the typed minutes with the clock minutes of now, both read in the offset of now. This is a plain clock compare, so
  // a DST day needs no extra rule: the skipped spring hour and the repeated fall hour are refused like any later time.
  const minuteNow = Math.floor(nowMs / MIN) * MIN;
  const localNow = new Date(minuteNow + offsetAt(minuteNow) * MIN);
  const gap = Number(m[1]) * 60 + Number(m[2]) - (localNow.getUTCHours() * 60 + localNow.getUTCMinutes());
  if (gap <= 0) return resolveTime(input, nowMs, offsetMin, offsetAt);
  const gapText = gap < 120 ? `${gap} min` : `${Math.floor(gap / 60)} h${gap % 60 ? ` ${gap % 60} min` : ''}`;
  throw new Error(`${s} is ${gapText} after the clock ${formatTime(minuteNow, offsetAt(minuteNow)).slice(11, 16)}; use a clock time, or a full ISO time for another day`);
}

/** One GATE line. Throws on a bad field, and on an HH:mm later than the clock. Prints no file and reads none. */
export function formatLine(spec, { nowMs, offsetMin, offsetAt = () => offsetMin }) {
  const kind = String(spec.kind ?? '');
  if (!KINDS.includes(kind)) throw new Error(`unknown kind "${kind.slice(0, 20)}": ${KINDS.join(', ')}`);
  const to = String(spec.to ?? '').trim().replace(/\s+/g, '_');
  if (!TO_RE.test(to)) throw new Error('bad receiver: give a session name, or all');
  const head = spec.head === undefined || spec.head === '' ? '-' : String(spec.head).toLowerCase();
  if (head !== '-' && !HEAD_RE.test(head)) throw new Error('bad head: 7 to 40 hex characters');
  const minuteNow = Math.floor(nowMs / MIN) * MIN;
  const at = spec.at ? resolveLineTime(spec.at, nowMs, offsetMin, offsetAt) : { ms: minuteNow, text: formatTime(minuteNow, offsetAt(minuteNow)) };
  let ask = '-';
  if (spec.ask && spec.ask !== '-') {
    const a = resolveLineTime(spec.ask, nowMs, offsetMin, offsetAt);
    if (a.ms > at.ms) throw new Error('the ask is after the time');
    ask = a.text;
  }
  return `GATE ${at.text} kind=${kind} to=${to} head=${head} ask=${ask}`;
}

// The flags of each command. A flag that is not on the list is a usage error (a typo must not run the default window).
const SWITCHES = { count: new Set(['json', 'strict', 'allow-empty']), line: new Set() };
const VALUE_FLAGS = { count: new Set(['file', 'since', 'from', 'to']), line: new Set(['kind', 'to', 'head', 'at', 'ask']) };

function parseArgs(argv) {
  const cmd = argv[0];
  if (!SWITCHES[cmd]) throw new Error('usage: gate-lines.mjs count|line (see the header of this file)');
  const out = { _: [cmd] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a.slice(0, 20)}"`);
    const k = a.slice(2);
    if (SWITCHES[cmd].has(k)) { out[k] = true; continue; }
    if (!VALUE_FLAGS[cmd].has(k)) throw new Error(`unknown flag --${k.slice(0, 20)} for ${cmd}`);
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

function windowOf(args, nowMs, offsetMin, offsetAt) {
  if (args.since && (args.from || args.to)) throw new Error('give --since, or --from and --to, not both');
  if (args.from || args.to) {
    const toMs = args.to ? resolveTime(args.to, nowMs, offsetMin, offsetAt).ms : nowMs;
    if (!args.from) throw new Error('--to needs --from');
    return { fromMs: resolveTime(args.from, nowMs, offsetMin, offsetAt).ms, toMs };
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
  // The offset at an instant (a DST day has two): the zone of this machine.
  const offsetAt = (ms) => -new Date(ms).getTimezoneOffset();
  const offsetMin = offsetAt(nowMs);
  if (cmd === 'line') {
    try {
      console.log(formatLine({ kind: args.kind, to: args.to, head: args.head, at: args.at, ask: args.ask }, { nowMs, offsetMin, offsetAt }));
      return 0;
    } catch (e) { return err(e.message); }
  }
  let win;
  let text;
  const file = args.file ?? defaultLog();
  try {
    win = windowOf(args, nowMs, offsetMin, offsetAt);
    if (!(win.toMs > win.fromMs)) {
      throw new Error('the window is empty: --to must be after --from (an HH:mm time is the latest such time that is not after now, so a --to later today reads as yesterday)');
    }
    text = readFileSync(file, 'utf8');
  } catch (e) { return err(e.code === 'ENOENT' ? `cannot read the log ${basename(file)}` : e.message); }
  const c = countText(text, win);
  // A zero prints no counts: "0 words" must never be read as a result. Only the error line, and exit 3. The bad lines say why.
  if (c.inWindow === 0 && !args['allow-empty']) {
    console.error(c.read === 0 ? '0 GATE lines read: no count' : `0 GATE lines in the window (${c.read} read, ${c.bad.length} bad): no count`);
    for (const b of c.bad) console.error(`bad line ${b.n}: ${b.reason}`);
    return 3;
  }
  console.log(args.json ? JSON.stringify({ log: basename(file), ...c }) : render(c, win, basename(file), offsetMin));
  return args.strict && c.bad.length > 0 ? 1 : 0;
}

// Run only as the entry file: an import (the test) must not start it. The real paths are compared, so a start through a
// junction or a symlink still runs.
function isEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}
if (isEntry()) process.exitCode = main(process.argv.slice(2));
