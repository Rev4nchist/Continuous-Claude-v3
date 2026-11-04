// author-input.mjs: what the verify authoring arm gives a model, and how it checks the answer. No model call.
//
//   verifyRowIds(probeSet)                    the records that hold at least one finding classify does not block (16 today)
//   buildAuthorInput({probeSet, records, git}) per record: range, findings (title, body, lines), the diff hunks around the cited lines
//   renderFindings(rowInput, {maxChars})      the findings block of the prompt, cut to fit
//   checkVerifyAnswer({files, manifest, input}) lint for the verify rules and the declare sidecar (C1)
//
// The prompt asks for one flow per finding (id = pid) and one `<pid>.declare.json`. The model writes fireMatch, correct and newCode.
// The harness writes pid, row, citedFile, startLine and endLine into the stored declare, so the model cannot move the cited lines.
// lintVerifyAnswer splits the lint per finding: a finding whose pair fails lint is dropped and recorded, the others are kept. The run fails only
// when no pair is clean (and not every finding is listed under cannotVerify).
// This module never imports author.mjs (author.mjs imports it).

import { parse } from 'yaml';
import { matchGlob } from '../../github/review-router.mjs';
import { makeTrexGit } from '../lib/git.mjs';
import { buildFireMatch } from './verdict.mjs';
import { defaultBaselineDir, loadBaseline } from './probe-set.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const FLOW_TIMEOUT_MAX_MS = 60_000;
export const MAX_BODY_CHARS = 2_000;
export const HUNK_CONTEXT = 12;
const DIFF_CONTEXT = 8;
const CORRECT_MAX_CHARS = 300;
const PER_FINDING_RESERVE = 120;
const ROW_ID = /^([SN])(\d+)$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rowOrder = (id) => { const m = ROW_ID.exec(id); return [m[1] === 'S' ? 0 : 1, Number(m[2])]; };
const byRow = (a, b) => { const [ka, na] = rowOrder(a); const [kb, nb] = rowOrder(b); return ka - kb || na - nb; };

/** The record ids that hold a finding classify does not block, S rows first, then N rows, each in number order. */
export function verifyRowIds(probeSet) {
  const ids = [...new Set(probeSet.rows.filter((r) => r.blocked === null).map((r) => r.row))];
  return ids.sort(byRow);
}

// ---------- diff hunks ----------

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Hunks of a unified diff, each with the new-file line number of every line. A removed line carries the number of the next new line. */
function parseHunks(diffText) {
  const hunks = [];
  let cur = null;
  let counter = 0;
  let last = 0;
  for (const raw of String(diffText ?? '').split('\n')) {
    const m = HUNK_HEAD.exec(raw);
    if (m) {
      cur = { header: raw, newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), lines: [] };
      hunks.push(cur);
      counter = cur.newStart;
      last = counter;
    } else if (cur && /^[ +\\-]/.test(raw)) {
      const kind = raw[0];
      const pos = kind === '\\' ? last : counter;
      cur.lines.push({ text: raw, pos });
      if (kind === ' ' || kind === '+') counter += 1;
      last = pos;
    } else if (cur && raw.startsWith('diff --git')) cur = null;
  }
  return hunks;
}

/**
 * The hunks of `diffText` that touch the cited lines (start..end, new-file numbers), as indented text.
 * A hunk longer than the cited range plus `context` lines on each side is cut to that window, and the header says "window".
 * Returns [] when no hunk is near the cited lines.
 */
export function selectHunks(diffText, start, end, { context = HUNK_CONTEXT } = {}) {
  const lo = start - context;
  const hi = end + context;
  const out = [];
  for (const h of parseHunks(diffText)) {
    const hunkEnd = h.newStart + Math.max(h.newCount, 1) - 1;
    if (hunkEnd < lo || h.newStart > hi) continue;
    const kept = h.lines.filter((l) => l.pos >= lo && l.pos <= hi);
    if (kept.length === 0) continue;
    const header = kept.length === h.lines.length ? h.header : `@@ window: new lines ${kept[0].pos}-${kept.at(-1).pos} of the hunk ${h.header.split('@@')[1].trim()} @@`;
    out.push([header, ...kept.map((l) => l.text)].join('\n'));
  }
  return out;
}

