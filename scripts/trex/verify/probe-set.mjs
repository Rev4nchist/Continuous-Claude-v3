// probe-set.mjs: the verify probe set. It reads the trex-baseline records, keeps the open Majors, tags each one with a
// group and attaches the SHAs and the classify() result. No model call.
//
//   node scripts/trex/verify/probe-set.mjs [--base <trex-baseline dir>] [--out <file>]
//
// Groups: A = the finding that is the hit of a positive row (results.json positives[].finding),
//         B = every open Major on an N (negative) row,
//         C = every other open Major on an S (positive) row.
// An open Major is `isMajorOpen` of record.mjs: critical or major, status open, confidence 3 or more.
// The fix SHA and the pre SHA of an S row come from plan.json (fix40, pre40, 40 hex). GROUPS in bench/author.mjs holds only 8 hex.
// `head` and `mergeBase` are the record values (what the review ran on). pre equals head except on S12 and S15 (a merge-commit head).
// The output is deterministic: sorted rows, a fixed key order, no timestamp.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMajorOpen } from '../../github/local-review/record.mjs';
import { classify, wantsSource } from './classify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHA40 = /^[0-9a-f]{40}$/;
const ROW_ID = /^([SN])(\d+)$/;
const HIT_TEXT = /^(.+?):(\d+) (.*)$/;
const GROUP_ORDER = { A: 0, B: 1, C: 2 };

const rowNumber = (id) => Number(ROW_ID.exec(id)[2]);
const sha40 = (v) => (typeof v === 'string' && SHA40.test(v.toLowerCase()) ? v.toLowerCase() : null);
const fail = (id, msg) => { throw new Error(`${id}: ${msg}`); };
const sortedKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));

/** The pid of a finding: its id, or a stable hash of row, file, line and title. */
const pidOf = (row, f) => f.id ?? createHash('sha256').update(`${row}|${f.file}|${f.startLine}|${f.title}`).digest('hex').slice(0, 16);

function hitOf(results, id) {
  const hit = (results?.positives ?? []).find((p) => p.id === id && p.hit === true);
  if (!hit) return null;
  const m = HIT_TEXT.exec(String(hit.finding ?? ''));
  if (!m) fail(id, `hit text "${hit.finding}" is not "<file>:<line> <title>"`);
  return { file: m[1], startLine: Number(m[2]), title: m[3] };
}

function rowShas(id, record, plan) {
  const head = sha40(record.head);
  const mergeBase = sha40(record.mergeBase);
  if (!head) fail(id, `record head "${record.head}" is not a 40-hex sha`);
  if (!mergeBase) fail(id, `record mergeBase "${record.mergeBase}" is not a 40-hex sha`);
  if (id.startsWith('N')) return { head, mergeBase, pre: null, fix: null };
  const prow = (plan?.rows ?? []).find((r) => r.id === id);
  if (!prow) fail(id, 'no plan row, so no fix SHA');
  const fix = sha40(prow.fix40);
  if (!fix) fail(id, `plan row has no 40-hex fix SHA (fix40 = ${JSON.stringify(prow.fix40)})`);
  const pre = sha40(prow.pre40);
  if (!pre) fail(id, `plan row has no 40-hex pre SHA (pre40 = ${JSON.stringify(prow.pre40)})`);
  // The record head is the plan head40. It equals pre40 except on S12 and S15, where the head is a merge commit.
  if (sha40(prow.head40) !== head) fail(id, `record head ${head} is not the plan head40 ${prow.head40}`);
  return { head, mergeBase, pre, fix };
}

function groupOf(id, f, hit) {
  if (id.startsWith('N')) return 'B';
  const matches = hit ? [f].filter((x) => x.file === hit.file && x.startLine === hit.startLine && x.title === hit.title) : [];
  return matches.length ? 'A' : 'C';
}

