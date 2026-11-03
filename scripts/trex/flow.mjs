// TREX flow files: load them through git, parse them with `yaml`, and check them against the section 4 schema.
// This module is the schema freeze. Other TREX modules import its constants and validators.
// Never import js-yaml from apps/agentic-os/node_modules. Use the root `yaml` devDependency.

import { parse } from 'yaml';

export const DRIVERS = Object.freeze(['cli', 'hook', 'mod-event', 'api', 'browser']);
export const MODES = Object.freeze(['scripted', 'agent']);
export const PROFILES = Object.freeze(['container', 'host']);
export const NEEDS = Object.freeze(['db', 'git']);
export const SEVERITIES = Object.freeze(['P0', 'P1', 'P2']);
export const CHECK_KINDS = Object.freeze(['exit', 'stdout', '!stdout', 'json', 'status', 'body', '!body', 'file', 'playwright', 'judge']);
/** Extra keys that only a `file` check may carry. */
export const FILE_MODIFIERS = Object.freeze(['~', '!~']);
export const ID_RE = /^[a-z0-9-]{3,64}$/;
export const TITLE_MAX = 120;
export const STEPS_MAX = 100;
export const LIMIT_BOUNDS = Object.freeze({ timeoutMs: [1, 900000], retries: [0, 2], maxSteps: [1, STEPS_MAX] });
export const DEFAULT_LIMITS = Object.freeze({ timeoutMs: 60000, retries: 1, maxSteps: STEPS_MAX });
export const HTTP_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

// ---------- small value tests. Each rule returns an error text, or null when the value is fine. ----------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.hasOwn(o, k);
const oneLine = (v) => typeof v === 'string' && v.trim() !== '' && !/[\r\n]/.test(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

const ruleLine = (v) => (oneLine(v) ? null : 'must be a non-empty one-line string');
const ruleText = (v) => (typeof v === 'string' ? null : 'must be a string');
const ruleInt = (lo, hi) => (v) => (isInt(v, lo, hi) ? null : `must be an integer from ${lo} to ${hi}`);
const ruleOneOf = (list) => (v) => (list.includes(v) ? null : `must be one of ${list.join(', ')}`);
const ruleArgv = (v) => (Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === 'string') ? null : 'must be a non-empty array of strings');
const ruleAny = () => null;

/** A tree-relative path: posix, no drive letter, no absolute start, no `..`. Fixture paths use it. */
function ruleRelPath(v) {
  if (!oneLine(v)) return 'must be a non-empty one-line string';
  if (v.includes('\\') || /^[A-Za-z]:/.test(v) || v.startsWith('/')) return 'must be a relative posix path';
  if (v.split('/').includes('..')) return 'must not contain ".."';
  return null;
}

function ruleRegex(v) {
  if (!oneLine(v)) return 'must be a non-empty one-line regex';
  try { new RegExp(v); return null; } catch (err) { return `is not a valid regex (${err.message})`; }
}

function ruleEnv(v) {
  const ok = isObj(v) && Object.values(v).every((x) => typeof x === 'string');
  return ok ? null : 'must be a mapping of strings';
}

// ---------- shapes: required and optional keys with a rule each. Unknown keys fail. ----------

function applyShape(obj, shape, prefix = '') {
  const errors = [];
  for (const key of Object.keys(obj)) {
    if (!has(shape.required, key) && !has(shape.optional, key)) errors.push(`${prefix}unknown key "${key}"`);
  }
  for (const [key, rule] of Object.entries(shape.required)) {
    if (!has(obj, key)) errors.push(`${prefix}${key} is required`);
    else addRule(errors, `${prefix}${key}`, rule(obj[key]));
  }
  for (const [key, rule] of Object.entries(shape.optional)) {
    if (has(obj, key)) addRule(errors, `${prefix}${key}`, rule(obj[key]));
  }
  return errors;
}

function addRule(errors, name, message) {
  if (message) errors.push(`${name} ${message}`);
}

