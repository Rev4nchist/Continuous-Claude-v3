// Gold row schema, validator and loaders for gold/*.json (the answer key of the review eval).
// Contract: docs/review-engine/map.md line 216 and, until the coordinator's map change lands,
// .claudedocs/re-execution/contracts/gold-schema-seat-answer.md (rules 1 to 5).
// Row fields: id, source 'A'|'B'|'C'|'CR', suite 'regression'|'capability', split 'dev'|'holdout'|'reserve',
//   target {pr, round, sha40, repo?} | {range: 'base..head'}, file, line?, severity, linkType,
//   labels [{by, verdict, judgeVersion?}], provenance, slice? ('security').
// Optional: `line`, `slice`, `labels[].judgeVersion`, and `target.repo` only on the PR form. No field is nullable, except a control's target.round (below).
// `target.repo` is 'owner/name': required when source is 'C', refused for A, B and CR. The range form never has it.
// Clean controls (gold/clean-controls.json, read by loadCleanControls): {id, split, target, provenance}.
//   The target has the same two forms as a gold row; repo is refused (a control is one of our own PRs, map.md:678).
//   One exception (Dave, 2026-11-14): a control may have round null when provenance.head is 'merged-head-no-round'
//   (no CodeRabbit round on its merged head). Its sha40 is still required and checked. A gold row never has round null.
//   Only exactly null is excepted: a marked control with round 0, -1 or '1' is refused as not a positive integer, and a
//   marked control with a positive integer round loads like any other control.
// `target.repo` is lower case only, with no `.git` suffix and no leading or trailing `.` or `-` in a part: this module
//   refuses a second spelling of one repository and never folds it (the producer folds before it writes).
// A file name with `.json` in another case, or a case variant of clean-controls.json or escape-baseline.json, is a problem.
// A row with an unknown key or an unknown field value is rejected: a bad gold row must never drop silently.
// `provenance` is the only open slot: each producer lane puts its own data there and checks its own keys.
// This module reads no config.json and no data. Tests write rows into a temp folder.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { HERE } from './config.mjs';
import { VERDICTS } from './labels.mjs';
import { LINK_TYPES } from './linktype.mjs';
import { SEV } from './match.mjs';

export const GOLD_DIR = path.join(HERE, 'gold');
export const SOURCES = Object.freeze(['A', 'B', 'C', 'CR']);
export const SUITES = Object.freeze(['regression', 'capability']);
export const SPLITS = Object.freeze(['dev', 'holdout', 'reserve']);
/** The optional `slice` values: how Gold B reports the security slice apart. */
export const SLICES = Object.freeze(['security']);
/** The severities a gold row may carry: the match.mjs fold targets, without `info` (never counts). */
export const SEVERITIES = Object.freeze([...new Set(Object.values(SEV))].filter((s) => s !== 'info'));
export const GOLD_ROW = Object.freeze({
  required: Object.freeze(['id', 'source', 'suite', 'split', 'target', 'file', 'severity', 'linkType', 'labels', 'provenance']),
  optional: Object.freeze(['line', 'slice']),
});
const CLEAN_CONTROL = Object.freeze({ required: Object.freeze(['id', 'split', 'target', 'provenance']), optional: Object.freeze([]) });
const CONTROLS_FILE = 'clean-controls.json';
/** Files in gold/ that are not row files (other shapes, owned by re-szz-miner). The loader skips them unread. */
export const NON_ROW_FILES = Object.freeze([CONTROLS_FILE, 'escape-baseline.json']);

/** Thrown by loadGold and loadCleanControls. `problems` has one `<file>[<row>] <field>: <reason>` line per problem. */
export class GoldError extends Error {
  constructor(problems) {
    super(`gold: ${problems.length} problem(s)\n${problems.join('\n')}`);
    this.name = 'GoldError';
    this.problems = problems;
  }
}

