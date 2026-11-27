#!/usr/bin/env node
/**
 * send-word.mjs -- card coord-clock-send. A seat or builder word with a time that comes from a clock read, never from typing.
 *
 * Usage: node scripts/coordination/send-word.mjs --file <text> --to <name> [--to <name2> ...] --lane <lane id> [--log <milestone file>] [--no-time] [--allow-typed]
 *
 *   --file         a text file with the token TIME (HH:MM and zone, e.g. "14:06 CST") and optionally TIME_S (HH:MM:SS and zone).
 *   --to           a receiver, one or more. Each gets one `lane.mjs say "<text>" --to <name> --lane <lane>` call.
 *   --lane         your lane id, passed to every say call.
 *   --log          a milestone file. One line is appended after the sends, never after a stop.
 *   --no-time      allow a text with no TIME token.
 *   --allow-typed  allow a typed clock time (HH:MM) in the text, for a time read from a source (a GitHub merge time). The log line records the flag.
 *
 * Order: refuse a text with no token (exit 2), refuse a typed clock time (exit 2), read the clock ONCE, fill every token from that one reading,
 * scan the filled text with scan-listed.mjs on stdin (exit 0 is the only pass; anything else stops: exit 1, nothing sent, no log, no text printed),
 * send one say call per receiver, append the log line, print the marker line and the filled text whole as the LAST output.
 * Status and errors go to stderr, before the text. The SendMessage copy is pasted from the block after the marker, never typed.
 *
 * Exit 0 sent. Exit 1 the scan stopped the send, or a say failed or is UNCONFIRMED, or the log write failed after the sends (the receivers or the log
 * error are named on stderr; the scanned text is still printed). UNCONFIRMED: the say exited 1 (lane.mjs M4.1 "not confirmed") or timed out; the DM may
 * already be on the board, so check it before you resend. FAILED: the say could not start or exited with another code.
 * Exit 2 a refusal: wrong flags, a missing file, no TIME token, a typed clock time, a text that starts with two hyphens, a say command line over 32000
 * UTF-16 units as Windows quotes it (the margin under the 32767 limit is 767).
 *
 * Test seams, read ONLY when SEND_WORD_ALLOW_ENV is exactly "1" (a stray variable in a real shell does nothing):
 *   SEND_WORD_NOW_SEQ   a file with one ISO instant per line; each clock read consumes the first line.
 *   SEND_WORD_LANE_CLI  a script that stands in for lane.mjs.
 *   SEND_WORD_SCAN_CLI  a script that stands in for scan-listed.mjs.
 *   SEND_WORD_SAY_TIMEOUT_MS  a shorter say timeout in ms (default 60000).
 *
 * It never edits lane.mjs or scan-listed.mjs: both run as child processes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MARKER = '=== SEND-WORD TEXT (copy this into SendMessage, nothing else) ===';
const ZONE = 'America/Chicago';
// One Windows command line holds 32767 UTF-16 units. The limit here is 32000: a margin of 767 units for what the count cannot see (the shell,
// the environment is separate, the quoting of a name with a space is counted but a future flag is not). The text is one argument of the say call.
// The count is the command line as Windows quoting writes it (card coord-followups-1127): each quote gets a backslash, a run of backslashes before
// a quote doubles, the argument is wrapped in quotes. Raw bytes are the wrong unit: 17000 quotes are 17 KB and 34000 units.
export const MAX_COMMAND_UNITS = 32000;
const SAY_TIMEOUT_MS = 60000;
const TYPED_TIME = /(?<!\d)\d{1,2}:\d{2}(?!\d)/;

const USAGE = 'usage: node scripts/coordination/send-word.mjs --file <text> --to <name> [--to <name2> ...] --lane <lane> [--log <file>] [--no-time] [--allow-typed]';

class Refusal extends Error {}

const seamsOn = (env) => env.SEND_WORD_ALLOW_ENV === '1';

/** The one clock read. The sequence seam consumes one line per read. */
export function readClock(env = process.env) {
  const seq = seamsOn(env) ? env.SEND_WORD_NOW_SEQ : '';
  if (!seq) return new Date();
  const lines = fs.readFileSync(seq, 'utf8').split('\n').filter(Boolean);
  if (lines.length === 0) throw new Refusal('send-word: the clock sequence is empty');
  fs.writeFileSync(seq, lines.length > 1 ? `${lines.slice(1).join('\n')}\n` : '');
  const d = new Date(lines[0]);
  if (Number.isNaN(d.getTime())) throw new Refusal('send-word: the clock sequence holds a bad instant');
  return d;
}

