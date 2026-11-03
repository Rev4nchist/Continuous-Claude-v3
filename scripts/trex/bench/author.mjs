#!/usr/bin/env node
/**
 * author.mjs: blind flow authoring for the TREX P0 replay bench (spec 5.13 with 13.1, 13.2 and 13.4).
 *
 * Usage (the ledger path is fixed: a live run exits 2 when CURSOR_REVIEW_LEDGER is set, because it would redirect the ledger and both caps;
 * only tests pass another path):
 *   node scripts/trex/bench/author.mjs --group S18 [--dry-run] [--keep-tree] [--retry | --retry-harness]
 *   node scripts/trex/bench/author.mjs --all
 *   node scripts/trex/bench/author.mjs --reparse <raw.json> --group <id>   parse a saved stream again: no agent, no ledger line
 *   node scripts/trex/bench/author.mjs --probe [--group S18]       one stream-json run that shows whether tool calls are visible
 *   node scripts/trex/bench/author.mjs --map-negatives [--sha <sha>] [--negatives <file>]
 *   node scripts/trex/bench/author.mjs --host-digest [--sha <sha>]  the digest a human review writes to host-review.json
 *   node scripts/trex/bench/author.mjs --freeze --sha <sha>         the sha is a commit that holds the flows; this script never commits
 * Model arms (arms spec section 4): add `--arm <grok|composer|composer2|xhigh|grok2|intent>` to any of these. The default arm is grok, the original bench.
 * An arm has its own model, flows folder, ledger ref prefix, run cap, groups and frozen file (see ARMS). `--model` must be a model of the arm.
 * The intent arm also reads scripts/trex/bench/intent/<group>.json (the PR title and body, fetched once with gh, see intent.mjs).
 *   `--refetch-intent` fetches it again. A leak hit in the intent text refuses the run (exit 2): edit that file, then run again.
 *
 * Exit codes follow cursor-review.mjs: 0 ran, 1 run failure, 2 bad input or refused by a rule, 3 cap reached or the run did not start.
 * Exit 3 for a run that did not start: runAgent found no free grok slot (grok-busy) and never spawned. The ledger end line has notStarted: true,
 * so neither BENCH_CAP, GROUP_CAP nor the weekly cap counts the run, and the next attempt needs no --retry. --all stops at the first exit 3.
 * Blindness on Windows: the agent has no sandbox. Every run uses stream-json, so analyzeStream audits the reads of the run. A read outside the
 * tree fails the run (blind: violated). A stream with no visible tool calls keeps the label "best-effort (no read audit)" (spec 13.4).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import * as cursor from '../../github/cursor-review.mjs';
import {
  EXIT, WEEKLY_CAP, buildAgentEnv, countRuns, defaultLedgerPath, finishRun, parseReviewOutput, prepareReview, readLedger, reserveRun,
  resolveAgent, runAgent,
} from '../../github/cursor-review.mjs';
import { withLock } from '../../github/lib/file-lock.mjs';
import { matchGlob } from '../../github/review-router.mjs';
import { CHECK_KINDS, DRIVERS, loadFlows, validateFlow } from '../flow.mjs';
import { hostActionOk, hostPs1Path } from '../host-allow.mjs';
import { INTENT_DIR, intentFacts, intentLeakHits, loadIntent, rangeEnd, stripLate } from './intent.mjs';
import { makeTrexGit } from '../lib/git.mjs';
import { stripEnv } from '../lib/strip-env.mjs';

/** The git function of every command here. The child env is stripped, so no Anthropic key reaches a git hook or alias. */
export const benchGit = (root) => makeTrexGit(root);

/** Dave decision 7 held 18 runs; on 2026-11-03 he approved 6 more for S8, S10, S12, S15 and 2 spares. */
export const BENCH_CAP = 24;
/** Runs one group may use: the first run plus up to two retries (the 2026-11-03 spares). */
export const GROUP_CAP = 3;
/** The bench timeout. The P0 probe timed out at the cursor-review default of 1500 s. */
export const BENCH_TIMEOUT_SEC = 2400;
/** What the P0 runtime can run. The prompt and lintFlow share these lists. */
export const P0_DRIVERS = Object.freeze(['cli', 'hook', 'mod-event']);
export const P0_CHECKS = Object.freeze(['exit', 'stdout', '!stdout', 'json', 'file']);
export const MAX_PROMPT_CHARS = 24_000;
export const DEFAULT_MODEL = 'grok-4.7-high';
export const FLOWS_DIR = 'scripts/trex/bench/flows';
export const BLIND = 'best-effort (no read audit)';
export const AUDITED = 'audited (stream-json reads in tree)';
export const VIOLATED = 'violated';
/** Dropped by 13.1: each holds a live seed defect, so a correct "not ok" there is a true positive. */
export const DROPPED_NEGATIVES = Object.freeze(['N1', 'N4', 'N5']);
const PROOFS_PATH = 'scripts/checks/proofs.json';
const promptFile = (arm) => fileURLToPath(new URL(`./${arm.prompt ?? 'author-prompt.md'}`, import.meta.url));
const FILES_SHOWN = 80;

/**
 * The 16 authoring groups (spec section 7). `range` is the author range, `pre` and `fix` are the seed SHAs.
 * S6 also serves row S7. S17 is the honest-skip group: it has no fix, and it is graded at `skipAt`.
 * `host` says which host flow shape the group may use.
 */
export const GROUPS = Object.freeze({
  S1: { range: 'beb9d5ef..23b62e5d', pre: '23b62e5d', fix: 'f0b67364', host: null },
  S2: { range: 'beb9d5ef..f0b67364', pre: 'f0b67364', fix: '16b8f382', host: null },
  S3: { range: 'dce71cdc..91b0b4c8', pre: '91b0b4c8', fix: '61f94d52', host: 'mod-event' },
  S4: { range: '226182d4..d1ae74d6', pre: 'd1ae74d6', fix: '42e1fbf5', host: 'mod-event' },
  S5: { range: '226182d4..ab76d406', pre: 'ab76d406', fix: 'e9579469', host: 'mod-event' },
  S6: { range: '89fc749c..2b51c197', pre: '2b51c197', fix: '1ec6ab3c', host: 'mod-event', rows: ['S6', 'S7'] },
  S8: { range: '4ff7dc66..2aabe283', pre: '2aabe283', fix: '574eb221', host: null },
  S9: { range: 'd4270286..8b69c3e1', pre: '8b69c3e1', fix: '74962d04', host: null },
  S10: { range: 'd981b2de..ec949669', pre: 'ec949669', fix: '9bcb694d', host: 'mod-event' },
  S11: { range: '18962377..0237674f', pre: '0237674f', fix: 'e0a5ac45', host: null },
  S12: { range: 'ac03ec78^1..ac03ec78', pre: '707612bd', fix: 'a4952ff5', host: 'pwsh' },
  S13: { range: '82a06d63..18962377', pre: '18962377', fix: '3b5a6018', host: null },
  S14: { range: '707612bd^1..707612bd', pre: '707612bd', fix: '1e285069', host: null },
  S15: { range: 'd47b9709^1..d47b9709', pre: '73040918', fix: '6f36d24f', host: 'pwsh' },
  S17: { range: '73040918..6f36d24f', pre: '73040918', fix: null, skipAt: '6f36d24f', host: 'pwsh', kind: 'honest-skip' },
  S18: { range: '6bc94082^1..6bc94082', pre: 'a309dd66', fix: '82a06d63', host: null },
});

const GROUP_IDS = Object.freeze(Object.keys(GROUPS));
/** The four groups with short container ranges: the xhigh, grok2 and composer2 arms run them (composer2 is the second composer run). */
const VARIANCE_GROUPS = Object.freeze(['S1', 'S8', 'S14', 'S18']);
const BENCH_DIR = 'scripts/trex/bench';
/** The authoring models (arms spec section 4). This list is not the review allowlist of cursor-review.mjs. -fast and auto are refused before it is read. */
export const AUTHOR_MODELS = Object.freeze(['grok-4.7-high', 'grok-4.7-xhigh', 'composer-2.5']);
/**
 * The model arms (arms spec sections 2 and 4). `models` is what the arm may run (the first is its default), `refPrefix` is the ledger ref prefix,
 * `stem` is the cache file prefix (empty for grok, so the old grok manifests keep their names) and `cap` is the arm's own run cap.
 * Optional: `prompt` is the template file beside this script (default author-prompt.md), and `intent: true` makes the arm read the stored
 * PR intent of the group (intent.mjs) and fill {intentTitle} and {intentBody} in that template.
 */
