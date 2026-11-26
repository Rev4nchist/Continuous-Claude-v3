#!/usr/bin/env node
/**
 * scan-listed.mjs -- card listed-id-scan-tool. One scan of listed ids (holdout, reserve and gold ids) for builders and the seat.
 * Read only. It prints counts, line numbers, columns, rule names and a masked context, never an id: not in stdout, not in stderr, not in --json.
 *
 * Why two counts (card evidence, 2026-11-26): the machine and the seat's rescan use two matchers and two lists.
 *   gate    the matcher of the push gate, commit-preflight, holdout-scan and the board mask: `countIdsIn` (scripts/github/lib/holdout-ids.mjs) on the gate
 *           list (`readIdList` of board-mask.mjs). A short number counts only right after #, PR, pr, pull/, pulls/, issues/ or pr- (rule pr-ref).
 *   strict  the rubric guard (scripts/eval/review-eval/rubrics/lint-ids.mjs): its set holds the reserve ids and every gold PR number, and a bare integer of
 *           MIN_INT_DIGITS digits or more hits anywhere (rule bare; leading zeros stripped, NFKC text). The seat's rescan works this way.
 * Both matchers are imported, none is copied except the bare-number rule of the guard, which `makeMatcher` keeps private; the test row S17 ties the
 * two together. `strict` counts hit places: the gate places plus the bare places (one place when both rules hit the same column).
 *
 * Usage: node scripts/coordination/scan-listed.mjs [--gate-only] [--json] [--root <dir>] <file | -> ...
 *   -           read standard input.
 *   --gate-only count and judge the gate rule alone (the exit code and the output hold no strict count).
 *   --root      the folder with the list files (default: the primary checkout; the dataset file is git-ignored and lives there).
 * Exit 0: no hit. Exit 1: a hit (gate or strict; with --gate-only the gate only). Exit 2: a usage error, a file that cannot be read, or a list that is
 * absent, empty or of the wrong shape (a scan that cannot run never passes). The messages are fixed text: no file content, no id.
 * File names are masked in the output (a digit run or a hex run in a name could itself be an id).
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
  'exit 0 no hit, 1 a hit, 2 usage error or a list that is absent, empty or broken. --gate-only judges the gate count alone; - reads standard input.',
].join('\n');

const MSG = Object.freeze({
  absent: 'scan-listed: the listed-id list is absent (the dataset file is not in this root: run from the primary checkout or pass --root)',
  bad: 'scan-listed: the listed-id list cannot be read or has the wrong shape',
  empty: 'scan-listed: the listed-id list is empty',
  file: 'scan-listed: a file cannot be read',
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

/** The rule name of a gate-list id: sha, key (<pr>:<id>), id (7 digits or more), pr-ref (a shorter number), token (anything else). */
const classOf = (id) => (/^[0-9a-f]{7,40}$/i.test(id) && /[a-f]/i.test(id) ? 'sha' : id.includes(':') ? 'key' : /^\d+$/.test(id) ? (id.length >= 7 ? 'id' : 'pr-ref') : 'token');

/**
 * A text with every hex run of 7 or more and every decimal digit of any script hidden: a context never shows an id, also not a part of one.
 * The text is folded with NFKC first (a fullwidth digit or letter is the same id), then any digit that the fold keeps (Arabic-Indic, Devanagari) is hidden.
 */
const maskText = (s, hide = null) => {
  const folded = s.normalize('NFKC');
  return (hide ? folded.replace(hide, '[ID]') : folded).replace(/[0-9a-f]{7,}/gi, 'HEX').replace(/\p{Nd}/gu, '#');
};

/**
 * The listed ids that are neither digits nor shas (a finding id can be a plain string, or a <pr>:<id> key) as one pattern, longest first, and the length of
 * the longest. maskText hides every copy of them: a context holds other copies next to a hit, and a file name can hold one. null when the list has none.
 */