export const laneCliPath = (env = process.env) =>
  (seamsOn(env) && env.SEND_WORD_LANE_CLI) || path.join(os.homedir(), '.claude', 'scripts', 'lane.mjs');
export const scanCliPath = (env = process.env) =>
  (seamsOn(env) && env.SEND_WORD_SCAN_CLI) || path.join(HERE, 'scan-listed.mjs');

/** The say timeout in ms. A test seam shortens it, read only when SEND_WORD_ALLOW_ENV is "1". */
export function sayTimeoutMs(env = process.env) {
  const n = Number(seamsOn(env) ? env.SEND_WORD_SAY_TIMEOUT_MS : '');
  return Number.isInteger(n) && n > 0 ? n : SAY_TIMEOUT_MS;
}

/** UTF-16 units one argument takes on a Windows command line, quoted as Node and libuv quote it. */
export function escapedUnits(arg) {
  const s = String(arg);
  if (s !== '' && !/[\s"]/.test(s)) return s.length;
  let units = 2; // the wrapping quotes
  let slashes = 0;
  for (const ch of s) {
    if (ch === '\\') { slashes += 1; continue; }
    if (ch === '"') units += slashes * 2 + 2; // the run doubles, the quote gets its own backslash, then the quote
    else units += slashes;
    if (ch !== '"') units += ch.length;
    slashes = 0;
  }
  return units + slashes * 2; // a run before the closing quote doubles
}

/** The whole say command line: node, lane.mjs, say, the text, --to <longest name>, --lane <lane>, with the spaces between. */
export function commandUnits(text, names, lane, env = process.env) {
  const longest = names.reduce((a, b) => (b.length > a.length ? b : a), '');
  const parts = [process.execPath, laneCliPath(env), 'say', text, '--to', longest, '--lane', lane];
  return parts.reduce((n, p) => n + escapedUnits(p), 0) + parts.length - 1;
}

/** Chicago wall time of one instant: date, HH:MM, HH:MM:SS and the zone label (CST or CDT). */
export function chicago(d) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  const hm = `${parts.hour}:${parts.minute}`;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hm, hms: `${hm}:${parts.second}`, zone: parts.timeZoneName };
}

export function fillTokens(text, d) {
  const c = chicago(d);
  return text.replace(/\bTIME_S\b/g, `${c.hms} ${c.zone}`).replace(/\bTIME\b/g, `${c.hm} ${c.zone}`);
}

function parseArgs(argv) {
  const a = { file: null, to: [], lane: null, log: null, noTime: false, allowTyped: false };
  const value = (i) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Refusal(USAGE);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--file') a.file = value(i++);
    else if (k === '--to') a.to.push(value(i++));
    else if (k === '--lane') a.lane = value(i++);
    else if (k === '--log') a.log = value(i++);
    else if (k === '--no-time') a.noTime = true;
    else if (k === '--allow-typed') a.allowTyped = true;
    else throw new Refusal(USAGE);
  }
  if (!a.file || a.to.length === 0 || !a.lane) throw new Refusal(USAGE);
  return a;
}

/** The first words of the text, cut at a space so no number is split. */
function snippet(text) {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= 80) return one;
  const cut = one.slice(0, 80);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 1));
}

function scanAllows(filled, env) {
  const r = spawnSync(process.execPath, [scanCliPath(env), '-'], { input: filled, encoding: 'utf8', timeout: 60000 });
  return { ok: r.status === 0, status: r.error ? 'could not start' : `exit ${r.status}` };
}