/** A rule for a nested mapping. It reports the inner errors in one message. */
const ruleShape = (shape) => (v) => {
  if (!isObj(v)) return 'must be a mapping';
  const inner = applyShape(v, shape);
  return inner.length ? `is invalid (${inner.join('; ')})` : null;
};

// ---------- driver actions ----------

const ACTION_SHAPES = Object.freeze({
  cli: { required: { cmd: ruleArgv }, optional: { cwd: ruleRelPath, env: ruleEnv, stdin: ruleText } },
  hook: { required: { hook: ruleRelPath, payload: ruleRelPath }, optional: {} },
  'mod-event': { required: { test: ruleLine }, optional: {} },
  api: {
    required: { method: ruleOneOf(HTTP_METHODS), path: (v) => (oneLine(v) && v.startsWith('/') ? null : 'must be a one-line path that starts with "/"') },
    optional: { bodyFile: ruleRelPath },
  },
  browser: {
    required: { playwright: ruleLine, config: ruleLine, projects: (v) => (Array.isArray(v) && v.length > 0 && v.every(oneLine) ? null : 'must be a non-empty array of names') },
    optional: {},
  },
});

/** Errors for one step action. The shape depends on the flow driver. */
export function validateAction(driver, action) {
  if (!DRIVERS.includes(driver)) return [`driver "${String(driver)}" is not one of ${DRIVERS.join(', ')}`];
  if (!isObj(action)) return ['action must be a mapping'];
  return applyShape(action, ACTION_SHAPES[driver]);
}

// ---------- checks ----------

const JSON_SHAPE = { required: { file: ruleLine, path: ruleLine, equals: ruleAny }, optional: {} };
const JUDGE_SHAPE = { required: { artifact: ruleLine }, optional: {} };

/** One rule per check kind. `file` is a path; its `~` and `!~` modifiers are checked in fileErrors. */
const KIND_RULES = Object.freeze({
  exit: ruleInt(0, 0xFFFFFFFF),
  stdout: ruleRegex,
  '!stdout': ruleRegex,
  json: ruleShape(JSON_SHAPE),
  status: ruleInt(100, 599),
  body: ruleRegex,
  '!body': ruleRegex,
  file: ruleLine,
  playwright: (v) => (v === 'passed' ? null : 'must be "passed"'),
  judge: ruleShape(JUDGE_SHAPE),
});

function fileErrors(check) {
  const errors = [];
  const mods = FILE_MODIFIERS.filter((m) => has(check, m));
  if (mods.length > 0 && !has(check, 'file')) errors.push(`"${mods[0]}" needs a file check`);
  if (mods.length > 1) errors.push('a file check takes "~" or "!~", not both');
  for (const m of mods) addRule(errors, `"${m}"`, ruleRegex(check[m]));
  return errors;
}

/** Errors for one check. `mode` is the flow mode: `judge` is allowed only in `agent`. */
export function validateCheck(check, mode = 'scripted') {
  if (!isObj(check)) return ['check must be a mapping'];
  const errors = [];
  const known = new Set(['text', ...CHECK_KINDS, ...FILE_MODIFIERS]);
  for (const key of Object.keys(check)) if (!known.has(key)) errors.push(`unknown key "${key}"`);
  addRule(errors, 'text', ruleLine(check.text));
  const kinds = CHECK_KINDS.filter((k) => has(check, k));
  if (kinds.length !== 1) errors.push(`a check needs exactly one kind of ${CHECK_KINDS.join(', ')} (found ${kinds.length})`);
  for (const kind of kinds) addRule(errors, kind, KIND_RULES[kind](check[kind]));
  if (has(check, 'judge') && mode !== 'agent') errors.push('judge is allowed only in mode agent');
  return [...errors, ...fileErrors(check)];
}

// ---------- flow fields ----------

const FLOW_KEYS = ['id', 'title', 'description', 'goal', 'paths', 'symbols', 'driver', 'mode', 'profile', 'needs', 'start', 'steps', 'limits', 'severity'];

