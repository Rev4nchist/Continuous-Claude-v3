#!/usr/bin/env node
// Rubric id guard: no holdout, reserve or gold id may appear in a rubric file.
// Usage: node scripts/eval/review-eval/rubrics/lint-ids.mjs --config <config.json> --dataset <dataset.json> [--gold <dir> | --no-gold] [--rubrics <dir>]
// The gold check is the default: with no --gold, the default gold folder of gold.mjs is read. --no-gold skips it and says so on stderr.
// Output is counts only. A hit prints the file base name and the line, never the token.
// Exit 0: no hit. Exit 1: a hit. Exit 2: bad input or a check that would pass on nothing. A guard that cannot run never passes.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setOf } from '../dataset.mjs';
import { GOLD_DIR, loadGold } from '../gold.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALUE_FLAGS = ['--config', '--dataset', '--gold', '--rubrics'];
const BOOL_FLAGS = ['--no-gold'];
const USAGE = 'usage: node scripts/eval/review-eval/rubrics/lint-ids.mjs --config <config.json> --dataset <dataset.json> [--gold <dir> | --no-gold] [--rubrics <dir>]';
const SHA40_RE = /^[0-9a-f]{40}$/i;
const LINE_SPLIT = /\r\n?|\n/;
/** Forbidden ids with fewer digits than this are counted as small-ids: they can hit a plain number in a rubric by chance. */
export const MIN_INT_DIGITS = 3;
// Two passes over each line, on NFKC text. Digit runs: a run of digits, never beside another digit, so id9123 and pr_9123 are found.
// Hex runs: a maximal run of 7 or more hex chars, so a SHA after -g, or after one glued hex letter, is found.
// Rule 7 of rubric-lint.mjs covers the PR-reference forms (pr, pull, issue, #N); this guard checks the real ids.
const DIGIT_RE = /(?<!\d)\d+(?!\d)/g;
const HEX_RE = /(?<![0-9a-f])[0-9a-f]{7,}(?![0-9a-f])/gi;

/** An input problem. The message names the flag and never holds file text. */
class InputError extends Error {}
const bad = (flag, why) => new InputError(`error: ${flag} ${why}`);

/**
 * The forbidden ids by source, each a Set of strings (hex in lower case):
 * holdout and reserve (dataset PRs by setOf, plus cfg.reserve), goldPr (every gold target.pr), goldSha (range sides and sha40).
 */
export function forbiddenParts({ cfg, dataset, goldRows = [] }) {
  const reserveList = cfg.reserve ?? [];
  if (!Array.isArray(reserveList) || reserveList.some((r) => !Number.isInteger(r?.pr))) throw bad('--config', 'reserve must be a list of { pr: <integer> }');
  if (!Array.isArray(cfg.holdoutExclude ?? [])) throw bad('--config', 'holdoutExclude must be a list');
  const parts = { holdout: new Set(), reserve: new Set(reserveList.map((r) => String(r.pr))), goldPr: new Set(), goldSha: new Set() };
  const prs = [...(dataset.prs ?? []), ...(dataset.findings ?? [])].map((x) => x?.pr).filter((p) => p !== undefined && p !== null);
  for (const pr of new Set(prs)) {
    const split = setOf(pr, cfg);
    if (split === 'holdout') parts.holdout.add(String(pr));
    else if (split === 'reserve') parts.reserve.add(String(pr));
  }
  const addSha = (s) => { if (typeof s === 'string' && SHA40_RE.test(s)) parts.goldSha.add(s.toLowerCase()); };
  for (const row of goldRows) {
    const t = row?.target ?? {};
    if (t.pr !== undefined && t.pr !== null) parts.goldPr.add(String(t.pr));
    addSha(t.sha40);
    if (typeof t.range === 'string') t.range.split('..').forEach(addSha);
  }
  return parts;
}

/** Every id a rubric must never hold, as strings. Hex values are lower case. */
export function forbiddenSet(args) {
  const p = forbiddenParts(args);
  return new Set([...p.holdout, ...p.reserve, ...p.goldPr, ...p.goldSha]);
}

function makeMatcher(set) {
  const shas = [...set].filter((s) => SHA40_RE.test(s));
  return {
    // An integer of MIN_INT_DIGITS or more digits (after leading zeros) hits when it is in the set.
    // A shorter one is a score, a version or a count and holds no id; rule 7 bans every PR reference form of any length.
    digits: (token) => {
      const bare = token.replace(/^0+(?=\d)/, '');
      return bare.length >= MIN_INT_DIGITS && (set.has(token) || set.has(bare));
    },
    // A hex run hits when it is in the set, is a prefix of a full SHA in the set, or holds a full SHA (a glued hex letter).
    hex: (token) => {
      const t = token.toLowerCase();
      return set.has(t) || shas.some((s) => (t.length <= s.length && s.startsWith(t)) || t.includes(s));
    },
  };
}

/**
 * Scans the .md files of dir (any case of the extension). A symlink entry throws an InputError.
 * @returns {{ files: number, tokens: number, hits: { file: string, line: number }[] }} one hit at most per line.
 */