// ---------- the per-record input ----------

function findRecordFinding(row, findings) {
  const list = Array.isArray(findings) ? findings : [];
  const byId = list.find((f) => f.id === row.pid);
  const found = byId ?? list.find((f) => f.file === row.file && f.startLine === row.startLine && f.title === row.title);
  if (!found) throw new Error(`pid ${row.pid} (${row.row} ${row.file}:${row.startLine}): no finding in the record`);
  return found;
}

function gitOk(git, args, what) {
  const r = git(args);
  if (r.status !== 0) throw new Error(`${what} failed: ${String(r.stderr).trim() || `git ${args[0]} exit ${r.status}`}`);
  return r.stdout;
}

const existsAt = (git, ref, file) => gitOk(git, ['ls-tree', '-z', ref, '--', file], `git ls-tree ${ref} ${file}`).replace(/\0/g, '').trim() !== '';

function findingInput(row, record, git) {
  const f = findRecordFinding(row, record.findings);
  const end = row.endLine ?? row.startLine ?? 1;
  const start = row.startLine ?? end;
  const diff = gitOk(git, ['diff', '--no-color', '--no-ext-diff', '--no-renames', `-U${DIFF_CONTEXT}`, row.mergeBase, row.head, '--', row.file], `git diff ${row.mergeBase}..${row.head} ${row.file}`);
  return {
    pid: row.pid, group: row.group, file: row.file, startLine: start, endLine: end, severity: f.severity ?? row.severity, confidence: f.confidence ?? row.confidence,
    title: f.title ?? row.title, body: String(f.body ?? ''), fileAtBase: existsAt(git, row.mergeBase, row.file), hunks: selectHunks(diff, start, end),
  };
}

/**
 * { [row]: { row, head, mergeBase, range, findings, citedFiles } } for every record that holds an unblocked finding.
 * probeSet: the probe-set.json object. records: [{ id, record }] from loadBaseline. git: (args) => { status, stdout, stderr }.
 * Throws when a probe-set row has no finding in its record or git cannot diff: a silent gap would let a model write a flow for nothing.
 */
export function buildAuthorInput({ probeSet, records, git, only = null }) {
  const out = {};
  for (const id of verifyRowIds(probeSet).filter((x) => only === null || x === only)) {
    const rows = probeSet.rows.filter((r) => r.row === id && r.blocked === null);
    const rec = records.find((r) => r.id === id);
    if (!rec) throw new Error(`${id}: no record in the baseline`);
    const { head, mergeBase } = rows[0];
    const findings = rows.map((r) => findingInput(r, rec.record, git));
    out[id] = { row: id, head, mergeBase, range: `${mergeBase}..${head}`, findings, citedFiles: [...new Set(findings.map((f) => f.file))] };
  }
  return out;
}

/** The author input of every verify record, read from the committed probe-set.json and the trex-baseline records. */
export function loadAuthorInput(root, { baselineDir, git, only = null } = {}) {
  const probeSet = JSON.parse(readFileSync(path.join(root, 'scripts', 'trex', 'verify', 'probe-set.json'), 'utf8'));
  const { records } = loadBaseline(baselineDir ?? defaultBaselineDir());
  return buildAuthorInput({ probeSet, records, git: git ?? makeTrexGit(root), only });
}

// ---------- the findings block of the prompt ----------

