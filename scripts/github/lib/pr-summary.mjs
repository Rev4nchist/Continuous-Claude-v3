// Step 0 of pre-pr: the plain summary the session writes before the run (.claude/cache/pre-pr/summary.md).
// Design: .claudedocs/2026-11-07-prepr-plain-summary-design.md. Tests: lib/pr-summary.test.mjs.
// The file has one label per line: Branch, Head, Base, Problem, Change, You will see, Risk, Not included.
// A problem that would FAIL is a NOTE unless mode is 'fail' (the one-week trial; the default is 'note'). checkSummary never throws.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const SUMMARY_REL = '.claude/cache/pre-pr/summary.md';
export const LABELS = ['Branch', 'Head', 'Base', 'Problem', 'Change', 'You will see', 'Risk', 'Not included'];
const TEXT_LABELS = ['Problem', 'Change', 'You will see', 'Risk', 'Not included'];
const MAX_FILES_SINCE = 5;
const MAX_SENTENCE_WORDS = 20;
const MAX_FIELD_WORDS = 80;
const MAX_FILE_WORDS = 120;

const lf = (text) => String(text).replace(/\r\n?/g, '\n');
const wordsOf = (text) => String(text).split(/\s+/).filter(Boolean).length;
const short = (sha) => String(sha).slice(0, 7);

/** The sha256 of the text with CRLF and LF read as the same text. */
export const hashOf = (text) => createHash('sha256').update(lf(text)).digest('hex');

/** The Change sentence of a summary text, or null. The Open PR dialog shows it. */
export function changeOf(text) {
  if (typeof text !== 'string') return null;
  return parseFields(text).get('Change')?.[0] || null;
}

/** { problem, change, youWillSee } of a summary text: the first value of each label, or null. The Land dialog shows them. */
export function summaryFieldsOf(text) {
  const fields = typeof text === 'string' ? parseFields(text) : new Map();
  const first = (label) => fields.get(label)?.[0] || null;
  return { problem: first('Problem'), change: first('Change'), youWillSee: first('You will see') };
}

// "Label: text", also written as a markdown bullet ("- Label: text") or in bold ("**Label:** text").
const LABEL_LINE = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?(Branch|Head|Base|Problem|Change|You will see|Risk|Not included)(?:\*\*)?:(?:\*\*)?[ \t]*(.*)$/;

/** Label -> list of values, one per line that holds a label. */
function parseFields(text) {
  const found = new Map();
  for (const line of lf(text).split('\n')) {
    const m = LABEL_LINE.exec(line);
    if (m) found.set(m[1], [...(found.get(m[1]) ?? []), m[2].trim()]);
  }
  return found;
}

/** "6 files, +464 -25" from git numstat of base...HEAD, or null when git cannot say. */
function factsOf(git, base) {
  const r = git(['diff', '--numstat', `${base}...HEAD`]);
  if (r.status !== 0) return null;
  const rows = String(r.stdout ?? '').split('\n').filter(Boolean).map((l) => l.split('\t'));
  const sum = (i) => rows.reduce((n, row) => n + (Number(row[i]) || 0), 0);
  return `${rows.length} ${rows.length === 1 ? 'file' : 'files'}, +${sum(0)} -${sum(1)}`;
}

function diffPaths(git, base) {
  const r = git(['diff', '--name-only', `${base}...HEAD`]);
  return r.status === 0 ? String(r.stdout ?? '').split('\n').map((p) => p.trim()).filter(Boolean) : null;
}

