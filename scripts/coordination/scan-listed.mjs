#!/usr/bin/env node
/**
 * scan-listed.mjs -- card listed-id-scan-tool. One scan of listed ids (holdout, reserve and gold ids) for builders and the seat.
 * Read only. It prints counts, line numbers, columns, rule names and a masked context, never an id: not in stdout, not in stderr, not in --json.
 * It is the builder and seat front end. The authoritative check is `countIdsIn` in the push gate and the board mask (the `gate` count below).
 *
 * Why two counts (card evidence, 2026-11-26): the machine and the seat's rescan use two matchers and two lists.
 *   gate    the matcher of the push gate, commit-preflight, holdout-scan and the board mask: `countIdsIn` (scripts/github/lib/holdout-ids.mjs) on the gate
 *           list (`readIdList` of board-mask.mjs). A short number counts only right after #, PR, pr, pull/, pulls/, issues/ or pr- (rule pr-ref).
 *   strict  the rubric guard (scripts/eval/review-eval/rubrics/lint-ids.mjs): its set holds the reserve ids and every gold PR number, and a bare integer of
 *           MIN_INT_DIGITS digits or more hits anywhere (rule bare; leading zeros stripped, NFKC text). The seat's rescan works this way. Strict also runs the
 *           gate places on the NFKC fold of each line, so an id written in fullwidth characters is a strict hit at its original column.
 * Both matchers are imported, none is copied except the bare-number rule of the guard, which `makeMatcher` keeps private; the test row S17 ties the
 * two together. `strict` counts hit places: the gate places plus the bare places (one place when two rules hit the same column).
 *
 * Usage: node scripts/coordination/scan-listed.mjs [--gate-only] [--json] [--root <dir>] <file | -> ...
 *   -           read standard input.
 *   --gate-only count and judge the gate rule alone (the exit code and the output hold no strict count).
 *   --root      the folder with the list files (default: the primary checkout; the dataset file is git-ignored and lives there).
 * Exit 0: no hit. Exit 1: a hit (gate or strict; with --gate-only the gate only). Exit 2: a usage error (help is allowed only as the one argument), a file that
 * cannot be read or is not plain text (a UTF-16 byte order mark or a NUL byte: save it as UTF-8), or a list that is absent, empty or of the wrong shape
 * (a scan that cannot run never passes). The messages are fixed text: no file content, no id.
 * File names are masked in the output (a digit run, a hex run or a listed string id in a name could itself be an id).
 *
 * Known limits (PR 748, one line each; a new case of the same kind, an encoding, fold or case trick, is added here and not fixed):
 *   a hit split across two lines (PR, a line break, the number) counts in `gate` but has no place; the blank filler of the place check can show a false second
 *   place next to a repeated id; clean-controls.json of the gold folder is read as gold rows (the rubric guard skips it); a combining mark or a script that
 *   NFKC does not fold can hide an id from `strict`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASET_REL, EVAL_CONFIG_REL, GOLD_DIR_REL, GOLD_NON_ROW_FILES, readIdList } from './board-mask.mjs';
import { checkHoldoutShape, countIdsIn } from '../github/lib/holdout-ids.mjs';
import { MIN_INT_DIGITS, forbiddenSet } from '../eval/review-eval/rubrics/lint-ids.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

export const USAGE = [
  'usage: node scripts/coordination/scan-listed.mjs [--gate-only] [--json] [--root <dir>] <file | -> ...',
  '  gate    what the machine enforces (push gate, commit-preflight, holdout-scan, board mask): ids of the gate list. A PR body must be 0.',
  `  strict  what the seat's rescan flags: the gate places plus any bare number of ${MIN_INT_DIGITS} digits or more in the rubric set. Aim for 0.`,
  'prints counts, line, column, rule and a masked context; never an id. A listed number right after #, PR, pr, pull/ or pr- is rule pr-ref.',
  'exit 0 no hit, 1 a hit, 2 usage error, a file that is not plain text, or a list that is absent, empty or broken. --gate-only judges the gate count alone; - reads standard input.',
].join('\n');

const MSG = Object.freeze({
  absent: 'scan-listed: the listed-id list is absent (the dataset file is not in this root: run from the primary checkout or pass --root)',
  bad: 'scan-listed: the listed-id list cannot be read or has the wrong shape',
  empty: 'scan-listed: the listed-id list is empty',
  file: 'scan-listed: a file cannot be read',
  binary: 'scan-listed: a file is not plain text (a UTF-16 byte order mark or a NUL byte): save it as UTF-8',
  usage: 'scan-listed: wrong arguments (run with --help)',
});

class Problem extends Error { constructor(kind) { super(MSG[kind]); this.kind = kind; } }

// ---------- lists ----------

/** The primary checkout: the dataset file is git-ignored and lives there. A failed git call gives the checkout of this script. */
function primaryRoot() {
  try {
    return path.dirname(execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { return REPO; }
}

/** The gold rows of `root`, read as board-mask reads them (a loose read: the gold ids need target.pr and the shas only). [] when the folder is absent. */
function readGoldRows(root) {
  const dir = path.join(root, GOLD_DIR_REL);
  let names;
  try { names = fs.readdirSync(dir); } catch (err) { if (err && err.code === 'ENOENT') return []; throw new Problem('bad'); }
  try {
    return names.filter((n) => n.endsWith('.json') && !GOLD_NON_ROW_FILES.includes(n)).flatMap((n) => {
      const rows = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (!Array.isArray(rows)) throw new Error('shape');
      return rows;
    });
  } catch { throw new Problem('bad'); }
}

/** Both lists of `root`: the gate list A and the rubric set B. Throws a Problem (absent, empty or bad) with a fixed message. */
export function loadLists(root) {
  let listA;
  try { listA = readIdList(root); } catch (err) { throw new Problem(err && ['absent', 'empty'].includes(err.kind) ? err.kind : 'bad'); }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, EVAL_CONFIG_REL), 'utf8'));
    const dataset = JSON.parse(fs.readFileSync(path.join(root, DATASET_REL), 'utf8'));
    // The shared shape check of the gates: a dataset with no findings gives a list of PR numbers only, and a scan on it would pass comment ids unseen.
    checkHoldoutShape(dataset, cfg);
    return { listA, setB: forbiddenSet({ cfg, dataset, goldRows: readGoldRows(root) }), minInt: MIN_INT_DIGITS, hide: hideRegex(listA) };
  } catch (err) { throw err instanceof Problem ? err : new Problem('bad'); }
}