const indent = (text) => text.split('\n').map((l) => `    ${l}`).join('\n');
const cutBody = (body) => (body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)} [body cut at ${MAX_BODY_CHARS} chars]` : body);

function headOf(f, i, n) {
  return [
    `### Finding ${i + 1} of ${n}`,
    `pid: ${f.pid}`,
    `Write the flow to \`${f.pid}.yaml\` (flow id ${f.pid}) and the declare to \`${f.pid}.declare.json\`.`,
    `Cited file: ${f.file}, lines ${f.startLine}-${f.endLine}`,
    `Severity: ${f.severity} (confidence ${f.confidence})`,
    `The cited file exists at the merge base: ${f.fileAtBase ? 'yes' : 'no'}`,
    `Title: ${f.title}`,
    'Finding body:',
    indent(cutBody(f.body)),
  ].join('\n');
}

/** Hunk text cut to `budget` chars by whole lines. The marker counts the lines it drops. */
function fitHunks(hunks, budget) {
  const lines = hunks.flatMap((h) => h.split('\n'));
  const kept = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 5 > budget) break;
    kept.push(l);
    used += l.length + 5;
  }
  const dropped = lines.length - kept.length;
  const cut = dropped > 0 ? [`[${dropped} diff lines cut to fit the prompt]`] : [];
  return [...kept, ...cut];
}

/**
 * The findings of one record as prompt text, at most maxChars. The body of a finding is never cut except above MAX_BODY_CHARS:
 * diff lines go first, evenly across the findings.
 */
export function renderFindings(input, { maxChars }) {
  const n = input.findings.length;
  const heads = input.findings.map((f, i) => headOf(f, i, n));
  const noHunk = input.findings.map((f) => f.hunks.length === 0);
  const fixed = heads.reduce((a, h) => a + h.length, 0) + n * PER_FINDING_RESERVE + 80;
  const withHunks = noHunk.filter((x) => !x).length;
  const budget = withHunks > 0 ? Math.max(0, Math.floor((maxChars - fixed) / withHunks)) : 0;
  const blocks = input.findings.map((f, i) => {
    if (noHunk[i]) return `${heads[i]}\nThe cited lines are outside the diff. Read the file in the folder.`;
    return `${heads[i]}\nDiff around the cited lines (new-file line numbers):\n${indent(fitHunks(f.hunks, budget).join('\n'))}`;
  });
  return `${blocks.join('\n\n')}\n`;
}

// ---------- the answer ----------

const FILE_NAME = /^([^/]+)\.(yaml|declare\.json)$/;

function stepProblems(doc) {
  const out = [];
  if (!isObj(doc)) return ['the flow is not a mapping'];
  const steps = Array.isArray(doc.steps) ? doc.steps : [];
  if (steps.length !== 1) out.push(`a verify flow needs one step (got ${steps.length}): the harness reads the output of that step`);
  if (doc.driver !== 'cli') out.push(`driver must be cli (got ${JSON.stringify(doc.driver)})`);
  if (doc.profile !== undefined && doc.profile !== 'container') out.push('profile must be container: a verify flow runs in the container');
  const limits = isObj(doc.limits) ? doc.limits : {};
  if (limits.retries !== 0) out.push('limits.retries must be 0: the harness repeats the run itself');
  if (limits.timeoutMs !== undefined && !(limits.timeoutMs <= FLOW_TIMEOUT_MAX_MS)) out.push(`limits.timeoutMs must be at most ${FLOW_TIMEOUT_MAX_MS}`);
  return out;
}

/**
 * One probe tests ONE claim, so its script has one "not ok" print site. Two sites mean a second assertion about a neighbouring behaviour:
 * base and fix can then fail on that other line, which carries the declared text too (first live smoke, S11). Only the step commands are
 * counted; the "not ok 1" text of a checks block is not.
 */
function printSiteProblems(doc) {
  const steps = isObj(doc) && Array.isArray(doc.steps) ? doc.steps : [];
  const cmds = steps.flatMap((s) => (Array.isArray(s?.action?.cmd) ? s.action.cmd : [s?.action?.cmd])).filter((c) => typeof c === 'string');
  const sites = cmds.join(' ').match(/\bnot ok\b/g)?.length ?? 0;
  return sites > 1 ? [`the probe has ${sites} "not ok" print sites: test exactly one claim (the one in the finding title) and print one "not ok" line`] : [];
}

