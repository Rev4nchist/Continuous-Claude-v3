// Replay: rebuild the review tree of a CodeRabbit round and run a reviewer on it. The reviewer is the local review engine (engine-run.mjs, the default)
// or the old cursor-review runReview ('cursor-review': args.reviewer, deps.reviewer or cfg.replayReviewer), which keeps old archives reproducible.
// Round 1 of a merged PR: merge-base(sha, merge^1)..sha. Round 1 of an open PR: merge-base(sha, pull.base.sha)..sha.
// Round k: rounds[k-1].sha..sha, or `rebased` (the round-1 rule) when that sha is not an ancestor.
// Output only under .claude/cache/e2e/review-eval/ (or the shadow root). Never under a local-review/ folder: LR-PIN reads there.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultLedgerPath, prepareReview, runReview } from '../../github/cursor-review.mjs';
import { LOCAL_REVIEW_DEFAULTS, loadConfig as loadEngineConfig } from '../../github/local-review.mjs';
import { budgetFromFile, EVAL_SESSION, SHADOW_SESSION } from './budget.mjs';
import { underLocalReview } from './config.mjs';
import { runEngine, toEvalFindings } from './engine-run.mjs';
import { checkEngineFreeze, checkFreeze } from './freeze.mjs';
import { fetchPr } from './github.mjs';
import { auditReplay } from './read-audit.mjs';

/** A sync git bound to a folder: (args) => { status, stdout, stderr }. */
export const REVIEWERS = ['engine', 'cursor-review'];

