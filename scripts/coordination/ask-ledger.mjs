#!/usr/bin/env node
/**
 * ask-ledger -- one row per question to Dave, read from main session transcripts (card coord-ask-ledger, Ask Loop card 1).
 * Design note: .claudedocs/coordination/2026-11-16-coord-ask-ledger-design.md. Read-only: it writes no transcript, no rule, no memory file,
 * and sends nothing. A row holds no free text: the class is the header (model text, kept only when it fits a short pattern), the question is a
 * hash, and an answer is a kind (tap, typed, open, declined) with a length. Never the question, the typed text or an option label.
 *
 * Usage: node scripts/coordination/ask-ledger.mjs [--dir <transcript folder>] [--since <iso>] [--until <iso>] [--out <file>]
 *        [--cache-dir <folder>] [--root <repo root of the listed-id list>] [--no-id-list]
 * Exit: 0 ok | 1 usage | 2 no question in the window (or no transcript) | 3 the listed-id list is unreadable or an id reached the output.
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
// A number after "#" (a PR number) is replaced before the pattern runs: a class then holds no id.
const classOf = (header) => { const h = header.replace(/#\d+/g, '#N'); return CLASS_RE.test(h) ? h : 'OTHER'; };
const RECOMMENDED = /\(Recommended\)\s*$/;
const MSG_LIST = 'ask-ledger: the listed-id list could not be read; no output';
const MSG_LEFT = 'ask-ledger: a listed id reached the output; no output';
const MSG_NOTE = 'ask-ledger: note: no listed-id list in this root; the rows hold no free text';

class Usage extends Error {}

export function parseArgs(argv) {
  const a = { dir: null, since: null, until: null, out: null, cacheDir: null, root: null, idList: true };
  const need = (i, name) => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Usage(`${name} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--no-id-list') a.idList = false;
    else if (['--dir', '--since', '--until', '--out', '--cache-dir', '--root'].includes(k)) { a[k.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = need(i, k); i++; }
    else throw new Usage(`unknown argument ${k}`);
  }
  for (const k of ['since', 'until']) if (a[k] !== null && !Number.isFinite(Date.parse(a[k]))) throw new Usage(`--${k} is not a time`);
  return a;
}

// The primary checkout: a worktree shares the git common dir of its primary. A failure falls back to this checkout.
function primaryRoot() {
  try {
    const common = execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    return path.dirname(common);
  } catch { return REPO; }
}

const slugOf = (p) => path.resolve(p).replace(/[:\\/]/g, '-');

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

function readTranscripts(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort(); } catch { return null; }
  const uses = new Map();
  const results = new Map();
  let badLines = 0;
  for (const name of names) {
    const mine = [];
    let last = -Infinity;
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
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
        // A repeated id (a resumed or copied file) is one question: the EARLIEST entry wins, whatever the file order.
        if (b.type === 'tool_use' && b.name === 'AskUserQuestion') {
          const old = uses.get(b.id);
          if (old && old.t <= t) continue;
          const u = { id: b.id, session: String(e.sessionId || name.replace(/\.jsonl$/, '')), t, questions: Array.isArray(b.input && b.input.questions) ? b.input.questions : [], end: null };
          uses.set(b.id, u);
          mine.push(u);
        } else if (b.type === 'tool_result') {
          const old = results.get(b.tool_use_id);
          if (old && old.t <= t) continue;
          const ans = e.toolUseResult && typeof e.toolUseResult.answers === 'object' && e.toolUseResult.answers ? e.toolUseResult.answers : {};
          results.set(b.tool_use_id, { t, answers: ans });
        }
      }
    }
    for (const u of mine) u.end = last;
  }
  return { names, uses, results, badLines };
}

function answerOf(q, ans) {
  const labels = (Array.isArray(q.options) ? q.options : []).map((o) => String(o && o.label));
  const parts = q.multiSelect === true ? ans.split(', ') : [ans];
  if (parts.every((p) => labels.includes(p))) return { kind: 'tap', recommended: parts.some((p) => RECOMMENDED.test(p)) };
  return { kind: 'typed', typedLen: ans.length };
}

export function buildRows(parsed, { since = -Infinity, until = Infinity } = {}) {
  const rows = [];
  for (const u of parsed.uses.values()) {
    if (u.t < since || u.t >= until) continue;
    const res = parsed.results.get(u.id);
    u.questions.forEach((q, qIndex) => {
      const text = String(q && q.question);
      const header = String((q && q.header) || '');
      const opts = Array.isArray(q && q.options) ? q.options : [];
      const row = {
        session: u.session, toolUseId: u.id, qIndex, class: classOf(header),
        qHash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12),
        optionCount: opts.length, multiSelect: q.multiSelect === true, hasRecommended: opts.some((o) => RECOMMENDED.test(String(o && o.label))),
        askedAt: u.t, answeredAt: null, waitSec: null, answerKind: 'open', recommendedTaken: null, typedLen: null,
      };
      if (res) {
        row.answeredAt = res.t;
        row.waitSec = Math.round(((res.t - u.t) / 1000) * 10) / 10;
        const ans = Object.prototype.hasOwnProperty.call(res.answers, text) ? res.answers[text] : undefined;
        if (typeof ans !== 'string') row.answerKind = 'declined';
        else {
          const a = answerOf(q, ans);
          row.answerKind = a.kind;
          if (a.kind === 'tap') row.recommendedTaken = a.recommended;
          else row.typedLen = a.typedLen;
        }
      } else {
        const end = Number.isFinite(until) ? until : u.end;
        row.waitSec = Math.round((Math.max(end, u.t) - u.t) / 100) / 10;
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

export function main(argv) {
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
  const parsed = readTranscripts(dir);
  const since = a.since ? Date.parse(a.since) : -Infinity;
  const until = a.until ? Date.parse(a.until) : Infinity;
  const rows = parsed ? buildRows(parsed, { since, until }) : [];
  if (!rows.length) {
    process.stderr.write(`ask-ledger: no question in ${dir.replace(/\\/g, '/')} for the window since=${a.since || '-'} until=${a.until || '-'}${parsed ? '' : ' (folder unreadable)'}\n`);
    return 2;
  }
  const text = JSON.stringify({ window: { since: a.since, until: a.until }, files: parsed.names.length, badLines: parsed.badLines, rows, byClass: byClass(rows) }, null, 1) + '\n';
  if (a.idList) {
    let ids = null;
    try { ids = readIdList(root); } catch (e) {
      if (e && e.kind === 'absent') process.stderr.write(`${MSG_NOTE}\n`);
      else { process.stderr.write(`${MSG_LIST}\n`); return 3; }
    }
    if (ids && (ids.length === 0 || countListed(text, ids) > 0)) { process.stderr.write(`${ids.length === 0 ? MSG_LIST : MSG_LEFT}\n`); return 3; }
  }
  if (outFile) fs.writeFileSync(outFile, text);
  process.stdout.write(text);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