// Copy of external-pull.mjs:12 (not exported there).
const SHA_RE = /^[0-9a-f]{40}$/;
const REF_RE = /^refs\/[A-Za-z0-9_-][A-Za-z0-9._\/-]*$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const BY_RE = /^[a-z][a-z0-9.-]*$/;
// One repository must have one key, and this module never folds a value: it only refuses. A part starts and ends with
// a letter, digit or _ (so it is never "." or ".."), and has . - inside. The producer folds before it writes.
const REPO_PART = '[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?';
const REPO_RE = new RegExp(`^${REPO_PART}/${REPO_PART}$`);
const PR_KEYS = ['pr', 'round', 'sha40'];
const FORMS = 'expected exactly one of {pr, round, sha40} (with repo for source C) or {range}';
const REPO_WHAT = 'owner/name (lower-case only, one slash, both parts non-empty, only letters, digits, . _ -, no part starting or ending with . or -, a name not ending in .git)';

const isPlain = (o) => {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return false;
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null;
};
const posInt = (n) => Number.isSafeInteger(n) && n >= 1;
const blank = (s) => typeof s !== 'string' || s === '' || s !== s.trim();
const quote = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const bad = (where, why) => [`${where}: ${why}`];
const KEY_CAP = 40;
/** A key name or an enum string, JSON-quoted and cut at KEY_CAP characters. */
const quoteCapped = (s) => quote(s.length > KEY_CAP ? s.slice(0, KEY_CAP) : s);
/** What a value is, never its content: 'a string', 'a number', 'an array', 'null'. A problem about an answer field uses this. */
function kind(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  const t = typeof v;
  return t === 'object' ? 'an object' : `${t === 'undefined' ? 'an' : 'a'} ${t}`;
}

/** Unknown keys and missing required keys of one object. `where` is the object path ('row', 'target', 'labels[0]'). */
function checkKeys(obj, allowed, required, where, root = 'row') {
  const prefix = where === root ? '' : `${where}.`;
  const problems = Object.keys(obj).filter((k) => !allowed.includes(k)).map((k) => `${where}: unknown field ${quoteCapped(k)}`);
  for (const k of required) if (!Object.hasOwn(obj, k)) problems.push(`${prefix}${k}: required`);
  return problems;
}

/** An answer field never prints its value: the type found and the expected set. `quoted` (source, suite, split, slice) quotes a string value only. */
function checkEnum(value, set, where, quoted = false) {
  if (set.includes(value)) return [];
  const found = quoted && typeof value === 'string' ? `${quoteCapped(value)} is not one of` : `${kind(value)} that is not one of`;
  return bad(where, `${found} ${set.join(', ')}`);
}

function checkPattern(value, re, where, what) {
  return typeof value === 'string' && re.test(value) ? [] : bad(where, `${kind(value)}, expected ${what}`);
}

function checkInt(value, where) {
  return posInt(value) ? [] : bad(where, `${kind(value)}, expected a positive integer`);
}

const PATH_WHAT = 'a repo-relative POSIX path';
function checkFile(f) {
  const badPath = blank(f) || f.includes('\\') || f.startsWith('/') || /^[A-Za-z]:/.test(f) || /[\x00-\x1f]/.test(f)
    || f.split('/').some((s) => s === '' || s === '.' || s === '..');
  return badPath ? bad('file', `${kind(f)}, expected ${PATH_WHAT}`) : [];
}

/** A ref side: REF_RE, and no trailing '/', no trailing '.lock', no '.' part (git refuses these names). */
const refOk = (s) => REF_RE.test(s) && !s.endsWith('/') && !s.endsWith('.lock') && !s.split('/').includes('.');

function checkRange(r) {
  const sides = typeof r === 'string' ? r.split('..') : [];
  const ok = sides.length === 2 && !r.includes('...') && sides.every((s) => SHA_RE.test(s) || refOk(s));
  if (!ok) return bad('target.range', `${kind(r)}, expected <sha40|refs/...>..<sha40|refs/...>`);
  return sides[0] === sides[1] ? bad('target.range', 'base and head are the same, an empty range') : [];
}

