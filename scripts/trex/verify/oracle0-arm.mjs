#!/usr/bin/env node
// oracle0-arm.mjs: the P1 control arm `oracle0` of TREX verify. NO model: it runs tests that already exist.
//
//   node scripts/trex/verify/oracle0-arm.mjs [--out <dir>] [--live] [--pids <pid,pid>] [--date YYYY-MM-DD]
//
// Without --live it only PLANS: it reads git, picks the nearest tests of each finding and writes <out>/oracle0/plan.json. No test runs.
// With --live it runs each nearest test group at the finding's head and at its merge-base and writes the C2 file
// <out>/oracle0/verdicts.json plus <out>/oracle0/evidence/<pid>.json and a dated copy beside <out> (the e2e folder).
//
// For each finding that classify did not block (the 16 scored findings and the unblocked group C findings; mods-host and the like are
// reported blocked and never run):
//   1. nearest tests: oracle0.mjs testFlows + test-map selectFlows over the files tracked at the finding's head. A test is "near" when it
//      imports the cited file or is named after it, so every near test touches the cited file.
//   2. planRunners turns them into runnable groups (node --test, claude plugin test, a pure Playwright spec). A server Playwright spec needs the
//      Next server and a database: that is a container job (oracle0-container.mjs) and this arm skips it, saying so. A vitest .test.ts is
//      skipped by planRunners (no runner): also said.
//   3. each group runs at head. Only when it FIRES at head does it run at the merge-base, with the HEAD copy of the test files laid over the
//      base tree (same test bytes on both sides, the way the fix-diff replay does it with the roles swapped: pre = merge-base, fix = head).
//      A clean head is `no-signal` without a base run. (First live run, 2026-11-03: all 35 heads were clean or unrunnable, and 10 base
//      runs failed to load the head test, so they read "broken" for a finding whose head was clean. The base run is now conditional.)
//   4. differential() from oracle0.mjs classifies both runs with prove-check classifyRun. judge() is NOT used: its pre/fix meaning is the other
//      way round for a finding (fire at "pre" and none at "fix").
//
// HOW A RESULT MAPS (decision, 2026-11-03)
//   differential-fail (fires at head, clean at base, on a test that touches the cited file)  -> `reproduced`. Severity stays.
//   everything else (clean at head, fails at both, broken, nothing runnable, no test)        -> `not_attempted`, the outcome named in `reason`.
// oracle0 NEVER downgrades. A clean pass at head is silence, not evidence: the host run records no coverage, and the design (G8) allows
// not_reproduced only when the cited lines are shown as executed. So oracle0 is a keep-or-confirm control: every severity equals the baseline,
// its precision on the scored set is the baseline 3 / 16 and it loses 0 hits. Gate (f) against oracle0 therefore reduces to "verify beats
// 19% at 0 hits lost". The informative output is the tally: how many findings an existing test already confirms, per group.
//
// Zero model runs: the child environment is stripEnv(process.env) (no Anthropic key, no CLAUDE_CODE_*), and no code path here starts
// grok, cursor-agent or `claude -p`. `claude plugin test` runs the plugin's own bun tests, as in the P0 fix-diff replay.
// Exit: 0 done (plan or live), 2 bad input.

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripEnv } from '../lib/strip-env.mjs';
import { classifyRun, differential, groupRow, isTestPath, nearestTests, oracleDeps, planRunners, testFlows } from './oracle0.mjs';
import { DEFAULT_OUT, loadProbeSet } from './score-arms.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ARM = 'oracle0';
const CLIP = 3000;
const SPEC_OR_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const clip = (s) => (s && s.length > CLIP ? `${s.slice(0, CLIP / 2)}\n[... ${s.length - CLIP} chars cut ...]\n${s.slice(-CLIP / 2)}` : s ?? '');

// ---------- outcome and verdict ----------

const ORDER = ['differential-fail', 'preexisting-fail', 'no-signal', 'broken'];

/**
 * One finding's outcome from its group entries: { kind, files, differential?: { verdict, head, base }, skipped?: string }.
 * Priority: a fire, then a pre-existing failure, then a clean run, then a broken run, then nothing runnable, then no tests.
 * @returns {{ outcome: string, detail: string }}
 */