// ---------- scan ----------

const HEX_RUN = /(?<![0-9a-f])[0-9a-f]{7,}(?![0-9a-f])/gi;
const DIGIT_RUN = /(?<!\d)\d+(?!\d)/g;
const LINE_SPLIT = /\r\n?|\n/;
const ID_MARK = '';
const HEX_MARK = '';

/** The rule name of a gate-list id: sha, key (<pr>:<id>), id (7 digits or more), pr-ref (a shorter number), token (anything else). */
const classOf = (id) => (/^[0-9a-f]{7,40}$/i.test(id) && /[a-f]/i.test(id) ? 'sha' : id.includes(':') ? 'key' : /^\d+$/.test(id) ? (id.length >= 7 ? 'id' : 'pr-ref') : 'token');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A short text (a file name) with every listed string id, every hex run of 7 or more and every decimal digit of any script hidden. The text is folded
 * with NFKC first (a fullwidth digit or letter is the same id), then any digit that the fold keeps (Arabic-Indic, Devanagari) is hidden.
 */
const maskText = (s, hide = null) => {
  const folded = s.normalize('NFKC');
  return (hide ? folded.replace(hide, '[ID]') : folded).replace(/[0-9a-f]{7,}/gi, 'HEX').replace(/\p{Nd}/gu, '#');
};

/** The listed ids that are neither digits nor shas (a finding id can be a plain string, or a <pr>:<id> key) as one pattern, longest first. null when there are none. */
function hideRegex(listA) {
  const tokens = listA.filter((id) => typeof id === 'string' && id !== '' && ['token', 'key'].includes(classOf(id))).sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return null;
  return { re: new RegExp(tokens.map(escapeRe).join('|'), 'gi'), max: tokens[0].length };
}

/** The NFKC fold of a line, and for each folded character the offset of the original character it came from (a ligature gives two folded ones). */
function foldLine(line) {
  let text = '';
  const map = [];
  let at = 0;
  for (const ch of line) {
    const folded = ch.normalize('NFKC');
    for (let k = 0; k < folded.length; k++) map.push(at);
    text += folded;
    at += ch.length;
  }
  return { text, map };
}

/**
 * The folded line with every hidden part replaced character by character, so the text keeps its length: a listed string id by ID_MARK, a hex run of
 * 7 or more by HEX_MARK, any decimal digit by #, any control character by ?. A context is cut from this text, so the cut can never fall inside an id.
 */