function flowProblems(file, finding) {
  let doc;
  try { doc = parse(file.text); } catch (err) { return [`${file.path}: YAML error: ${String(err.message).split('\n')[0]}`]; }
  const out = [...stepProblems(doc), ...printSiteProblems(doc)];
  if (isObj(doc) && doc.id !== finding.pid) out.push(`flow id ${JSON.stringify(doc.id)} must be the finding pid ${finding.pid}`);
  const paths = isObj(doc) && Array.isArray(doc.paths) ? doc.paths : [];
  if (!paths.some((g) => typeof g === 'string' && matchGlob(g, finding.file))) out.push(`paths must name the cited file ${finding.file}`);
  return out.map((p) => `${file.path}: ${p}`);
}

function declareShapeProblems(d, finding) {
  const out = [];
  if (d.pid !== undefined && d.pid !== finding.pid) out.push(`pid ${JSON.stringify(d.pid)} differs from the finding pid ${finding.pid}`);
  const c = d.correct;
  if (typeof c !== 'string' || c.trim() === '' || c.includes('\n') || c.length > CORRECT_MAX_CHARS) out.push(`correct must be one sentence on one line, at most ${CORRECT_MAX_CHARS} chars`);
  if (typeof d.newCode !== 'boolean') out.push('newCode must be true or false');
  else if (!d.newCode && !finding.fileAtBase) out.push('newCode must be true: the cited file is absent at the merge base');
  const fire = buildFireMatch(d);
  if (!fire.ok) out.push(`fireMatch rejected (${fire.reason}): ${fire.detail}`);
  return { out, fire };
}

/** Problems with a declare file, and the stored C1 declare (null when the file does not parse). yamlText is the flow source (G9 check). */
function declareResult(file, finding, row, yamlText) {
  let d;
  try { d = JSON.parse(file.text); } catch (err) { return { problems: [`${file.path}: the declare is not valid JSON (${err.message})`], text: null }; }
  if (!isObj(d)) return { problems: [`${file.path}: the declare must be a JSON object`], text: null };
  const { out, fire } = declareShapeProblems(d, finding);
  if (fire.ok && d.newCode === true && yamlText !== null && fire.re.test(yamlText)) {
    out.push('fireMatch matches the text of the probe source: on new code the failing line must carry a value the app returned (G9)');
  }
  const stored = { pid: finding.pid, row, fireMatch: d.fireMatch, correct: d.correct, citedFile: finding.file, startLine: finding.startLine, endLine: finding.endLine, newCode: d.newCode };
  return { problems: out.map((p) => `${file.path}: ${p}`), text: `${JSON.stringify(stored, null, 2)}\n` };
}

function fileProblems(files, pids) {
  const out = [];
  for (const f of files) {
    const m = FILE_NAME.exec(f.path);
    if (!m || !pids.has(m[1])) out.push(`${f.path}: a verify answer holds only <pid>.yaml and <pid>.declare.json for the pids above`);
  }
  return out;
}

function manifestPids(manifest, pids) {
  const out = [];
  for (const f of Array.isArray(manifest?.flows) ? manifest.flows : []) if (isObj(f) && !pids.has(f.id)) out.push(`the manifest lists flow id ${f.id}, which is not a finding pid`);
  const skipped = new Set((Array.isArray(manifest?.cannotVerify) ? manifest.cannotVerify : []).filter(isObj).map((c) => c.pid).filter((p) => typeof p === 'string'));
  return { problems: out, skipped };
}

/**
 * Lint for a verify answer. files: [{ path, text }] from parseAuthorOutput. manifest: the parsed json block. input: one buildAuthorInput record.
 * Returns { files, problems }: files has each valid declare replaced by the stored C1 declare. A finding with no flow is allowed only when
 * cannotVerify names its pid (the arm then reports it blocked:no_flow).
 */
