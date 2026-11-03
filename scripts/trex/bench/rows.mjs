// Load and check the P0 bench inputs: proofs-trex.json (positive rows) and negatives.json (spec 5.12, 7, 13.1).
// bench.mjs calls loadRows, loadNegatives, validateRows and validateNegatives before it runs anything.
// Everything here is read only. `git` is (args) => { status, stdout, stderr }.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFlows } from '../flow.mjs';
import { DROPPED_NEGATIVES, FLOWS_DIR, GROUPS, mapNegatives } from './author.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PLACEHOLDER = '<frozen sha>';
/** The rows that must exist: S1-S15 are the catch denominator, S18 is reported outside it. S16 has no row. */
export const ROW_IDS = Object.freeze([...Array.from({ length: 15 }, (_, i) => `S${i + 1}`), 'S18']);
export const FIRE_MATCH = '^not ok ';
export const ROW_TIMEOUT_MS = 900000;
const NEGATIVE_KINDS = ['skip'];

// ---------- loading ----------

/** The rows array of a proofs file. Throws when the file has no rows array. */
export function loadRows(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(j?.rows)) throw new Error(`${file}: "rows" must be an array`);
  return j.rows;
}

function checkNegative(n, seen) {
  const id = n?.id;
  if (typeof id !== 'string' || id === '') throw new Error('negative: "id" must be a non-empty string');
  if (typeof n.head !== 'string' || n.head === '') throw new Error(`negative ${id}: "head" must be a non-empty string`);
  if (n.kind !== undefined && !NEGATIVE_KINDS.includes(n.kind)) throw new Error(`negative ${id}: "kind" must be one of ${NEGATIVE_KINDS.join(', ')}`);
  if (seen.has(id)) throw new Error(`negative ${id}: duplicate id`);
  seen.add(id);
}

/** [{id, head, kind?, why?}] from a bare list or { negatives }. Throws on a bad entry or a duplicate id. */
export function loadNegatives(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(j) ? j : j?.negatives;
  if (!Array.isArray(list)) throw new Error(`${file}: "negatives" must be an array`);
  const seen = new Set();
  for (const n of list) checkNegative(n, seen);
  return list;
}

// ---------- rows ----------

const groupOf = (major) => (major === 'S7' ? 'S6' : major);
const flagValue = (cmd, flag) => (Array.isArray(cmd) && cmd.includes(flag) ? cmd[cmd.indexOf(flag) + 1] : undefined);
const isFrozenRef = (v) => v === PLACEHOLDER || /^[0-9a-f]{7,40}$/.test(String(v));

function idProblems(rows, expect) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.major)) out.push(`${r.major}: duplicate row`);
    seen.add(r.major);
    if (r.major === 'S16') out.push('S16: excluded (no source anchor), it must have no row');
  }
  for (const id of expect) if (!seen.has(id)) out.push(`${id}: row missing`);
  return out;
}

function shaProblems(git, label, field, sha, ref, needAncestor) {
  if (git(['cat-file', '-e', `${sha}^{commit}`]).status !== 0) return [`${label}: ${field} ${sha} not found in git`];
  if (!needAncestor) return [];
  const s = git(['merge-base', '--is-ancestor', sha, ref]).status;
  if (s === 0) return [];
  return [s === 1 ? `${label}: ${field} ${sha} is not an ancestor of ${ref}` : `${label}: ancestor check of ${field} ${sha} against ${ref} failed`];
}

const rangeEnds = (range) => String(range).split('..').map((s) => s.replace(/\^\d*$/, '')).filter(Boolean);

function cmdProblems(row, group, root) {
  const out = [];
  const L = row.major;
  const dir = `${FLOWS_DIR}/${group}`;
  if (!isFrozenRef(flagValue(row.cmd, '--config'))) out.push(`${L}: --config must be the literal "${PLACEHOLDER}" or a frozen sha`);
  if (flagValue(row.cmd, '--flows-dir') !== dir) out.push(`${L}: --flows-dir must be ${dir}`);
  else if (!existsSync(path.join(root, dir))) out.push(`${L}: flows dir ${dir} does not exist`);
  if (flagValue(row.cmd, '--simulate') !== 'tree') out.push(`${L}: cmd must run --simulate tree`);
  if (flagValue(row.cmd, '--tree') !== '{tree}') out.push(`${L}: cmd must pass --tree {tree}`);
  if (flagValue(row.cmd, '--evidence') !== '{tree}/.trex-out') out.push(`${L}: cmd must pass --evidence {tree}/.trex-out`);
  if (row.cmd?.[1] !== '{repo}/scripts/trex/run.mjs') out.push(`${L}: cmd must run {repo}/scripts/trex/run.mjs`);
  return out;
}