/**
 * Where `repo` may appear in a PR-form target, by source: 'required' (C), 'refused' (A, B, CR and every control),
 * 'free' (the source is missing or invalid: that problem is reported once, and a repo that is present is only shape-checked).
 */
function repoRule(source) {
  if (source === 'C') return 'required';
  return SOURCES.includes(source) ? 'refused' : 'free';
}

const repoOk = (v) => typeof v === 'string' && REPO_RE.test(v) && !v.endsWith('.git');

function checkRepo(t, rule) {
  if (!Object.hasOwn(t, 'repo')) return rule === 'required' ? bad('target.repo', 'required when source is C') : [];
  if (rule === 'refused') return bad('target.repo', 'refused (only a source C row names a repo)');
  return repoOk(t.repo) ? [] : bad('target.repo', `${kind(t.repo)}, expected ${REPO_WHAT}`);
}

/** The provenance marker of a control on its merged head. Only such a control may have round null. */
const MERGED_HEAD = 'merged-head-no-round';
const onMergedHead = (c) => isPlain(c?.provenance) && c.provenance.head === MERGED_HEAD;

/** nullRound: round null is allowed (a merged-head control only). */
function checkPrForm(t, rule, nullRound) {
  return [
    ...checkKeys(t, [...PR_KEYS, 'repo'], PR_KEYS, 'target'),
    ...checkRepo(t, rule),
    ...('pr' in t ? checkInt(t.pr, 'target.pr') : []),
    ...('round' in t && !(nullRound && t.round === null) ? checkInt(t.round, 'target.round') : []),
    ...('sha40' in t ? checkPattern(t.sha40, SHA_RE, 'target.sha40', '40 lowercase hex characters') : []),
  ];
}

function checkRangeForm(t, prKeys, rule) {
  if (prKeys.length) return bad('target', `${FORMS}; got both forms (${prKeys.join(', ')} with range)`);
  const head = rule === 'required' ? bad('target', 'source C needs the PR form with repo; the range form has no repo') : [];
  return [...head, ...checkKeys(t, ['range'], ['range'], 'target'), ...checkRange(t.range)];
}

function checkTarget(t, rule, nullRound = false) {
  if (!isPlain(t)) return ['target: expected an object'];
  const prKeys = PR_KEYS.filter((k) => Object.hasOwn(t, k));
  if (Object.hasOwn(t, 'range')) return checkRangeForm(t, prKeys, rule);
  return prKeys.length ? checkPrForm(t, rule, nullRound) : bad('target', FORMS);
}

function checkLabel(l, where) {
  if (!isPlain(l)) return bad(where, 'expected an object');
  return [
    ...checkKeys(l, ['by', 'verdict', 'judgeVersion'], ['by', 'verdict'], where),
    ...('by' in l ? checkPattern(l.by, BY_RE, `${where}.by`, 'a lowercase rater name') : []),
    ...('verdict' in l ? checkEnum(l.verdict, VERDICTS, `${where}.verdict`) : []),
    ...('judgeVersion' in l && blank(l.judgeVersion) ? bad(`${where}.judgeVersion`, `${kind(l.judgeVersion)}, expected a non-empty string with no outer spaces`) : []),
  ];
}

function checkLabels(ls) {
  if (!Array.isArray(ls)) return bad('labels', 'expected an array');
  return ls.flatMap((l, i) => checkLabel(l, `labels[${i}]`));
}

function checkProvenance(p) {
  if (isPlain(p) && Object.keys(p).length) return [];
  const found = isPlain(p) ? 'an empty object' : kind(p);
  return bad('provenance', `${found}, expected an object with at least one key`);
}

const idRule = (v) => checkPattern(v, ID_RE, 'id', 'an id (letters, digits, . _ : -; no spaces)');
const splitRule = (v) => checkEnum(v, SPLITS, 'split', true);

