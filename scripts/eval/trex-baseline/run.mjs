#!/usr/bin/env node
// Drives the local review engine (scripts/github/local-review.mjs reviewHead) over the TREX baseline runs.
// reviewHead needs a PR; each run gets a synthetic pull (head = range head, base = range base) through the injected gh dep.
//   node run.mjs --out <dir> [--dry] [--only S1,N3] [--max-runs 26] [--concurrency 3] [--retries 2]
// --dry stubs the agent: no cursor-agent starts, a temp ledger is used, and the band, model, tree and leak report are written.
// Live mode counts every agent start against --max-runs and refuses to start another past it. notStarted runs do not count and
// may be retried up to --retries times in total.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultLedgerPath, prepareReview, runAgent } from '../../github/cursor-review.mjs';
import { reviewHead } from '../../github/local-review.mjs';
import { readAtSha } from '../../github/local-review/context.mjs';
import { planRuns } from './adapter.mjs';
import { buildRows } from './rows.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const BENCH_DIR = 'C:/Users/dkhay/continuous-claude/.claude/worktrees/trex/scripts/trex/bench';
const SESSION = 'trex-baseline';
const flag = (argv, name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d; };

const git = (args) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
  return r.stdout ?? '';
};

/** Text files under dir that hold any needle. Skips .git and binary-looking files. */
function leakScan(dir, needles) {
  const hits = [];
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { if (ent.name !== '.git' && ent.name !== 'node_modules') walk(p); continue; }
      if (!ent.isFile() || statSync(p).size > 2_000_000) continue;
      const text = readFileSync(p, 'utf8');
      for (const n of needles) if (n && text.includes(n)) hits.push({ file: path.relative(dir, p).replaceAll('\\', '/'), needle: n });
    }
  };
  walk(dir);
  return hits;
}

/** A synthetic gh: the one call resolveTarget makes. */
function syntheticGh(run) {
  const pull = {
    number: run.pr, draft: false, title: `trex-baseline ${run.runId}`, body: '', user: { login: 'trex-baseline' }, labels: [],
    head: { sha: run.head40, ref: `trex-baseline-${run.runId}` }, base: { sha: run.base40, ref: 'main' },
  };
  return async () => pull;
}