function benchProblems(row, group, g) {
  const b = row.bench ?? {};
  const L = row.major;
  const out = [];
  if (b.kind !== 'catch') out.push(`${L}: bench.kind must be "catch"`);
  if (b.group !== group) out.push(`${L}: bench.group must be ${group} (got ${b.group})`);
  if (b.phase !== 'P0') out.push(`${L}: bench.phase must be "P0"`);
  if (b.authorRange !== g.range) out.push(`${L}: bench.authorRange must be ${g.range} (the author.mjs group range)`);
  const files = b.defectFiles;
  if (!Array.isArray(files) || files.length === 0 || files.some((f) => typeof f !== 'string' || f === '')) out.push(`${L}: bench.defectFiles must be a non-empty list of paths`);
  return out;
}

function fieldProblems(row, g) {
  const L = row.major;
  const out = [];
  if (row.check !== 'trex') out.push(`${L}: check must be "trex"`);
  if (row.copy !== undefined) out.push(`${L}: copy is not allowed (a copied run.mjs would import the old pre-pr.mjs)`);
  if (JSON.stringify(row.paths) !== '["."]') out.push(`${L}: paths must be ["."]`);
  if (row.fireMatch !== FIRE_MATCH) out.push(`${L}: fireMatch must be ${FIRE_MATCH}`);
  if (row.timeoutMs !== ROW_TIMEOUT_MS) out.push(`${L}: timeoutMs must be ${ROW_TIMEOUT_MS}`);
  if (row.pre !== g.pre) out.push(`${L}: pre ${row.pre} differs from the author group (${g.pre})`);
  if (row.fix !== g.fix) out.push(`${L}: fix ${row.fix} differs from the author group (${g.fix})`);
  return out;
}

function rowProblems(git, row, o) {
  const group = groupOf(row.major);
  const g = GROUPS[group];
  if (!g) return [`${row.major}: no author group ${group}`];
  const out = [...fieldProblems(row, g), ...benchProblems(row, group, g), ...cmdProblems(row, group, o.root)];
  for (const f of ['pre', 'fix']) out.push(...shaProblems(git, row.major, f, row[f] ?? g[f], o.ref, true));
  for (const sha of rangeEnds(g.range)) out.push(...shaProblems(git, row.major, 'range end', sha, o.ref, false));
  return out;
}

/**
 * Problems in the positive rows, as strings. [] means all good.
 * opts: { root (repo), ref ('fork/main'), expect (the row ids that must exist) }.
 * The --config value may still be the placeholder, or already a frozen sha.
 */
export function validateRows(git, rows, opts = {}) {
  const o = { root: REPO, ref: 'fork/main', expect: ROW_IDS, ...opts };
  const out = idProblems(rows, o.expect);
  for (const row of rows) out.push(...rowProblems(git, row, o));
  return out;
}

// ---------- negatives ----------

function groupFlows(git, sha) {
  return Object.fromEntries(Object.keys(GROUPS).map((g) => [g, loadFlows(git, sha, `${FLOWS_DIR}/${g}`).map((f) => ({ id: f.id, paths: f.paths }))]));
}

function headProblems(git, n, ref) {
  if (DROPPED_NEGATIVES.includes(n.id)) return [`${n.id}: dropped by spec 13.1 (it holds a live seed defect)`];
  if (git(['cat-file', '-e', `${n.head}^{commit}`]).status !== 0) return [`${n.id}: head ${n.head} not found in git`];
  return shaProblems(git, n.id, 'head', n.head, ref, true);
}

function mapProblems(negatives, mapped) {
  const out = [...mapped.problems];
  for (const n of negatives) {
    const why = mapped.skipped[n.id];
    if (why === 'not_clean' && n.kind !== 'skip') out.push(`${n.id}: not_clean, no touched group has its fix as an ancestor of the head`);
    if (n.kind === 'skip' && why !== 'no_match' && !mapped.problems.some((p) => p.startsWith(n.id))) out.push(`${n.id}: a skip negative must be no_match (got ${why ?? 'graded'})`);
  }
  return out;
}

/**
 * Problems in the negatives, as strings. [] means all good.
 * Spec 13.1: a (negative, group) pair is graded only when fix(group) is an ancestor of the head. A negative must be clean
 * for the groups it touches, and at least `minTested` of them must be graded for one group (a no_match one is not tested).
 * opts: { sha ('HEAD', where the frozen flows are read), ref, minTested (10), flows, fixes } (flows and fixes are for tests).
 */
export function validateNegatives(git, negatives, opts = {}) {
  const o = { sha: 'HEAD', ref: 'fork/main', minTested: 10, ...opts };
  const out = negatives.flatMap((n) => headProblems(git, n, o.ref));
  const ctx = { groups: o.flows ?? groupFlows(git, o.sha), fixes: o.fixes ?? Object.fromEntries(Object.entries(GROUPS).map(([k, v]) => [k, v.fix])) };
  const mapped = mapNegatives(negatives, ctx, git);
  out.push(...mapProblems(negatives, mapped));
  const tested = negatives.filter((n) => n.kind !== 'skip' && (mapped.negatives[n.id] ?? []).length > 0).length;
  if (tested < o.minTested) out.push(`only ${tested} negatives are tested (graded for at least one group); the bench needs ${o.minTested}`);
  return out;
}