function hideRegex(listA) {
  const tokens = listA.filter((id) => typeof id === 'string' && id !== '' && ['token', 'key'].includes(classOf(id))).sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return null;
  return { re: new RegExp(tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi'), max: tokens[0].length };
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
 * A masked context: 40 characters each side, the hit itself replaced by [ID], every listed string id hidden. The slices are cut a token longer than
 * the context, hidden, and then cut to 40, so a token on the edge is hidden whole and never shows as a part.
 */
function contextOf(line, at, len, hide) {
  const pad = hide ? hide.max : 0;
  const before = maskText(line.slice(Math.max(0, at - 40 - pad), at), hide?.re).slice(-40);
  const after = maskText(line.slice(at + len, at + len + 40 + pad), hide?.re).slice(0, 40);
  return `${before}[ID]${after}`.replace(/\s+/g, ' ');
}

/**
 * Where `id` hits in `line`: { at, len } places. Each candidate place is checked by the real matcher on a small slice (the 8 characters before, which
 * hold the context window, and one after), so the rule of countIdsIn is not copied here. A hit with no place found falls back to column 1.
 */
function placesOf(line, id, cls) {
  const out = [];
  if (cls === 'sha') {
    for (const m of line.matchAll(HEX_RUN)) if (countIdsIn(m[0], [id]) > 0) out.push({ at: m.index, len: m[0].length });
  } else {
    const fold = cls === 'token' || cls === 'key';
    const hay = fold ? line.toLowerCase() : line;
    const want = fold ? id.toLowerCase() : id;
    for (let from = 0; ;) {
      const at = hay.indexOf(want, from);
      if (at < 0) break;
      from = at + 1;
      // The candidate alone must hit: another copy of the id in the slice (a valid reference just before) is blanked, so it cannot vouch for this one.
      const blank = (s) => (fold ? s.toLowerCase() : s).split(want).join('_'.repeat(want.length));
      const before = blank(line.slice(Math.max(0, at - 8), at));
      const after = blank(line.slice(at + want.length, at + want.length + 1));
      if (countIdsIn(`${before}${line.slice(at, at + want.length)}${after}`, [id]) > 0) out.push({ at, len: want.length });
    }
  }
  return out.length ? out : [{ at: 0, len: 0 }];
}

/**
 * Scans a text. lists: { listA (array of ids), setB (Set of strings), minInt }. Returns { gate, strict, hits }.
 * gate is `countIdsIn` on the whole text: the number the machine counts. strict is the number of hit places (gate places and bare places);
 * with gateOnly it is null and only the gate places are listed. A hit is { line, col, rule, ctx }, col counts from 1.
 */
export function scanText(text, { listA, setB, minInt, hide = null }, { gateOnly = false } = {}) {
  const src = String(text ?? '');
  const gate = countIdsIn(src, listA);
  const hits = [];
  const seen = new Set();
  const shaIds = listA.filter((id) => typeof id === 'string' && classOf(id) === 'sha');
  const add = (line, no, place, rule) => {
    hits.push({ line: no, col: place.at + 1, rule, ctx: contextOf(line, place.at, place.len, hide) });
    seen.add(`${no}:${place.at}`);
  };
  src.split(LINE_SPLIT).forEach((line, i) => {
    const no = i + 1;
    if (gate > 0 && countIdsIn(line, listA) > 0) {
      for (const id of listA) {
        if (typeof id !== 'string' || id === '' || countIdsIn(line, [id]) === 0) continue;
        const cls = classOf(id);
        for (const place of placesOf(line, id, cls)) add(line, no, place, cls);
      }
    }
    if (gateOnly) return;
    const { text: folded, map } = foldLine(line);
    for (const m of folded.matchAll(DIGIT_RUN)) {
      // The place is reported in the original line: the fold can move offsets (a ligature gives two characters).
      const at = map[m.index];
      const end = m.index + m[0].length < map.length ? map[m.index + m[0].length] : line.length;
      const bare = m[0].replace(/^0+(?=\d)/, '');
      if (bare.length >= minInt && (setB.has(m[0]) || setB.has(bare)) && !seen.has(`${no}:${at}`)) add(line, no, { at, len: end - at }, 'bare');
    }
    // A sha written in fullwidth hex is the same sha: the rubric guard folds the text before it reads hex runs, so strict does too (gate stays the raw count).
    if (shaIds.length === 0) return;
    for (const m of folded.matchAll(HEX_RUN)) {
      const at = map[m.index];
      if (seen.has(`${no}:${at}`) || countIdsIn(m[0], shaIds) === 0) continue;
      const end = m.index + m[0].length < map.length ? map[m.index + m[0].length] : line.length;
      add(line, no, { at, len: end - at }, 'sha');
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
    else if (k === '--root') { if (i + 1 >= argv.length || (argv[i + 1].startsWith('--') && argv[i + 1] !== '-')) throw new Problem('usage'); a.root = argv[++i]; }
    else if (k === '-' || !k.startsWith('--')) a.files.push(k);
    else throw new Problem('usage');
  }
  return a;
}

/** A file name safe to print: the base name with its digit runs and hex runs hidden, numbered so two files stay apart. */
const labelOf = (file, i, hide) => (file === '-' ? '<stdin>' : `${i + 1}:${maskText(path.basename(file), hide?.re)}`);

function readInputs(files, hide) {
  return files.map((file, i) => {
    try { return { label: labelOf(file, i, hide), text: fs.readFileSync(file === '-' ? 0 : file, 'utf8') }; } catch { throw new Problem('file'); }
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