export const ARMS = Object.freeze({
  grok: { name: 'grok', models: ['grok-4.7-high'], flowsDir: FLOWS_DIR, refPrefix: 'trex-', stem: '', cap: BENCH_CAP, groups: GROUP_IDS, frozen: 'frozen.json' },
  composer: { name: 'composer', models: ['composer-2.5'], flowsDir: `${BENCH_DIR}/flows-composer`, refPrefix: 'trex-composer-', stem: 'composer-', cap: 20 /* Dave 11-02: 24 composer runs in all; composer2 owns 4 */, groups: GROUP_IDS, frozen: 'frozen-composer.json' },
  composer2: { name: 'composer2', models: ['composer-2.5'], flowsDir: `${BENCH_DIR}/flows-composer2`, refPrefix: 'trex-composer2-', stem: 'composer2-', cap: 4, groups: VARIANCE_GROUPS, frozen: 'frozen-composer2.json' },
  xhigh: { name: 'xhigh', models: ['grok-4.7-xhigh'], flowsDir: `${BENCH_DIR}/flows-xhigh`, refPrefix: 'trex-xhigh-', stem: 'xhigh-', cap: 4, groups: VARIANCE_GROUPS, frozen: 'frozen-xhigh.json' },
  grok2: { name: 'grok2', models: ['grok-4.7-high'], flowsDir: `${BENCH_DIR}/flows-grok2`, refPrefix: 'trex-grok2-', stem: 'grok2-', cap: 0 /* Dave 11-03: grok2's 4 runs moved to the intent probe */, groups: VARIANCE_GROUPS, frozen: 'frozen-grok2.json' },
  // The intent arm: grok-4.7-high, told what the PR says the change is meant to do (intent.mjs). Its prompt is author-prompt-intent.md.
  intent: { name: 'intent', models: ['grok-4.7-high'], flowsDir: `${BENCH_DIR}/flows-intent`, refPrefix: 'trex-intent-', stem: 'intent-', cap: 4, groups: VARIANCE_GROUPS, frozen: 'frozen-intent.json', prompt: 'author-prompt-intent.md', intent: true },
});
export const ARM_NAMES = Object.freeze(Object.keys(ARMS));
const OTHER_PREFIXES = Object.freeze(ARM_NAMES.filter((n) => n !== 'grok').map((n) => ARMS[n].refPrefix));

/** The arm and model of a run, or { error }. opts: { arm?, model? }. A model must be an authoring model, never -fast or auto, and one the arm runs. */
export function planRun(opts = {}) {
  const arm = Object.hasOwn(ARMS, opts.arm ?? 'grok') ? ARMS[opts.arm ?? 'grok'] : null;
  if (!arm) return { error: `unknown arm ${JSON.stringify(opts.arm)}: use ${ARM_NAMES.join(', ')}` };
  const model = opts.model === undefined || opts.model === null ? arm.models[0] : String(opts.model);
  if (/fast/i.test(model)) return { error: `model ${JSON.stringify(model)} is a fast variant: authoring never runs in fast mode` };
  if (model.trim().toLowerCase() === 'auto') return { error: 'model auto is refused: pass an explicit authoring model' };
  if (!AUTHOR_MODELS.includes(model)) return { error: `model ${JSON.stringify(model)} is not allowed: use ${AUTHOR_MODELS.join(', ')}` };
  if (!arm.models.includes(model)) return { error: `arm ${arm.name} runs ${arm.models.join(' or ')}, not ${model}` };
  return { arm, model };
}

const HOST_NONE = 'Write container flows only. Do not write `profile: host` flows.';
const HOST_TEXT = 'A flow with `profile: host` runs on the real Windows machine. It may use only two action shapes. '
  + 'Shape 1: driver mod-event with `{test: <name>}`, which runs `claude plugin test`. '
  + 'Shape 2: driver cli with `{cmd: [pwsh, -NoProfile, -File, <tree-relative path>.ps1]}` and no other key. '
  + 'The .ps1 must already exist in the code after the change. Never write a .ps1 in your output: it is not allowed under `scripts/trex/bench/flows/`. '
  + 'A host flow has no hook driver, no `start.run` and no `start.serve`. Any other host argv fails the lint.';
const hostRules = (host) => (host ? HOST_TEXT : HOST_NONE);

const two = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };

// ---------- budget ----------

/** The ids of runs whose end line says notStarted (no grok slot, no spawn). The same rule as countRuns in cursor-review.mjs. */
const notStartedIds = (entries) => new Set(entries.filter((e) => e.notStarted === true && e.id).map((e) => e.id));

/** True when a ledger ref belongs to the arm. The grok arm owns "trex-" except the refs of the other arms. */
function refInArm(ref, arm) {
  if (typeof ref !== 'string' || !ref.startsWith(arm.refPrefix)) return false;
  return arm.name !== 'grok' || !OTHER_PREFIXES.some((p) => ref.startsWith(p));
}

/**
 * Bench authoring runs of one arm in the ledger (default grok). Spec 13.4: a run counts when its ref belongs to the arm (grok: "trex-" without
 * the other arm prefixes). One run is one id, so a start and an end line count once. A run that never started (end line notStarted) does not count.
 * There is no time window: the cap is for the whole arm.
 */
export function benchRuns(ledgerPath, armName = 'grok') {
  const arm = ARMS[armName];
  const { entries } = readLedger(ledgerPath);
  const unstarted = notStartedIds(entries);
  const byId = new Map();
  for (const e of entries) {
    if (refInArm(e.ref, arm) && !unstarted.has(e.id) && !byId.has(e.id)) byId.set(e.id, e.ref);
  }
  const byRef = {};
  for (const ref of byId.values()) byRef[ref] = (byRef[ref] ?? 0) + 1;
  return { used: byId.size, byRef };
}

/** The outcome of the latest earlier run for a ref: 'ok', 'failed' or null (no earlier run). A run with no end line failed. A run that never started is no run. */
function lastOutcome(ledgerPath, ref) {
  const { entries } = readLedger(ledgerPath);
  const unstarted = notStartedIds(entries);
  const starts = entries.filter((e) => e.ref === ref && e.phase === 'start' && !unstarted.has(e.id));
  const last = starts.at(-1);
  if (!last) return null;
  const end = entries.find((e) => e.id === last.id && e.phase === 'end');
  return end && end.exit === EXIT.OK ? 'ok' : 'failed';
}

/** Refuses a run that would break a rule. { exit, reason } or null. Runs before reserveRun and before any tree is built. */
function budgetGate({ ledgerPath, ref, probe, retry, now, maxRuns, arm }) {
  const { used, byRef } = benchRuns(ledgerPath, arm.name);
  if (used >= maxRuns) return { exit: EXIT.CAP, reason: `bench cap reached: ${used} of ${maxRuns} runs (arm ${arm.name}, ref prefix ${arm.refPrefix})` };
  const weekly = countRuns(readLedger(ledgerPath).entries, { now });
  if (weekly >= WEEKLY_CAP) return { exit: EXIT.CAP, reason: `weekly cap reached: ${weekly} of ${WEEKLY_CAP} runs in the last 7 days` };
  const prior = byRef[ref] ?? 0;
  if (prior >= (probe ? 1 : GROUP_CAP)) return { exit: EXIT.CAP, reason: `${ref} has ${prior} earlier run(s): no more are allowed (${GROUP_CAP - 1} retries per group, one probe)` };
  if (prior === 0) return null;
  if (arm.name === 'composer' && VARIANCE_GROUPS.includes(ref.slice(arm.refPrefix.length)) && lastOutcome(ledgerPath, ref) === 'ok') {
    return { exit: EXIT.REFUSED, reason: `${ref} succeeded: its second run is the composer2 arm (--arm composer2), because a rerun here replaces the first answer` };
  }
  if (!retry) return { exit: EXIT.REFUSED, reason: `${ref} already ran: pass --retry after a failed run, or --retry-harness after a harness fault` };
  if (retry !== 'harness' && lastOutcome(ledgerPath, ref) === 'ok') return { exit: EXIT.REFUSED, reason: `${ref} succeeded: a retry needs --retry-harness` };
  return null;
}

// ---------- leak scan ----------

const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const HEX_RE = /\b[0-9a-f]{8,40}\b/gi;
const MIN_SUBJECT = 15;

function* walk(dir, rel = '') {
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { if (entry.name !== '.git') yield* walk(dir, next); } else if (entry.isFile()) yield next;
  }
}

function readText(dir, rel) {
  const file = path.join(dir, ...rel.split('/'));
  if (statSync(file).size > MAX_SCAN_BYTES) return null;
  const buf = readFileSync(file);
  return buf.subarray(0, 8000).includes(0) ? null : buf.toString('utf8');
}

function shaHits(text, rows) {
  const tokens = new Set((text.match(HEX_RE) ?? []).map((t) => t.slice(0, 8).toLowerCase()));
  const out = [];
  for (const row of rows) {
    for (const [kind, sha] of [['fix', row.fix], ['pre', row.pre]]) {
      if (sha && tokens.has(sha.slice(0, 8).toLowerCase())) out.push(`names the ${kind} sha ${sha.slice(0, 8)} (${row.id})`);
    }
  }
  return out;
}

function subjectHits(text, rows) {
  const low = text.toLowerCase();
  return rows.filter((r) => (r.subject ?? '').length >= MIN_SUBJECT && low.includes(r.subject.toLowerCase())).map((r) => `holds the fix commit subject of ${r.id}`);
}

const NOTE_FILE = /\.(?:md|txt|jsonl?)$/i;

/**
 * A note file (not PR.diff) that holds a fix file path and the row id as a word: the shape of an answer note such as "S12 ... land-pr.ps1".
 * A root-level fix file such as README.md is too common to flag. Source and test files are not notes: they cite paths all the time.
 */