function maskLine(fold, hide) {
  const chars = fold.text.split('');
  if (hide) for (const m of fold.text.matchAll(hide.re)) chars.fill(ID_MARK, m.index, m.index + m[0].length);
  for (const m of fold.text.matchAll(HEX_RUN)) for (let k = m.index; k < m.index + m[0].length; k++) if (chars[k] !== ID_MARK) chars[k] = HEX_MARK;
  for (let k = 0; k < chars.length; k++) {
    if (/\p{Nd}/u.test(chars[k])) chars[k] = '#';
    else if (/[\p{Cc}\p{Cf}]/u.test(chars[k])) chars[k] = '?';
  }
  return { map: fold.map, chars };
}

/** A masked context: 40 folded characters each side of the hit, the hit itself replaced by [ID], runs of hidden parts shown as [ID] or HEX. */
function contextOf(lm, at, len) {
  const first = (v) => {
    let lo = 0;
    let hi = lm.map.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lm.map[mid] < v) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const from = first(at);
  const to = len > 0 ? first(at + len) : from;
  const show = (a, b) => lm.chars.slice(a, b).join('').replace(/+/g, '[ID]').replace(/+/g, 'HEX');
  return `${show(Math.max(0, from - 40), from)}[ID]${show(to, to + 40)}`.replace(/\s+/g, ' ');
}

/**
 * Where `id` hits in `line`: { at, len } places. Each candidate place is checked by the real matcher on a small slice (the 8 characters before, which
 * hold the context window, and one after), so the rule of countIdsIn is not copied here. A hit with no place found falls back to column 1.
 * A string id is found on the raw line with a case-blind pattern (lower-casing the line would move offsets: a dotted capital I becomes two characters).
 */
function placesOf(line, id, cls) {
  const out = [];
  if (cls === 'sha') {
    for (const m of line.matchAll(HEX_RUN)) if (countIdsIn(m[0], [id]) > 0) out.push({ at: m.index, len: m[0].length });
  } else {
    const fold = cls === 'token' || cls === 'key';
    const candidates = [];
    if (fold) for (const m of line.matchAll(new RegExp(escapeRe(id), 'gi'))) candidates.push({ at: m.index, len: m[0].length });
    else for (let from = 0; ;) { const at = line.indexOf(id, from); if (at < 0) break; from = at + 1; candidates.push({ at, len: id.length }); }
    for (const c of candidates) {
      // The candidate alone must hit: another copy of the id in the slice (a valid reference just before) is blanked, so it cannot vouch for this one.
      const blank = (s) => (fold ? s.toLowerCase() : s).split(fold ? id.toLowerCase() : id).join('_'.repeat(id.length));
      const before = blank(line.slice(Math.max(0, c.at - 8), c.at));
      const after = blank(line.slice(c.at + c.len, c.at + c.len + 1));
      if (countIdsIn(`${before}${line.slice(c.at, c.at + c.len)}${after}`, [id]) > 0) out.push(c);
    }
  }
  return out.length ? out : [{ at: 0, len: 0 }];
}

/** The ids of the list that the matcher counts in the text, in list order. A group that counts 0 is dropped whole, so a long line costs a few calls, not one for each id. */
function hitIds(text, ids) {
  if (ids.length === 0 || countIdsIn(text, ids) === 0) return [];
  if (ids.length === 1) return ids;
  const mid = ids.length >> 1;
  return [...hitIds(text, ids.slice(0, mid)), ...hitIds(text, ids.slice(mid))];
}

/** The gate places of a text: { cls, at, len } for each place of each id of the list that the matcher counts in it. */
function gatePlaces(text, listA) {
  const out = [];
  for (const id of hitIds(text, listA.filter((x) => typeof x === 'string' && x !== ''))) {
    const cls = classOf(id);
    for (const place of placesOf(text, id, cls)) out.push({ cls, ...place });
  }
  return out;
}

/**
 * Scans a text. lists: { listA (array of ids), setB (Set of strings), minInt, hide }. Returns { gate, strict, hits }.
 * gate is `countIdsIn` on the whole text: the number the machine counts. strict is the number of hit places (gate places, gate places of the NFKC fold,
 * and bare places); with gateOnly it is null and only the gate places are listed. A hit is { line, col, rule, ctx }, col counts from 1.
 */
