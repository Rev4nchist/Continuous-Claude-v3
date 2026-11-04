#!/usr/bin/env node
// apply-verdicts.mjs: write copies of the 25 trex-baseline records with one arm's verdicts applied. No model, no Docker.
//
//   node scripts/trex/verify/apply-verdicts.mjs --verdicts <arm>/verdicts.json [--baseline <dir>] [--out <dir>]
//
// Input: a C2 file {arm, generatedFrom, rows:[{pid,row,verdict,reason,newSeverity,newConfidence,...}]} of arm verify, oracle0 or rerate.
// Output: <out>/<arm>/records/<row>/record.json for every <S|N><n>/record.json of the baseline. <out> defaults to the folder
//   above <arm>/verdicts.json. Findings without a C2 row are copied unchanged. The baseline is read-only: it is never written.
// Each matched finding goes through applyVerdict() (verdict.mjs), so it gets `verify.{verdict,reason,originalSeverity,originalConfidence,...}`.
// An arm whose verdict is not a verify verdict (rerate_down) carries its result in newSeverity/newConfidence: those are used when they
// lower the finding. Nothing here raises a severity or a confidence. majorsOpen of the copy is recomputed from its findings; the source
// count stays in `verifyApplied.originalMajorsOpen`. Exit: 0 all pids matched, 1 some pid matched no finding, 2 bad input.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { majorsOpen } from '../../github/local-review/record.mjs';
import { applyVerdict } from './verdict.mjs';
import { defaultBaselineDir } from './probe-set.mjs';

export const ARMS = Object.freeze(['verify', 'oracle0', 'rerate']);
const ROW_ID = /^[SN]\d+$/;
const SEVERITY_RANK = { critical: 5, major: 4, minor: 3, trivial: 2, info: 1 };
const DEFAULT_CONFIDENCE = 3;

export class InputError extends Error {}

function checkC2(c2) {
  if (!c2 || typeof c2 !== 'object') throw new InputError('the verdicts file must be an object');
  if (!ARMS.includes(c2.arm)) throw new InputError(`arm "${c2.arm}" must be one of ${ARMS.join(', ')}`);
  if (!Array.isArray(c2.rows)) throw new InputError('rows must be an array');
  const seen = new Set();
  for (const r of c2.rows) {
    if (typeof r?.pid !== 'string' || typeof r?.row !== 'string') throw new InputError('every row needs a string pid and row');
    if (typeof r.verdict !== 'string' || r.verdict === '') throw new InputError(`row ${r.pid} has no verdict`);
    if (seen.has(r.pid)) throw new InputError(`duplicate pid ${r.pid}`);
    seen.add(r.pid);
  }
}

const inside = (dir, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** The record folders of a baseline: <S|N><n>/record.json, in row order. */
function recordRows(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && ROW_ID.test(e.name))
    .map((e) => e.name)
    .filter((n) => readdirSync(path.join(dir, n)).includes('record.json'))
    .sort((a, b) => a[0].localeCompare(b[0]) || Number(a.slice(1)) - Number(b.slice(1)));
}

/** applyVerdict's result, then the arm's own newSeverity and newConfidence when they are lower. Never raises. */
function applyRow(finding, row) {
  const next = applyVerdict(finding, { verdict: row.verdict, reason: row.reason ?? '', priorOpen: false });
  const rank = SEVERITY_RANK[next.severity];
  if (rank !== undefined && SEVERITY_RANK[row.newSeverity] !== undefined && SEVERITY_RANK[row.newSeverity] < rank) next.severity = row.newSeverity;
  const current = typeof next.confidence === 'number' && Number.isFinite(next.confidence) ? next.confidence : DEFAULT_CONFIDENCE;
  if (Number.isFinite(row.newConfidence) && row.newConfidence < current) next.confidence = row.newConfidence;
  return next;
}

function applyToRecord(record, rowId, { rows, arm }, matched) {
  const copy = structuredClone(record);
  const original = majorsOpen(record).length;
  copy.findings = (copy.findings ?? []).map((f) => {
    const row = rows.find((r) => r.row === rowId && r.pid === f.id);
    if (!row) return f;
    matched.add(row.pid);
    return applyRow(f, row);
  });
  copy.majorsOpen = majorsOpen(copy).length;
  return { ...copy, verifyApplied: { arm, originalMajorsOpen: original } };
}

/**
 * @param {{ c2: object, baselineDir: string, outDir: string }} input
 * @returns {{ arm: string, records: number, applied: number, unmatched: string[], written: string[] }}
 */
export function applyArm({ c2, baselineDir, outDir }) {
  checkC2(c2);
  if (inside(outDir, baselineDir)) throw new InputError('the out dir is inside the baseline dir: the baseline stays read-only');
  const matched = new Set();
  const written = [];
  for (const rowId of recordRows(baselineDir)) {
    const record = JSON.parse(readFileSync(path.join(baselineDir, rowId, 'record.json'), 'utf8'));
    const dest = path.join(outDir, c2.arm, 'records', rowId, 'record.json');
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, `${JSON.stringify(applyToRecord(record, rowId, c2, matched), null, 2)}\n`);
    written.push(dest);
  }
  const unmatched = c2.rows.map((r) => r.pid).filter((p) => !matched.has(p));
  return { arm: c2.arm, records: written.length, applied: matched.size, unmatched, written };
}

function parseArgs(argv) {
  const o = { verdicts: null, baseline: null, out: null };
  const keys = { '--verdicts': 'verdicts', '--baseline': 'baseline', '--out': 'out' };
  for (let i = 0; i < argv.length; i += 1) {
    if (!keys[argv[i]]) throw new InputError(`unknown argument ${argv[i]}`);
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new InputError(`${argv[i]} needs a value`);
    o[keys[argv[i]]] = argv[++i];
  }
  if (!o.verdicts) throw new InputError('--verdicts <file> is required');
  return o;
}

export async function main(argv, deps = {}) {
  const out = deps.out ?? console.log;
  try {
    const o = parseArgs(argv);
    const file = path.resolve(o.verdicts);
    const c2 = JSON.parse(readFileSync(file, 'utf8'));
    const outDir = path.resolve(o.out ?? path.dirname(path.dirname(file)));
    const r = applyArm({ c2, baselineDir: path.resolve(o.baseline ?? defaultBaselineDir()), outDir });
    out(`# apply-verdicts: arm ${r.arm}, ${r.records} records written under ${path.join(outDir, r.arm, 'records').replaceAll('\\', '/')}, ${r.applied} of ${c2.rows.length} verdict rows applied`);
    if (r.unmatched.length > 0) out(`# apply-verdicts: unmatched pids (no finding with that id in that row): ${r.unmatched.join(', ')}`);
    return r.unmatched.length > 0 ? 1 : 0;
  } catch (err) {
    if (!(err instanceof InputError) && !(err instanceof SyntaxError) && err?.code !== 'ENOENT') throw err;
    out(`# apply-verdicts: ${String(err.message).split('\n')[0]}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((c) => process.exit(c));