function fixFileHits(text, rows, rel) {
  if (!NOTE_FILE.test(rel)) return [];
  const out = [];
  for (const row of rows) {
    if (!new RegExp(`\\b${row.id}\\b`).test(text)) continue;
    const named = (row.fixFiles ?? []).find((f) => f.includes('/') && text.includes(f));
    if (named) out.push(`names the fix file ${named} next to ${row.id}`);
  }
  return out;
}

/**
 * Hits in a review tree. Each row is { id, pre, fix, subject?, fixFiles? }. A hit is a file that names a pre or fix sha (first 8 hex
 * characters), holds a fix commit subject, or names a fix file next to its row id. The last rule is a heuristic: a plain mention of
 * a source path is not a leak, because the author may read that file. Returns text lines, one per hit.
 */
export function leakScan(dir, rows) {
  const hits = [];
  for (const rel of walk(dir)) {
    const text = readText(dir, rel);
    if (text === null) continue;
    for (const why of leakScanText(text, rows, rel)) hits.push(`${rel}: ${why}`);
  }
  return hits;
}

/** The three text rules of leakScan on one text. `rel` is the file name the text stands for (a note file name turns the fix file rule on). */
export function leakScanText(text, rows, rel = 'text.md') {
  return [...shaHits(text, rows), ...subjectHits(text, rows), ...fixFileHits(text, rows, rel)];
}

/** Leak rows, one per group. Git failures give a row without subject or fix files: those two rules are best effort. */
function benchRows(git) {
  const out = (args) => { const r = git(args); return r.status === 0 ? r.stdout.trim() : ''; };
  return Object.entries(GROUPS).map(([id, g]) => {
    const fixFiles = g.fix ? out(['diff', '--name-only', '--no-renames', g.pre, g.fix]).split(/\r?\n/).filter(Boolean) : [];
    return { id, pre: g.pre, fix: g.fix, subject: g.fix ? out(['log', '-1', '--format=%s', g.fix]) : '', fixFiles };
  });
}

// ---------- author output ----------

/** A group-folder-relative posix path. Returns an error text, or null when the path is safe. */
function pathProblem(p) {
  const bad = typeof p !== 'string' || p === '' || p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p)
    || p.split('/').some((s) => s === '' || s === '.' || s === '..' || s === '.git');
  return bad ? `file path ${JSON.stringify(p)} is outside the group folder` : null;
}

/**
 * Fenced blocks that open with "```file path=<p>" and close with a line that holds only "```". The opener may follow prose on its line
 * (the S17 answer had "...would actually hit.```file path=x.yaml"): the prose is dropped and the fence starts a new line.
 */
function fileBlocks(lines) {
  const blocks = [];
  const problems = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /```file[ \t]+path=(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '```') j += 1;
    if (j >= lines.length) { problems.push(`file block ${m[1]} is not closed`); break; }
    blocks.push({ path: m[1].trim(), text: lines.slice(i + 1, j).join('\n') });
    i = j;
  }
  return { blocks, problems };
}