export function scanText(text, { listA, setB, minInt, hide = null }, { gateOnly = false } = {}) {
  const src = String(text ?? '');
  const gate = countIdsIn(src, listA);
  const hits = [];
  const seen = new Set();
  src.split(LINE_SPLIT).forEach((line, i) => {
    const no = i + 1;
    let fold = null;
    let lm = null;
    const getFold = () => (fold ??= foldLine(line));
    const add = (place, rule) => {
      const key = `${no}:${place.at}`;
      if (seen.has(key)) return;
      seen.add(key);
      lm ??= maskLine(getFold(), hide);
      hits.push({ line: no, col: place.at + 1, rule, ctx: contextOf(lm, place.at, place.len) });
    };
    if (gate > 0 && countIdsIn(line, listA) > 0) for (const p of gatePlaces(line, listA)) add(p, p.cls);
    if (gateOnly) return;
    const f = getFold();
    // The place of a folded match, in the original line: the fold can move offsets (a ligature gives two characters).
    const back = (at, len) => {
      const start = f.map[at];
      return { at: start, len: (at + len < f.map.length ? f.map[at + len] : line.length) - start };
    };
    // An id written in fullwidth or another folding form is the same id: the rubric guard folds the text before it reads it, so strict does too (gate stays the raw count).
    if (f.text !== line && countIdsIn(f.text, listA) > 0) for (const p of gatePlaces(f.text, listA)) add(back(p.at, p.len), p.cls);
    for (const m of f.text.matchAll(DIGIT_RUN)) {
      const bare = m[0].replace(/^0+(?=\d)/, '');
      if (bare.length >= minInt && setB.has(bare)) add(back(m.index, m[0].length), 'bare');
    }
  });
  return { gate, strict: gateOnly ? null : hits.length, hits };
}

// ---------- command line ----------

function parseArgs(argv) {
  const a = { gateOnly: false, json: false, root: null, help: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--help' || k === '-h') a.help = true;
    else if (k === '--gate-only') a.gateOnly = true;
    else if (k === '--json') a.json = true;
    else if (k === '--root') { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Problem('usage'); a.root = argv[++i]; }
    else if (k === '-' || !k.startsWith('--')) a.files.push(k);
    else throw new Problem('usage');
  }
  // Help is the whole command or nothing: a file named -h must never turn a scan into a usage text with exit 0.
  if (a.help && argv.length > 1) throw new Problem('usage');
  return a;
}

/** A file name safe to print: the base name with its digit runs, hex runs and listed string ids hidden, numbered so two files stay apart. */
const labelOf = (file, i, hide) => (file === '-' ? '<stdin>' : `${i + 1}:${maskText(path.basename(file), hide?.re)}`);

/** Reads each input as bytes: a UTF-16 byte order mark or a NUL byte means the text would split every number, so the scan would pass a hit as clean. */
function readInputs(files, hide) {
  return files.map((file, i) => {
    let bytes;
    try { bytes = fs.readFileSync(file === '-' ? 0 : file); } catch { throw new Problem('file'); }
    const utf16 = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
    if (utf16 || bytes.includes(0)) throw new Problem('binary');
    return { label: labelOf(file, i, hide), text: bytes.toString('utf8') };
  });
}

export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  try {
    const a = parseArgs(argv);
    if (a.help) { io.out(`${USAGE}\n`); return 0; }
    if (a.files.length === 0) throw new Problem('usage');
    const lists = loadLists(a.root ? path.resolve(a.root) : primaryRoot());
    const inputs = readInputs(a.files, lists.hide);
    const files = inputs.map((f) => ({ file: f.label, ...scanText(f.text, lists, { gateOnly: a.gateOnly }) }));
    const gate = files.reduce((n, f) => n + f.gate, 0);
    const strict = a.gateOnly ? null : files.reduce((n, f) => n + f.strict, 0);
    if (a.json) {
      io.out(`${JSON.stringify({ files, gate, strict })}\n`);
    } else {
      const lines = [];
      for (const f of files) {
        lines.push(`${f.file}: gate ${f.gate}${a.gateOnly ? '' : ` strict ${f.strict}`}`);
        for (const h of f.hits) lines.push(`HIT ${f.file} line=${h.line} col=${h.col} rule=${h.rule} ctx=${h.ctx}`);
      }
      lines.push(`total gate ${gate}${a.gateOnly ? '' : ` strict ${strict}`}`);
      io.out(`${lines.join('\n')}\n`);
    }
    return gate > 0 || (!a.gateOnly && strict > 0) ? 1 : 0;
  } catch (err) {
    if (!(err instanceof Problem)) { io.err('scan-listed: internal error\n'); return 2; }
    io.err(`${err.message}\n`);
    return 2;
  }
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) process.exitCode = main(process.argv.slice(2));
