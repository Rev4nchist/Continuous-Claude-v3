// Grade one check against the result of one step. Pure code: no model, no I/O.
// StepResult: {code, stdout, stderr, timedOut, files, reason?, status?, body?}.
//   files maps a path to its text. null means the file does not exist. A missing key means nobody read it.
//   reason is set by a driver that refused to run the step. Every check then reads as blocked.
// Check states: passed | failed | blocked | not_attempted. Reasons are fixed codes, never child output.

import { isDeepStrictEqual } from 'node:util';
import { CHECK_KINDS } from './flow.mjs';

const UNSUPPORTED = new Set(['judge', 'playwright']);
const passed = () => ({ state: 'passed' });
const failed = (reason) => ({ state: 'failed', reason });
const blocked = (reason) => ({ state: 'blocked', reason });
const invalid = () => blocked('check_invalid');
const verdict = (ok, reason) => (ok ? passed() : failed(reason));
const text = (v) => (typeof v === 'string' ? v : '');

/** Multi-line anchors: `^not ok ` must match at the start of any line. Returns null for a bad regex. */
function compile(source) {
  try { return new RegExp(source, 'm'); } catch { return null; }
}

/** Run `fn` with a compiled regex, or give check_invalid when the regex is bad. */
function withRegex(source, fn) {
  const re = typeof source === 'string' ? compile(source) : null;
  return re ? fn(re) : invalid();
}

/** Read a collected file. Returns {content} or a ready verdict (blocked: not read, failed: absent). */
function readFile(files, name) {
  if (typeof name !== 'string' || !files || !Object.hasOwn(files, name)) return { done: invalid() };
  if (files[name] === null) return { done: failed('file_missing') };
  return { content: text(files[name]) };
}

/** `a.b[0].c` or `a.b.0.c`, with an optional leading `$`. Returns null for an empty path. */
function pathTokens(p) {
  if (typeof p !== 'string') return null;
  const tokens = p.replace(/^\$\.?/, '').match(/[^.[\]]+/g);
  return tokens && tokens.length ? tokens : null;
}

/** Walk own properties only, so `constructor` and `__proto__` are never found. */
function walk(value, tokens) {
  let cur = value;
  for (const t of tokens) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, t)) return { found: false };
    cur = cur[t];
  }
  return { found: true, value: cur };
}

function gradeJson(check, r) {
  const spec = check.json;
  const tokens = pathTokens(spec?.path);
  const file = readFile(r.files, spec?.file);
  if (!tokens || !Object.hasOwn(spec, 'equals')) return invalid();
  if (file.done) return file.done;
  let doc;
  try { doc = JSON.parse(file.content); } catch { return failed('json_bad'); }
  const hit = walk(doc, tokens);
  if (!hit.found) return failed('json_path_missing');
  return verdict(isDeepStrictEqual(hit.value, spec.equals), 'json_mismatch');
}

function gradeFile(check, r) {
  const file = readFile(r.files, check.file);
  if (file.done) return file.done;
  if (Object.hasOwn(check, '~')) return withRegex(check['~'], (re) => verdict(re.test(file.content), 'file_no_match'));
  if (Object.hasOwn(check, '!~')) return withRegex(check['!~'], (re) => verdict(!re.test(file.content), 'file_matched'));
  return passed();
}

function gradeBody(source, r, wantMatch) {
  if (typeof r.body !== 'string') return invalid();
  return withRegex(source, (re) => verdict(re.test(r.body) === wantMatch, wantMatch ? 'body_no_match' : 'body_matched'));
}

const GRADERS = {
  exit: (c, r) => (Number.isInteger(c.exit) ? verdict(r.code === c.exit, 'exit_mismatch') : invalid()),
  stdout: (c, r) => withRegex(c.stdout, (re) => verdict(re.test(text(r.stdout)), 'stdout_no_match')),
  '!stdout': (c, r) => withRegex(c['!stdout'], (re) => verdict(!re.test(text(r.stdout)), 'stdout_matched')),
  status: (c, r) => (typeof r.status === 'number' ? verdict(r.status === c.status, 'status_mismatch') : invalid()),
  body: (c, r) => gradeBody(c.body, r, true),
  '!body': (c, r) => gradeBody(c['!body'], r, false),
  file: gradeFile,
  json: gradeJson,
};

/** The one check kind a check carries, or null when it carries none or more than one. */
function kindOf(check) {
  if (check === null || typeof check !== 'object' || Array.isArray(check)) return null;
  const kinds = CHECK_KINDS.filter((k) => Object.hasOwn(check, k));
  return kinds.length === 1 ? kinds[0] : null;
}

/**
 * Grade one check. Order of rules: bad check, kind not built in P0, step not run, driver refusal, timeout, then the kind.
 * @returns {{state: 'passed'|'failed'|'blocked'|'not_attempted', reason?: string}}
 */
export function gradeCheck(check, stepResult) {
  const kind = kindOf(check);
  if (!kind) return invalid();
  if (UNSUPPORTED.has(kind)) return blocked('unsupported_in_p0');
  if (stepResult === null || stepResult === undefined) return { state: 'not_attempted', reason: 'step_not_run' };
  if (stepResult.reason) return blocked(stepResult.reason);
  if (stepResult.timedOut) return { state: 'not_attempted', reason: 'timeout' };
  return GRADERS[kind](check, stepResult);
}

/** Paths a driver must read after a step so `file` and `json` checks can be graded. Each path once, in order. */
export function filesWanted(checks) {
  const wanted = [];
  for (const c of checks ?? []) {
    const name = Object.hasOwn(c ?? {}, 'file') ? c.file : c?.json?.file;
    if (typeof name === 'string' && !wanted.includes(name)) wanted.push(name);
  }
  return wanted;
}