/** Same syntax as matchGlob in review-router.mjs: posix, no "./", no braces. Read there, not imported. */
function ruleGlob(v) {
  if (!oneLine(v)) return 'must be a non-empty one-line string';
  if (v.includes('\\')) return 'must use "/" as separator';
  if (/[{}]/.test(v)) return 'must not use braces';
  if (v.split('/').some((s) => s === '' || s === '.' || s === '..')) return 'must not start with "./" or "/", and must have no empty, "." or ".." segment';
  return null;
}

function ruleList(rule) {
  return (v) => {
    if (!Array.isArray(v)) return 'must be an array';
    const bad = v.map(rule).findIndex((m) => m);
    return bad < 0 ? null : `[${bad}] ${rule(v[bad])}`;
  };
}

const rulePaths = (v) => (Array.isArray(v) && v.length > 0 ? ruleList(ruleGlob)(v) : 'must be a non-empty array of globs');
const ruleNeeds = (v) => ruleList(ruleOneOf(NEEDS))(v) ?? (new Set(v).size === v.length ? null : 'must not repeat a value');

const START_SHAPE = {
  required: {},
  optional: {
    git: (v) => (v === 'commit' ? null : 'must be "commit"'),
    remote: ruleLine, stamp: ruleRelPath, db: ruleRelPath, cwd: ruleRelPath, run: ruleArgv, note: ruleLine,
    serve: ruleShape({ required: { cmd: ruleArgv, port: ruleInt(1, 65535), ready: ruleLine }, optional: {} }),
  },
};

const LIMITS_SHAPE = { required: {}, optional: Object.fromEntries(Object.entries(LIMIT_BOUNDS).map(([k, [lo, hi]]) => [k, ruleInt(lo, hi)])) };

function headErrors(flow) {
  const errors = [];
  const title = (v) => (oneLine(v) && v.length <= TITLE_MAX ? null : `must be one line, 1 to ${TITLE_MAX} characters`);
  const id = (v) => (typeof v === 'string' && ID_RE.test(v) ? null : `must match ${ID_RE}`);
  const required = { id, title, description: ruleLine, goal: ruleLine, paths: rulePaths, driver: ruleOneOf(DRIVERS) };
  const optional = { symbols: ruleList(ruleLine), mode: ruleOneOf(MODES), profile: ruleOneOf(PROFILES), needs: ruleNeeds, severity: ruleOneOf(SEVERITIES) };
  for (const [key, rule] of Object.entries(required)) {
    if (!has(flow, key)) errors.push(`${key} is required`);
    else addRule(errors, key, rule(flow[key]));
  }
  for (const [key, rule] of Object.entries(optional)) if (has(flow, key)) addRule(errors, key, rule(flow[key]));
  if (flow.profile === 'host' && flow.mode === 'agent') errors.push('profile host allows only mode scripted');
  return errors;
}

function startErrors(flow) {
  if (!has(flow, 'start')) return [];
  if (!isObj(flow.start)) return ['start must be a mapping'];
  const errors = applyShape(flow.start, START_SHAPE, 'start.');
  if (has(flow.start, 'note') && flow.mode !== 'agent') errors.push('start.note is allowed only in mode agent');
  if (has(flow.start, 'db') && !(Array.isArray(flow.needs) && flow.needs.includes('db'))) errors.push('start.db needs "db" in needs');
  return errors;
}

function limitsErrors(flow) {
  if (!has(flow, 'limits')) return [];
  if (!isObj(flow.limits)) return ['limits must be a mapping'];
  return applyShape(flow.limits, LIMITS_SHAPE, 'limits.');
}

function stepErrors(step, i, flow) {
  if (!isObj(step)) return [`steps[${i}] must be a mapping`];
  const errors = [];
  for (const key of Object.keys(step)) if (key !== 'action' && key !== 'checks') errors.push(`steps[${i}] unknown key "${key}"`);
  if (!has(step, 'action')) errors.push(`steps[${i}].action is required`);
  else if (DRIVERS.includes(flow.driver)) errors.push(...validateAction(flow.driver, step.action).map((e) => `steps[${i}].action: ${e}`));
  if (!Array.isArray(step.checks) || step.checks.length === 0) errors.push(`steps[${i}].checks must be a non-empty array`);
  else step.checks.forEach((c, j) => errors.push(...validateCheck(c, flow.mode ?? 'scripted').map((e) => `steps[${i}].checks[${j}]: ${e}`)));
  return errors;
}