/** The last fenced json block, and only when it ends the answer. { value } or { error }. */
function manifestBlock(text) {
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.at(-1)?.trim() !== '```') return { error: 'the answer does not end with the json manifest block' };
  let open = lines.length - 2;
  while (open >= 0 && !lines[open].trim().startsWith('```')) open -= 1;
  if (open < 0 || !/^```json\s*$/.test(lines[open].trim())) return { error: 'the answer does not end with the json manifest block' };
  try { return { value: JSON.parse(lines.slice(open + 1, -1).join('\n')) }; } catch (err) { return { error: `the manifest is not valid JSON (${err.message})` }; }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFlowFile = (p) => /\.ya?ml$/i.test(p);

function manifestProblems(m, paths) {
  if (!isObj(m) || !Array.isArray(m.flows) || !Array.isArray(m.cannotVerify)) return ['the manifest needs "flows" and "cannotVerify" arrays'];
  const problems = [];
  const ids = new Set();
  for (const f of m.flows) {
    if (!isObj(f) || typeof f.id !== 'string' || typeof f.file !== 'string') { problems.push('a manifest flow needs "id" and "file" strings'); continue; }
    if (!paths.has(f.file)) problems.push(`the manifest names ${f.file}, but no file block wrote it`);
    if (ids.has(f.id)) problems.push(`the manifest lists flow id ${f.id} twice`);
    ids.add(f.id);
  }
  const listed = new Set(m.flows.filter(isObj).map((f) => f.file));
  for (const p of paths) if (isFlowFile(p) && !listed.has(p)) problems.push(`${p} is a flow file that the manifest does not list`);
  return problems;
}

/** Reads the author answer. { files: [{path, text}], manifest, problems }. */
export function parseAuthorOutput(text, changedFiles = []) {
  const body = String(text ?? '');
  const { blocks, problems } = fileBlocks(body.split(/\r?\n/));
  const files = [];
  const seen = new Set();
  for (const b of blocks) {
    const bad = pathProblem(b.path);
    if (bad) problems.push(bad);
    else if (seen.has(b.path)) problems.push(`file path ${b.path} appears twice`);
    else { seen.add(b.path); files.push(b); }
  }
  if (blocks.length === 0) problems.push('the answer holds no file block');
  const mf = manifestBlock(body);
  if (mf.error) problems.push(mf.error); else problems.push(...manifestProblems(mf.value, seen));
  if (changedFiles.length > 0 && !changedFiles.some((f) => body.includes(f))) problems.push('the answer names no changed file: the agent may not have read the change');
  return { files, manifest: mf.value ?? null, problems };
}

// ---------- flow lint ----------

function stepsOf(flow) {
  return Array.isArray(flow?.steps) ? flow.steps.filter(isObj) : [];
}

function policyErrors(flow) {
  const errors = [];
  if (isObj(flow) && flow.mode !== undefined && flow.mode !== 'scripted') errors.push('mode must be scripted: a flow is graded in code');
  if (isObj(flow?.start) && 'note' in flow.start) errors.push('start.note is not allowed');
  const judge = stepsOf(flow).some((s) => Array.isArray(s.checks) && s.checks.some((c) => isObj(c) && 'judge' in c));
  if (judge) errors.push('a judge check is not allowed');
  return errors;
}

/** Spec 5.13: the P0 runtime has no api or browser driver and cannot run status, body, !body or playwright checks. */
function p0Errors(flow) {
  if (!isObj(flow)) return [];
  const errors = [];
  if (DRIVERS.includes(flow.driver) && !P0_DRIVERS.includes(flow.driver)) errors.push(`driver ${flow.driver} is not runnable in P0: use ${P0_DRIVERS.join(', ')}`);
  const kinds = stepsOf(flow).flatMap((s) => (Array.isArray(s.checks) ? s.checks.filter(isObj).flatMap((c) => CHECK_KINDS.filter((k) => k in c)) : []));
  for (const kind of new Set(kinds)) {
    if (kind !== 'judge' && !P0_CHECKS.includes(kind)) errors.push(`check ${kind} is not runnable in P0: use ${P0_CHECKS.join(', ')}`);
  }
  return errors;
}

/** Spec 13.2: a host flow may run only what host-allow.mjs allows. treeHas(path) says whether a .ps1 exists at the group head. */
function hostErrors(flow, treeHas) {
  if (flow.profile !== 'host') return [];
  const errors = [];
  if (flow.start?.run || flow.start?.serve) errors.push('host flow: start.run and start.serve are not allowed');
  stepsOf(flow).forEach((s, i) => {
    const why = hostActionOk(flow.driver, s.action, { treeHas });
    if (why) errors.push(`host flow: steps[${i}].action is not allowed: ${why}`);
  });
  return errors;
}

function fixtureRefs(flow) {
  const refs = [flow.start?.stamp, flow.start?.db];
  for (const s of stepsOf(flow)) refs.push(s.action?.payload, s.action?.bodyFile);
  return refs.filter((r) => typeof r === 'string');
}

/**
 * Errors for one authored flow file. validateFlow plus the bench rules: scripted only, no judge, no start.note, `paths` hit a changed
 * file, every fixture exists in the group output (when opts.files is given), and the host argv allowlist of spec 13.2.
 * opts.treeHas(path) tells whether a file exists at the group head. Without it, no host .ps1 passes.
 */
export function lintFlow(yamlText, changedFiles = [], opts = {}) {
  let flow;
  try { flow = parse(yamlText); } catch (err) { return [`YAML error: ${String(err.message).split('\n')[0]}`]; }
  const schema = validateFlow(flow);
  const errors = [...schema, ...policyErrors(flow), ...p0Errors(flow)];
  if (schema.length === 0) {
    if (!flow.paths.some((g) => changedFiles.some((f) => matchGlob(g, f)))) errors.push('paths hit no changed file');
    errors.push(...hostErrors(flow, opts.treeHas));
    if (opts.files) for (const r of fixtureRefs(flow)) if (!opts.files.includes(r)) errors.push(`fixture ${r} is not in the group output`);
  }
  return [...new Set(errors)];
}

// ---------- prompt ----------

/** Fills the template in one pass, so a value that holds "{files}" is never filled again. */
export function renderPrompt(template, vars) {
  return template.replace(/\{(ref|group|folder|files|fileCount|hostRules|intentTitle|intentBody)\}/g, (_, k) => String(vars[k]));
}

function promptFor(template, group, files, ref, arm, intent) {
  const shown = files.slice(0, FILES_SHOWN);
  const more = files.length > shown.length ? `\n... and ${files.length - shown.length} more` : '';
  const vars = { ref, group, folder: `${arm.flowsDir}/${group}/`, files: `${shown.join('\n')}${more}`, fileCount: files.length, hostRules: hostRules(GROUPS[group].host) };
  if (intent) Object.assign(vars, { intentTitle: intent.view.title, intentBody: intent.view.body.trim() || '(The description is empty.)' });
  return renderPrompt(template, vars);
}

// ---------- the intent ----------

/**
 * The stored intent of a group, cut of late lines, with its leak hits. { view, file, status, pr, source, leaks } or { error }.
 * The file is read (or fetched once) before any tree is built, so a missing intent costs nothing. `row` is the leak row of the group.
 */
function intentFor(group, opts, deps, git, row) {
  const g = GROUPS[group];
  const loaded = loadIntent(group, g.range, { root: opts.root, git, gh: deps.gh, now: deps.now ?? Date.now, refetch: Boolean(opts.refetchIntent) });
  if (loaded.error) return { error: loaded.error };
  const facts = intentFacts(git, { end: rangeEnd(g.range), fix: g.fix });
  const view = stripLate(loaded.intent, loaded.intent.pr ?? facts.endPr);
  const text = `${view.title}\n${view.body}`;
  const hits = [...leakScanText(text, [row], 'intent.md'), ...intentLeakHits(text, { pr: loaded.intent.pr, facts, title: view.title })];
  const leaks = hits.map((why) => `${INTENT_DIR}/${group}.json: ${why}`);
  return { view, file: `${INTENT_DIR}/${group}.json`, status: loaded.status, pr: loaded.intent.pr, source: loaded.intent.source, leaks };
}

// ---------- the tree ----------

/** Deletes proofs.json from the tree and drops its section from PR.diff, if the range added or changed it. */
function sanitizeTree(dir) {
  rmSync(path.join(dir, ...PROOFS_PATH.split('/')), { force: true });
  const diff = path.join(dir, 'PR.diff');
  if (!existsSync(diff)) return;
  const chunks = readFileSync(diff, 'utf8').split(/^(?=diff --git )/m);
  const kept = chunks.filter((c) => !c.startsWith(`diff --git a/${PROOFS_PATH} `));
  if (kept.length !== chunks.length) writeFileSync(diff, kept.join(''));
}

// ---------- the probe ----------

const PATH_KEYS = new Set(['path', 'file_path', 'filePath', 'target_file', 'targetFile']);

function findPath(v) {
  if (!v || typeof v !== 'object') return null;
  for (const [k, x] of Object.entries(v)) {
    if (PATH_KEYS.has(k) && typeof x === 'string') return x;
    const inner = findPath(x);
    if (inner) return inner;
  }
  return null;
}

function outsideTree(p, treeDir) {
  const np = p.replace(/\\/g, '/');
  if (!(np.startsWith('/') || /^[A-Za-z]:/.test(np))) return path.posix.normalize(np).startsWith('..');
  const tree = treeDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const low = np.toLowerCase();
  return !(low === tree || low.startsWith(`${tree}/`));
}

/** What a stream-json answer shows about tool use. Pure. Event names are matched loosely, because the schema is not documented. */
export function analyzeStream(stdout, treeDir) {
  const events = String(stdout ?? '').split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(isObj);
  const calls = events.filter((e) => /tool_call|tool_use/i.test(String(e.type)) && e.subtype !== 'completed');
  const reads = calls.map((e) => findPath(e.tool_call ?? e)).filter(Boolean);
  return {
    events: events.length,
    eventTypes: [...new Set(events.map((e) => String(e.type)))],
    toolCalls: calls.length,
    toolCallsVisible: calls.length > 0,
    reads,
    outsideTree: reads.filter((p) => outsideTree(p, treeDir)),
  };
}

// ---------- authorGroup ----------

const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

function notRunText(text, deps) {
  if (deps.notRun) return deps.notRun(text);
  return cursor.NOT_RUN instanceof RegExp ? cursor.NOT_RUN.test(text) : false;
}

function runError(run, parsed, model) {
  if (run.timedOut) return 'TIMED OUT: the agent and its process tree were stopped';
  if (run.error) return `the agent did not start or crashed: ${run.error}`;
  if (run.status !== 0) return `the agent exited with status ${run.status}`;
  if (parsed.modelMismatch) return `model check failed: the output names a model other than ${model}`;
  if (parsed.isError) return parsed.problems.join('; ');
  if (parsed.text.trim() === '') return 'the agent returned no result text';
  return null;
}

function lintAll(files, changedFiles, treeHas) {
  const names = files.map((f) => f.path);
  return files.filter((f) => isFlowFile(f.path)).flatMap((f) => lintFlow(f.text, changedFiles, { files: names, treeHas }).map((e) => `${f.path}: ${e}`));
}

/**
 * The blob id of a file at a commit, or null when the path is not a regular file there (a folder, a symlink or nothing).
 * `git ls-tree` only reads: it never touches the work tree.
 */
export function blobAt(git, head, file) {
  const r = git(['ls-tree', '-z', head, '--', file]);
  if (r.status !== 0) return null;
  for (const entry of String(r.stdout).split('\0')) {
    const m = /^(?:100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/.exec(entry);
    if (m && m[2] === file) return m[1];
  }
  return null;
}

function writeFlows(folder, files) {
  rmSync(folder, { recursive: true, force: true });
  return files.map((f) => {
    const file = path.join(folder, ...f.path.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, f.text.endsWith('\n') ? f.text : `${f.text}\n`);
    return file;
  });
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** { arm, model } for a run, or { error }. Checks the arm, the model (planRun) and that the group is one of the arm's groups. */
function checkRun(group, opts) {
  const plan = planRun(opts);
  if (plan.error) return plan;
  if (!Object.hasOwn(GROUPS, group)) return { error: `unknown group ${JSON.stringify(group)}: use one of ${plan.arm.groups.join(', ')}` };
  if (!plan.arm.groups.includes(group)) return { error: `group ${group} is not in arm ${plan.arm.name}: use one of ${plan.arm.groups.join(', ')}` };
  return plan;
}

/** Builds and checks the tree and the prompt. { prep, prompt, leaks } or { exit, problems }. The tree is cleaned up on a refusal. */
async function stage(group, opts, deps, ref, arm) {
  const git = deps.git ?? benchGit(opts.root);
  const rows = benchRows(git);
  const intent = arm.intent ? intentFor(group, opts, deps, git, rows.find((r) => r.id === group)) : null;
  if (intent?.error) return { exit: EXIT.FAILED, problems: [intent.error] };
  let prep;
  try { prep = await (deps.prepare ?? prepareReview)({ root: opts.root, input: { range: GROUPS[group].range } }); } catch (err) {
    return { exit: err.code === 'BAD_INPUT' ? EXIT.REFUSED : EXIT.FAILED, problems: [err.message] };
  }
  sanitizeTree(prep.dir);
  const leaks = [...leakScan(prep.dir, rows.filter((r) => r.id === group)), ...(intent?.leaks ?? [])];
  const crossGroup = leakScan(prep.dir, rows.filter((r) => r.id !== group));
  const template = deps.template ?? readFileSync(promptFile(arm), 'utf8');
  const prompt = promptFor(template, group, prep.files, ref, arm, intent);
  const refuse = (problems) => { if (!opts.keepTree) prep.cleanup(); return { exit: EXIT.REFUSED, problems }; };
  if (!opts.dryRun && leaks.length > 0) return refuse([`leak scan found ${leaks.length} hit(s) before the agent started`, ...leaks]);
  if (!opts.dryRun && prompt.length > MAX_PROMPT_CHARS) return refuse([`the prompt is ${prompt.length} chars, over the limit of ${MAX_PROMPT_CHARS}`]);
  return { prep, prompt, leaks, crossGroup, git, group, intent };
}

function dryRunResult(group, opts, ledgerPath, now, st, plan) {
  const { used } = benchRuns(ledgerPath, plan.arm.name);
  const weekly = countRuns(readLedger(ledgerPath).entries, { now });
  const info = { group, arm: plan.arm.name, model: plan.model, flows: `${plan.arm.flowsDir}/${group}`, range: GROUPS[group].range, tree: st.prep.dir, changedFiles: st.prep.files.length, promptChars: st.prompt.length, leaks: st.leaks, crossGroup: st.crossGroup.length, intent: st.intent ? { title: st.intent.view.title, pr: st.intent.pr, source: st.intent.source, file: st.intent.file, status: st.intent.status, stripped: st.intent.view.stripped } : null, benchRuns: used, benchCap: opts.maxRuns ?? plan.arm.cap, weekly, weeklyCap: WEEKLY_CAP };
  if (!opts.keepTree) st.prep.cleanup();
  const bad = st.leaks.length > 0 || st.prompt.length > MAX_PROMPT_CHARS;
  return { exit: bad ? EXIT.REFUSED : EXIT.OK, dryRun: true, info, files: [], manifest: null, usage: null, problems: st.leaks };
}

/** Starts the agent for a reserved run and returns the parsed answer. */
async function callAgent({ group, opts, deps, st, reserved, model, fmt }) {
  const env = deps.env ?? process.env;
  const agent = deps.agent ?? resolveAgent({ env });
  if (agent.error) return { run: { error: agent.error }, parsed: null };
  const args = [...(agent.prefixArgs ?? []), '-p', '--mode', 'ask', '--trust', '--output-format', fmt, '--model', model, st.prompt];
  const spec = { command: agent.cmd, args, cwd: st.prep.dir, timeoutMs: opts.timeoutMs ?? BENCH_TIMEOUT_SEC * 1000, env: buildAgentEnv(stripEnv(env), deps.platform ?? process.platform) };
  let run;
  try { run = await (deps.runner ?? runAgent)(spec); } catch (err) { run = { status: null, stdout: '', stderr: '', timedOut: false, error: String(err.message) }; }
  return { run, parsed: parseReviewOutput(run.stdout, { expectModel: model }), reserved, group };
}

/**
 * One authoring run for one group. opts: { root, ledgerPath, model, timeoutMs, maxRuns, retry, probe, dryRun, keepTree, cacheDir }.
 * deps (tests): { prepare, runner, agent, env, now, git, template, platform, notRun }.
 * Returns { exit, runId, files, manifest, usage, problems } (a dry run returns `info` too).
 * Every run asks for stream-json. The answer is the last `result` event. A read outside the tree gives exit 1 and writes no flow.
 */
export async function authorGroup(group, opts = {}, deps = {}) {
  const now = deps.now ?? Date.now;
  const fail = (exit, problems) => ({ exit, runId: null, files: [], manifest: null, usage: null, problems });
  const plan = checkRun(group, opts);
  if (plan.error) return fail(EXIT.REFUSED, [plan.error]);
  const { arm, model } = plan;
  const probe = Boolean(opts.probe);
  const ref = `${arm.refPrefix}${probe ? 'probe' : group}`;
  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath(deps.env ?? process.env);
  // A first look, so a refused run builds no tree. The real check runs again under the lock, just before the reservation.
  const gate = opts.dryRun ? null : budgetGate(gateArgs({ ledgerPath, ref, probe, opts, now, arm }));
  if (gate) return fail(gate.exit, [gate.reason]);
  const folder = path.join(opts.root, ...arm.flowsDir.split('/'), group);
  if (!opts.dryRun && !probe && !opts.retry && existsSync(folder) && readdirSync(folder).length > 0) return fail(EXIT.REFUSED, [`${folder} is not empty: pass --retry to replace it`]);
  const st = await stage(group, opts, deps, ref, arm);
  if (!st.prep) return fail(st.exit, st.problems);
  if (opts.dryRun) return dryRunResult(group, opts, ledgerPath, now(), st, plan);
  try { return await reservedRun({ group, opts, deps, st, ref, probe, ledgerPath, folder, now, arm, model }); } finally { if (!opts.keepTree) st.prep.cleanup(); }
}

const gateArgs = ({ ledgerPath, ref, probe, opts, now, arm }) => ({ ledgerPath, ref, probe, retry: opts.retry, now: now(), maxRuns: opts.maxRuns ?? arm.cap, arm });
const BENCH_LOCK_WAIT_MS = 10_000;

/**
 * Checks the caps and reserves the run in one step under a lock beside the ledger, so two sessions cannot both pass the check at 17 of 18.
 * Returns { reserved } or { refusal: { exit, problems } }.
 */
function reserveUnderLock(c) {
  const { opts, ref, probe, ledgerPath, now, arm, model } = c;
  const sessionId = (c.deps.env ?? process.env).CLAUDE_CODE_SESSION_ID || null;
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const locked = withLock(`${ledgerPath}.trex-bench`, { lockWaitMs: opts.lockWaitMs ?? BENCH_LOCK_WAIT_MS }, () => {
    const gate = budgetGate(gateArgs({ ledgerPath, ref, probe, opts, now, arm }));
    if (gate) return { refusal: { exit: gate.exit, problems: [gate.reason] } };
    return { reserved: reserveRun(ledgerPath, { ref, model, band: 'MID', sessionId }, { now }) };
  });
  if (locked.ok === false) return { refusal: { exit: EXIT.FAILED, problems: [locked.detail] } };
  const r = locked.reserved;
  if (r && !r.ok) return { refusal: { exit: r.reason === 'lock' ? EXIT.FAILED : EXIT.CAP, problems: [r.detail ?? `${r.reason} reached (${r.count})`] } };
  return locked;
}

async function reservedRun(c) {
  const { group, opts, deps, st, ref, probe, ledgerPath, folder, now, arm, model } = c;
  const sessionId = (deps.env ?? process.env).CLAUDE_CODE_SESSION_ID || null;
  const { reserved, refusal } = reserveUnderLock(c);
  if (refusal) return { exit: refusal.exit, runId: null, files: [], manifest: null, usage: null, problems: refusal.problems };
  const { run, parsed } = await callAgent({ group, opts, deps, st, reserved, model, fmt: 'stream-json' });
  if (run.notStarted) return notStartedRun({ group, opts, ref, probe, reserved, model, sessionId, run, now, ledgerPath, arm });
  const error = parsed ? runError(run, parsed, model) : run.error;
  const out = parsed && !error ? readAnswer(parsed.text, st, deps) : { files: [], manifest: null, problems: [] };
  const audit = analyzeStream(run.stdout, st.prep.dir);
  const violated = audit.outsideTree.length > 0;
  const problems = [...(violated ? [outsideProblem(audit.outsideTree)] : []), ...(error ? [error] : []), ...out.problems];
  const exit = (error || violated || (!probe && problems.length > 0)) ? EXIT.FAILED : EXIT.OK;
  const written = exit === EXIT.OK && !probe ? writeFlows(folder, out.files) : [];
  const retries = (benchRuns(ledgerPath, arm.name).byRef[ref] ?? 1) - 1;
  finishRun(ledgerPath, reserved.id, { ref, model, band: 'MID', sessionId, durationMs: run.durationMs ?? null, exit, timedOut: Boolean(run.timedOut), usage: parsed?.usage ?? null, ...(problems.length ? { error: problems[0].slice(0, 300) } : {}) }, { now });
  const rec = { group, arm: arm.name, ref, runId: reserved.id, model, usage: parsed?.usage ?? null, retries, status: exit === EXIT.OK ? 'ok' : 'failed', exit, problems, blind: blindLabel(audit), outputFormat: 'stream-json', ...audit, durationMs: run.durationMs ?? null, timedOut: Boolean(run.timedOut), promptChars: st.prompt.length, ...(st.intent ? { intent: { pr: st.intent.pr, source: st.intent.source, title: st.intent.view.title, file: st.intent.file, status: st.intent.status, stripped: st.intent.view.stripped.length } } : {}), crossGroupHits: st.crossGroup, files: out.files.map((f) => f.path), flows: out.manifest?.flows ?? [], cannotVerify: out.manifest?.cannotVerify ?? [] };
  saveArtifacts({ opts, now, group, probe, rec, run, arm });
  return { exit, runId: reserved.id, files: written, manifest: out.manifest, usage: rec.usage, problems };
}

/**
 * runAgent found no free grok slot and never spawned the agent. The end line carries notStarted: true (the field countRuns in
 * cursor-review.mjs skips), so the run uses no bench run, no group run and no weekly run. No flows, no raw file. The manifest has its
 * own file name: it never replaces the manifest of an earlier run and latestManifest (freeze) never reads it. The ledger exit is 1,
 * as in cursor-review.mjs; the returned exit is 3.
 */
function notStartedRun({ group, opts, ref, probe, reserved, model, sessionId, run, now, ledgerPath, arm }) {
  const waitMin = Math.round((run.waitedMs ?? 0) / 60_000);
  const reason = `not started: ${run.error ?? 'no grok slot'} (waited ${waitMin} min); the agent did not run and the run is not counted against the caps`;
  finishRun(ledgerPath, reserved.id, { ref, model, band: 'MID', sessionId, durationMs: 0, exit: EXIT.FAILED, timedOut: false, waitedMs: run.waitedMs ?? 0, notStarted: true, error: reason.slice(0, 300) }, { now });
  const dir = opts.cacheDir ?? path.join(opts.root, '.claude', 'cache', 'e2e');
  const stem = `${dayOf(now())}-trex-author-${arm.stem}${probe ? 'probe' : slug(group)}-not-started-${reserved.id.slice(0, 8)}`;
  writeJson(path.join(dir, `${stem}.manifest.json`), { group, arm: arm.name, ref, runId: reserved.id, model, status: 'not-started', exit: EXIT.CAP, error: reason, waitedMs: run.waitedMs ?? 0, notStarted: true });
  return { exit: EXIT.CAP, runId: reserved.id, files: [], manifest: null, usage: null, problems: [reason], notStarted: true };
}

/** The blind label of a run: violated after a read outside the tree, audited when tool calls were visible, else best-effort. */
const blindLabel = (a) => (a.outsideTree.length > 0 ? VIOLATED : a.toolCallsVisible ? AUDITED : BLIND);

function outsideProblem(paths) {
  const shown = paths.slice(0, 3).join(', ');
  return `blind violated: the agent read ${paths.length} path(s) outside the tree (${shown}${paths.length > 3 ? ', ...' : ''}): its flows are not used`;
}

function readAnswer(text, st, deps) {
  const out = parseAuthorOutput(text, st.prep.files);
  if (out.files.length === 0 && notRunText(text, deps)) out.problems.unshift('the answer says the agent could not read the change: the run is void');
  const shas = runShas(st.group);
  const treeHas = (p) => shas.every((sha) => blobAt(st.git, sha, p) !== null);
  return { ...out, problems: [...out.problems, ...lintAll(out.files, st.prep.files, treeHas)] };
}

function saveArtifacts({ opts, now, group, probe, rec, run, arm }) {
  const dir = opts.cacheDir ?? path.join(opts.root, '.claude', 'cache', 'e2e');
  const stem = path.join(dir, `${dayOf(now())}-trex-author-${arm.stem}${probe ? 'probe' : slug(group)}${!probe && rec.retries > 0 ? `-r${rec.retries}` : ''}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${stem}.raw.json`, run.stdout ?? '');
  writeJson(probe ? `${stem}.json` : `${stem}.manifest.json`, rec);
}

// ---------- reparse ----------

/** The tree path of a saved run: the cwd of its system init event. null when the stream has none. */
function streamCwd(stdout) {
  for (const l of String(stdout ?? '').split(/\r?\n/)) {
    try { const e = JSON.parse(l); if (isObj(e) && e.type === 'system' && typeof e.cwd === 'string') return e.cwd; } catch { /* not a JSON line */ }
  }
  return null;
}

/** The changed files of a group range, as prepareReview lists them: merge base to head, minus the folders left out of a tree. */
function groupChangedFiles(git, range) {
  const [a, b] = String(range).split(/\.{2,3}/);
  const mb = git(['merge-base', a, b]);
  const base = mb.status === 0 && mb.stdout.trim() ? mb.stdout.trim() : a;
  const d = git(['diff', '--name-only', '--no-renames', '-z', base, b]);
  if (d.status !== 0) throw new Error(`git diff ${base} ${b} failed: ${String(d.stderr).trim()}`);
  return d.stdout.split('\0').filter(Boolean).filter((f) => !cursor.isExcluded(f));
}

function readJsonOrNull(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** Refuses a reparse that would break a rule. A problem text, or null. */
function reparseRefusal(raw, group, folder, arm) {
  if (!new RegExp(`-trex-author-${arm.stem}${group}(?:-r\\d+)?\\.raw\\.json$`).test(path.basename(raw))) return `${path.basename(raw)} is not a raw file of group ${group} in arm ${arm.name}`;
  if (!existsSync(raw)) return `${raw} does not exist`;
  if (existsSync(folder) && readdirSync(folder).length > 0) return `${folder} is not empty: a reparse never replaces flows`;
  return null;
}

/**
 * Reads the answer of a saved stream-json run again: the same parse, lint and write path as a live run, with no agent call, no ledger
 * line and no bench cap. Use it after a parser fix, on the raw file of a run that failed to parse. opts: { root, model? }.
 * deps (tests): { git, notRun }. Returns { exit, runId, files, manifest, usage, problems, manifestFile }.
 * It refuses (exit 2) when the group folder is not empty or the saved stream shows a read outside the tree (blind: violated).
 */
export async function reparseGroup(rawFile, group, opts = {}, deps = {}) {
  const fail = (exit, problems) => ({ exit, runId: null, files: [], manifest: null, usage: null, problems, manifestFile: null });
  const plan = checkRun(group, opts);
  if (plan.error) return fail(EXIT.REFUSED, [plan.error]);
  const { arm } = plan;
  const raw = path.resolve(String(rawFile ?? ''));
  const folder = path.join(opts.root, ...arm.flowsDir.split('/'), group);
  const refusal = reparseRefusal(raw, group, folder, arm);
  if (refusal) return fail(EXIT.REFUSED, [refusal]);
  const stdout = readFileSync(raw, 'utf8');
  const treeDir = streamCwd(stdout);
  const audit = analyzeStream(stdout, treeDir ?? '');
  if (treeDir === null && audit.toolCallsVisible) return fail(EXIT.REFUSED, ['the saved stream has no system init cwd: its reads cannot be audited']);
  if (audit.outsideTree.length > 0) return fail(EXIT.REFUSED, [outsideProblem(audit.outsideTree)]);
  const git = deps.git ?? benchGit(opts.root);
  let files;
  try { files = groupChangedFiles(git, GROUPS[group].range); } catch (err) { return fail(EXIT.FAILED, [err.message]); }
  const parsed = parseReviewOutput(stdout, {});
  const error = runError({ status: 0 }, parsed, null);
  const out = error ? { files: [], manifest: null, problems: [] } : readAnswer(parsed.text, { prep: { files }, git, group }, deps);
  const problems = [...(error ? [error] : []), ...out.problems];
  const exit = problems.length > 0 ? EXIT.FAILED : EXIT.OK;
  const written = exit === EXIT.OK ? writeFlows(folder, out.files) : [];
  const orig = readJsonOrNull(raw.replace(/\.raw\.json$/, '.manifest.json'));
  const rec = { group, arm: arm.name, ref: `${arm.refPrefix}${group}`, runId: orig?.runId ?? null, model: orig?.model ?? plan.model, usage: parsed.usage ?? null, retries: orig?.retries ?? 0, status: exit === EXIT.OK ? 'ok' : 'failed', exit, problems, blind: blindLabel(audit), outputFormat: 'stream-json', reparsedFrom: raw, ...audit, files: out.files.map((f) => f.path), flows: out.manifest?.flows ?? [], cannotVerify: out.manifest?.cannotVerify ?? [] };
  const manifestFile = raw.replace(/\.raw\.json$/, '-reparse.manifest.json');
  writeJson(manifestFile, rec);
  return { exit, runId: rec.runId, files: written, manifest: out.manifest, usage: rec.usage, problems, manifestFile };
}

// ---------- negatives ----------

const diffNames = (git, id, head) => {
  const r = git(['diff', '--name-only', '--no-renames', `${head}^1`, head]);
  if (r.status !== 0) throw new Error(`negative ${id}: git diff ${head}^1 ${head} failed: ${r.stderr.trim()}`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
};

function isAncestor(git, id, fix, head) {
  const r = git(['merge-base', '--is-ancestor', fix, head]);
  if (r.status > 1) throw new Error(`negative ${id}: git merge-base --is-ancestor ${fix} ${head} failed: ${r.stderr.trim()}`);
  return r.status === 0;
}

function mapOne(neg, ctx, git) {
  const changed = diffNames(git, neg.id, neg.head);
  const hit = Object.keys(ctx.groups).filter((g) => ctx.fixes[g] && ctx.groups[g].some((f) => f.paths.some((p) => changed.some((c) => matchGlob(p, c)))));
  const graded = hit.filter((g) => isAncestor(git, neg.id, ctx.fixes[g], neg.head));
  return { graded, ungraded: hit.filter((g) => !graded.includes(g)), matched: hit.length > 0 };
}

/**
 * Spec 13.1. For each negative M (N1, N4 and N5 are dropped), pick the groups whose frozen flows have `paths` that meet
 * `git diff --name-only M^1..M`. A pair is graded only when the group fix is an ancestor of M. No match gives "no_match".
 * negatives: [{id, head, kind?}]. ctx: { groups: {<g>: [{id, paths}]}, fixes: {<g>: sha} }.
 */
export function mapNegatives(negatives, ctx, git) {
  const out = { negatives: {}, skipped: {}, ungraded: {}, dropped: [], problems: [] };
  for (const neg of negatives) {
    if (DROPPED_NEGATIVES.includes(neg.id)) { out.dropped.push(neg.id); continue; }
    const r = mapOne(neg, ctx, git);
    out.negatives[neg.id] = r.graded;
    if (r.ungraded.length) out.ungraded[neg.id] = r.ungraded;
    if (r.graded.length === 0) out.skipped[neg.id] = r.matched ? 'not_clean' : 'no_match';
    if (neg.kind === 'skip' && r.graded.length > 0) out.problems.push(`${neg.id} is a skip-class negative, but frozen flows match it: ${r.graded.join(', ')}`);
  }
  return out;
}

// ---------- freeze ----------

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * The shas a group's flows run at: its pre, its fix and, for a group with no fix (S17), its skipAt sha (spec section 7).
 * The author range end is not a run sha.
 */
export function runShas(g) {
  const row = GROUPS[g];
  if (!row) throw new Error(`unknown group ${g}`);
  return [...new Set([row.pre, row.fix ?? row.skipAt].filter(Boolean))];
}

/** { <group>: [head] } from mapNegatives().negatives ({ N2: ['S1'] }) and the negatives list [{ id, head }]. Graded pairs only. */
export function negativeHeadsOf(negatives, mapped) {
  const out = {};
  for (const neg of negatives) {
    for (const g of mapped[neg.id] ?? []) (out[g] ??= []).push(neg.head);
  }
  return out;
}

/** { "<path>@<sha>": blobId } for every .ps1 that a host flow runs, at every sha. Throws when one is not a regular file at a sha. */
function ps1Blobs(git, g, flow, shas) {
  const blobs = {};
  for (const step of flow.steps ?? []) {
    const file = hostPs1Path(flow.driver, step.action);
    if (file === null) continue;
    for (const sha of shas) {
      const id = blobAt(git, sha, file);
      if (id === null) throw new Error(`host flow ${flow.id} runs ${file}, which is not a file at ${sha} (group ${g})`);
      blobs[`${file}@${sha}`] = id;
    }
  }
  return Object.fromEntries(Object.entries(blobs).sort(([x], [y]) => (x < y ? -1 : 1)));
}

/**
 * The digest a human review covers: sha256 over the normalized host flows (profile host) of the committed groups, read through git
 * at `sha`, plus the git blob id of every .ps1 those flows run, at every sha the group's flows run at: its pre, its fix (skipAt for S17)
 * and each graded negative head in opts.negativeHeads ({ <group>: [sha] }, see negativeHeadsOf). Container flows do not change it.
 * A reviewer reads the host flows and those scripts, then writes this digest to host-review.json.
 */
export function hostFlowDigest(git, sha, { flowsDir = FLOWS_DIR, groups = Object.keys(GROUPS), negativeHeads = {} } = {}) {
  const parts = [];
  for (const g of [...groups].sort()) {
    const shas = [...new Set([...runShas(g), ...(negativeHeads[g] ?? [])])];
    for (const flow of loadFlows(git, sha, `${flowsDir}/${g}`)) {
      if (flow.profile === 'host') parts.push(JSON.stringify({ group: g, flow, scripts: ps1Blobs(git, g, flow, shas) }));
    }
  }
  return sha256(parts.join('\n'));
}

const gitText = (git, args, what) => {
  const r = git(args);
  if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr.trim() || `git ${args[0]} exit ${r.status}`}`);
  return r.stdout.trim();
};