export function outcomeOf(groups) {
  for (const o of ORDER) {
    const g = groups.find((x) => x.differential?.verdict === o);
    if (g) return { outcome: o, detail: detailOf(o, g) };
  }
  const skipped = groups.filter((g) => g.skipped);
  if (skipped.length) return { outcome: 'no-runnable-test', detail: skipped.map((g) => g.skipped).join('; ') };
  return { outcome: 'no-test', detail: 'no existing test imports the cited file or is named after it' };
}

function detailOf(outcome, g) {
  const d = g.differential;
  const files = (g.files ?? []).join(', ');
  if (outcome === 'differential-fail') return `${files} fires at head (${d.head?.fireLine ?? '?'}) and is clean at base`;
  if (outcome === 'preexisting-fail') return `${files} fires at head and at base (${d.head?.fireLine ?? '?'}): says nothing about this head`;
  if (outcome === 'no-signal') return `${files} is clean at head`;
  return `${files} could not run: ${d.head?.why ?? d.base?.why ?? d.setupError ?? 'unknown'}`;
}

/** Only a differential fail changes the verdict. Nothing here ever returns not_reproduced. */
export function mapOutcome(outcome, detail) {
  return { verdict: outcome === 'differential-fail' ? 'reproduced' : 'not_attempted', reason: `oracle0 ${outcome}: ${detail}` };
}

/** The probe-set rows that classify did not block: the ones oracle0 runs. */
export const targetsOf = (probeRows) => probeRows.filter((r) => r.blocked === null);

/** Outcome counts per group, over unblocked findings that have a result. */
export function tally(probeRows, results) {
  const out = { A: {}, B: {}, C: {} };
  for (const r of targetsOf(probeRows)) {
    const res = results.get(r.pid);
    if (res) out[r.group][res.outcome] = (out[r.group][res.outcome] ?? 0) + 1;
  }
  return out;
}

/** The C2 file. results: Map pid -> { outcome, detail, tests, evidencePath }. A pid with no result was not selected. */
export function buildArm(probeRows, results, { generatedFrom = '' } = {}) {
  const rows = probeRows.map((r) => {
    const res = results.get(r.pid);
    let m;
    if (r.blocked) m = { verdict: `blocked:${r.blocked}`, reason: `classify: ${r.blocked}` };
    else if (res) m = mapOutcome(res.outcome, res.detail);
    else m = { verdict: 'not_attempted', reason: 'oracle0: not selected for this run' };
    return {
      pid: r.pid, row: r.row, group: r.group, ...m, originalSeverity: r.severity, originalConfidence: r.confidence,
      newSeverity: r.severity, newConfidence: r.confidence, falseConfirm: null, evidencePath: res?.evidencePath ?? null,
      oracle0: { outcome: res?.outcome ?? (r.blocked ? 'blocked' : 'not-selected'), tests: res?.tests ?? [] },
    };
  });
  return { arm: ARM, generatedFrom, rows };
}

// ---------- git blobs ----------

/** Parses `git cat-file --batch` output for n requests, in order. A missing object is null. */
export function parseCatFileBatch(buf, n) {
  const out = [];
  let at = 0;
  for (let i = 0; i < n; i += 1) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) throw new Error(`cat-file output ends after ${i} of ${n} objects`);
    const header = buf.toString('utf8', at, nl);
    at = nl + 1;
    if (/ missing$/.test(header)) { out.push(null); continue; }
    const m = / (blob|tree|commit|tag) (\d+)$/.exec(header);
    if (!m) throw new Error(`cat-file header not understood: ${JSON.stringify(header.slice(0, 80))}`);
    const size = Number(m[2]);
    out.push(buf.toString('utf8', at, at + size));
    at += size + 1;
  }
  return out;
}

function gitHeadContext(repo) {
  return (head) => {
    const ls = spawnSync('git', ['-C', repo, 'ls-tree', '-r', '-z', '--name-only', head], { encoding: 'utf8', maxBuffer: 1 << 28, env: stripEnv(process.env) });
    if (ls.status !== 0) throw new Error(`git ls-tree ${head}: ${(ls.stderr || ls.error?.message || '').trim()}`);
    const listed = ls.stdout.split('\0').filter(Boolean);
    const tests = listed.filter((f) => isTestPath(f) && SPEC_OR_TEST.test(f));
    const cat = spawnSync('git', ['-C', repo, 'cat-file', '--batch'], { input: tests.map((f) => `${head}:${f}\n`).join(''), maxBuffer: 1 << 29, env: stripEnv(process.env) });
    if (cat.status !== 0) throw new Error(`git cat-file --batch: ${String(cat.stderr).trim()}`);
    const blobs = parseCatFileBatch(cat.stdout, tests.length);
    const texts = new Map(tests.map((f, i) => [f, blobs[i]]));
    return { listed, read: (f) => texts.get(f) ?? '' };
  };
}