function stepsErrors(flow) {
  if (!has(flow, 'steps')) return ['steps is required'];
  const steps = flow.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > STEPS_MAX) return [`steps must be an array of 1 to ${STEPS_MAX} steps`];
  const errors = steps.flatMap((s, i) => stepErrors(s, i, flow));
  const cap = isObj(flow.limits) ? flow.limits.maxSteps : undefined;
  if (Number.isInteger(cap) && steps.length > cap) errors.push(`steps has ${steps.length} entries, over limits.maxSteps ${cap}`);
  return errors;
}

/** All problems in one flow object, as text. An empty array means the flow is valid. */
export function validateFlow(flow) {
  if (!isObj(flow)) return ['flow must be a mapping'];
  const errors = Object.keys(flow).filter((k) => !FLOW_KEYS.includes(k)).map((k) => `unknown key "${k}"`);
  return [...errors, ...headErrors(flow), ...startErrors(flow), ...limitsErrors(flow), ...stepsErrors(flow)];
}

/** A copy of a valid flow with the defaults filled in. */
export function normalizeFlow(flow) {
  const out = structuredClone(flow);
  out.mode ??= 'scripted';
  out.profile ??= 'container';
  out.needs ??= [];
  out.severity ??= 'P1';
  out.limits = { ...DEFAULT_LIMITS, ...out.limits };
  return out;
}

// ---------- loading through git ----------

/** Thrown when a flow file cannot be read, parsed or validated. `problems` is [{file, errors}]. */
export class FlowError extends Error {
  constructor(problems) {
    super(problems.map((p) => `${p.file}: ${p.errors.join('; ')}`).join('\n'));
    this.name = 'FlowError';
    this.problems = problems;
  }
}

const FLOW_FILE_RE = /\.ya?ml$/i;

function listFlowFiles(git, sha, dir) {
  const r = git(['ls-tree', '-r', '--name-only', '-z', sha, '--', dir]);
  if (r.status !== 0) throw new Error(`git ls-tree ${sha} ${dir} failed: ${r.stderr.trim()}`);
  return r.stdout.split('\0').filter((p) => FLOW_FILE_RE.test(p)).sort();
}

function readFlowText(git, sha, file) {
  const r = git(['show', `${sha}:${file}`]);
  if (r.status !== 0) throw new Error(`git show ${sha}:${file} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

function parseFlowFile(text) {
  try { return { value: parse(text) }; } catch (err) { return { error: `YAML error: ${String(err.message).split('\n')[0]}` }; }
}

/**
 * Read every *.yaml / *.yml flow under `dir` at commit `sha`, through git only. Never reads the working tree.
 * `git` is a function `(args: string[]) => {status, stdout, stderr}`, as `makeGit` in pre-pr.mjs returns.
 * Returns normalized flows sorted by file path. Throws a FlowError when any file is invalid or two flows share an id.
 */
export function loadFlows(git, sha, dir = '.trex/flows') {
  const root = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  const flows = [];
  const problems = [];
  const seen = new Map();
  for (const file of listFlowFiles(git, sha, root)) {
    const parsed = parseFlowFile(readFlowText(git, sha, file));
    const errors = parsed.error ? [parsed.error] : validateFlow(parsed.value);
    if (!parsed.error && errors.length === 0 && seen.has(parsed.value.id)) errors.push(`id "${parsed.value.id}" is also used by ${seen.get(parsed.value.id)}`);
    if (errors.length) { problems.push({ file, errors }); continue; }
    seen.set(parsed.value.id, file);
    flows.push(normalizeFlow(parsed.value));
  }
  if (problems.length) throw new FlowError(problems);
  return flows;
}