export function makeGit(root) {
  return (args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

const out = (r) => (r.status === 0 ? r.stdout.trim() : null);

/** { sha40, base, range: 'normal' | 'rebased', spec, reason? }. pull: { merged, mergeSha, baseSha, rounds[] }. */
export function roundRange(pr, round, { git, pull }) {
  const cur = pull.rounds?.[round - 1];
  if (!cur) return { sha40: null, base: null, range: 'normal', spec: null, reason: `PR ${pr} has no CodeRabbit round ${round}` };
  const sha40 = cur.sha40;
  const roundOneBase = () => {
    const other = pull.merged && pull.mergeSha ? `${pull.mergeSha}^1` : pull.baseSha;
    return other ? out(git(['merge-base', sha40, other])) : null;
  };
  let base;
  let range = 'normal';
  if (round === 1) {
    base = roundOneBase();
  } else {
    const prev = pull.rounds[round - 2].sha40;
    if (git(['merge-base', '--is-ancestor', prev, sha40]).status === 0) {
      base = prev;
    } else {
      base = roundOneBase();
      range = 'rebased';
    }
  }
  return base ? { sha40, base, range, spec: `${base}..${sha40}` } : { sha40, base: null, range, spec: null, reason: 'no merge base found' };
}

/** Makes every sha available locally: fetch pull/N/head, then the sha itself. { ok, missing[] }. */
export function ensureCommits(git, shas, pr, remote = 'fork') {
  const have = (sha) => git(['cat-file', '-e', `${sha}^{commit}`]).status === 0;
  let missing = shas.filter((s) => !have(s));
  if (missing.length > 0) {
    git(['fetch', '--quiet', remote, `pull/${pr}/head`]);
    missing = missing.filter((s) => !have(s));
  }
  for (const s of [...missing]) {
    git(['fetch', '--quiet', remote, s]);
    if (have(s)) missing = missing.filter((m) => m !== s);
  }
  return { ok: missing.length === 0, missing };
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The config file the engine itself loads: review-router.config.json beside the local-review.mjs this checkout runs (engine-here). */
const ENGINE_CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'review-router.config.json');

/** retry_max of the engine config, so a replay knows how many runs one engine call may reserve (1 + retry_max). An unreadable config gives the engine default. */
function engineRetryMax(file) {
  const loaded = loadEngineConfig(file);
  return loaded.ok ? loaded.cfg.retry_max : LOCAL_REVIEW_DEFAULTS.retry_max;
}

/**
 * One replay. args: { pr, round, buildOnly, set, kind: 'eval' | 'shadow', reviewer?: 'engine' | 'cursor-review', bodyMode?: 'withheld' | 'full' }.
 * bodyMode (engine only): 'withheld' (the default) keeps the PR body out of the reviewer's CONTEXT.md; the body of a merged PR holds the findings and their fixes.
 * deps: { root, cfg, git, fetchPrFn, checkFreeze, checkEngineFreeze, runEngine, readConfigText, reviewer, ledgerPath, runsPath, outRoot, prepare, runReview, readFindings, now, tmpRoot, env, gh, repo }.
 * Returns { exit, status: 'ok' | 'failed' | 'tree_unbuildable' | 'cap' | 'frozen' | 'refused' | 'built', ... }. It does not throw.
 */
export async function replayRun({ pr, round, buildOnly = false, set = 'holdout', kind = 'eval', reviewer: asked, bodyMode = 'withheld' }, deps) {
  const root = deps.root;
  const cfg = deps.cfg;
  const now = deps.now ?? Date.now;
  const git = deps.git ?? makeGit(root);
  const ledgerPath = deps.ledgerPath ?? defaultLedgerPath();
  const outRoot = deps.outRoot ?? path.join(root, '.claude', 'cache', 'e2e', 'review-eval');
  const runsPath = deps.runsPath ?? path.join(outRoot, 'runs.jsonl');
  const refuse = (exit, status, reason) => ({ exit, status, reason, pr, round });
  const reviewer = asked ?? deps.reviewer ?? cfg.replayReviewer ?? 'engine';
  if (!['withheld', 'full'].includes(bodyMode)) return refuse(2, 'refused', `unknown bodyMode ${JSON.stringify(bodyMode)}: use withheld or full`);
  if (!REVIEWERS.includes(reviewer)) return refuse(2, 'refused', `unknown reviewer ${JSON.stringify(reviewer)}: use ${REVIEWERS.join(' or ')}`);

  const bad = [outRoot, runsPath].find(underLocalReview);
  if (bad) return refuse(2, 'refused', `replay never writes under a local-review folder: ${bad}`);

  let promptSha = null;
  if (!buildOnly) {
    const frozen = reviewer === 'engine' ? (deps.checkEngineFreeze ?? checkEngineFreeze)(cfg) : (deps.checkFreeze ?? checkFreeze)(cfg);
    if (!frozen.ok) return refuse(2, 'frozen', frozen.reason);
    promptSha = frozen.promptSha256;
    // One engine call reserves 1 + retry_max runs, so the budget must hold all of them, not just the first.
    const need = reviewer === 'engine' ? 1 + engineRetryMax(deps.engineConfigPath ?? ENGINE_CONFIG) : 1;
    const budget = budgetFromFile(ledgerPath, cfg, { now: now(), kind, need });
    if (!budget.ok) return refuse(3, 'cap', `${budget.reason} (eval ${budget.evalUsed}, global ${budget.globalUsed})`);
  }

  let pull;
  try { pull = await (deps.fetchPrFn ?? fetchPr)(pr, { gh: deps.gh, repo: deps.repo }); } catch (err) { return refuse(1, 'failed', `PR ${pr}: ${err.message}`); }
  const cur = pull.rounds?.[round - 1];
  const record = (patch) => ({ schema: 1, reviewer, set, pr, round, sha40: cur?.sha40 ?? null, base40: null, range: 'normal', promptSha256: promptSha, cursorRunId: null, findingsPath: null, durationMs: 0, usage: null, findingCount: 0, ts: new Date(now()).toISOString(), ...patch });
  const unbuildable = (reason, extra = {}) => {
    const rec = record({ status: 'tree_unbuildable', reason, ...extra });
    if (!buildOnly) appendRun(runsPath, rec);
    return { exit: 1, status: 'tree_unbuildable', reason, pr, round, record: rec };
  };
  if (!cur) return unbuildable(`PR ${pr} has no CodeRabbit round ${round}`);

  const need = [cur.sha40, pull.mergeSha, pull.rounds[round - 2]?.sha40].filter(Boolean);
  const have = ensureCommits(git, need, pr);
  if (!have.ok && have.missing.includes(cur.sha40)) return unbuildable(`sha ${cur.sha40.slice(0, 8)} is not reachable after the fetch`);
  const r = roundRange(pr, round, { git, pull });
  if (!r.base) return unbuildable(r.reason ?? 'no range');

  const prepare = deps.prepare ?? prepareReview;
  if (buildOnly) {
    try {
      const prep = await prepare({ root, input: { range: r.spec }, tmpRoot: deps.tmpRoot ?? os.tmpdir() });
      const files = prep.files?.length ?? 0;
      prep.cleanup();
      return { exit: 0, status: 'built', pr, round, sha40: r.sha40, base40: r.base, range: r.range, files };
    } catch (err) {
      return unbuildable(String(err.message), { base40: r.base, range: r.range });
    }
  }

  const outDir = path.join(outRoot, String(pr), r.sha40.slice(0, 8));
  const env = { ...(deps.env ?? process.env), CLAUDE_CODE_SESSION_ID: kind === 'shadow' ? SHADOW_SESSION : EVAL_SESSION };
  if (reviewer === 'engine') return replayEngine({ bodyMode, pr, round, r, deps, root, outRoot, outDir, runsPath, ledgerPath, env, record, git });
  let res;
  try {
    res = await (deps.runReview ?? runReview)({ root, input: { range: r.spec }, model: 'grok-4.7-high', band: 'MID', ledgerPath, outDir }, { env });
  } catch (err) {
    res = { exit: 1, error: String(err.message) };
  }
  let found = {};
  if (res.findingsPath) { try { found = (deps.readFindings ?? readJson)(res.findingsPath); } catch { found = {}; } }
  const status = res.exit === 0 ? 'ok' : res.exit === 3 ? 'cap' : 'failed';
  const audit = status === 'ok' ? auditReplay({ env, ...deps.auditOpts, kind: 'cursor-review', runOk: true, streamPath: res.rawPath ?? res.findingsPath?.replace(/\.findings\.json$/, '.raw.json') ?? null, runId: res.runId, head: r.sha40, pr, round, git }) : null;
  const rec = record({
    status, base40: r.base, range: r.range, cursorRunId: res.runId ?? null, findingsPath: res.findingsPath ?? null, durationMs: found.durationMs ?? 0,
    usage: found.usage ?? null, findingCount: Array.isArray(found.findings) ? found.findings.length : 0, ...(res.error || res.reason ? { reason: res.error ?? res.reason } : {}), ...audit?.patch,
  });
  appendRun(runsPath, rec);
  return { exit: rec.void ? 1 : res.exit === 0 ? 0 : res.exit ?? 1, status: rec.status, pr, round, record: rec, findingsPath: res.findingsPath };
}

function appendRun(file, rec) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(rec)}\n`);
}

/**
 * The engine path of replayRun: one reviewHead run on the round (engine-run.mjs). The run row carries the funnel, the trace path, the record path,
 * the band config source and its sha256. The findings file has the shape evaluateRuns reads (line = the engine startLine), plus the withdrawn list.
 * State of the run (records, slots) sits in <outRoot>/engine-state, never under a local-review folder.
 */
async function replayEngine({ bodyMode, pr, round, r, deps, root, outRoot, outDir, runsPath, ledgerPath, env, record, git }) {
  const configText = (deps.readConfigText ?? (() => readFileSync(path.join(root, 'review-router.config.json'), 'utf8')))();
  const res = await (deps.runEngine ?? runEngine)({
    pr, sha40: r.sha40, base40: r.base, root, stateRoot: path.join(outRoot, 'engine-state'), stateDir: outRoot, ledgerPath, env, configText, bodyMode, gh: deps.gh, repo: deps.repo, log: deps.log,
  });
  let findingsPath = null;
  let found = null;
  if (res.record) {
    found = toEvalFindings(res.record, { tracePath: res.tracePath && existsSync(res.tracePath) ? res.tracePath : null });
    mkdirSync(outDir, { recursive: true });
    findingsPath = path.join(outDir, `${res.record.runId}.findings.json`);
    writeFileSync(findingsPath, `${JSON.stringify(found, null, 2)}\n`);
  }
  const audit = ['ok', 'incomplete'].includes(res.status) ? auditReplay({ env, ...deps.auditOpts, kind: 'engine', runOk: res.status === 'ok', streamPath: res.recordPath?.replace(/\.json$/, '.stream.jsonl.gz') ?? null, runId: res.record?.runId, head: r.sha40, pr, round, git }) : null;
  const rec = record({
    status: res.status, base40: r.base, range: r.range, cursorRunId: res.record?.runId ?? null, findingsPath, durationMs: found?.durationMs ?? 0, usage: found?.usage ?? null,
    findingCount: found?.findings.length ?? 0, trusted: false, bodyMode, baseConfig: res.baseConfig ?? null, recordPath: res.recordPath ?? null, tracePath: found?.tracePath ?? null,
    funnel: found?.funnel ?? null, withdrawnCount: found?.withdrawn.length ?? 0, modelVerified: found?.modelVerified ?? false, coverageComplete: res.record?.coverage?.complete ?? null,
    ...(res.record ? { promptSha256: res.record.promptSha256 ?? null } : {}), ...(res.reason ? { reason: res.reason } : {}), ...audit?.patch,
  });
  appendRun(runsPath, rec);
  return { exit: rec.status === 'ok' ? 0 : rec.status === 'cap' ? 3 : 1, status: rec.status, ...(rec.reason ? { reason: rec.reason } : {}), pr, round, record: rec, findingsPath };
}
