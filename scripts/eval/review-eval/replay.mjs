// Replay: rebuild the review tree of a CodeRabbit round and run the engine (grok via runReview) on it.
// Round 1 of a merged PR: merge-base(sha, merge^1)..sha. Round 1 of an open PR: merge-base(sha, pull.base.sha)..sha.
// Round k: rounds[k-1].sha..sha, or `rebased` (the round-1 rule) when that sha is not an ancestor.
// Output only under .claude/cache/e2e/review-eval/ (or the shadow root). Never under a local-review/ folder: LR-PIN reads there.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultLedgerPath, prepareReview, runReview } from '../../github/cursor-review.mjs';
import { budgetFromFile, EVAL_SESSION, SHADOW_SESSION } from './budget.mjs';
import { underLocalReview } from './config.mjs';
import { checkFreeze } from './freeze.mjs';
import { fetchPr } from './github.mjs';

/** A sync git bound to a folder: (args) => { status, stdout, stderr }. */
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

/**
 * One replay. args: { pr, round, buildOnly, set, kind: 'eval' | 'shadow' }.
 * deps: { root, cfg, git, fetchPrFn, checkFreeze, ledgerPath, runsPath, outRoot, prepare, runReview, readFindings, now, tmpRoot, env, gh, repo }.
 * Returns { exit, status: 'ok' | 'failed' | 'tree_unbuildable' | 'cap' | 'frozen' | 'refused' | 'built', ... }. It does not throw.
 */
export async function replayRun({ pr, round, buildOnly = false, set = 'holdout', kind = 'eval' }, deps) {
  const root = deps.root;
  const cfg = deps.cfg;
  const now = deps.now ?? Date.now;
  const git = deps.git ?? makeGit(root);
  const ledgerPath = deps.ledgerPath ?? defaultLedgerPath();
  const outRoot = deps.outRoot ?? path.join(root, '.claude', 'cache', 'e2e', 'review-eval');
  const runsPath = deps.runsPath ?? path.join(outRoot, 'runs.jsonl');
  const refuse = (exit, status, reason) => ({ exit, status, reason, pr, round });

  const bad = [outRoot, runsPath].find(underLocalReview);
  if (bad) return refuse(2, 'refused', `replay never writes under a local-review folder: ${bad}`);

  let promptSha = null;
  if (!buildOnly) {
    const frozen = (deps.checkFreeze ?? checkFreeze)(cfg);
    if (!frozen.ok) return refuse(2, 'frozen', frozen.reason);
    promptSha = frozen.promptSha256;
    const budget = budgetFromFile(ledgerPath, cfg, { now: now(), kind });
    if (!budget.ok) return refuse(3, 'cap', `${budget.reason} (eval ${budget.evalUsed}, global ${budget.globalUsed})`);
  }

  let pull;
  try { pull = await (deps.fetchPrFn ?? fetchPr)(pr, { gh: deps.gh, repo: deps.repo }); } catch (err) { return refuse(1, 'failed', `PR ${pr}: ${err.message}`); }
  const cur = pull.rounds?.[round - 1];
  const record = (patch) => ({ schema: 1, set, pr, round, sha40: cur?.sha40 ?? null, base40: null, range: 'normal', promptSha256: promptSha, cursorRunId: null, findingsPath: null, durationMs: 0, usage: null, findingCount: 0, ts: new Date(now()).toISOString(), ...patch });
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
  let res;
  try {
    res = await (deps.runReview ?? runReview)({ root, input: { range: r.spec }, model: 'grok-4.7-high', band: 'MID', ledgerPath, outDir }, { env });
  } catch (err) {
    res = { exit: 1, error: String(err.message) };
  }
  let found = {};
  if (res.findingsPath) { try { found = (deps.readFindings ?? readJson)(res.findingsPath); } catch { found = {}; } }
  const status = res.exit === 0 ? 'ok' : res.exit === 3 ? 'cap' : 'failed';
  const rec = record({
    status, base40: r.base, range: r.range, cursorRunId: res.runId ?? null, findingsPath: res.findingsPath ?? null, durationMs: found.durationMs ?? 0,
    usage: found.usage ?? null, findingCount: Array.isArray(found.findings) ? found.findings.length : 0, ...(res.error || res.reason ? { reason: res.error ?? res.reason } : {}),
  });
  appendRun(runsPath, rec);
  return { exit: res.exit === 0 ? 0 : res.exit ?? 1, status, pr, round, record: rec, findingsPath: res.findingsPath };
}

function appendRun(file, rec) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(rec)}\n`);
}