// ---------- real runner ----------

const PROOF_ROOT = ['.claude', 'cache', 'proof'];

function removeTree(repo, tree) {
  const root = path.join(path.resolve(repo), ...PROOF_ROOT);
  const rel = path.relative(root, path.resolve(tree));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return;
  rmSync(tree, { recursive: true, force: true });
}

/** The real deps: git for the plan, prove-check trees for the runs. The env has no Anthropic key. */
export function realRunDeps(repo = REPO) {
  const od = oracleDeps({ repo, env: stripEnv(process.env) });
  return {
    headContext: gitHeadContext(repo),
    async runGroup(row) {
      const release = od.acquire ? od.acquire(row) : null;
      const trees = [];
      try {
        const h = od.buildTree(row, row.fix);
        trees.push(h.tree);
        const head = od.runCmd(row, h.tree);
        // The base side matters only when the test fires at head. A clean or broken head has no differential, and the head test laid
        // over the base tree often cannot load there (the PR added the export it imports): that is noise, not a result.
        if (classifyRun(row, head).verdict !== 'fire') return { head, base: null };
        const b = od.buildTree(row, row.pre);
        trees.push(b.tree);
        return { head, base: od.runCmd(row, b.tree) };
      } finally {
        if (typeof release === 'function') release();
        for (const t of trees) removeTree(repo, t);
      }
    },
    now: () => new Date().toISOString(),
  };
}

// ---------- planning and running ----------

function planFor(target, ctx) {
  const tests = nearestTests(ctx.flows, target.file);
  const { groups, skipped } = planRunners(tests, ctx.read);
  return { pid: target.pid, row: target.row, group: target.group, file: target.file, head: target.head, base: target.mergeBase, tests, groups, skipped };
}

const groupKey = (p, g) => [p.head, p.base, g.kind, ...[...g.files].sort()].join('|');

async function runOne(plan, g, deps, cache) {
  const key = groupKey(plan, g);
  if (!cache.has(key)) {
    const row = groupRow({ major: plan.pid, pre: plan.base, fix: plan.head, overlay: g.files }, g, { check: ARM });
    cache.set(key, (async () => {
      try { return { row, runs: await deps.runGroup(row) }; } catch (e) { return { row, error: String(e.message ?? e) }; }
    })());
  }
  return cache.get(key);
}

const tailOf = (run) => clip(`${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim());

/** differential() when both sides ran. With no base run the head alone decides: clean is no-signal, broken is broken, a fire has no base to compare. */
function differentialOf(row, runs) {
  if (runs.base) return differential(row, runs.head, runs.base);
  const head = classifyRun(row, runs.head);
  if (head.verdict === 'no-fire') return { verdict: 'no-signal', head, base: null };
  return { verdict: 'broken', head: head.verdict === 'broken' ? head : { ...head, why: 'fires at head but no base run was made' }, base: null };
}

async function entriesFor(plan, deps, cache) {
  const entries = plan.skipped.map((s) => ({ kind: 'skipped', files: [s.file], skipped: `${s.file}: ${s.reason}` }));
  for (const g of plan.groups) {
    if (g.container) { entries.push({ kind: g.kind, files: g.files, skipped: `${g.files.join(', ')}: container group (Playwright server spec), not run by this host-only arm` }); continue; }
    const r = await runOne(plan, g, deps, cache);
    if (r.error) { entries.push({ kind: g.kind, files: g.files, differential: { verdict: 'broken', head: { why: `setup error: ${r.error}` }, base: {} }, key: groupKey(plan, g) }); continue; }
    const d = differentialOf(r.row, r.runs);
    entries.push({ kind: g.kind, files: g.files, differential: { verdict: d.verdict, head: d.head, base: d.base }, cmd: r.runs.head.cmd, key: groupKey(plan, g), tail: { head: tailOf(r.runs.head), base: r.runs.base ? tailOf(r.runs.base) : null } });
  }
  return entries;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const o = { live: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new RangeError(`${a} needs a value`); i += 1; return argv[i]; };
    if (a === '--out') o.out = val();
    else if (a === '--live') o.live = true;
    else if (a === '--pids') o.pids = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--date') o.date = val();
    else throw new RangeError(`unknown argument ${a}`);
  }
  return o;
}

const localDate = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const planJson = (p) => ({ pid: p.pid, row: p.row, group: p.group, file: p.file, head: p.head, base: p.base, tests: p.tests, groups: p.groups.map((g) => ({ kind: g.kind, files: g.files, container: g.container === true, cmd: g.cmd })), skipped: p.skipped });
const write = (file, data) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`); };

