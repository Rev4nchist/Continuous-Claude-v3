#!/usr/bin/env node
/**
 * ask-ledger -- one row per question to Dave, read from main session transcripts (card coord-ask-ledger, Ask Loop card 1).
 * Design note: .claudedocs/coordination/2026-11-16-coord-ask-ledger-design.md. Read-only: it writes no transcript, no rule, no memory file,
 * and sends nothing. A row holds no free text: the class is the header (model text, kept only when it fits a short pattern and holds no
 * listed id), the question is a hash, and an answer is a kind (tap, typed, open, declined) with a length. Never the question, the typed
 * text or an option label.
 *
 * Usage: node scripts/coordination/ask-ledger.mjs [--dir <transcript folder>] [--since <iso>] [--until <iso>] [--out <file>]
 *        [--cache-dir <folder>] [--root <repo root of the listed-id list>]
 * Window: a question counts when since <= askedAt < until. An open question runs to the end of its file, or to --until when that is earlier.
 * Exit: 0 ok | 1 usage | 2 no question in the window (or no transcript) | 3 the listed-id list is unreadable or an id reached the output
 *       | 4 internal error (a fixed line, no path).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { countListed, readIdList } from './board-mask.mjs';
import { percentile } from './coord-drill-2/metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const CLASS_RE = /^[A-Za-z0-9 /+:.#-]{1,40}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const RECOMMENDED = /\(Recommended\)\s*$/;
const MSG_LIST = 'ask-ledger: the listed-id list could not be read; no output';
const MSG_LEFT = 'ask-ledger: a listed id reached the output; no output';
const MSG_NOTE = 'ask-ledger: note: no listed-id list in this root; the rows hold no free text';
const MSG_INTERNAL = 'ask-ledger: internal error; no output';

class Usage extends Error {}

export function parseArgs(argv) {
  const a = { dir: null, since: null, until: null, out: null, cacheDir: null, root: null };
  const need = (i, name) => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Usage(`${name} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (['--dir', '--since', '--until', '--out', '--cache-dir', '--root'].includes(k)) { a[k.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = need(i, k); i++; }
    else throw new Usage(`unknown argument ${k}`);
  }
  for (const k of ['since', 'until']) if (a[k] !== null && !Number.isFinite(Date.parse(a[k]))) throw new Usage(`--${k} is not a time`);
  return a;
}

// The primary checkout: a worktree shares the git common dir of its primary. A failure falls back to this checkout.
function primaryRoot() {
  try {
    const common = execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.dirname(common);
  } catch { return REPO; }
}

// Claude Code names a project folder by the path with every character that is not a letter or digit turned into "-".
const slugOf = (p) => path.resolve(p).replace(/[^A-Za-z0-9]/g, '-');

// --out must end inside the cache folder by its REAL path: a ".." part or a link cannot leave it.
export function checkOut(out, cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const realCache = fs.realpathSync(cacheDir);
  const target = path.resolve(out);
  let realParent;
  try { realParent = fs.realpathSync(path.dirname(target)); } catch { throw new Usage('--out folder does not exist'); }
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const inside = norm(realParent) === norm(realCache) || norm(realParent).startsWith(norm(realCache) + path.sep);
  if (!inside) throw new Usage('--out must be inside the ask-ledger cache folder');
  try { if (fs.lstatSync(target).isSymbolicLink()) throw new Usage('--out is a link'); } catch (e) { if (e instanceof Usage) throw e; }
  return target;
}

// A repeated id (a resumed or copied file) is one question: the EARLIEST entry wins, whatever the file order.
function readTranscripts(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort(); } catch { return null; }
  const uses = new Map();
  const results = new Map();
  let badLines = 0;
  let unreadable = 0;
  for (const name of names) {
    let text;
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { unreadable++; continue; } // a file too big for one string, or no access
    const mine = [];
    let last = -Infinity;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { badLines++; continue; }
      const t = Date.parse(e && e.timestamp);
      if (!Number.isFinite(t)) continue; // valid JSON with no time (a snapshot or summary line): not a question, not a bad line
      if (t > last) last = t;
      const c = e.message && e.message.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_use' && b.name === 'AskUserQuestion') {
          const old = uses.get(b.id);
          if (old && old.t <= t) continue;
          const sid = String(e.sessionId || name.replace(/\.jsonl$/, ''));
          const u = { id: String(b.id), session: sid, t, questions: Array.isArray(b.input && b.input.questions) ? b.input.questions : [], end: null };
          uses.set(b.id, u);
          mine.push(u);
        } else if (b.type === 'tool_result') {
          const old = results.get(b.tool_use_id);
          if (old && old.t <= t) continue;
          const tur = e.toolUseResult;
          const ans = tur && typeof tur === 'object' && tur.answers && typeof tur.answers === 'object' ? tur.answers : {};
          results.set(b.tool_use_id, { t, answers: ans });
        }
      }
    }
    for (const u of mine) u.end = last;
  }
  return { names, uses, results, badLines, unreadable };
}

// A multiSelect answer joins the chosen labels with ", ", and a label can hold ", " itself. Try the longest label first and
// BACK UP when the rest cannot be split (labels "One", "One, Two", "Two, Three" and the answer "One, Two, Three" is One + "Two, Three").
function splitLabels(ans, labels) {
  const byLen = [...new Set(labels)].filter((l) => l.length).sort((x, y) => y.length - x.length);
  const memo = new Map();
  const go = (rest) => {
    if (!rest.length) return [];
    if (memo.has(rest)) return memo.get(rest);
    let found = null;
    for (const l of byLen) {
      if (rest === l) { found = [l]; break; }
      if (rest.startsWith(`${l}, `)) {
        const next = rest.slice(l.length + 2);
        if (!next.length) continue; // an answer that ends in ", " is not a list of labels
        const tail = go(next);
        if (tail) { found = [l, ...tail]; break; }
      }
    }
    memo.set(rest, found);
    return found;
  };
  return go(ans);
}

function answerOf(q, ans) {
  const labels = (Array.isArray(q.options) ? q.options : []).map((o) => String(o && o.label));
  const parts = labels.includes(ans) ? [ans] : q.multiSelect === true ? splitLabels(ans, labels) : null;
  if (parts && parts.length) return { kind: 'tap', recommended: parts.some((p) => RECOMMENDED.test(p)) };
  return { kind: 'typed', typedLen: ans.length };
}

// A number after "#" (a PR number) is replaced before the pattern runs. A header that still holds a listed id is class OTHER.
function classOf(header, ids) {
  const h = header.replace(/#\d+/g, '#N');
  if (!CLASS_RE.test(h)) return 'OTHER';
  return ids && ids.length && countListed(h, ids) > 0 ? 'OTHER' : h;
}

const clean = (s) => (ID_RE.test(s) ? s : 'unknown');
const tenth = (ms) => Math.round(ms / 100) / 10;

export function buildRows(parsed, { since = -Infinity, until = Infinity, ids = null } = {}) {
  const rows = [];
  for (const u of parsed.uses.values()) {
    if (u.t < since || u.t >= until) continue;
    const res = parsed.results.get(u.id);
    u.questions.forEach((q, qIndex) => {
      if (!q || typeof q !== 'object') return;
      const text = String(q.question);
      const opts = Array.isArray(q.options) ? q.options : [];
      const row = {
        session: clean(u.session), toolUseId: clean(u.id), qIndex, class: classOf(String(q.header || ''), ids),
        qHash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12),
        optionCount: opts.length, multiSelect: q.multiSelect === true, hasRecommended: opts.some((o) => RECOMMENDED.test(String(o && o.label))),
        askedAt: u.t, answeredAt: null, waitSec: null, answerKind: 'open', recommendedTaken: null, typedLen: null,
      };
      if (res) {
        row.answeredAt = res.t;
        row.waitSec = tenth(res.t - u.t);
        const ans = Object.prototype.hasOwnProperty.call(res.answers, text) ? res.answers[text] : undefined;
        if (typeof ans !== 'string') row.answerKind = 'declined';
        else {
          const a = answerOf(q, ans);
          row.answerKind = a.kind;
          if (a.kind === 'tap') row.recommendedTaken = a.recommended;
          else row.typedLen = a.typedLen;
        }
      } else {
        row.waitSec = tenth(Math.min(until, u.end) - u.t); // like metric7: an open wait stops at the end of the data
      }
      rows.push(row);
    });
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  rows.sort((a, b) => a.askedAt - b.askedAt || cmp(a.session, b.session) || cmp(a.toolUseId, b.toolUseId) || a.qIndex - b.qIndex);
  return rows;
}

const share = (n, d) => (d ? n / d : null);

export function byClass(rows) {
  const out = {};
  for (const name of [...new Set(rows.map((r) => r.class))].sort()) {
    const r = rows.filter((x) => x.class === name);
    const taps = r.filter((x) => x.answerKind === 'tap');
    const typed = r.filter((x) => x.answerKind === 'typed');
    const waits = r.filter((x) => x.answerKind !== 'open').map((x) => x.waitSec);
    out[name] = {
      count: r.length, open: r.filter((x) => x.answerKind === 'open').length,
      waitP50Sec: percentile(waits, 0.5), waitP90Sec: percentile(waits, 0.9), waitsOver300: r.filter((x) => x.waitSec > 300).length,
      typedShare: share(typed.length, taps.length + typed.length),
      recommendedTakenShare: share(taps.filter((x) => x.recommendedTaken === true).length, taps.length),
    };
  }
  return out;
}

function run(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { process.stderr.write(`ask-ledger: ${e.message}\n`); return 1; }
  const primary = primaryRoot();
  const root = a.root || primary;
  const dir = a.dir || path.join(os.homedir(), '.claude', 'projects', slugOf(primary));
  let outFile = null;
  try { if (a.out) outFile = checkOut(a.out, a.cacheDir || path.join(primary, '.claude', 'cache', 'ask-ledger')); } catch (e) {
    if (!(e instanceof Usage)) throw e;
    process.stderr.write(`ask-ledger: ${e.message}\n`);
    return 1;
  }
  let ids = null;
  try { ids = readIdList(root); } catch (e) {
    if (e && e.kind === 'absent') process.stderr.write(`${MSG_NOTE}\n`);
    else { process.stderr.write(`${MSG_LIST}\n`); return 3; }
  }
  const parsed = readTranscripts(dir);
  const rows = parsed ? buildRows(parsed, { since: a.since ? Date.parse(a.since) : -Infinity, until: a.until ? Date.parse(a.until) : Infinity, ids }) : [];
  if (!rows.length) {
    process.stderr.write(`ask-ledger: no question in ${dir.replace(/\\/g, '/')} for the window since=${a.since || '-'} until=${a.until || '-'}${parsed ? '' : ' (folder unreadable)'}\n`);
    return 2;
  }
  const text = JSON.stringify({ window: { since: a.since, until: a.until }, files: parsed.names.length, unreadable: parsed.unreadable, badLines: parsed.badLines, rows, byClass: byClass(rows) }, null, 1) + '\n';
  if (ids && countListed(text, ids) > 0) { process.stderr.write(`${MSG_LEFT}\n`); return 3; }
  if (outFile) fs.writeFileSync(outFile, text);
  process.stdout.write(text);
  return 0;
}

// A thrown error would print a stack with full paths: print one fixed line instead.
export function main(argv) {
  try { return run(argv); } catch { process.stderr.write(`${MSG_INTERNAL}\n`); return 4; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