/** One checker per field, called as (value, whole object). validateRow runs the checker of each key the row has. */
const FIELD_RULES = {
  id: idRule,
  source: (v) => checkEnum(v, SOURCES, 'source', true),
  suite: (v) => checkEnum(v, SUITES, 'suite', true),
  split: splitRule,
  target: (v, row) => checkTarget(v, repoRule(row.source)),
  file: checkFile,
  line: (v) => checkInt(v, 'line'),
  severity: (v) => checkEnum(v, SEVERITIES, 'severity'),
  linkType: (v) => checkEnum(v, LINK_TYPES, 'linkType'),
  labels: checkLabels,
  provenance: checkProvenance,
  slice: (v) => checkEnum(v, SLICES, 'slice', true),
};
/** A control has no source: its target never takes a repo (a clean control is one of our own PRs, map.md:678). */
const CONTROL_RULES = {
  id: idRule,
  split: splitRule,
  target: (v, c) => checkTarget(v, 'refused', onMergedHead(c)),
  provenance: checkProvenance,
};

function validateShape(obj, shape, rules, label = 'row') {
  if (!isPlain(obj)) return [`${label}: expected an object`];
  const allowed = [...shape.required, ...shape.optional];
  const problems = checkKeys(obj, allowed, shape.required, label, label);
  for (const k of Object.keys(obj)) if (allowed.includes(k)) problems.push(...rules[k](obj[k], obj));
  return problems;
}

/** Validate one gold row. Returns every problem as `<field path>: <reason>`; [] means valid. Never throws. */
export function validateRow(row) {
  return validateShape(row, GOLD_ROW, FIELD_RULES);
}

const validateControl = (c) => validateShape(c, CLEAN_CONTROL, CONTROL_RULES, 'control');
const ROW_KIND = { what: 'gold rows', validate: validateRow };
const CONTROL_KIND = { what: 'clean controls', validate: validateControl };

function noteId(r, at, seen, problems) {
  if (!isPlain(r) || typeof r.id !== 'string') return;
  if (seen.has(r.id)) problems.push(`${at} id: duplicate of ${seen.get(r.id)}`);
  else seen.set(r.id, at);
}

/** The position part of a JSON.parse message. The rest of the message quotes the source text, so it is never reported. */
const POSITION_RE = /at position \d+( \(line \d+ column \d+\))?$/;

// Built with fromCharCode: a typed escape for this character has been turned into the raw character before.
const BOM = String.fromCharCode(0xfeff);

/** The text of a file, or null (with a problem pushed) when it cannot be read or starts with a BOM. */
function readText(dir, name, problems) {
  try {
    const text = readFileSync(path.join(dir, name), 'utf8');
    if (!text.startsWith(BOM)) return text;
    problems.push(`${name}: has a BOM`);
  } catch (e) {
    problems.push(`${name}: cannot read (${e.code ?? 'unknown'})`);
  }
  return null;
}

/** Read one JSON file that must hold an array. Pushes its problems and returns the array ([] when the file is unusable). Error text never holds file content. */
function readJsonArray(dir, name, problems, what) {
  const text = readText(dir, name, problems);
  if (text === null) return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const where = POSITION_RE.exec(String(e?.message))?.[0];
    problems.push(`${name}: not valid JSON${where ? ` ${where}` : ''}`);
    return [];
  }
  if (Array.isArray(data)) return data;
  problems.push(`${name}: expected a JSON array of ${what}`);
  return [];
}

/** Read one array file and validate each item with kind.validate. Returns the items. */
function readItems(dir, name, problems, seen, { what, validate }) {
  const data = readJsonArray(dir, name, problems, what);
  data.forEach((r, i) => {
    const at = `${name}[${i}]`;
    for (const m of validate(r)) problems.push(`${at} ${m}`);
    noteId(r, at, seen, problems);
  });
  return data;
}

const readRowFile = (dir, name, problems, seen) => readItems(dir, name, problems, seen, ROW_KIND);

const fail = (problem) => { throw new GoldError([problem]); };
const cannotRead = (dir, e) => `${path.basename(dir)}: cannot read (${e.code ?? 'unknown'})`;