export async function main(argv, deps, io = { log: (s) => process.stdout.write(`${s}\n`) }) {
  let o;
  try { o = parseArgs(argv); } catch (e) { io.log(`oracle0-arm: ${e.message}`); return 2; }
  const probeSet = loadProbeSet();
  const out = path.resolve(o.out ?? DEFAULT_OUT);
  const dir = path.join(out, ARM);
  const known = new Set(probeSet.rows.map((r) => r.pid));
  const bad = (o.pids ?? []).filter((p) => !known.has(p));
  if (bad.length) { io.log(`oracle0-arm: unknown pid ${bad.join(', ')}`); return 2; }
  const d = deps ?? realRunDeps();
  const targets = targetsOf(probeSet.rows).filter((r) => !o.pids || o.pids.includes(r.pid));

  const ctxs = new Map();
  const ctxOf = (head) => {
    if (!ctxs.has(head)) { const c = d.headContext(head); ctxs.set(head, { ...c, flows: testFlows(c.listed, c.read) }); }
    return ctxs.get(head);
  };
  const plans = targets.map((t) => planFor(t, ctxOf(t.head)));
  const uniqueRuns = new Set(plans.flatMap((p) => p.groups.filter((g) => !g.container).map((g) => groupKey(p, g))));
  write(path.join(dir, 'plan.json'), { arm: ARM, live: o.live, rows: plans.map(planJson) });
  io.log(`oracle0 plan: ${plans.length} findings, ${plans.filter((p) => p.tests.length).length} with a near test, ${uniqueRuns.size} unique group runs (head + base each)`);
  if (!o.live) {
    io.log(`oracle0-arm: plan only, nothing was run. Plan: ${path.join(dir, 'plan.json')}. Add --live to run the tests (no model is used).`);
    return 0;
  }

  const cache = new Map();
  const results = new Map();
  for (const plan of plans) {
    const entries = await entriesFor(plan, d, cache);
    const { outcome, detail } = outcomeOf(entries);
    const evidencePath = path.join(ARM, 'evidence', `${plan.pid}.json`);
    write(path.join(out, evidencePath), { pid: plan.pid, row: plan.row, file: plan.file, head: plan.head, base: plan.base, outcome, detail, tests: plan.tests, groups: entries });
    results.set(plan.pid, { outcome, detail, tests: plan.tests, evidencePath });
    io.log(`${plan.row.padEnd(4)} ${plan.pid} ${outcome}${plan.tests.length ? ` (${plan.tests.length} test${plan.tests.length === 1 ? '' : 's'})` : ''}`);
  }
  const date = o.date ?? localDate();
  const generatedFrom = `oracle0-arm.mjs live ${d.now?.() ?? ''} probe-set ${probeSet.rows.length} rows, ${plans.length} findings run, ${uniqueRuns.size} unique group runs`.trim();
  const arm = buildArm(probeSet.rows, results, { generatedFrom });
  const summary = { date, generatedFrom, findingsRun: plans.length, uniqueGroupRuns: uniqueRuns.size, tally: tally(probeSet.rows, results), verdicts: arm.rows.reduce((m, r) => { m[r.verdict] = (m[r.verdict] ?? 0) + 1; return m; }, {}) };
  // score-arms scores a control only from a live, complete file: dryRun false, partial false, attemptedPids = the findings this run judged.
  write(path.join(dir, 'verdicts.json'), { ...arm, dryRun: false, partial: o.pids !== undefined, attemptedPids: plans.map((p) => p.pid), summary });
  write(path.join(path.dirname(out), `${date}-trex-verify-p1-oracle0.json`), { summary, rows: arm.rows });
  io.log(`oracle0 tally (unblocked findings): ${JSON.stringify(summary.tally)}`);
  io.log(`oracle0 verdicts: ${JSON.stringify(summary.verdicts)}`);
  io.log(path.join(dir, 'verdicts.json'));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