export async function main(argv) {
  const out = path.resolve(flag(argv, '--out', path.join(ROOT, '.claude', 'cache', 'e2e', 'trex-baseline')));
  const dry = argv.includes('--dry');
  const maxRuns = Number(flag(argv, '--max-runs', 26));
  const concurrency = Number(flag(argv, '--concurrency', 3));
  const maxRetries = Number(flag(argv, '--retries', 2));
  const only = flag(argv, '--only', null)?.split(',');
  process.env.CCV3_GROK_MAX_CONCURRENT = process.env.CCV3_GROK_MAX_CONCURRENT || '3';

  const rows = buildRows({ benchDir: BENCH_DIR, git });
  let runs = planRuns(rows);
  if (only) runs = runs.filter((r) => only.includes(r.runId) || r.rowIds.some((id) => only.includes(id)));
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'plan.json'), `${JSON.stringify({ rows: rows.map(({ fixHunk, ...r }) => r), runs }, null, 1)}\n`);

  const stateDir = path.join(out, dry ? '_state-dry' : '_state');
  mkdirSync(stateDir, { recursive: true });
  const ledger = dry ? path.join(stateDir, 'cursor-review-ledger.jsonl') : defaultLedgerPath();
  const configPath = path.join(stateDir, 'review-router.config.json');
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8'));
  cfg.local_review = { ...(cfg.local_review ?? {}), max_concurrent: concurrency, retry_max: 0 }; // retries are mine, and only for notStarted
  writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);

  let used = 0; // agent starts, notStarted excluded
  let retriesLeft = maxRetries;
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION };

  async function one(run, attempt) {
    const dir = path.join(out, run.runId);
    mkdirSync(dir, { recursive: true });
    const info = { runId: run.runId, rowIds: run.rowIds, base40: run.base40, head40: run.head40, attempt };
    const rowsOf = rows.filter((r) => run.rowIds.includes(r.id));
    const needles = rowsOf.flatMap((r) => [r.pre40?.slice(0, 8), r.fix40?.slice(0, 8)]).filter(Boolean);
    let lastRun = null;
    const wrapPrepare = async (a) => {
      const prep = await prepareReview(a);
      rmSync(path.join(prep.dir, 'scripts', 'checks', 'proofs.json'), { force: true }); // holds S1-S10 answers (bench spec section 4, step 3)
      info.treeFiles = prep.files.length;
      info.leaks = leakScan(prep.dir, needles);
      info.diffBytes = existsSync(path.join(prep.dir, 'PR.diff')) ? statSync(path.join(prep.dir, 'PR.diff')).size : null;
      return prep;
    };
    const agentRun = async (spec) => {
      info.model = spec.args[spec.args.indexOf('--model') + 1];
      if (dry) {
        info.dryStubbed = true;
        return { status: 1, stdout: '', stderr: 'dry run: agent stubbed', timedOut: false, durationMs: 0 };
      }
      if (used >= maxRuns) return { status: null, stdout: '', stderr: 'run cap guard', timedOut: false, error: 'cap-guard', notStarted: true, durationMs: 0 };
      used += 1;
      info.startedAt = new Date().toISOString();
      const r = await runAgent(spec);
      if (r.notStarted) used -= 1;
      lastRun = r;
      writeFileSync(path.join(dir, `raw-stdout.${attempt}.txt`), r.stdout ?? '');
      writeFileSync(path.join(dir, `raw-stderr.${attempt}.txt`), r.stderr ?? '');
      return r;
    };
    const res = await reviewHead(
      { pr: run.pr, fresh: true, engineHere: true, root: ROOT },
      {
        env, root: ROOT, gh: syntheticGh(run), runAgent: agentRun, prepareReview: wrapPrepare, agent: dry ? { cmd: 'stub' } : undefined,
        // Old merge bases hold no band matrix, which refuses the run; the band rules come from the pinned (current) config for every row.
        readAtSha: (r, s, p) => (p === 'review-router.config.json' ? null : readAtSha(r, s, p)),
        stateRoot: path.join(stateDir, 'records'), stateDir, cursorLedger: ledger, configPath, tldr: null,
        stderr: (m) => { info.log = `${info.log ?? ''}${m}\n`; },
      },
    );
    info.result = res;
    info.notStarted = Boolean(lastRun?.notStarted);
    info.durationMs = lastRun?.durationMs ?? null;
    if (res.recordPath && existsSync(res.recordPath)) copyFileSync(res.recordPath, path.join(dir, 'record.json'));
    writeFileSync(path.join(dir, `run-info.${attempt}.json`), `${JSON.stringify(info, null, 1)}\n`);
    return info;
  }

  const queue = [...runs.map((r) => ({ run: r, attempt: 1 }))];
  const done = [];
  async function worker() {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const info = await one(job.run, job.attempt);
      done.push(info);
      const notRun = info.notStarted && !dry;
      process.stderr.write(`${new Date().toISOString()} ${job.run.runId} attempt ${job.attempt}: exit ${info.result.exit} ${info.result.skipReason ?? info.result.reason ?? info.result.status ?? ''} (used ${used}/${maxRuns})\n`);
      if (notRun && retriesLeft > 0) { retriesLeft -= 1; queue.push({ run: job.run, attempt: job.attempt + 1 }); }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  const summary = { dry, used, retriesLeft, runs: done.map((d) => ({ runId: d.runId, attempt: d.attempt, model: d.model, treeFiles: d.treeFiles, leaks: d.leaks?.length ?? null, diffBytes: d.diffBytes, exit: d.result.exit, skip: d.result.skipReason ?? null, reason: d.result.reason ?? null, status: d.result.status ?? null, findingCount: d.result.findingCount ?? null, durationMs: d.durationMs })) };
  writeFileSync(path.join(out, dry ? 'summary-dry.json' : 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
  console.log(JSON.stringify(summary, null, 1));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.stack || e.message); process.exit(1); });
}