const looksLikePath = (p) => !/[\s<>*?{}$|]/.test(p) && !p.startsWith('-') && !/^[a-z]+:\/\//i.test(p) && (p.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(p));
const inDiff = (p, paths) => {
  const q = p.replace(/^\.\//, '').replace(/\/$/, '');
  return paths.some((d) => d === q || d.endsWith(`/${q}`) || d.startsWith(`${q}/`));
};

function unknownPaths(text, paths) {
  const named = [...lf(text).matchAll(/`([^`\n]+)`/g)].map((m) => m[1].replace(/[.,;:]+$/, '')).filter(looksLikePath);
  return [...new Set(named)].filter((p) => !inDiff(p, paths));
}

/** Problems with the Head label. Returns [{ fail, text }]. */
function headProblems(value, head, git) {
  if (!/^[0-9a-f]{7,40}$/i.test(value)) return [{ fail: true, text: `Head "${value.slice(0, 40)}" is not a commit hash (7 to 40 hex digits)` }];
  const notAncestor = (why) => [{ fail: true, text: `Head ${short(value)} is not an ancestor of HEAD (${why})` }];
  const full = git(['rev-parse', '--verify', '--quiet', `${value}^{commit}`]);
  if (full.status !== 0) return notAncestor('no such commit');
  const sha = String(full.stdout).trim();
  if (git(['merge-base', '--is-ancestor', sha, head]).status !== 0) return notAncestor('the summary was written on another line of history');
  if (sha === head) return [];
  // Branch work only (first parent, no merge commits): files that a merge of the base brought in do not count.
  const since = git(['log', '--first-parent', '--no-merges', '--format=', '--name-only', `${sha}..${head}`]);
  const n = since.status === 0 ? new Set(String(since.stdout).split('\n').map((l) => l.trim()).filter(Boolean)).size : null;
  if (n === null) return [{ fail: false, text: `Head ${short(value)} is older than HEAD; git could not count the files since` }];
  if (n === 0) return [];
  const text = `${n} ${n === 1 ? 'file' : 'files'} changed since Head ${short(value)}`;
  return n > MAX_FILES_SINCE ? [{ fail: true, text: `${text}: the summary is stale` }] : [{ fail: false, text: `Head ${short(value)} is older than HEAD (${text})` }];
}

function labelProblems(fields) {
  return LABELS.flatMap((label) => {
    const values = fields.get(label);
    if (!values) return [{ fail: true, text: `label "${label}" is missing` }];
    if (values.length > 1) return [{ fail: true, text: `label "${label}" appears more than once` }];
    return values[0] === '' ? [{ fail: true, text: `label "${label}" is empty` }] : [];
  });
}

function lengthProblems(fields, text) {
  const out = [];
  for (const label of TEXT_LABELS) {
    const value = fields.get(label)?.[0] ?? '';
    if (wordsOf(value) > MAX_FIELD_WORDS) out.push({ fail: false, text: `${label} has ${wordsOf(value)} words (limit ${MAX_FIELD_WORDS})` });
    const long = value.split(/(?<=[.!?])\s+/).map(wordsOf).find((n) => n > MAX_SENTENCE_WORDS);
    if (long) out.push({ fail: false, text: `a sentence in ${label} has ${long} words (limit ${MAX_SENTENCE_WORDS})` });
  }
  if (wordsOf(text) > MAX_FILE_WORDS) out.push({ fail: false, text: `the file has ${wordsOf(text)} words (limit ${MAX_FILE_WORDS})` });
  return out;
}

function problemsOf(text, { branch, head, base, git }) {
  const fields = parseFields(text);
  const one = (label) => fields.get(label)?.[0] ?? '';
  const out = labelProblems(fields);
  if (one('Branch') && one('Branch') !== branch) out.push({ fail: true, text: `Branch is "${one('Branch')}" but this run is on "${branch}"` });
  if (one('Head') && fields.get('Head').length === 1) out.push(...headProblems(one('Head'), head, git));
  if (one('Risk') && !/^(Low|Medium|High)(?![\w])/.test(one('Risk'))) out.push({ fail: true, text: 'Risk must start with Low, Medium or High' });
  out.push(...lengthProblems(fields, text));
  const paths = diffPaths(git, base);
  if (paths) out.push(...unknownPaths(text, paths).map((p) => ({ fail: false, text: `\`${p}\` is not a file in this diff` })));
  return out;
}

// ok: the file is a real summary of this branch (no FAIL-class problem). A NOTE for an older Head or a long sentence is still ok; a NOTE that hides a FAIL-class problem in note mode is not.
const done = (status, detail, notes, sha, facts, ok = false) => ({ result: { step: 'summary', status, detail, notes }, sha, facts, ok });

function check({ root, head, branch, base = 'main', git, readFile = (f) => readFileSync(f, 'utf8'), mode = 'note' }) {
  const facts = factsOf(git, base);
  let text;
  try { text = readFile(path.join(root, SUMMARY_REL)); } catch { text = null; }
  const problems = typeof text === 'string'
    ? problemsOf(text, { branch, head, base, git })
    : [{ fail: true, text: `no summary file at ${SUMMARY_REL}: write it now (Branch, Head, Base, Problem, Change, You will see, Risk, Not included), paste it to Dave in chat, then run pre-pr again` }];
  const sha = typeof text === 'string' ? hashOf(text) : null;
  const sorted = [...problems.filter((p) => p.fail), ...problems.filter((p) => !p.fail)];
  const failing = sorted.some((p) => p.fail);
  if (sorted.length === 0) return done('PASS', `summary matches ${branch} at ${short(head)}${facts ? ` (${facts})` : ''}`, [], sha, facts, true);
  const status = failing && mode === 'fail' ? 'FAIL' : 'NOTE';
  const rest = sorted.slice(1).map((p) => p.text);
  const notes = [...(facts ? [`facts: ${facts}`] : []), ...rest, ...(failing && status === 'NOTE' ? ['this check only notes for now; it becomes a FAIL when Dave turns it on'] : [])];
  return done(status, `${sorted[0].text}${rest.length ? ` (${rest.length} more below)` : ''}`, notes, sha, facts, !failing);
}

/** { result, sha, facts }: result is the pre-pr step { step: 'summary', status, detail, notes }, sha the file hash or null. Never throws. */
export function checkSummary(args = {}) {
  try {
    return check(args);
  } catch (err) {
    return done('NOTE', `summary check hit an internal error (${String(err?.message ?? err).split('\n')[0]}); the summary was not checked`, [], null, null);
  }
}