function rowsOfRecord({ id, record }, { results, plan }, deps) {
  if (!ROW_ID.test(id)) fail(id, 'not an S or N row');
  const shas = rowShas(id, record, plan);
  const hit = hitOf(results, id);
  const majors = (record.findings ?? []).filter(isMajorOpen);
  const hitCount = hit ? majors.filter((f) => groupOf(id, f, hit) === 'A').length : 0;
  if (hit && hitCount === 0) fail(id, `hit "${hit.file}:${hit.startLine} ${hit.title}" matches no open Major`);
  if (hitCount > 1) fail(id, `hit "${hit.file}:${hit.startLine}" matches more than one open Major`);
  return majors.map((f) => {
    const source = wantsSource(f.file) && deps.readSource ? deps.readSource(shas.head, f.file) ?? undefined : undefined;
    const c = classify(f, { source });
    return {
      pid: pidOf(id, f), row: id, group: groupOf(id, f, hit), file: f.file, startLine: f.startLine ?? null, endLine: f.endLine ?? null,
      title: f.title, severity: f.severity, confidence: f.confidence ?? null, head: shas.head, mergeBase: shas.mergeBase, pre: shas.pre, fix: shas.fix,
      blocked: c.blocked, surface: c.surface,
    };
  });
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const compareRows = (a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || rowNumber(a.row) - rowNumber(b.row) || cmp(a.row, b.row)
  || cmp(a.file, b.file) || (a.startLine ?? 0) - (b.startLine ?? 0) || cmp(a.pid, b.pid);

function countsOf(rows) {
  const groups = { A: 0, B: 0, C: 0 };
  const groupB = {};
  const blocked = { A: {}, B: {}, C: {} };
  for (const r of rows) {
    groups[r.group] += 1;
    if (r.group === 'B') groupB[r.row] = (groupB[r.row] ?? 0) + 1;
    if (r.blocked) blocked[r.group][r.blocked] = (blocked[r.group][r.blocked] ?? 0) + 1;
  }
  const blockedOut = Object.fromEntries(Object.entries(blocked).map(([g, by]) => [g, { total: Object.values(by).reduce((a, b) => a + b, 0), ...sortedKeys(by) }]));
  return { total: rows.length, groups, groupB: sortedKeys(groupB), blocked: blockedOut };
}

/**
 * @param {{records: {id: string, record: object}[], results: object, plan: object}} input
 * @param {{readSource?: (head: string, file: string) => string|null}} [deps]
 */
export function buildProbeSet(input, deps = {}) {
  const rows = [];
  const seen = new Set();
  for (const rec of input.records) {
    for (const row of rowsOfRecord(rec, input, deps)) {
      if (seen.has(row.pid)) throw new Error(`${row.row}: duplicate pid ${row.pid}`);
      seen.add(row.pid);
      rows.push(row);
    }
  }
  rows.sort(compareRows);
  return { schema: 1, counts: countsOf(rows), rows };
}

export const serializeProbeSet = (out) => `${JSON.stringify(out, null, 2)}\n`;

/** The trex-baseline folder: TREX_BASELINE_DIR, else the first `.claude/cache/e2e/trex-baseline` found above this file (the primary checkout holds it). */
export function defaultBaselineDir() {
  if (process.env.TREX_BASELINE_DIR) return process.env.TREX_BASELINE_DIR;
  const tail = ['.claude', 'cache', 'e2e', 'trex-baseline'];
  for (let dir = HERE, prev = null; dir !== prev; prev = dir, dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ...tail, 'results.json'))) return path.join(dir, ...tail);
  }
  return path.join(HERE, '..', '..', '..', ...tail);
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Reads every `<S|N><n>/record.json`, results.json and plan.json of a baseline folder. A row folder with no record.json is skipped. */
export function loadBaseline(dir) {
  const records = readdirSync(dir)
    .filter((name) => ROW_ID.test(name) && existsSync(path.join(dir, name, 'record.json')))
    .sort((a, b) => cmp(a[0], b[0]) || rowNumber(a) - rowNumber(b))
    .map((id) => ({ id, record: readJson(path.join(dir, id, 'record.json')) }));
  return { records, results: readJson(path.join(dir, 'results.json')), plan: readJson(path.join(dir, 'plan.json')) };
}

/** The cited file at a head, from git history. null when the commit or file is not in this repo. */
export const gitReadSource = (cwd) => (head, file) => {
  const r = spawnSync('git', ['-C', cwd, 'show', `${head}:${file}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};

/** A plain-text summary of the groups, for the e2e artifact. */
export function summarize(out) {
  const { counts } = out;
  const lines = [`probe-set: ${counts.total} open Majors`, `groups: A ${counts.groups.A}, B ${counts.groups.B}, C ${counts.groups.C}`];
  lines.push(`group A rows: ${out.rows.filter((r) => r.group === 'A').map((r) => r.row).join(' ')}`);
  lines.push(`group B per row: ${Object.entries(counts.groupB).map(([r, n]) => `${r} ${n}`).join(', ')}`);
  for (const g of ['A', 'B', 'C']) {
    const { total, ...by } = counts.blocked[g];
    lines.push(`blocked in ${g}: ${total} of ${counts.groups[g]}${total ? ` (${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}`);
  }
  for (const r of out.rows.filter((x) => x.blocked)) lines.push(`  ${r.group} ${r.row} ${r.file}:${r.startLine} blocked:${r.blocked} (${r.surface})`);
  return lines.join('\n');
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const base = arg('--base') ?? defaultBaselineDir();
  const outFile = arg('--out') ?? path.join(HERE, 'probe-set.json');
  const out = buildProbeSet(loadBaseline(base), { readSource: gitReadSource(HERE) });
  writeFileSync(outFile, serializeProbeSet(out));
  console.log(summarize(out));
  console.log(`wrote ${outFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