function latestManifest(cacheDir, group, arm) {
  const re = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-trex-author-${arm.stem}${group}(?:-r(\\d+))?(-reparse)?\\.manifest\\.json$`);
  const found = existsSync(cacheDir) ? readdirSync(cacheDir).map((n) => ({ n, m: re.exec(n) })).filter((x) => x.m) : [];
  const rank = (x) => Number(x.m[2] ?? 0) * 2 + (x.m[3] ? 1 : 0);
  found.sort((a, b) => (a.m[1] === b.m[1] ? rank(a) - rank(b) : a.m[1] < b.m[1] ? -1 : 1));
  return found.length ? JSON.parse(readFileSync(path.join(cacheDir, found.at(-1).n), 'utf8')) : null;
}

// --host-digest prints the digest, so anyone who can run this script can write a matching marker.
// The marker is a human-process gate, not a security boundary. The text names no digest and no marker JSON so it is not a recipe.
const MARKER_ERROR = 'host-flow review marker missing or stale; ask Dave to review with --host-digest';

function checkMarker(markerPath, digest) {
  let marker;
  try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch { throw new Error(MARKER_ERROR); }
  if (marker?.sha256 !== digest) throw new Error(MARKER_ERROR);
}

function groupRecords(cacheDir, groups, arm) {
  const out = {};
  for (const g of groups) {
    const m = latestManifest(cacheDir, g, arm);
    if (!m || m.status === 'failed' || m.status === 'not-started') throw new Error(`group ${g} has no successful author manifest in ${cacheDir}`);
    out[g] = { runId: m.runId, model: m.model, usage: m.usage ?? null, retries: m.retries ?? 0, blind: m.blind ?? BLIND };
  }
  return out;
}

/** The number of host flows (profile host) in the arm's groups at a commit. */
function hostFlowCount(git, sha, flowsDir, groups) {
  return groups.flatMap((g) => loadFlows(git, sha, `${flowsDir}/${g}`)).filter((f) => f.profile === 'host').length;
}

/** The git blob id of a working-copy file (clean filters applied, so it equals the committed blob), or null when git cannot hash it. */
export function inputBlob(git, file) {
  const r = git(['hash-object', file]);
  const id = r.status === 0 ? r.stdout.trim() : '';
  return id === '' ? null : id;
}

/** What the bench must find unchanged after the freeze: each negative head and the blob ids of negatives.json and proofs-trex.json (finding 5). */
function pinInputs(git, negatives, opts) {
  const dir = path.join(opts.root, 'scripts', 'trex', 'bench');
  const file = (key, p) => {
    const id = inputBlob(git, p);
    if (id === null) throw new Error(`cannot hash ${key} (${p}) for the freeze pins`);
    return id;
  };
  const files = { negatives: file('negatives.json', opts.negativesFile ?? path.join(dir, 'negatives.json')), proofs: file('proofs-trex.json', opts.proofsFile ?? path.join(dir, 'proofs-trex.json')) };
  return { negatives: Object.fromEntries(negatives.filter((n) => n.kind !== 'honest-skip').map((n) => [n.id, n.head])), files };
}

/** The flows tree id at a commit. Refuses a dirty flows dir and a commit whose flows tree differs from HEAD. */
function checkedFlowsTree(git, sha, flowsDir) {
  if (gitText(git, ['status', '--porcelain', '--', flowsDir], 'git status') !== '') throw new Error(`${flowsDir} is dirty: commit or discard the changes before the freeze`);
  gitText(git, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], `commit ${sha}`);
  const flowsTree = gitText(git, ['rev-parse', `${sha}:${flowsDir}`], `rev-parse ${sha}:${flowsDir}`);
  if (flowsTree !== gitText(git, ['rev-parse', `HEAD:${flowsDir}`], `rev-parse HEAD:${flowsDir}`)) throw new Error(`the flows tree at ${sha} differs from HEAD: freeze the commit that is checked out`);
  return flowsTree;
}

/** The host review digest, or null when the arm has no host flow: nothing needs a human review, so no marker is read. */
function reviewDigest(git, sha, c) {
  if (c.hostFlows === 0) return null;
  const digest = hostFlowDigest(git, sha, { flowsDir: c.flowsDir, groups: c.groups, negativeHeads: c.negativeHeads });
  checkMarker(c.markerPath, digest);
  return digest;
}

/**
 * Writes frozen.json (frozen-<arm>.json for another arm) for a commit `sha` that already holds the flows. It never runs git commit: the orchestrator commits.
 * Refuses a dirty flows dir, a sha whose flows tree differs from HEAD, and, when the arm has host flows, a missing or stale host review marker.
 * An arm with no host flow needs no marker and records hostFlows: 0.
 * It also records `pins`: each negative head and the blob ids of negatives.json and proofs-trex.json, so the bench preflight can refuse an edit made after the freeze.
 * The host review marker is host-review.json for the grok arm and host-review-<arm>.json for the others.
 * opts: { root, arm, flowsDir, groups, fixes, cacheDir, markerPath, negatives, negativesFile, proofsFile, outFile }. Returns the frozen record.
 */
export function freeze(sha, opts, deps = {}) {
  const git = deps.git ?? benchGit(opts.root);
  const plan = planRun({ arm: opts.arm });
  if (plan.error) throw new Error(plan.error);
  const { arm } = plan;
  const flowsDir = opts.flowsDir ?? arm.flowsDir;
  const groups = opts.groups ?? arm.groups;
  const cacheDir = opts.cacheDir ?? path.join(opts.root, '.claude', 'cache', 'e2e');
  const flowsTree = checkedFlowsTree(git, sha, flowsDir);
  const flows = Object.fromEntries(groups.map((g) => [g, loadFlows(git, sha, `${flowsDir}/${g}`).map((f) => ({ id: f.id, paths: f.paths }))]));
  const fixes = opts.fixes ?? Object.fromEntries(Object.entries(GROUPS).map(([g, v]) => [g, v.fix]));
  const map = mapNegatives(opts.negatives ?? [], { groups: flows, fixes }, git);
  if (map.problems.length) throw new Error(`negative mapping problems: ${map.problems.join('; ')}`);
  const hostFlows = hostFlowCount(git, sha, flowsDir, groups);
  const markerPath = opts.markerPath ?? path.join(opts.root, 'scripts', 'trex', 'bench', arm.name === 'grok' ? 'host-review.json' : `host-review-${arm.name}.json`);
  const hostReview = reviewDigest(git, sha, { hostFlows, flowsDir, groups, markerPath, negativeHeads: negativeHeadsOf(opts.negatives ?? [], map.negatives) });
  const pins = pinInputs(git, opts.negatives ?? [], opts);
  const records = groupRecords(cacheDir, groups, arm);
  const blind = Object.values(records).every((r) => r.blind === AUDITED) ? AUDITED : BLIND;
  const frozen = { sha, arm: arm.name, flowsTree, groups: records, negatives: map.negatives, skipped: map.skipped, hostFlows, hostReview, blind, pins };
  writeJson(opts.outFile ?? path.join(opts.root, 'scripts', 'trex', 'bench', arm.frozen), frozen);
  return frozen;
}

// ---------- command line ----------

const ACTIONS = ['group', 'all', 'probe', 'map-negatives', 'freeze', 'host-digest', 'reparse'];

/** --reparse <raw.json> --group <id>: nothing else. A reparse has no dry run, no retry and no tree. */
function reparseArgs(out, acts) {
  if (acts.length !== 2 || !acts.includes('group') || !out.reparse || !out.group) return { error: '--reparse <raw.json> needs --group <id> and no other action' };
  if (out.dryRun || out.retry || out.keepTree) return { error: '--reparse takes no --dry-run, --retry or --keep-tree' };
  return { ...out, action: 'reparse' };
}

export function parseArgs(argv) {
  const out = { actions: [] };
  const flag = { '--all': 'all', '--probe': 'probe', '--map-negatives': 'map-negatives', '--freeze': 'freeze', '--host-digest': 'host-digest' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (flag[a]) out.actions.push(flag[a]);
    else if (a === '--group') { out.group = next(); out.actions.push('group'); } else if (a === '--sha') out.sha = next();
    else if (a === '--reparse') { out.reparse = next(); out.actions.push('reparse'); }
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--refetch-intent') out.refetchIntent = true;
    else if (a === '--keep-tree') out.keepTree = true;
    else if (a === '--retry') out.retry = out.retry ?? true;
    else if (a === '--retry-harness') out.retry = 'harness';
    else if (a === '--ledger') return { error: '--ledger is not a command line option' };
    else if (a === '--negatives') out.negativesFile = next();
    else if (a === '--model') out.model = next();
    else if (a === '--arm') { out.arm = next(); if (!Object.hasOwn(ARMS, out.arm)) return { error: `--arm needs one of ${ARM_NAMES.join(', ')}` }; }
    else if (a === '--timeout-sec') out.timeoutMs = Number(next()) * 1000;
    else return { error: `unknown argument ${JSON.stringify(a)}` };
  }
  out.arm ??= 'grok';
  if (out.refetchIntent && !ARMS[out.arm].intent) return { error: '--refetch-intent applies to the intent arm only: pass --arm intent' };
  const acts = [...new Set(out.actions)];
  if (out.actions.includes('reparse')) return reparseArgs(out, acts);
  if (out.actions.includes('probe') && acts.length === 2 && acts.includes('group')) out.action = 'probe';
  else if (acts.length !== 1) return { error: `pass exactly one of --group <id>, --all, --probe, --${ACTIONS.slice(3).join(', --')}` };
  else out.action = acts[0];
  if (out.action === 'freeze' && !out.sha) return { error: '--freeze needs --sha <commit>' };
  return out;
}

function repoRoot() {
  return benchGit(process.cwd())(['rev-parse', '--show-toplevel']).stdout.trim() || process.cwd();
}

function printIntent(i, say) {
  say(`intent: ${i.pr === null ? 'commit message' : `PR #${i.pr}`} "${i.title}" from ${i.file} (${i.status})`);
  if (i.stripped.length === 0) return;
  say(`intent: stripped ${i.stripped.length} line(s) that look written after the merge (the file keeps them):`);
  for (const l of i.stripped.slice(0, 10)) say(`  - ${l.length > 160 ? `${l.slice(0, 160)}...` : l}`);
}

function printDryRun(info, say) {
  say(`dry run: ${info.group} (range ${info.range})`);
  say(`arm: ${info.arm} (${info.model})`);
  say(`flows: ${info.flows}`);
  say(`tree: ${info.tree} (removed after the dry run; pass --keep-tree to keep it)`);
  say(`changed files: ${info.changedFiles}`);
  say(`prompt: ${info.promptChars} chars (limit ${MAX_PROMPT_CHARS})`);
  if (info.intent) printIntent(info.intent, say);
  say(info.leaks.length === 0 ? 'leak scan: clean' : `leak scan: ${info.leaks.length} hit(s)`);
  for (const l of info.leaks) say(`  - ${l}`);
  say(`other-group hits (not blocking): ${info.crossGroup}`);
  say(`bench runs: ${info.benchRuns} of ${info.benchCap} (weekly ${info.weekly} of ${info.weeklyCap})`);
  say('No agent started, no ledger line.');
}

async function runReparse(args, root, deps, say) {
  const r = await reparseGroup(args.reparse, args.group, { root, model: args.model, arm: args.arm }, deps);
  say(`${args.group}: reparse exit ${r.exit}${r.problems.length ? ` (${r.problems[0]})` : ''}`);
  for (const p of r.problems.slice(1)) say(`  - ${p}`);
  say(`reparsed from: ${path.resolve(args.reparse)}`);
  for (const f of r.files) say(`wrote: ${f}`);
  if (r.manifestFile) say(`manifest: ${r.manifestFile}`);
  say('No agent started, no ledger line.');
  return r.exit;
}

function loadNegatives(file) {
  const v = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(v) ? v : v.negatives;
}

function groupFlows(git, sha, arm) {
  return Object.fromEntries(arm.groups.map((g) => [g, loadFlows(git, sha, `${arm.flowsDir}/${g}`).map((f) => ({ id: f.id, paths: f.paths }))]));
}

const allFixes = () => Object.fromEntries(Object.entries(GROUPS).map(([g, v]) => [g, v.fix]));
const mapAll = (git, sha, negatives, arm) => mapNegatives(negatives, { groups: groupFlows(git, sha, arm), fixes: allFixes() }, git);

/** The digest for a human host review: the same one freeze computes, with the negative heads mapped to each group. */
function hostDigestOf(git, sha, negatives, arm) {
  const negativeHeads = negativeHeadsOf(negatives, mapAll(git, sha, negatives, arm).negatives);
  return hostFlowDigest(git, sha, { flowsDir: arm.flowsDir, groups: arm.groups, negativeHeads });
}

async function runGroups(args, base, deps, say) {
  const groups = args.action === 'all' ? ARMS[args.arm].groups : [args.group ?? 'S18'];
  let worst = EXIT.OK;
  for (const g of groups) {
    const r = await authorGroup(g, { ...base, probe: args.action === 'probe' }, deps);
    if (r.dryRun) printDryRun(r.info, say);
    else say(`${g}: exit ${r.exit}${r.problems.length ? ` (${r.problems[0]})` : ''}`);
    worst = Math.max(worst, args.action === 'all' && r.exit === EXIT.REFUSED && /already ran/.test(r.problems[0] ?? '') ? EXIT.OK : r.exit);
    if (r.exit === EXIT.CAP) break;
  }
  return worst;
}

/** True for a live run (not --dry-run) while CURSOR_REVIEW_LEDGER moves the ledger and so both caps. */
const redirectsLedger = (args, deps) => ['group', 'all', 'probe'].includes(args.action) && !args.dryRun && Boolean((deps.env ?? process.env).CURSOR_REVIEW_LEDGER);

/** Returns the exit code. deps (tests): authorGroup deps plus root, ledgerPath, stdout, stderr. */
export async function main(argv, deps = {}) {
  const say = deps.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const args = parseArgs(argv);
  if (args.error) { err(`author: ${args.error}`); return EXIT.REFUSED; }
  if (redirectsLedger(args, deps)) {
    err('author: a live run refuses when CURSOR_REVIEW_LEDGER is set: it would redirect the ledger and both caps');
    return EXIT.REFUSED;
  }
  const root = deps.root ?? repoRoot();
  if (args.action === 'reparse') return await runReparse(args, root, deps, say);
  const ledgerPath = deps.ledgerPath ?? defaultLedgerPath(deps.env ?? process.env);
  const base = { root, ledgerPath, arm: args.arm, model: args.model, timeoutMs: args.timeoutMs, retry: args.retry, dryRun: args.dryRun, keepTree: args.keepTree, refetchIntent: args.refetchIntent };
  try {
    if (['group', 'all', 'probe'].includes(args.action)) return await runGroups(args, base, deps, say);
    const git = deps.git ?? benchGit(root);
    const sha = args.sha ?? 'HEAD';
    const negFile = args.negativesFile ?? path.join(root, 'scripts', 'trex', 'bench', 'negatives.json');
    const negatives = loadNegatives(negFile);
    if (args.action === 'host-digest') { say(hostDigestOf(git, sha, negatives, ARMS[args.arm])); return EXIT.OK; }
    if (args.action === 'map-negatives') {
      say(JSON.stringify(mapAll(git, sha, negatives, ARMS[args.arm]), null, 2));
      return EXIT.OK;
    }
    say(JSON.stringify(freeze(args.sha, { root, negatives, negativesFile: negFile, arm: args.arm }, { git }), null, 2));
    return EXIT.OK;
  } catch (e) {
    err(`author: ${e.message}`);
    return EXIT.REFUSED;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2));