/** The entries of dir. A read error is a GoldError with the code and the folder name, never the path. */
function readDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return fail(cannotRead(dir, e));
  }
}

function isFolder(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch (e) {
    return fail(cannotRead(dir, e));
  }
}

/**
 * The problem for a file name in gold/, or null. A name with .json in any case is a candidate row file.
 * A non-row file name (NON_ROW_FILES) must match exactly, and the extension must be lower-case.
 */
function nameProblem(name) {
  const lower = name.toLowerCase();
  if (!lower.endsWith('.json')) return null;
  const exact = NON_ROW_FILES.find((n) => n === lower);
  if (exact && name !== exact) return `${quoteCapped(name)}: the name must be exactly ${exact} (lower case)`;
  return name.endsWith('.json') ? null : `${quoteCapped(name)}: the extension must be lower-case .json`;
}

/**
 * Load every row file in dir (default gold/). A missing folder is empty. Throws GoldError when any file or row is bad,
 * or when dir is a regular file (`<dir name>: not a folder`).
 * @returns {{rows: object[], files: string[], skipped: string[]}} rows in file order (plain .sort() by name), then row order.
 */
export function loadGold(dir = GOLD_DIR) {
  if (!existsSync(dir)) return { rows: [], files: [], skipped: [] };
  if (!isFolder(dir)) fail(`${path.basename(dir)}: not a folder`);
  // Case-blind: a name with .json in any case is a candidate. A wrong case is a problem, never a silent drop.
  const entries = readDir(dir).filter((e) => e.name.toLowerCase().endsWith('.json'));
  const listed = (pick) => entries.filter(pick).map((e) => e.name).sort();
  const fileNames = listed((e) => e.isFile());
  const linkNames = listed((e) => e.isSymbolicLink());
  const okName = (n) => nameProblem(n) === null;
  const problems = [...fileNames, ...linkNames].sort().map(nameProblem).filter(Boolean);
  const names = fileNames.filter(okName);
  const links = linkNames.filter(okName);
  const skipped = names.filter((n) => NON_ROW_FILES.includes(n));
  const files = names.filter((n) => !NON_ROW_FILES.includes(n));
  problems.push(...links.filter((n) => !NON_ROW_FILES.includes(n)).map((n) => `${n}: is a link, not a file`));
  const seen = new Map();
  const rows = files.flatMap((name) => readRowFile(dir, name, problems, seen));
  if (problems.length) throw new GoldError(problems);
  return { rows, files, skipped };
}

/**
 * Load the clean controls: <dir>/clean-controls.json only (default gold/). A missing folder or file is an empty list.
 * Throws GoldError when the file or a control is bad, or when dir is a regular file (ENOTDIR).
 * @returns {object[]} the controls in file order.
 */
export function loadCleanControls(dir = GOLD_DIR) {
  if (!existsSync(dir)) return [];
  // Windows reports ENOENT, not ENOTDIR, for a path below a regular file: test the folder itself.
  if (!isFolder(dir)) fail(`${CONTROLS_FILE}: cannot read (ENOTDIR)`);
  // A case-blind file system resolves a case variant to the exact path: compare with the real entry names.
  const variants = readDir(dir).map((e) => e.name).filter((n) => n.toLowerCase() === CONTROLS_FILE && n !== CONTROLS_FILE).sort();
  if (variants.length) throw new GoldError(variants.map(nameProblem));
  let st;
  try {
    st = lstatSync(path.join(dir, CONTROLS_FILE));
  } catch (e) {
    return e.code === 'ENOENT' ? [] : fail(`${CONTROLS_FILE}: cannot read (${e.code ?? 'unknown'})`);
  }
  if (st.isSymbolicLink()) fail(`${CONTROLS_FILE}: is a link, not a file`);
  const problems = [];
  const controls = readItems(dir, CONTROLS_FILE, problems, new Map(), CONTROL_KIND);
  if (problems.length) throw new GoldError(problems);
  return controls;
}