/**
 * One say call. 'sent', 'unconfirmed' or 'failed'. lane.mjs (M4.1) exits 1 with "not confirmed" when its insert failed, and the DM may already be on the
 * board. A timeout is the same: the insert may have run. Only a spawn that could not start, or an exit other than 1, is a plain failure.
 */
function say(name, lane, text, env) {
  const r = spawnSync(process.execPath, [laneCliPath(env), 'say', text, '--to', name, '--lane', lane], { encoding: 'utf8', timeout: sayTimeoutMs(env) });
  if (r.error) return r.error.code === 'ETIMEDOUT' ? 'unconfirmed' : 'failed';
  if (r.status === 0) return 'sent';
  return r.status === 1 ? 'unconfirmed' : 'failed';
}

export function main(argv, env = process.env, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  try {
    const a = parseArgs(argv);
    let raw;
    try { raw = fs.readFileSync(a.file, 'utf8'); } catch { throw new Refusal(`send-word: cannot read ${a.file}`); }
    const template = raw.replace(/\n+$/, '');
    if (!a.noTime && !/\bTIME(_S)?\b/.test(template)) throw new Refusal('send-word: no TIME token in the text (add TIME, or pass --no-time)');
    if (!a.allowTyped && TYPED_TIME.test(template)) throw new Refusal('send-word: a typed clock time is in the text: use TIME, or pass --allow-typed for a time read from a source');

    const now = readClock(env);
    const filled = fillTokens(template, now);
    const units = commandUnits(filled, a.to, a.lane, env);
    if (units > MAX_COMMAND_UNITS) throw new Refusal(`send-word: the say command line would be ${units} units, over ${MAX_COMMAND_UNITS} (one Windows command line holds 32767, quotes and backslashes count extra): shorten the text`);

    // A text that starts with two hyphens would be the first word after `say` and could read as a flag.
    if (filled.startsWith('--')) throw new Refusal('send-word: the text starts with two hyphens (the say command could read it as a flag): change the first words');

    const scan = scanAllows(filled, env);
    if (!scan.ok) {
      io.err(`send-word: the scan stopped the send (${scan.status}): nothing sent, no log line, no text printed\n`);
      return 1;
    }

    const sent = [];
    const failed = [];
    const unconfirmed = [];
    for (const name of a.to) {
      const result = say(name, a.lane, filled, env);
      (result === 'sent' ? sent : result === 'unconfirmed' ? unconfirmed : failed).push(name);
    }

    // The sends are done. A log write that fails must not lose their result: name the error, still print the text, exit 1.
    let logError = null;
    if (a.log) {
      try {
        const c = chicago(now);
        const line = `- ${c.date} ${c.hm} ${c.zone} send-word to ${a.to.join(', ')} lane ${a.lane}: ${snippet(filled)}`
          + `${a.allowTyped ? ' [typed-time allowed]' : ''}${failed.length ? ` FAILED: ${failed.join(', ')}` : ''}`
          + `${unconfirmed.length ? ` UNCONFIRMED: ${unconfirmed.join(', ')}` : ''}`;
        fs.mkdirSync(path.dirname(path.resolve(a.log)), { recursive: true });
        fs.appendFileSync(a.log, `\n${line}\n`);
      } catch (err) { logError = err.message; }
    }

    const sentText = sent.length ? sent.join(', ') : 'nobody';
    if (failed.length) io.err(`send-word: say failed for ${failed.join(', ')}; sent to ${sentText}\n`);
    if (unconfirmed.length) io.err(`send-word: say unconfirmed for ${unconfirmed.join(', ')}: it may already be on the board, so check the board before you resend; sent to ${sentText}\n`);
    if (!failed.length && !unconfirmed.length) io.err(`send-word: sent to ${sent.join(', ')}\n`);
    if (logError) io.err(`send-word: the log line was NOT written (${logError}); the sends above are done\n`);
    io.out(`${MARKER}\n${filled}\n`);
    return failed.length || unconfirmed.length || logError ? 1 : 0;
  } catch (err) {
    if (!(err instanceof Refusal)) { io.err(`send-word: internal error: ${err.message}\n`); return 1; }
    io.err(`${err.message}\n`);
    return 2;
  }
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) process.exitCode = main(process.argv.slice(2));