export function checkVerifyAnswer({ files, manifest, input }) {
  const pids = new Map(input.findings.map((f) => [f.pid, f]));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const { problems: mp, skipped } = manifestPids(manifest, pids);
  const problems = [...fileProblems(files, pids), ...mp];
  const stored = new Map();
  for (const f of input.findings) {
    const yamlFile = byPath.get(`${f.pid}.yaml`);
    const declFile = byPath.get(`${f.pid}.declare.json`);
    if (!yamlFile) {
      if (!skipped.has(f.pid)) problems.push(`finding ${f.pid}: no flow written and no cannotVerify entry with this pid`);
      continue;
    }
    problems.push(...flowProblems(yamlFile, f));
    if (!declFile) { problems.push(`finding ${f.pid}: no ${f.pid}.declare.json written`); continue; }
    const d = declareResult(declFile, f, input.row, yamlFile.text);
    problems.push(...d.problems);
    if (d.text !== null) stored.set(declFile.path, d.text);
  }
  return { files: files.map((f) => (stored.has(f.path) ? { ...f, text: stored.get(f.path) } : f)), problems };
}

// ---------- per-finding lint (critic major 6) ----------

/** The pid a lint line is about: "<pid>.yaml: ...", "<pid>.declare.json: ..." or "finding <pid>: ...". */
const PID_PREFIX = /^(?:finding )?([^\s:/]+?)(?:\.yaml|\.declare\.json)?: /;

const failedSummary = (failed, record) => {
  const lines = Object.entries(failed).map(([pid, ps]) => `${pid}: ${ps[0]}`);
  return (lines.length > 0 ? lines : record.slice(0, 3)).join(' | ');
};

/**
 * checkVerifyAnswer, split per finding. extraProblems: lint lines from outside this module (the generic flow lint, parseAuthorOutput).
 * Returns { files, lint, fatal }.
 *   files  the stored files of every clean pair (<pid>.yaml and the stored <pid>.declare.json); [] when fatal.
 *   lint   { row, findings, clean: [pid], failed: { pid: [problem] }, cannotVerify: [pid], record: [problem] } (written to <row>/lint.json).
 *   fatal  one line when no pair is clean and not every finding is under cannotVerify; else [].
 * A problem about a pid goes to that pid. A problem that names no finding (a stray file, a manifest slip) is a record problem: it is
 * recorded and does not fail the run, because the driver lints each pid again and one bad finding costs only itself.
 */
export function lintVerifyAnswer({ files, manifest, input, extraProblems = [] }) {
  const checked = checkVerifyAnswer({ files, manifest, input });
  const pids = input.findings.map((f) => f.pid);
  const known = new Set(pids);
  const failed = {};
  const record = [];
  for (const p of [...extraProblems, ...checked.problems]) {
    const m = PID_PREFIX.exec(p);
    if (m && known.has(m[1])) (failed[m[1]] ??= []).push(p); else record.push(p);
  }
  const have = new Set(files.map((f) => f.path));
  const { skipped } = manifestPids(manifest, known);
  const clean = pids.filter((pid) => !failed[pid] && have.has(`${pid}.yaml`) && have.has(`${pid}.declare.json`));
  const cannotVerify = pids.filter((pid) => skipped.has(pid) && !have.has(`${pid}.yaml`));
  const lint = { row: input.row, findings: pids.length, clean, failed, cannotVerify, record: [...new Set(record)] };
  const fatal = clean.length === 0 && cannotVerify.length < pids.length ? [`no finding passed lint (${pids.length} finding(s)): ${failedSummary(failed, lint.record)}`] : [];
  const keep = new Set(clean.flatMap((pid) => [`${pid}.yaml`, `${pid}.declare.json`]));
  return { files: fatal.length > 0 ? [] : checked.files.filter((f) => keep.has(f.path)), lint, fatal };
}