export function scanRubrics(dir, set) {
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.some((e) => e.isSymbolicLink())) throw bad('--rubrics', 'holds a symlink');
  const names = entries.filter((e) => e.isFile() && /\.md$/i.test(e.name)).map((e) => e.name).sort();
  const match = makeMatcher(set);
  let tokens = 0;
  const hits = [];
  for (const file of names) {
    readFileSync(path.join(dir, file), 'utf8').normalize('NFKC').split(LINE_SPLIT).forEach((text, i) => {
      const digits = [...text.matchAll(DIGIT_RE)].map((m) => m[0]);
      const hexes = [...text.matchAll(HEX_RE)].map((m) => m[0]);
      tokens += digits.length + hexes.length;
      if (digits.some(match.digits) || hexes.some(match.hex)) hits.push({ file, line: i + 1 });
    });
  }
  return { files: names.length, tokens, hits };
}

/** The gold source: { skip: true } for --no-gold, else { skip: false, dir } with the --gold folder or the default gold folder. */
export function goldChoice(opts) {
  if (opts['--no-gold']) return { skip: true };
  return { skip: false, dir: opts['--gold'] ?? GOLD_DIR };
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return null;
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (Object.hasOwn(opts, flag)) return null;
    if (BOOL_FLAGS.includes(flag)) { opts[flag] = true; continue; }
    const value = argv[i + 1];
    if (!VALUE_FLAGS.includes(flag) || value === undefined || value.startsWith('--')) return null;
    opts[flag] = value;
    i += 1;
  }
  if (!opts['--config'] || !opts['--dataset']) return null;
  if (opts['--no-gold'] && Object.hasOwn(opts, '--gold')) return null;
  return opts;
}

function readJson(flag, file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { throw bad(flag, 'cannot be read'); }
  try { return JSON.parse(text); } catch { throw bad(flag, 'is not valid JSON'); }
}

const isFolder = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

function loadGoldRows(choice) {
  if (choice.skip) return [];
  if (!isFolder(choice.dir)) throw bad('--gold', 'is not a readable folder (the default gold folder is used when --gold is not given)');
  let rows;
  try { rows = loadGold(choice.dir).rows; } catch { throw bad('--gold', 'holds a file that loadGold refuses'); }
  if (rows.length === 0) throw bad('--gold', 'gives no rows: the gold check would pass on nothing (use --no-gold to skip it)');
  return rows;
}

function loadInputs(opts) {
  const cfg = readJson('--config', opts['--config']);
  if (!isPlain(cfg)) throw bad('--config', 'has the wrong shape');
  const dataset = readJson('--dataset', opts['--dataset']);
  if (!isPlain(dataset) || !Array.isArray(dataset.prs) || !Array.isArray(dataset.findings)) throw bad('--dataset', 'must be { prs[], findings[] }');
  if (![...dataset.prs, ...dataset.findings].some((x) => x?.pr !== undefined && x?.pr !== null)) throw bad('--dataset', 'gives no PRs: the check would pass on nothing');
  const rubrics = opts['--rubrics'] ?? HERE;
  if (!isFolder(rubrics)) throw bad('--rubrics', 'is not a readable folder');
  return { cfg, dataset, rubrics, goldRows: loadGoldRows(goldChoice(opts)) };
}

/** Runs the check. Returns { code, stdout, stderr }. Never throws. */
export function lint(argv) {
  const opts = parseArgs(argv);
  if (!opts) return { code: 2, stdout: '', stderr: `${USAGE}\n` };
  try {
    const { cfg, dataset, rubrics, goldRows } = loadInputs(opts);
    const parts = forbiddenParts({ cfg, dataset, goldRows });
    const set = new Set([...parts.holdout, ...parts.reserve, ...parts.goldPr, ...parts.goldSha]);
    if (set.size === 0) throw bad('--config', 'and --dataset give an empty forbidden set: the check would pass on nothing');
    const scan = scanRubrics(rubrics, set);
    if (scan.files === 0) throw bad('--rubrics', 'holds no .md file: the check would pass on nothing');
    const small = [...set].filter((s) => /^\d+$/.test(s) && s.length < MIN_INT_DIGITS).length;
    const lines = [
      `files ${scan.files}, tokens ${scan.tokens}, forbidden-set size ${set.size}, hits ${scan.hits.length}`,
      `holdout ${parts.holdout.size}, reserve ${parts.reserve.size}, gold-pr ${parts.goldPr.size}, gold-sha ${parts.goldSha.size}`,
      `small-ids ${small}`,
      ...scan.hits.map((h) => `HIT ${h.file}:${h.line}`),
    ];
    const note = opts['--no-gold'] ? 'note: --no-gold given, gold ids were not checked\n' : '';
    return { code: scan.hits.length ? 1 : 0, stdout: `${lines.join('\n')}\n`, stderr: note };
  } catch (e) {
    return { code: 2, stdout: '', stderr: `${e instanceof InputError ? e.message : 'error: lint-ids failed unexpectedly'}\n` };
  }
}

/** True when this file is the script node started. Paths are resolved and, on Windows, compared without case. */
function isMain() {
  try {
    const a = realpathSync(fileURLToPath(import.meta.url));
    const b = realpathSync(path.resolve(process.argv[1]));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isMain()) {
  const r = lint(process.argv.slice(2));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
