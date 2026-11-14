// Tests for scripts/github/local-review-sweep.mjs (re-live-advisory). Every test names the source change that would break it.
// Run: node --test scripts/github/local-review-sweep.test.mjs
// gh, the agent, the clock, the state folders, the read-audit file and the cache folders are injected or temp. No test starts cursor-agent,
// calls GitHub, fetches, or reads or writes under the real ~/.claude/state. Fixtures are synthetic: made-up PR numbers, heads and findings.
//  T1  live cap          -> count end rows, eval- refs, old rows, other purposes or notStarted runs; check once, not before each run;
//                           forget the retry room (1 + retry_max) or read retry_max from somewhere else than the engine that runs
//  T2  CRITICAL          -> ignore laneState, skip CRITICAL when the check is done, or skip it with no laneState
//  T3  one engineVersion -> compute the version from something other than the engine SHA (the PR head differs from it)
//  T4  path F            -> import the checkout's engine instead of the copy, drop LOCAL_REVIEW_PINNED, mislabel a frozen run
//  T5  copy kept intact  -> check the copy once per sweep, count a run whose copy failed to extract or went away
//  T6  earlier heads     -> run the PR's last head, set evalRun, keep the body, run a minor-only head, key "already run" wrongly,
//                           pick a PR among several candidates, skip the branch filter or the branch fallback
//  T7  pairs             -> rewrite an existing pair, copy a .failed.txt, keep a head with no PR or an unknown sha
//  T8  read audit        -> skip the audit, count a void run, keep going after a void
//  T9  order and share   -> run MID before HIGH, ignore --band-counts, run LOW, ignore --max-runs
//  T10 facts             -> pass facts to a PR with no worktree, or facts of another head
//  T11 per-branch cap    -> stop the sweep at the engine's per-branch refusal
//  T12 CLI               -> run, resolve or fetch in --dry-run, accept an unknown flag or another repo, report the wrong mode
//  T13 real engine       -> the call does not fit the real reviewHead; an unpinned run gets the frozen label or counts
//  T14 failed run        -> skip the audit of a failed run that left a stream, count it, or exit 0 after it
//  T15 engine refusal    -> exit 0 after a refusal, or keep going after a pin refusal
//  T16 engine cap        -> treat the engine's own cap as a per-branch skip
//  E   counted           -> count a pinned run without the frozen engineVersion (T4b, T4c), or an unpinned run (T13)
//  Exit codes: 0 T2 and most, 1 T5 T14 T15, 2 T12b, 3 T1 T16, 4 T8 T8b
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BAND_SET_FILES, REVIEWER_SET_FILES, computeVersions as realComputeVersions } from '../eval/review-eval/engine-version.mjs';
import { readLines } from '../eval/review-eval/read-audit.mjs';
import { checkPin } from './local-review.mjs';
import {
  DEFAULT_BAND_COUNTS, FROZEN_LABEL, REHEARSAL_LABEL, SWEEP_EXIT, WEEKLY_LIVE_CAP, liveStarts, main, parseArgs, parseWorktrees, planOrder, proveCopy,
} from './local-review-sweep.mjs';
import { parseAgentStream } from './pre-pr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const REAL_CONFIG = path.join(REPO_ROOT, 'review-router.config.json');
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const DAY = 86_400_000;
const BASE = 'b'.repeat(40);
const MB = 'c'.repeat(40);
const H = (n) => String(n).repeat(40).slice(0, 40);
const FENCE = '`'.repeat(3);

const madeDirs = [];
const tmp = (label) => { const d = mkdtempSync(path.join(os.tmpdir(), `lrs-test-${label}-`)); madeDirs.push(d); return d; };
after(() => { for (const d of madeDirs) rmSync(d, { recursive: true, force: true }); });
const put = (dir, rel, text) => { const f = path.join(dir, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); return f; };
const jsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });

// ---------- a stub engine module: the same text runs in-test and from a pinned copy ----------
// resolveTarget and reviewHead log each call on globalThis. reviewHead appends a real start row to the temp Cursor ledger (as reserveRun does),
// then answers by the PR's fakeResult: a record with a clean or void stream, a failed record with or without a stream, a cap, a refusal.
const STUB_SRC = (marker) => String.raw`import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
export const MARKER = ${JSON.stringify(marker)};
const slug = (b) => String(b).replace(/[^A-Za-z0-9._-]/g, '-');
export async function resolveTarget({ pr, gh, repo }) {
  (globalThis.__sweepStubResolve ??= []).push(pr);
  const pull = await gh(['api', 'repos/' + repo + '/pulls/' + pr]);
  return { pr, head: pull.head.sha, pullBaseSha: pull.base.sha, mergeBase: pull.base.sha, pull, branch: pull.head.ref, files: [{ filename: 'f.mjs', band: pull.fakeBand }] };
}
export function routeBand({ files }) {
  const band = files[0] && files[0].band ? files[0].band : 'MID';
  return { band, detail: { band }, model: band === 'LOW' ? null : 'grok-4.7-high', escalate: [] };
}
function stream(tree, outside) {
  const p = outside ? 'C:\\work\\primary\\scripts\\eval\\review-eval\\linktype-labels.json' : tree + '\\src\\app.mjs';
  const res = { result: { success: { content: 'x', path: p, relatedCursorRulePaths: [], relatedCursorRules: [] } } };
  const body = (done) => ({ readToolCall: { args: { path: p }, ...(done ? res : {}) }, hookAdditionalContexts: [], toolCallId: 'c1' });
  const call = (sub, done) => ({ type: 'tool_call', subtype: sub, call_id: 'c1', tool_call: body(done) });
  const init = { type: 'system', subtype: 'init', cwd: tree, model: 'Grok 4.7 256K High', session_id: 's' };
  const ev = [init, call('started', false), call('completed', true), { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's' }];
  return ev.map((e) => JSON.stringify(e)).join('\n') + '\n';
}
// Answers the engine gives BEFORE any ledger start (local-review.mjs: skips, refusals, reserveRun refusals, a busy slot): no start row.
const BEFORE_START = {
  'ref-cap': { exit: 3, reason: 'ref-cap reached (8)' },
  cap: { exit: 3, reason: 'cap reached (240)' },
  refused: { exit: 2, reason: 'branch name "x" collides with the engine folder' },
  'refused-pin': { exit: 2, reason: 'not started from a pinned engine copy: run without LOCAL_REVIEW_PINNED so the engine pins itself' },
  skip: { exit: 0, skipReason: 'range done: a complete record exists at this head' },
};
// Answers that can follow a reserved start: a start row is written first.
const AFTER_START = { empty: { exit: 0 }, 'no-record': { exit: 1, reason: 'record write failed: planted' } };
export async function reviewHead(opts, deps) {
  const calls = (globalThis.__sweepStubCalls ??= []);
  const pull = await deps.gh(['api', 'repos/' + opts.repo + '/pulls/' + opts.pr]);
  const pinned = deps.env && deps.env.LOCAL_REVIEW_PINNED ? deps.env.LOCAL_REVIEW_PINNED : null;
  calls.push({ marker: MARKER, url: import.meta.url, pinned, opts, pullHead: pull.head.sha, stateRoot: deps.stateRoot, cursorLedger: deps.cursorLedger });
  if (BEFORE_START[pull.fakeResult]) return { recordPath: null, skipReason: null, ...BEFORE_START[pull.fakeResult] };
  const runId = 'stub-' + calls.length + '-' + opts.pr;
  mkdirSync(path.dirname(deps.cursorLedger), { recursive: true });
  const start = { ts: new Date(deps.now()).toISOString(), phase: 'start', id: runId, ref: 'branch-' + slug(pull.head.ref), purpose: 'review' };
  appendFileSync(deps.cursorLedger, JSON.stringify(start) + '\n');
  if (deps.onRun) deps.onRun(opts, pull);
  if (pull.fakeResult === 'throw') throw new Error('planted engine crash');
  if (AFTER_START[pull.fakeResult]) return { recordPath: null, skipReason: null, ...AFTER_START[pull.fakeResult] };
  const dir = path.join(deps.stateRoot, slug(pull.head.ref), pull.head.sha);
  mkdirSync(dir, { recursive: true });
  const recordPath = path.join(dir, runId + '.json');
  const failed = String(pull.fakeResult || '').startsWith('failed');
  const record = {
    schema: 1, runId, pr: opts.pr, branch: pull.head.ref, head: pull.head.sha, band: { band: pull.fakeBand || 'MID' }, status: failed ? 'failed' : 'ok',
    coverage: { complete: !failed }, bodyMode: opts.withholdBody ? 'withheld' : 'full', engineSha: pinned, marker: MARKER,
  };
  writeFileSync(recordPath, JSON.stringify(record));
  if (pull.fakeResult !== 'failed') {
    const tree = path.join(deps.tmpRoot, 'cursor-review-' + runId, 'tree');
    writeFileSync(recordPath.replace(/\.json$/, '.stream.jsonl.gz'), gzipSync(stream(tree, pull.fakeResult === 'void')));
  }
  if (failed) return { exit: 1, recordPath, skipReason: null, runId, status: 'failed', reason: 'the agent exited with status 1: planted' };
  return { exit: 0, recordPath, skipReason: null, runId, status: 'ok' };
}
`;
const STUB_DIR = tmp('stub');
const STUB_URL = pathToFileURL(put(STUB_DIR, 'local-review.mjs', STUB_SRC('in-test'))).href;
const stubCalls = () => globalThis.__sweepStubCalls ?? [];
const resolveCalls = () => globalThis.__sweepStubResolve ?? [];
const resetStub = () => { globalThis.__sweepStubCalls = []; globalThis.__sweepStubResolve = []; };

// ---------- fakes ----------

function pullOf(number, { band = 'MID', head = H(number), ref = `feat/pr-${number}`, draft = false, result, state = 'open' } = {}) {
  return {
    number, state, draft, title: `PR ${number}`, body: 'body', user: { login: 'dave' }, labels: [], head: { sha: head, ref }, base: { sha: BASE, ref: 'main' },
    fakeBand: band, fakeResult: result,
  };
}

function fakeGh(w) {
  return async (args) => {
    w.ghCalls.push(args);
    const url = String(args[1]);
    const find = (n) => structuredClone(w.pulls.find((p) => p.number === n));
    let m = /^repos\/[^/]+\/[^/?]+\/pulls\?state=open&per_page=100&page=(\d+)$/.exec(url);
    if (m) return Number(m[1]) === 1 ? w.pulls.map((p) => structuredClone(p)) : [];
    m = /^repos\/[^/]+\/[^/?]+\/pulls\?state=all&head=([^&]+)&per_page=100&page=1$/.exec(url);
    if (m) { const branch = decodeURIComponent(m[1]).split(':')[1]; return w.pulls.filter((p) => p.head.ref === branch).map((p) => structuredClone(p)); }
    m = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(url);
    if (m) { const p = find(Number(m[1])); if (!p) throw new Error('HTTP 404'); return p; }
    m = /^repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})\/pulls\?per_page=100&page=1$/.exec(url);
    if (m) return (w.commitPulls[m[1]] ?? []).map(find);
    throw new Error(`unscripted gh ${url}`);
  };
}

/** The repo git: worktree list, short sha lookup, HEAD, cat-file -e (fails for w.missing), and an empty ls-tree (the symlink check passes). */
function fakeRepoGit(w) {
  return (args) => {
    w.repoGitCalls.push(args);
    const [a, b] = args;
    if (a === 'worktree') return ok(w.worktrees);
    if (a === 'rev-parse' && args.includes('HEAD')) return ok(`${w.headSha}\n`);
    if (a === 'rev-parse') { const full = w.shas[String(args.at(-1)).replace('^{commit}', '')]; return full ? ok(`${full}\n`) : { status: 1, stdout: '', stderr: '' }; }
    if (a === 'cat-file' && b === '-e') return w.missing.has(String(args[2]).replace('^{commit}', '')) ? { status: 1, stdout: '', stderr: '' } : ok();
    if (a === 'ls-tree') return ok('');
    return { status: 1, stdout: '', stderr: `unscripted git ${args.join(' ')}` };
  };
}

const fakeVersions = ({ sha }) => ({ engineVersion: `ev-${sha.slice(0, 6)}`, bandVersion: `bv-${sha.slice(0, 6)}` });

function world(over = {}) {
  const T = tmp('w');
  const w = {
    T, root: path.join(T, 'root'), stateRoot: path.join(T, 'state', 'local-review'), cursorLedger: path.join(T, 'state', 'cursor-review-ledger.jsonl'),
    tmpRoot: path.join(T, 'tmp'), auditState: path.join(T, 'state', 'review-engine', 'read-audit.jsonl'), cliDir: path.join(T, 'cli'),
    pulls: [], commitPulls: {}, shas: {}, worktrees: '', headSha: H('f'), missing: new Set(), ghCalls: [], repoGitCalls: [], logs: [], out: [], ...over,
  };
  for (const d of [w.root, w.tmpRoot, w.cliDir]) mkdirSync(d, { recursive: true });
  resetStub();
  return w;
}

function deps(w, over = {}) {
  return {
    root: w.root, gh: fakeGh(w), git: fakeRepoGit(w), stateRoot: w.stateRoot, cursorLedger: w.cursorLedger, tmpRoot: w.tmpRoot, auditStatePath: w.auditState,
    env: { PATH: 'x' }, now: () => NOW, importEngine: () => import(STUB_URL), laneState: () => ({ criticalModelCheckDone: true }), computeVersions: fakeVersions,
    log: (s) => w.logs.push(String(s)), out: (s) => w.out.push(String(s)), runAgent: async () => { throw new Error('no agent in tests'); }, agent: { cmd: 'fake-agent' },
    ...over,
  };
}

const sweep = (w, argv = [], over = {}) => main(['--cli-dir', w.cliDir, '--json', ...argv], deps(w, over));
const reportOf = (w) => JSON.parse(w.out.at(-1));
const listFile = (w) => path.join(w.stateRoot, 'cli-pairs', 'sweep-runs.jsonl');
const seedList = (w, rows) => { mkdirSync(path.dirname(listFile(w)), { recursive: true }); for (const r of rows) appendFileSync(listFile(w), `${JSON.stringify(r)}\n`); };

/** A synthetic CodeRabbit CLI agent stream in the event shape of pre-pr.test.mjs (review_context, finding, complete). */
const cliStream = (severities) => `${[
  JSON.stringify({ type: 'review_context', workingDirectory: '/x', currentBranch: 'feat/x', baseBranch: 'main' }),
  ...severities.map((s, i) => JSON.stringify({ type: 'finding', severity: s, fileName: `src/f${i}.mjs`, startLine: i + 1, endLine: i + 1, title: `made-up ${s} finding ${i}` })),
  JSON.stringify({ type: 'complete', status: 'review_completed', findings: severities.length, outcome: 'completed' }),
].join('\n')}\n`;

function seedLedger(w, rows) {
  mkdirSync(path.dirname(w.cursorLedger), { recursive: true });
  for (const r of rows) appendFileSync(w.cursorLedger, `${JSON.stringify(r)}\n`);
}
const liveRow = (i, over = {}) => ({ ts: new Date(NOW - 3600_000).toISOString(), phase: 'start', id: `live-${i}`, ref: 'branch-feat-x', purpose: 'review', ...over });
const noiseRows = () => [
  ...Array.from({ length: 5 }, (_, i) => liveRow(`e${i}`, { ref: `eval-7-${i}` })),
  ...Array.from({ length: 5 }, (_, i) => liveRow(`o${i}`, { ts: new Date(NOW - 8 * DAY).toISOString() })),
  ...Array.from({ length: 5 }, (_, i) => liveRow(`b${i}`, { purpose: 'bench' })),
  ...Array.from({ length: 5 }, (_, i) => ({ ts: new Date(NOW - 60_000).toISOString(), phase: 'end', id: `end-only-${i}`, ref: 'branch-feat-x', purpose: 'review' })),
  liveRow('ns'), { ts: new Date(NOW - 60_000).toISOString(), phase: 'end', id: 'live-ns', notStarted: true, purpose: 'review', ref: 'branch-feat-x' },
];
const seedLive = (w, n) => seedLedger(w, [...noiseRows(), ...Array.from({ length: n }, (_, i) => liveRow(i))]);

// ---------- T1 live cap ----------

test('T1 the cap is checked before EACH run with room for 1 + retry_max: 98 live starts allow one run, its start row fills the room, and the sweep stops', async () => {
  // Breaks when: the cap is checked once per sweep, the retry room is left out, or liveStarts counts a row that is not a live review start.
  const w = world({ pulls: [pullOf(1), pullOf(2)] });
  seedLive(w, 98);
  assert.equal(await sweep(w), SWEEP_EXIT.CAP);
  assert.equal(stubCalls().length, 1);
  const r = reportOf(w);
  assert.equal(r.stopped, 'live-cap');
  assert.deepEqual(r.ledger, { liveStarts: 99, cap: WEEKLY_LIVE_CAP, retryMax: 1, overCap: false });
});

test('T1b liveStarts skips eval refs, old rows, other purposes, end rows and notStarted runs; 99 live starts refuse the first run (99 + 1 + 1 > 100)', async () => {
  // Breaks when: liveStarts counts a row that is not a live start, or the check uses ">= cap" on the count alone.
  const w = world({ pulls: [pullOf(1)] });
  seedLive(w, 99);
  assert.equal(liveStarts(jsonl(w.cursorLedger), NOW), 99);
  assert.equal(await sweep(w), SWEEP_EXIT.CAP);
  assert.equal(stubCalls().length, 0);
});

test('T1e a ledger line that cannot be read counts as a live start: 97 starts and 2 damaged lines refuse the run (99 + 1 + 1 > 100)', async () => {
  // Breaks when: the cap check reads only the lines that parse (a damaged line can be a start row, so the check must err toward refusing).
  const w = world({ pulls: [pullOf(1)] });
  seedLive(w, 97);
  appendFileSync(w.cursorLedger, '{"ts":"2026-11-1\n[1,2]\n');
  assert.equal(await sweep(w), SWEEP_EXIT.CAP, w.logs.join('\n'));
  assert.equal(stubCalls().length, 0);
  assert.deepEqual(reportOf(w).ledger, { liveStarts: 99, cap: WEEKLY_LIVE_CAP, retryMax: 1, overCap: false, damaged: 2 });
});

test('T1c local_review.weekly_live_cap in the root config replaces the constant; a count above the cap sets overCap', async () => {
  // Breaks when: the sweep ignores the config key a later lane adds, or does not report a count over the cap.
  const w = world({ pulls: [pullOf(1)] });
  put(w.root, 'review-router.config.json', JSON.stringify({ local_review: { weekly_live_cap: 3 } }));
  seedLedger(w, Array.from({ length: 4 }, (_, i) => liveRow(i)));
  assert.equal(await sweep(w), SWEEP_EXIT.CAP);
  assert.equal(stubCalls().length, 0);
  assert.deepEqual(reportOf(w).ledger, { liveStarts: 4, cap: 3, retryMax: 1, overCap: true });
});

// ---------- T2 CRITICAL ----------

test('T2 a CRITICAL PR is skipped and counted while laneState says the model check is open, and runs when it is done', async () => {
  // Breaks when: laneState is not read, or CRITICAL is skipped although the check is done.
  const open = world({ pulls: [pullOf(5, { band: 'CRITICAL' })] });
  assert.equal(await sweep(open, [], { laneState: () => ({ criticalModelCheckDone: false }) }), SWEEP_EXIT.OK);
  assert.equal(stubCalls().length, 0);
  assert.equal(reportOf(open).skipped.critical, 1);
  const done = world({ pulls: [pullOf(5, { band: 'CRITICAL' })] });
  assert.equal(await sweep(done, [], { laneState: () => ({ criticalModelCheckDone: true }) }), SWEEP_EXIT.OK);
  assert.equal(stubCalls().length, 1);
  assert.equal(reportOf(done).skipped.critical, 0);
});

test('T2b with no laneState (the command line) skipCritical is false: a CRITICAL PR runs', async () => {
  // Breaks when: the default holds CRITICAL back, so a command-line sweep can never run one.
  const w = world({ pulls: [pullOf(5, { band: 'CRITICAL' })] });
  assert.equal(await sweep(w, [], { laneState: undefined }), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.equal(stubCalls().length, 1);
});

// ---------- a temp repo whose engine file is the stub (path F) ----------

function realGit(dir) {
  return (args, { input, env } = {}) => {
    const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], {
      cwd: dir, input, encoding: 'utf8', windowsHide: true, env: env ? { ...process.env, ...env } : process.env,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}
const gitOk = (git, ...args) => { const r = git(args); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

/** A temp repo with the whole freeze set; each commit's engine file is the stub module with its own marker (so each commit has its own versions). */
function engineRepo({ localReview = {} } = {}) {
  const dir = tmp('repo');
  const git = realGit(dir);
  gitOk(git, 'init', '-q', '-b', 'main');
  const commit = (marker) => {
    for (const f of REVIEWER_SET_FILES) put(dir, f, f === 'scripts/github/local-review.mjs' ? STUB_SRC(marker) : `// ${f} ${marker}\n`);
    put(dir, 'scripts/github/local-review/prompt.mjs', 'export const PROMPT_VERSION = 1;\n');
    for (const f of BAND_SET_FILES) put(dir, f, f === 'scripts/github/review-router.mjs' ? '// band rules\n' : `// ${f}\n`);
    put(dir, 'review-router.config.json', `${JSON.stringify({ local_review: localReview, matrix: {} })}\n`);
    put(dir, 'docs/outside.md', 'not part of the copy\n');
    gitOk(git, 'add', '-A');
    gitOk(git, 'commit', '-q', '-m', marker);
    return gitOk(git, 'rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

/** A PR-head commit first, then the engine commit: the PR head differs from the engine SHA and from HEAD, and has other versions. */
function repoWithHeads(opts) {
  const repo = engineRepo(opts);
  const prHead = repo.commit('pr-head');
  const sha = repo.commit('engine');
  return { repo, prHead, sha };
}

function pinnedWorld(repo, pulls) {
  const w = world({ pulls });
  return { w, over: { git: repo.git, root: repo.dir, importEngine: (u) => import(u), computeVersions: undefined } };
}

// ---------- T3 one engineVersion ----------

test('T3 two runs on one engine SHA give two list lines with the engine SHA versions, not the PR head versions', async () => {
  // Breaks when: the version is computed from anything but the engine SHA that ran (for example the PR head).
  const { repo, prHead, sha } = repoWithHeads();
  const { w, over } = pinnedWorld(repo, [pullOf(1, { band: 'HIGH', head: prHead }), pullOf(2, { band: 'HIGH', head: prHead, ref: 'feat/other' })]);
  assert.equal(await sweep(w, ['--engine-sha', sha], over), SWEEP_EXIT.OK, w.logs.join('\n'));
  const rows = jsonl(listFile(w));
  assert.equal(rows.length, 2);
  const want = realComputeVersions({ sha, git: repo.git });
  const atHead = realComputeVersions({ sha: prHead, git: repo.git });
  assert.notEqual(want.engineVersion, atHead.engineVersion);
  for (const r of rows) {
    assert.equal(r.engineVersion, want.engineVersion);
    assert.equal(r.bandVersion, want.bandVersion);
  }
});

// ---------- T4 path F ----------

test('T4 --engine-sha extracts the engine into <records>/engine/<sha>/, imports it from there with LOCAL_REVIEW_PINNED, and the real checkPin accepts that path', async () => {
  // Breaks when: the sweep imports the checkout's engine, does not set LOCAL_REVIEW_PINNED, extracts elsewhere, or tags the line unpinned.
  const { repo, prHead, sha } = repoWithHeads();
  const { w, over } = pinnedWorld(repo, [pullOf(4, { band: 'HIGH', head: prHead })]);
  assert.equal(await sweep(w, ['--engine-sha', sha, '--frozen-sha', sha], over), SWEEP_EXIT.OK, w.logs.join('\n'));
  const copy = path.join(w.stateRoot, 'engine', sha);
  assert.ok(existsSync(path.join(copy, 'scripts', 'github', 'local-review.mjs')));
  assert.ok(existsSync(path.join(copy, 'review-router.config.json')));
  assert.equal(existsSync(path.join(copy, 'docs')), false);
  const [call] = stubCalls();
  assert.equal(call.marker, 'engine');
  assert.equal(path.resolve(fileURLToPath(call.url)), path.resolve(copy, 'scripts', 'github', 'local-review.mjs'));
  assert.equal(call.pinned, sha);
  assert.equal(call.opts.engineHere, undefined);
  const pin = checkPin({ env: { LOCAL_REVIEW_PINNED: sha }, selfPath: fileURLToPath(call.url), engineRoot: path.join(w.stateRoot, 'engine') });
  assert.deepEqual(pin, { ok: true, pinned: true, engineSha: sha });
  const [row] = jsonl(listFile(w));
  assert.equal(row.pinned, true);
  assert.equal(row.engineSha, sha);
  assert.equal(row.head, prHead);
  assert.equal(row.engineVersion, realComputeVersions({ sha, git: repo.git }).engineVersion);
  assert.equal(row.label, FROZEN_LABEL);
  assert.equal(row.counted, true);
  assert.equal(row.kind, 'open-head');
  assert.equal(reportOf(w).mode, 'pinned');
  // F2: the line keeps what the label was tested against, so a later gate can check it against decisions.md.
  assert.equal(row.frozenSha, sha);
  assert.equal(row.frozenEngineVersion, realComputeVersions({ sha, git: repo.git }).engineVersion);
});

test('T4b a --frozen-sha whose engineVersion differs gives the rehearsal label', async () => {
  // Breaks when: the label ignores --frozen-sha, or compares SHAs instead of engineVersions.
  const { repo, prHead, sha } = repoWithHeads();
  const { w, over } = pinnedWorld(repo, [pullOf(4, { band: 'HIGH', head: prHead })]);
  assert.equal(await sweep(w, ['--engine-sha', sha, '--frozen-sha', prHead], over), SWEEP_EXIT.OK, w.logs.join('\n'));
  const [row] = jsonl(listFile(w));
  assert.equal(row.label, REHEARSAL_LABEL);
  assert.equal(row.pinned, true);
  assert.equal(row.counted, false);
  assert.match(row.reason, /frozen/);
});

test('T4c a pinned run with no --frozen-sha is rehearsal and not counted (counted needs the frozen engineVersion)', async () => {
  // Breaks when: counted leaves out the frozen-version condition.
  const { repo, prHead, sha } = repoWithHeads();
  const { w, over } = pinnedWorld(repo, [pullOf(4, { band: 'HIGH', head: prHead })]);
  assert.equal(await sweep(w, ['--engine-sha', sha], over), SWEEP_EXIT.OK, w.logs.join('\n'));
  const [row] = jsonl(listFile(w));
  assert.equal(row.audit, 'pass');
  assert.equal(row.label, REHEARSAL_LABEL);
  assert.equal(row.counted, false);
  assert.match(row.reason, /frozen/);
  assert.equal(row.frozenSha, null, 'F2: no --frozen-sha, nothing to test against');
  assert.equal(row.frozenEngineVersion, null);
});

test('T1d retry_max comes from the config of the engine that runs: retry_max 0 leaves room for a run at 99 live starts', async () => {
  // Breaks when: the retry room is read from the root config or fixed at the default.
  const { repo, prHead, sha } = repoWithHeads({ localReview: { retry_max: 0 } });
  const { w, over } = pinnedWorld(repo, [pullOf(1, { band: 'HIGH', head: prHead })]);
  seedLive(w, 99);
  assert.equal(await sweep(w, ['--engine-sha', sha], over), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.equal(stubCalls().length, 1);
  assert.equal(reportOf(w).ledger.retryMax, 0);
});

// ---------- T5 copy intact ----------

test('T5 a copy that is gone before a run is extracted again; a failed extraction gives one error line and no list line', async () => {
  // Breaks when: the sweep trusts a copy it checked once, or writes a list line for a run that never had an engine.
  const { repo, prHead, sha } = repoWithHeads();
  // Each sweep gets its own open head: a head with an ok line for this engine does not run again (F7).
  const laterHead = repo.commit('later-head');
  const { w, over } = pinnedWorld(repo, [pullOf(1, { band: 'HIGH', head: prHead })]);
  const copy = path.join(w.stateRoot, 'engine', sha);
  assert.equal(await sweep(w, ['--engine-sha', sha], over), SWEEP_EXIT.OK, w.logs.join('\n'));
  rmSync(copy, { recursive: true, force: true });
  w.pulls = [pullOf(2, { band: 'HIGH', head: sha, ref: 'feat/two' })];
  assert.equal(await sweep(w, ['--engine-sha', sha], over), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.ok(existsSync(path.join(copy, 'scripts', 'github', 'local-review.mjs')), 'extracted again');
  assert.equal(jsonl(listFile(w)).length, 2);
  rmSync(copy, { recursive: true, force: true });
  w.pulls = [pullOf(3, { band: 'HIGH', head: laterHead, ref: 'feat/three' })];
  const failing = (args, o) => (args[0] === 'read-tree' ? { status: 128, stdout: '', stderr: 'fatal: planted' } : repo.git(args, o));
  w.logs.length = 0;
  assert.equal(await sweep(w, ['--engine-sha', sha], { ...over, git: failing }), SWEEP_EXIT.FAILED);
  assert.equal(jsonl(listFile(w)).length, 2, 'no list line for the run without an engine');
  assert.equal(w.logs.filter((l) => /engine copy/.test(l)).length, 1, w.logs.join('\n'));
});

test('T5b a copy that goes away during a run: one error line, the pinned line is not counted; the next run of the same sweep gets the copy back', async () => {
  // Breaks when: the sweep counts a run whose engine copy vanished, drops the pinned tag, or checks the copy once per sweep instead of per run.
  const { repo, prHead, sha } = repoWithHeads();
  const { w, over } = pinnedWorld(repo, [pullOf(1, { band: 'HIGH', head: prHead }), pullOf(2, { band: 'HIGH', head: prHead, ref: 'feat/two' })]);
  const copy = path.join(w.stateRoot, 'engine', sha);
  let first = true;
  const onRun = () => { if (first) rmSync(copy, { recursive: true, force: true }); first = false; };
  assert.equal(await sweep(w, ['--engine-sha', sha, '--frozen-sha', sha], { ...over, engineDeps: { onRun } }), SWEEP_EXIT.FAILED);
  const [one, two] = jsonl(listFile(w));
  assert.equal(one.pinned, true);
  assert.equal(one.counted, false);
  assert.match(one.reason, /engine copy/);
  assert.equal(one.copyGone, true, 'the line says the copy went away, so a later sweep gives this head one more try');
  assert.equal(two.copyGone, undefined);
  assert.equal(two.pinned, true);
  assert.equal(two.counted, true, 'the copy was extracted again before the second run');
  assert.ok(existsSync(path.join(copy, 'scripts', 'github', 'local-review.mjs')));
  assert.equal(w.logs.filter((l) => /engine copy/.test(l)).length, 1, w.logs.join('\n'));
});

// ---------- T6 earlier heads ----------

test('T6 a saved CLI output with a Major runs the engine on that earlier head: patched gh head, body withheld, no evalRun', async () => {
  // Breaks when: the run reviews the PR's last head, sets evalRun (its own cap ref), or keeps the PR body.
  const early = H('e');
  const w = world({ pulls: [pullOf(7, { band: 'HIGH' })], shas: { eeeeeee: early, '1234567': H('d') }, commitPulls: { [early]: [7], [H('d')]: [7] } });
  const majorText = cliStream(['major', 'minor']);
  assert.equal(parseAgentStream(majorText).bySeverity.major, 1, 'the real parser reads the synthetic stream as a Major');
  put(w.cliDir, '2026-11-10-pre-pr-cr-eeeeeee.txt', majorText);
  const minorText = cliStream(['minor', 'trivial']);
  assert.equal(parseAgentStream(minorText).bySeverity.major, undefined);
  put(w.cliDir, '2026-11-10-pre-pr-cr-1234567.txt', minorText);
  assert.equal(await sweep(w), SWEEP_EXIT.OK, w.logs.join('\n'));
  const calls = stubCalls();
  assert.equal(calls.length, 2, 'the open head and the one Major head');
  const earlier = calls.find((c) => c.pullHead === early);
  assert.ok(earlier, 'the engine saw the earlier head in the gh answer');
  assert.equal(earlier.opts.withholdBody, true);
  assert.equal(earlier.opts.evalRun, undefined);
  assert.equal(earlier.opts.pr, 7);
  assert.ok(!calls.some((c) => c.pullHead === H('d')), 'a minor-only head gives no run');
  const rows = jsonl(listFile(w));
  const row = rows.find((r) => r.head === early);
  assert.equal(row.kind, 'earlier-head');
  assert.equal(row.bodyMode, 'withheld');
  assert.equal(rows.find((r) => r.head === H(7)).kind, 'open-head');
  assert.equal(rows.find((r) => r.head === H(7)).bodyMode, 'full');
  const cli = reportOf(w).window.cli;
  assert.equal(cli.majorHeads, 1);
  assert.equal(cli.majorWithRecord, 1);
  assert.equal(cli.majorShare, 1);
  assert.deepEqual(cli.byBand, { HIGH: { cliHeads: 2, withRecord: 1, share: 0.5 } });
});

/** An unpinned world with one Major CLI head (H('e')) of PR 7, and list lines seeded for that head. */
function earlierWorld(seed) {
  const early = H('e');
  const w = world({ pulls: [pullOf(7, { band: 'HIGH' })], shas: { eeeeeee: early }, commitPulls: { [early]: [7] } });
  put(w.cliDir, '2026-11-10-pre-pr-cr-eeeeeee.txt', cliStream(['critical']));
  const ts = new Date(NOW - DAY).toISOString();
  seedList(w, seed.map((r, i) => ({ v: 1, ts, runId: `seed-${i}-${r.status}-${r.audit}`, pr: 7, head: early, engineSha: null, kind: 'earlier-head', ...r })));
  return { w, early, earlyRuns: () => stubCalls().filter((c) => c.pullHead === early).length };
}

test('T6b "already run" is keyed on head + engineSha: an ok line or a void line blocks; one failed line allows one more try, two block', async () => {
  // Breaks when: a void head runs again, a failed head never gets its second try, or a twice-failed head keeps running.
  const cases = [
    [[{ status: 'ok', audit: 'pass' }], 0],
    [[{ status: 'ok', audit: 'void' }], 0],
    [[{ status: 'failed', audit: 'void' }], 0],
    [[{ status: 'failed', audit: 'not-run' }], 1],
    [[{ status: 'failed', audit: 'not-run' }, { status: 'failed', audit: 'pass' }], 0],
    // A run whose engine copy went away is a failed run of the sweep, though its record says ok: one more try, then it blocks.
    [[{ status: 'ok', audit: 'pass', copyGone: true }], 1],
    // A run whose copy changed during the run (F4) is a failed run too: one more try.
    [[{ status: 'ok', audit: 'pass', copyChanged: true }], 1],
    [[{ status: 'ok', audit: 'pass', copyGone: true }, { status: 'ok', audit: 'pass', copyGone: true }], 0],
    [[{ status: 'ok', audit: 'void', copyGone: true }], 0],
  ];
  for (const [seed, runs] of cases) {
    const { w, earlyRuns } = earlierWorld(seed);
    assert.equal(await sweep(w), SWEEP_EXIT.OK, w.logs.join('\n'));
    assert.equal(earlyRuns(), runs, JSON.stringify(seed));
    assert.equal(reportOf(w).skipped.alreadyRun, 1 - runs, JSON.stringify(seed));
  }
});

test('T6d an unpinned (rehearsal) line does not block a pinned run on the same head', async () => {
  // Breaks when: the "already run" key leaves out the engine SHA.
  const { repo, prHead, sha } = repoWithHeads();
  const { w, over } = pinnedWorld(repo, [pullOf(7, { band: 'HIGH', head: sha })]);
  w.commitPulls = { [prHead]: [7] };
  put(w.cliDir, `2026-11-10-pre-pr-cr-${prHead.slice(0, 7)}.txt`, cliStream(['major']));
  seedList(w, [{ v: 1, ts: new Date(NOW - DAY).toISOString(), runId: 'old', pr: 7, head: prHead, engineSha: null, status: 'ok', audit: 'pass', kind: 'earlier-head' }]);
  assert.equal(await sweep(w, ['--engine-sha', sha], over), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.equal(stubCalls().filter((c) => c.pullHead === prHead).length, 1);
  assert.equal(reportOf(w).skipped.alreadyRun, 0);
});

test('T6c the PR of a CLI head: by commit first, and with a known worktree branch only the one candidate on that branch', async () => {
  // Breaks when: the branch filter is skipped (PR 8 shares the commit), or the branch lookup runs although the commit found the PR.
  const early = H('e');
  const wt = tmp('wt-cli');
  const cliDir = path.join(wt, '.claude', 'cache', 'e2e');
  put(cliDir, '2026-11-10-pre-pr-cr-eeeeeee.txt', cliStream(['major']));
  const worktrees = [`worktree ${wt.replaceAll('\\', '/')}`, `HEAD ${H(7)}`, 'branch refs/heads/feat/pr-7', ''].join('\n');
  const pulls = [pullOf(8, { band: 'HIGH' }), pullOf(7, { band: 'HIGH' })];
  const w = world({ pulls, shas: { eeeeeee: early }, commitPulls: { [early]: [8, 7] }, worktrees });
  assert.equal(await main(['--cli-dir', cliDir, '--json'], deps(w)), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.deepEqual(stubCalls().filter((c) => c.pullHead === early).map((c) => c.opts.pr), [7]);
  assert.ok(w.ghCalls.some((a) => String(a[1]).includes(`/commits/${early}/pulls`)));
  assert.ok(!w.ghCalls.some((a) => String(a[1]).includes('state=all&head=')), 'no branch lookup when the commit found the PR');
});

test('T6e a head that no PR holds by commit (a force push replaced it) is found by its worktree branch', async () => {
  // Breaks when: the branch fallback is dropped.
  const early = H('e');
  const wt = tmp('wt-cli');
  const cliDir = path.join(wt, '.claude', 'cache', 'e2e');
  put(cliDir, '2026-11-10-pre-pr-cr-eeeeeee.txt', cliStream(['major']));
  const worktrees = [`worktree ${wt.replaceAll('\\', '/')}`, `HEAD ${H(7)}`, 'branch refs/heads/feat/pr-7', ''].join('\n');
  const w = world({ pulls: [pullOf(7, { band: 'HIGH' })], shas: { eeeeeee: early }, worktrees });
  assert.equal(await main(['--cli-dir', cliDir, '--json'], deps(w)), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.ok(stubCalls().some((c) => c.pullHead === early && c.opts.pr === 7));
  assert.ok(w.ghCalls.some((a) => String(a[1]).includes(`head=${encodeURIComponent('Rev4nchist:feat/pr-7')}`)), JSON.stringify(w.ghCalls));
});

test('T6f two candidate PRs and no branch to choose by: no run, counted as ambiguousPr, never "open first"', async () => {
  // Breaks when: the lookup picks the open PR (or the first) among several candidates.
  const early = H('e');
  const w = world({ pulls: [pullOf(7, { band: 'HIGH', state: 'closed' }), pullOf(8, { band: 'HIGH' })], shas: { eeeeeee: early }, commitPulls: { [early]: [7, 8] } });
  w.pulls[0].draft = true; // keeps PR 7 out of the open-head targets
  put(w.cliDir, '2026-11-10-pre-pr-cr-eeeeeee.txt', cliStream(['major']));
  assert.equal(await sweep(w), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.equal(stubCalls().filter((c) => c.pullHead === early).length, 0);
  assert.equal(reportOf(w).skipped.ambiguousPr, 1);
  assert.equal(existsSync(path.join(w.stateRoot, 'cli-pairs', '8')), false, 'no pair for an ambiguous head');
});

test('T6g a gh failure in the PR lookup is not read as "no PR": the head is counted under ghError, logged, and the sweep exits 1', async () => {
  // Breaks when: ghList swallows a gh error (a rate limit then reads as "no PR" and the head is silently dropped).
  const early = H('e');
  const w = world({ pulls: [pullOf(7, { band: 'HIGH' })], shas: { eeeeeee: early } });
  put(w.cliDir, '2026-11-10-pre-pr-cr-eeeeeee.txt', cliStream(['major']));
  const over = {
    gh: async (args) => { if (/\/commits\/[0-9a-f]{40}\/pulls/.test(String(args[1]))) throw new Error('HTTP 403: API rate limit exceeded'); return fakeGh(w)(args); },
  };
  assert.equal(await sweep(w, [], over), SWEEP_EXIT.FAILED, w.logs.join('\n'));
  assert.equal(reportOf(w).skipped.ghError, 1);
  assert.equal(reportOf(w).skipped.noPr, 0);
  assert.ok(w.logs.some((l) => /rate limit/.test(l)), w.logs.join('\n'));
});

test('T6h a commit that GitHub does not know (HTTP 404 or 422) is "no PR", not an error', async () => {
  // Breaks when: every gh failure is an error (an unpushed commit would then fail each daily sweep).
  const early = H('e');
  const w = world({ pulls: [pullOf(7, { band: 'HIGH' })], shas: { eeeeeee: early } });
  put(w.cliDir, '2026-11-10-pre-pr-cr-eeeeeee.txt', cliStream(['major']));
  const over = {
    gh: async (args) => { if (/\/commits\/[0-9a-f]{40}\/pulls/.test(String(args[1]))) throw new Error('gh: No commit found for SHA (HTTP 422)'); return fakeGh(w)(args); },
  };
  assert.equal(await sweep(w, [], over), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.equal(reportOf(w).skipped.noPr, 1);
  assert.equal(reportOf(w).skipped.ghError, 0);
});

test('T6i the PR lookup pages: a head whose PR is on page 2 of commits/<sha>/pulls is found', async () => {
  // Breaks when: ghList reads one page only (GitHub gives 30 by default).
  const early = H('e');
  const w = world({ pulls: [pullOf(7, { band: 'HIGH' })], shas: { eeeeeee: early } });
  put(w.cliDir, '2026-11-10-pre-pr-cr-eeeeeee.txt', cliStream(['major']));
  const filler = Array.from({ length: 100 }, () => ({ number: null })); // 100 rows with no PR number: a full first page
  const seen = [];
  const over = { gh: async (args) => {
    const m = /\/commits\/[0-9a-f]{40}\/pulls\?per_page=100&page=(\d+)$/.exec(String(args[1]));
    if (!m) return fakeGh(w)(args);
    seen.push(Number(m[1]));
    return Number(m[1]) === 1 ? filler : [structuredClone(w.pulls[0])];
  } };
  assert.equal(await sweep(w, [], over), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.deepEqual(seen, [1, 2]);
  assert.ok(stubCalls().some((c) => c.pullHead === early && c.opts.pr === 7));
});

// ---------- T7 pairs ----------

test('T7 pairs: a passed CLI file is copied once to cli-pairs/<pr>/<sha40>.txt; .failed.txt, no-PR and unknown-sha files are skipped and counted', async () => {
  // Breaks when: an existing pair is rewritten, a failed file is copied, or a head with no PR or an unknown sha is kept.
  const head = H('a');
  const w = world({ pulls: [pullOf(9, { head })], shas: { aaaaaaa: head, '3333333': H(3) }, commitPulls: { [head]: [9] } });
  const text = cliStream(['minor']);
  put(w.cliDir, '2026-11-10-pre-pr-cr-aaaaaaa.txt', text);
  put(w.cliDir, '2026-11-10-pre-pr-cr-bbbbbbb.failed.txt', cliStream(['major']));
  put(w.cliDir, '2026-11-10-pre-pr-cr-3333333.txt', text);
  put(w.cliDir, '2026-11-10-pre-pr-cr-4444444.txt', text);
  assert.equal(await sweep(w, ['--pairs-only']), SWEEP_EXIT.OK, w.logs.join('\n'));
  const pair = path.join(w.stateRoot, 'cli-pairs', '9', `${head}.txt`);
  assert.equal(readFileSync(pair, 'utf8'), text);
  const r = reportOf(w);
  assert.equal(r.pairs.saved, 1);
  assert.equal(r.skipped.failedCli, 1);
  assert.equal(r.skipped.noPr, 1);
  assert.equal(r.skipped.ambiguousSha, 1);
  assert.equal(stubCalls().length, 0, '--pairs-only runs no engine');
  assert.deepEqual(readdirSync(path.join(w.stateRoot, 'cli-pairs')).sort(), ['9']);
  writeFileSync(pair, 'SENTINEL');
  assert.equal(await sweep(w, ['--pairs-only']), SWEEP_EXIT.OK);
  assert.equal(readFileSync(pair, 'utf8'), 'SENTINEL', 'same name = same head: never rewritten');
  assert.equal(reportOf(w).pairs.saved, 0);
  assert.equal(reportOf(w).pairs.existing, 1);
});

// ---------- T8 read audit ----------

test('T8 a clean stream gives a pass line and a counted row; a planted void stream gives a void line, no counted row, a stop, and the report names it', async () => {
  // Breaks when: the audit is not called, a void run is counted, or the sweep keeps going after a void.
  const { repo, prHead, sha } = repoWithHeads();
  const pulls = [
    pullOf(1, { band: 'HIGH', head: prHead }),
    pullOf(2, { band: 'MID', head: prHead, ref: 'feat/void', result: 'void' }),
    pullOf(3, { band: 'MID', head: prHead, ref: 'feat/three' }),
  ];
  const { w, over } = pinnedWorld(repo, pulls);
  assert.equal(await sweep(w, ['--engine-sha', sha, '--frozen-sha', sha], over), SWEEP_EXIT.VOID, w.logs.join('\n'));
  const lines = readLines(w.auditState);
  assert.equal(lines.length, 2);
  const rows = jsonl(listFile(w));
  const clean = rows.find((r) => r.pr === 1);
  const bad = rows.find((r) => r.pr === 2);
  assert.equal(clean.audit, 'pass');
  assert.equal(clean.counted, true);
  assert.equal(lines.find((l) => l.runId === clean.runId).verdict, 'pass');
  assert.equal(bad.audit, 'void');
  assert.equal(bad.counted, false);
  assert.equal(lines.find((l) => l.runId === bad.runId).verdict, 'void');
  assert.equal(stubCalls().length, 2, 'the batch stops at the void');
  const r = reportOf(w);
  assert.equal(r.stopped, 'void');
  assert.deepEqual(r.window.readAudit.voids.map((v) => [v.pr, v.head]), [[2, prHead]]);
});

test('T8b the plain-text report names the void run head and prints the CLI-Major and ledger lines', async () => {
  // Breaks when: textReport drops the read-audit summary, the CLI-Major line or the ledger load.
  const w = world({ pulls: [pullOf(2, { band: 'MID', result: 'void' })] });
  assert.equal(await main(['--cli-dir', w.cliDir], deps(w)), SWEEP_EXIT.VOID);
  const text = w.out.at(-1);
  assert.match(text, new RegExp(`read audit: 1 void run\\(s\\) \\[stub-1-2 PR 2 head ${H(2)} rules outside-path(,answer-key)?\\]`));
  assert.match(text, /CLI-Major heads: 0/);
  assert.match(text, /ledger load: 1 live starts in 7 days of a cap of 100/);
  assert.match(text, /STOPPED: void/);
});

test('T8c a void run names its audit rules (rule, tool, answerKey) in the list line, the VOID log line and the report; no path, no field, no call id', async () => {
  // Breaks when: auditRun drops the rule names, listLine does not write auditRules, the VOID log line or the report omits the rule,
  // or a path, a field name or a call id leaks into the list line.
  const w = world({ pulls: [pullOf(1, { band: 'HIGH' }), pullOf(2, { band: 'MID', result: 'void' })] });
  assert.equal(await main(['--cli-dir', w.cliDir], deps(w)), SWEEP_EXIT.VOID);
  const rows = jsonl(listFile(w));
  const clean = rows.find((r) => r.pr === 1);
  const bad = rows.find((r) => r.pr === 2);
  assert.deepEqual(clean.auditRules, [], 'a pass run has no audit rules');
  assert.ok(bad.auditRules.some((x) => x.rule === 'outside-path'), JSON.stringify(bad.auditRules));
  for (const x of bad.auditRules) assert.deepEqual(Object.keys(x).sort(), ['answerKey', 'rule', 'tool']);
  assert.doesNotMatch(JSON.stringify(bad), /linktype-labels|C:\\\\work\\\\primary/, 'no read path in the list line');
  assert.match(w.logs.join('\n'), /read audit VOID for run stub-2-2 \(PR 2, head [0-9a-f]+, rules outside-path/);
  assert.match(w.out.at(-1), /\[stub-2-2 PR 2 head [0-9a-f]+ rules outside-path/);
});

test('T8d a pass run that a newer audit line voids: the report names the rules of that newer line, without its path fields', async () => {
  // Breaks when: the report takes the rules from the old list line (rules none) once a re-audit voids the run, or copies field/callId.
  const w = world({ pulls: [pullOf(1, { band: 'HIGH' })] });
  assert.equal(await main(['--cli-dir', w.cliDir], deps(w)), SWEEP_EXIT.OK);
  const row = jsonl(listFile(w)).find((r) => r.pr === 1);
  assert.equal(row.audit, 'pass');
  // The audit line carries the real clock (auditReplay), not the sweep's test clock: go one minute past it.
  const first = readLines(w.auditState).find((l) => l.runId === row.runId);
  const later = new Date(Date.parse(first.ts) + 60_000).toISOString();
  appendFileSync(w.auditState, `${JSON.stringify({ schema: 1, ts: later, runId: row.runId, verdict: 'void',
    rules: [{ rule: 'outside-path', tool: 'glob', field: 'files[0]', callId: 'c9', answerKey: false }] })}\n`);
  assert.equal(await main(['--cli-dir', w.cliDir, '--dry-run'], deps(w)), SWEEP_EXIT.OK);
  const text = w.out.at(-1);
  assert.match(text, new RegExp(`\\[${row.runId} PR 1 head [0-9a-f]+ rules outside-path\\]`));
  assert.equal(await main(['--cli-dir', w.cliDir, '--dry-run', '--json'], deps(w)), SWEEP_EXIT.OK);
  assert.deepEqual(reportOf(w).window.readAudit.voids[0].rules, [{ rule: 'outside-path', tool: 'glob', answerKey: false }]);
});

// ---------- T9 order and share ----------

test('T9 HIGH first, then MID and ELEVATED by the --band-counts share; LOW never runs; --max-runs stops the sweep', async () => {
  // Breaks when: the order is by PR number, the share ignores the counts file, LOW runs, or --max-runs is not honoured.
  const pulls = [pullOf(1, { band: 'LOW' }), pullOf(2), pullOf(3), pullOf(4, { band: 'ELEVATED' }), pullOf(5, { band: 'HIGH' }), pullOf(6), pullOf(8, { band: 'ELEVATED' })];
  const w = world({ pulls });
  const counts = put(w.T, 'band-counts.json', JSON.stringify({ HIGH: 10, ELEVATED: 1, MID: 3, LOW: 50 }));
  assert.equal(await sweep(w, ['--band-counts', counts]), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.deepEqual(stubCalls().map((c) => c.opts.pr), [5, 2, 4, 3, 6, 8]);
  assert.equal(reportOf(w).skipped.low, 1);
  const w2 = world({ pulls });
  assert.equal(await sweep(w2, ['--band-counts', counts, '--max-runs', '3']), SWEEP_EXIT.OK);
  assert.deepEqual(stubCalls().map((c) => c.opts.pr), [5, 2, 4]);
});

test('T9b planOrder: the default share is the documented constant; a zero-weight risk band comes last', () => {
  // Breaks when: DEFAULT_BAND_COUNTS is not used without a file, or a zero count still interleaves.
  const t = (pr, band) => ({ pr, band, kind: 'open-head' });
  const base = [t(1, 'MID'), t(2, 'MID'), t(3, 'ELEVATED'), t(4, 'ELEVATED'), t(5, 'HIGH')];
  assert.deepEqual(DEFAULT_BAND_COUNTS, { ELEVATED: 1, MID: 1 });
  assert.deepEqual(planOrder(base, { bandCounts: DEFAULT_BAND_COUNTS }).order.map((x) => x.pr), [5, 1, 3, 2, 4]);
  assert.deepEqual(planOrder(base, { bandCounts: { MID: 0, ELEVATED: 1 } }).order.map((x) => x.pr), [5, 3, 4, 1, 2]);
});

// ---------- T10 facts ----------

test('T10 a PR whose branch has a worktree at the same head with catchers.json gets factsText; others get none; the report gives the share', async () => {
  // Breaks when: facts go to a PR with no worktree, facts of another head are passed, or the share is miscounted.
  const wt1 = tmp('wt1');
  const wt3 = tmp('wt3');
  put(wt1, '.claude/cache/pre-pr/catchers.json', '{"made":"up facts"}\n');
  put(wt3, '.claude/cache/pre-pr/catchers.json', '{"other":"head"}\n');
  const worktrees = [
    `worktree ${wt1.replaceAll('\\', '/')}`, `HEAD ${H(1)}`, 'branch refs/heads/feat/pr-1', '',
    `worktree ${wt3.replaceAll('\\', '/')}`, `HEAD ${H('9')}`, 'branch refs/heads/feat/pr-3', '',
  ].join('\n');
  const w = world({ pulls: [pullOf(1, { band: 'HIGH' }), pullOf(2, { band: 'HIGH' }), pullOf(3, { band: 'HIGH' })], worktrees });
  assert.equal(await sweep(w), SWEEP_EXIT.OK, w.logs.join('\n'));
  const byPr = Object.fromEntries(stubCalls().map((c) => [c.opts.pr, c.opts.factsText]));
  assert.equal(byPr[1], '{"made":"up facts"}\n');
  assert.equal(byPr[2], undefined);
  assert.equal(byPr[3], undefined, 'the worktree is at another head: its facts describe another tree');
  const r = reportOf(w);
  assert.deepEqual(r.window.facts, { with: 1, without: 2, share: 1 / 3 });
  assert.deepEqual(jsonl(listFile(w)).map((x) => x.facts), [true, false, false]);
  assert.equal(parseWorktrees(worktrees)[0].branch, 'feat/pr-1');
});

// ---------- T11 per-branch cap, T15 refusals, T16 engine cap ----------

test('T11 a per-branch cap refusal from the engine is skipped and counted, and the sweep goes on', async () => {
  // Breaks when: the engine's ref-cap answer stops the sweep or is counted as a run.
  const w = world({ pulls: [pullOf(1, { band: 'HIGH', result: 'ref-cap' }), pullOf(2, { band: 'HIGH' })] });
  assert.equal(await sweep(w), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.deepEqual(stubCalls().map((c) => c.opts.pr), [1, 2]);
  assert.equal(reportOf(w).skipped.perBranchCap, 1);
  assert.deepEqual(jsonl(listFile(w)).map((x) => x.pr), [2]);
});

test('T15 an engine refusal marks the sweep failed and the sweep goes on; a pin refusal stops it with one error line', async () => {
  // Breaks when: a refusal leaves exit 0, or a pin refusal (every later run would be refused too) does not stop the sweep.
  const w = world({ pulls: [pullOf(1, { band: 'HIGH', result: 'refused' }), pullOf(2, { band: 'HIGH' })] });
  assert.equal(await sweep(w), SWEEP_EXIT.FAILED, w.logs.join('\n'));
  assert.deepEqual(stubCalls().map((c) => c.opts.pr), [1, 2]);
  assert.equal(reportOf(w).skipped.refused, 1);
  assert.deepEqual(jsonl(listFile(w)).map((x) => x.pr), [2], 'a refusal comes before any ledger start: no list line');
  const p = world({ pulls: [pullOf(1, { band: 'HIGH', result: 'refused-pin' }), pullOf(2, { band: 'HIGH' })] });
  assert.equal(await sweep(p), SWEEP_EXIT.FAILED, p.logs.join('\n'));
  assert.deepEqual(stubCalls().map((c) => c.opts.pr), [1]);
  assert.equal(reportOf(p).stopped, 'error');
  assert.equal(p.logs.filter((l) => /pin/.test(l) && /stops/.test(l)).length, 1, p.logs.join('\n'));
});

test('T16 the engine\'s own cap (exit 3, "cap reached") stops the sweep with exit 3', async () => {
  // Breaks when: the engine cap is treated like a per-branch skip or a busy slot.
  const w = world({ pulls: [pullOf(1, { band: 'HIGH', result: 'cap' }), pullOf(2, { band: 'HIGH' })] });
  assert.equal(await sweep(w), SWEEP_EXIT.CAP, w.logs.join('\n'));
  assert.deepEqual(stubCalls().map((c) => c.opts.pr), [1]);
  assert.equal(reportOf(w).stopped, 'engine-cap');
});

// ---------- T12 CLI ----------

test('T12 --dry-run lists the planned runs and makes no engine call and no write', async () => {
  // Breaks when: --dry-run calls reviewHead, copies a pair, extracts a copy or writes the list file.
  const head = H('a');
  const w = world({ pulls: [pullOf(1, { band: 'HIGH' }), pullOf(2, { draft: true })], shas: { aaaaaaa: head }, commitPulls: { [head]: [1] } });
  put(w.cliDir, '2026-11-10-pre-pr-cr-aaaaaaa.txt', cliStream(['major']));
  assert.equal(await sweep(w, ['--dry-run']), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.equal(stubCalls().length, 0);
  assert.equal(existsSync(w.stateRoot), false, 'nothing written under the records root');
  assert.equal(existsSync(w.auditState), false);
  const r = reportOf(w);
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.planned.map((p) => [p.pr, p.kind, p.band]), [[1, 'open-head', 'HIGH'], [1, 'earlier-head', 'HIGH']]);
  assert.equal(r.skipped.draft, 1);
});

test('T12c --dry-run with the target commits not here: no resolveTarget, no fetch, no engine call, no write; the plan says the risk band is unknown', async () => {
  // Breaks when: the dry run resolves (and so may fetch) a target whose commits are missing.
  const head = H('a');
  const w = world({ pulls: [pullOf(1, { band: 'HIGH' })], shas: { aaaaaaa: head }, commitPulls: { [head]: [1] }, missing: new Set([H(1), head]) });
  put(w.cliDir, '2026-11-10-pre-pr-cr-aaaaaaa.txt', cliStream(['major']));
  assert.equal(await sweep(w, ['--dry-run']), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.deepEqual(resolveCalls(), []);
  assert.equal(w.repoGitCalls.filter((a) => a.includes('fetch')).length, 0);
  assert.equal(stubCalls().length, 0);
  assert.equal(existsSync(w.stateRoot), false);
  assert.equal(existsSync(path.dirname(w.stateRoot)), false, 'not even the state folder');
  const r = reportOf(w);
  assert.deepEqual(r.planned.map((p) => [p.pr, p.kind, p.band, p.note]), [
    [1, 'open-head', null, 'risk band unknown (commits not here)'], [1, 'earlier-head', null, 'risk band unknown (commits not here)'],
  ]);
  w.out.length = 0;
  assert.equal(await main(['--cli-dir', w.cliDir, '--dry-run'], deps(w)), SWEEP_EXIT.OK);
  assert.match(w.out.at(-1), /risk band unknown \(commits not here\)/);
});

test('T12d a dry run with --engine-sha and no copy reports mode unpinned (planned with the checkout engine)', async () => {
  // Breaks when: the report mode comes from the flag, not from the engine that was loaded.
  const w = world({ pulls: [pullOf(1, { band: 'HIGH' })] });
  assert.equal(await sweep(w, ['--dry-run', '--engine-sha', H('a')]), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.equal(reportOf(w).mode, 'unpinned');
  assert.equal(existsSync(path.join(w.stateRoot, 'engine')), false);
});

// ---------- F8 the pick options (a proof run on one named head) ----------

/** Two HIGH pull requests, and one earlier head of PR 2 with a CLI Major. Unfiltered plan: #1 open, #2 open, #2 earlier. */
function pickWorld() {
  const early = H('e');
  const w = world({ pulls: [pullOf(1, { band: 'HIGH' }), pullOf(2, { band: 'HIGH' })], shas: { eeeeeee: early }, commitPulls: { [early]: [2] } });
  put(w.cliDir, '2026-11-10-pre-pr-cr-eeeeeee.txt', cliStream(['major']));
  return { w, early };
}

test('F8 --only-pr with --only-kind earlier-head runs exactly that head; the other planned targets are counted as filtered', async () => {
  // Breaks when: the filter is not applied before the runs (a proof run with --max-runs 1 then starts on the first open head).
  const { w, early } = pickWorld();
  assert.equal(await sweep(w, ['--only-pr', '2', '--only-kind', 'earlier-head', '--max-runs', '1']), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.deepEqual(stubCalls().map((c) => [c.opts.pr, c.pullHead]), [[2, early]]);
  assert.equal(reportOf(w).skipped.filtered, 2);
});

test('F8b --only-pr alone keeps both kinds of that pull request; --only-kind open-head alone keeps the open heads of every pull request', async () => {
  // Breaks when: one option silently implies the other, or the kind filter also drops by pull request.
  const a = pickWorld();
  assert.equal(await sweep(a.w, ['--only-pr', '2']), SWEEP_EXIT.OK, a.w.logs.join('\n'));
  assert.deepEqual(stubCalls().map((c) => c.opts.pr), [2, 2]);
  const b = pickWorld();
  const before = stubCalls().length;
  assert.equal(await sweep(b.w, ['--only-kind', 'open-head']), SWEEP_EXIT.OK, b.w.logs.join('\n'));
  assert.deepEqual(stubCalls().slice(before).map((c) => [c.opts.pr, c.pullHead === b.early]), [[1, false], [2, false]]);
});

test('F8c a dry run shows the filtered plan; a filter that matches nothing plans nothing and exits 0', async () => {
  // Breaks when: the dry run prints the unfiltered plan (the operator then cannot check the target before a paid run).
  const { w } = pickWorld();
  assert.equal(await sweep(w, ['--dry-run', '--only-pr', '2', '--only-kind', 'earlier-head']), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.deepEqual(reportOf(w).planned.map((p) => [p.pr, p.kind]), [[2, 'earlier-head']]);
  assert.equal(stubCalls().length, 0);
  const none = pickWorld();
  assert.equal(await sweep(none.w, ['--dry-run', '--only-pr', '99']), SWEEP_EXIT.OK);
  assert.deepEqual(reportOf(none.w).planned, []);
  assert.equal(reportOf(none.w).skipped.filtered, 3);
});

test('F8d a bad --only-pr or --only-kind value is a usage error (exit 2) before any gh or git call', async () => {
  // Breaks when: a bad value is ignored (the sweep would then run unfiltered).
  const { w } = pickWorld();
  for (const argv of [['--only-pr', '0'], ['--only-pr', 'x'], ['--only-pr', '2.5'], ['--only-pr'], ['--only-kind', 'head'], ['--only-kind', 'Open-Head'], ['--only-kind']]) {
    assert.equal(await main([...argv], deps(w)), SWEEP_EXIT.USAGE, argv.join(' '));
    assert.ok(parseArgs(argv).error, argv.join(' '));
  }
  assert.equal(w.ghCalls.length + w.repoGitCalls.length, 0);
  assert.deepEqual(parseArgs(['--only-pr', '523', '--only-kind', 'earlier-head']), { onlyPr: 523, onlyKind: 'earlier-head' });
});

test('T12b an unknown flag exits 2 before any gh or git call; only the fork repo is allowed (any case); any other repo is refused', async () => {
  // Breaks when: an unknown flag is ignored, the default repo changes, or a repo other than the fork is accepted.
  const w = world({ pulls: [pullOf(1, { band: 'HIGH' })] });
  assert.equal(await main(['--bogus'], deps(w)), SWEEP_EXIT.USAGE);
  assert.equal(w.ghCalls.length + w.repoGitCalls.length, 0);
  assert.ok(parseArgs(['--bogus']).error);
  for (const repo of ['parcadei/Continuous-Claude-v3', 'someone/else', 'Rev4nchist/other']) {
    assert.equal(await main(['--repo', repo, '--cli-dir', w.cliDir], deps(w)), SWEEP_EXIT.USAGE, repo);
  }
  assert.equal(w.ghCalls.length, 0);
  assert.equal(parseArgs(['--repo', 'rev4nchist/continuous-claude-v3']).error, undefined);
  assert.equal(await sweep(w), SWEEP_EXIT.OK);
  assert.ok(w.ghCalls.every((a) => String(a[1]).startsWith('repos/Rev4nchist/Continuous-Claude-v3/')), JSON.stringify(w.ghCalls));
  assert.ok(parseArgs(['--engine-sha', 'abc']).error);
  assert.ok(parseArgs(['--max-runs', '0']).error);
});

// ---------- T13 the real engine ----------

const PR_DIFF = ['diff --git a/src/app.mjs b/src/app.mjs', '--- a/src/app.mjs', '+++ b/src/app.mjs', '@@ -2,3 +2,4 @@', ' l2', ' l3', '+l3b', ' l4', ''].join('\n');

/** The engine's own git, scripted as in local-review.test.mjs: one changed file, a fixed merge base, no fork/main (trusted stays false). */
function engineGit() {
  return (args) => {
    const [a, b] = args;
    if (a === 'cat-file') return ok();
    if (a === 'merge-base' && b === '--is-ancestor') return { status: 1, stdout: '', stderr: '' };
    if (a === 'merge-base') return ok(`${MB}\n`);
    if (a === 'diff' && b === '--name-status') return ok('M\0src/app.mjs\0');
    return { status: 1, stdout: '', stderr: `unscripted git ${args.join(' ')}` };
  };
}

/** prepareReview that builds the tree at <tmpRoot>/cursor-review-<n>/tree, the form the read audit requires. */
function treePrepare(tmpRoot) {
  let n = 0;
  return async () => {
    n += 1;
    const dir = path.join(tmpRoot, `cursor-review-e2e${n}`, 'tree');
    put(dir, 'src/app.mjs', Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n'));
    writeFileSync(path.join(dir, 'PR.diff'), PR_DIFF);
    return { ref: 'x..y', base: MB, dir, files: ['src/app.mjs'], agentFiles: [], cleanup: () => rmSync(path.dirname(dir), { recursive: true, force: true }) };
  };
}

/** A cursor-agent stream-json run: init in the tree, one read inside it, then the result with the engine's json block. */
function agentRunIn(cwd) {
  const p = path.join(cwd, 'src', 'app.mjs');
  const res = { result: { success: { content: 'l1', path: p, relatedCursorRulePaths: [], relatedCursorRules: [] } } };
  const body = (done) => ({ readToolCall: { args: { path: p }, ...(done ? res : {}) }, hookAdditionalContexts: [], toolCallId: 'r1' });
  const read = (sub, done) => ({ type: 'tool_call', subtype: sub, call_id: 'r1', tool_call: body(done) });
  const answer = `Reviewed.\n${FENCE}json\n${JSON.stringify({ findings: [], reviewed: ['src/app.mjs'], prior: {} })}\n${FENCE}`;
  const events = [
    { type: 'system', subtype: 'init', cwd, model: 'Grok 4.7 256K High', session_id: 's' }, read('started', false), read('completed', true),
    { type: 'result', subtype: 'success', is_error: false, result: answer, usage: { inputTokens: 1 }, duration_ms: 5, session_id: 's' },
  ];
  return { status: 0, stdout: `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, stderr: '', timedOut: false, durationMs: 5 };
}

function realEngineDeps(w) {
  return {
    git: engineGit(), prepareReview: treePrepare(w.tmpRoot), readAtSha: (r, s, rel) => (rel === 'review-router.config.json' ? readFileSync(REAL_CONFIG, 'utf8') : null),
    agentVersion: () => '2026.11.01-test', pidAlive: () => true, sleep: async () => {}, configPath: REAL_CONFIG,
  };
}

test('T13 end to end, unpinned: the real reviewHead (engineHere) writes a real record and a pass line; with --frozen-sha = HEAD it stays rehearsal and not counted', async () => {
  // Breaks when: the sweep's call does not fit reviewHead, the version is taken from the PR head, or an unpinned run gets the frozen label or counts.
  const { repo, prHead, sha } = repoWithHeads();
  const w = world({ pulls: [pullOf(11, { head: prHead, ref: 'feat/e2e' })] });
  const agentCalls = [];
  const runAgent = async (spec) => { agentCalls.push(spec); return agentRunIn(spec.cwd); };
  const over = {
    git: repo.git, root: repo.dir, importEngine: undefined, computeVersions: undefined, runAgent, agent: { cmd: 'fake-node', prefixArgs: [] }, engineDeps: realEngineDeps(w),
  };
  assert.equal(await sweep(w, ['--frozen-sha', sha], over), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.equal(agentCalls.length, 1);
  assert.ok(agentCalls[0].args.includes('grok-4.7-high'), 'the engine picks the model');
  const [row] = jsonl(listFile(w));
  const record = JSON.parse(readFileSync(row.recordPath, 'utf8'));
  assert.equal(record.pr, 11);
  assert.equal(record.head, prHead);
  assert.equal(record.status, 'ok');
  assert.equal(record.trusted, false);
  assert.ok(existsSync(row.recordPath.replace(/\.json$/, '.stream.jsonl.gz')));
  assert.equal(row.pinned, false);
  assert.equal(row.audit, 'pass');
  assert.equal(row.engineVersion, realComputeVersions({ sha, git: repo.git }).engineVersion, 'unpinned: the version at the checkout HEAD');
  assert.notEqual(row.engineVersion, realComputeVersions({ sha: prHead, git: repo.git }).engineVersion);
  assert.equal(row.label, REHEARSAL_LABEL, 'an unpinned run is always rehearsal, even when its version equals the frozen one');
  assert.equal(row.counted, false);
  assert.match(row.reason, /unpinned/);
  assert.equal(readLines(w.auditState).at(-1).symlinkCheck, 'pass');
  const ledger = jsonl(w.cursorLedger);
  assert.equal(ledger.filter((l) => l.phase === 'start' && l.ref === 'branch-feat-e2e' && l.purpose === 'review').length, 1, 'a live ref, inside the live cap');
});

test('T13b end to end, pinned: the real engine extracted from a commit runs from <records>/engine/<sha>/, its own checkPin accepts it, and the line counts', async () => {
  // Breaks when: the pinned call fails the real checkPin (selfPath, engineRoot or LOCAL_REVIEW_PINNED out of step) or the copy misses a module.
  const repo = engineRepo();
  const prHead = repo.commit('pr-head');
  // Only the engine's import closure (scripts/github and scripts/ratchets, no tests, no fixtures) and the config: no review-eval data goes to temp.
  const tracked = spawnSync('git', ['ls-files', '-z', '--', 'scripts/github', 'scripts/ratchets', 'review-router.config.json'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout
    .split('\0').filter((f) => f && !f.endsWith('.test.mjs') && !f.split('/').includes('fixtures'));
  for (const rel of tracked) { mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true }); copyFileSync(path.join(REPO_ROOT, rel), path.join(repo.dir, rel)); }
  gitOk(repo.git, 'add', '-A');
  gitOk(repo.git, 'commit', '-q', '-m', 'real engine');
  const sha = gitOk(repo.git, 'rev-parse', 'HEAD');
  const w = world({ pulls: [pullOf(12, { head: prHead, ref: 'feat/e2e-pinned' })] });
  const runAgent = async (spec) => agentRunIn(spec.cwd);
  const engineDeps = { ...realEngineDeps(w), configPath: undefined };
  const over = { git: repo.git, root: repo.dir, importEngine: undefined, computeVersions: undefined, runAgent, agent: { cmd: 'fake-node', prefixArgs: [] }, engineDeps };
  assert.equal(await sweep(w, ['--engine-sha', sha, '--frozen-sha', sha], over), SWEEP_EXIT.OK, w.logs.join('\n'));
  const [row] = jsonl(listFile(w));
  const record = JSON.parse(readFileSync(row.recordPath, 'utf8'));
  assert.equal(record.engineSha, sha, 'the record was written by the pinned copy');
  assert.equal(record.head, prHead);
  assert.equal(record.status, 'ok');
  assert.equal(row.pinned, true);
  assert.equal(row.audit, 'pass');
  assert.equal(row.counted, true);
  assert.equal(row.label, FROZEN_LABEL);
  assert.equal(row.engineVersion, realComputeVersions({ sha, git: repo.git }).engineVersion);
  assert.notEqual(row.engineVersion, realComputeVersions({ sha: prHead, git: repo.git }).engineVersion);
});

// ---------- T14 failed runs ----------

test('T14 a failed run: audited when its stream exists (runOk false), not-run when it has none; never counted; the sweep goes on and exits 1', async () => {
  // Breaks when: a failed run with a stream is not audited, a failed run without one is audited (a no-stream void stops the sweep), or one counts.
  const { repo, prHead, sha } = repoWithHeads();
  const pulls = [
    pullOf(1, { band: 'HIGH', head: prHead, result: 'failed' }), pullOf(2, { band: 'HIGH', head: prHead, ref: 'feat/two', result: 'failed-stream' }),
    pullOf(3, { band: 'HIGH', head: prHead, ref: 'feat/three' }),
  ];
  const { w, over } = pinnedWorld(repo, pulls);
  assert.equal(await sweep(w, ['--engine-sha', sha, '--frozen-sha', sha], over), SWEEP_EXIT.FAILED, w.logs.join('\n'));
  assert.deepEqual(stubCalls().map((c) => c.opts.pr), [1, 2, 3]);
  const [none, withStream, good] = jsonl(listFile(w));
  assert.equal(none.audit, 'not-run');
  assert.equal(none.counted, false);
  assert.equal(none.status, 'failed');
  assert.equal(withStream.audit, 'pass');
  assert.equal(withStream.counted, false);
  assert.match(withStream.reason, /status failed/);
  assert.equal(good.counted, true);
  assert.deepEqual(readLines(w.auditState).map((l) => l.runId), [withStream.runId, good.runId]);
});

// ---------- F1 an unreadable ledger fails closed ----------

test('F1 a Cursor ledger that exists and cannot be read (a folder: EISDIR) refuses the sweep with exit 3 and one log line; no engine call', async () => {
  // Breaks when: a read error of the ledger reads as 0 starts (readLedger turns every read error into an empty ledger).
  const w = world({ pulls: [pullOf(1, { band: 'HIGH' })] });
  mkdirSync(w.cursorLedger, { recursive: true });
  assert.equal(await sweep(w), SWEEP_EXIT.CAP, w.logs.join('\n'));
  assert.equal(stubCalls().length, 0);
  assert.equal(w.logs.filter((l) => /ledger/.test(l) && /cannot be read/.test(l)).length, 1, w.logs.join('\n'));
  assert.equal(reportOf(w).stopped, 'ledger-unreadable');
});

test('F1b an injected ledger reader that throws EACCES refuses with exit 3; a missing ledger file is still 0 starts', async () => {
  // Breaks when: only EISDIR is caught, or a missing file is refused too.
  const w = world({ pulls: [pullOf(1, { band: 'HIGH' })] });
  seedLive(w, 1);
  const readLedgerText = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
  assert.equal(await sweep(w, [], { readLedgerText }), SWEEP_EXIT.CAP, w.logs.join('\n'));
  assert.equal(stubCalls().length, 0);
  const fresh = world({ pulls: [pullOf(1, { band: 'HIGH' })] });
  assert.equal(existsSync(fresh.cursorLedger), false);
  assert.equal(await sweep(fresh), SWEEP_EXIT.OK, fresh.logs.join('\n'));
  assert.equal(stubCalls().length, 1);
});

// ---------- F3 every answer that can follow a start leaves a list line ----------

const KEY_FIELDS = ['pr', 'head', 'engineSha', 'kind', 'pinned', 'engineVersion', 'bandVersion', 'versionSha', 'frozenSha', 'frozenEngineVersion'];

test('F3 the engine throws after its start: one failed list line (recordPath null, not counted, a reason, the key fields), exit 1, the sweep goes on', async () => {
  // Breaks when: a throw leaves no line (alreadyRun cannot see the failed start), or the sweep stops at it.
  const w = world({ pulls: [pullOf(1, { band: 'HIGH', result: 'throw' }), pullOf(2, { band: 'HIGH' })] });
  assert.equal(await sweep(w), SWEEP_EXIT.FAILED, w.logs.join('\n'));
  assert.deepEqual(stubCalls().map((c) => c.opts.pr), [1, 2]);
  const [bad, good] = jsonl(listFile(w));
  assert.equal(bad.pr, 1);
  assert.equal(bad.status, 'failed');
  assert.equal(bad.recordPath, null);
  assert.equal(bad.counted, false);
  assert.match(bad.reason, /planted engine crash/);
  for (const k of KEY_FIELDS) assert.ok(k in bad, `key field ${k}`);
  assert.equal(bad.head, H(1));
  assert.equal(bad.kind, 'open-head');
  assert.equal(good.pr, 2);
});

test('F3b exit 0 with no record and no skip reason, and exit 1 with no record: each a failed line; a skip row (exit 0 + skipReason) gives none', async () => {
  // Breaks when: an answer without a record is only a counter, or a skip row is listed as a failed run.
  const pulls = [pullOf(1, { band: 'HIGH', result: 'empty' }), pullOf(2, { band: 'HIGH', result: 'no-record' }), pullOf(3, { band: 'HIGH', result: 'skip' })];
  const w = world({ pulls });
  assert.equal(await sweep(w), SWEEP_EXIT.FAILED, w.logs.join('\n'));
  const rows = jsonl(listFile(w));
  assert.deepEqual(rows.map((r) => [r.pr, r.status, r.recordPath, r.counted]), [[1, 'failed', null, false], [2, 'failed', null, false]]);
  assert.match(rows[1].reason, /record write failed/);
  assert.equal(reportOf(w).skipped.engineSkip['range done: a complete record exists at this head'], 1);
});

test('F3c two failed lines of an earlier head (engine throws) block it; the failed lines carry the key alreadyRun reads', async () => {
  // Breaks when: a failed line has another head or engineSha than its run, so the "one more try" rule never closes.
  const early = H('e');
  const w = world({ pulls: [pullOf(7, { band: 'HIGH', result: 'throw' })], shas: { eeeeeee: early }, commitPulls: { [early]: [7] } });
  w.pulls[0].draft = true; // only the earlier head runs
  put(w.cliDir, '2026-11-10-pre-pr-cr-eeeeeee.txt', cliStream(['major']));
  for (let i = 0; i < 3; i += 1) assert.equal(await sweep(w), i < 2 ? SWEEP_EXIT.FAILED : SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.equal(stubCalls().filter((c) => c.pullHead === early).length, 2);
  assert.equal(reportOf(w).skipped.alreadyRun, 1);
});

test('F3d the append of the list line fails after a void run: the error is logged and the sweep still exits 4', async () => {
  // Breaks when: an I/O error on the list file swallows the void stop.
  const w = world({ pulls: [pullOf(2, { band: 'MID', result: 'void' }), pullOf(3, { band: 'MID' })] });
  const appendFile = (file, text) => {
    if (String(file).endsWith('sweep-runs.jsonl')) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
    return appendFileSync(file, text);
  };
  assert.equal(await sweep(w, [], { appendFile }), SWEEP_EXIT.VOID, w.logs.join('\n'));
  assert.equal(stubCalls().length, 1);
  assert.ok(w.logs.some((l) => /list line/.test(l) && /ENOSPC/.test(l)), w.logs.join('\n'));
});

// ---------- F4 the pinned copy is proved by blob before each run ----------

const REVIEWER_FILE = 'scripts/github/cursor-review.mjs';

test('F4 a fresh extract proves clean: every reviewer-set file, review-router.mjs and the config have their blob at the SHA', async () => {
  // Breaks when: the extract changes bytes (line ends) or the proof reads the wrong list.
  const { repo, prHead, sha } = repoWithHeads();
  const { w, over } = pinnedWorld(repo, [pullOf(1, { band: 'HIGH', head: prHead })]);
  assert.equal(await sweep(w, ['--engine-sha', sha, '--frozen-sha', sha], over), SWEEP_EXIT.OK, w.logs.join('\n'));
  const dir = path.join(w.stateRoot, 'engine', sha);
  assert.equal(proveCopy({ dir, sha, git: repo.git, root: repo.dir, computeVersions: realComputeVersions }), null);
  writeFileSync(path.join(dir, ...REVIEWER_FILE.split('/')), '// tampered\n');
  assert.match(proveCopy({ dir, sha, git: repo.git, root: repo.dir, computeVersions: realComputeVersions }), /cursor-review\.mjs differs/);
});

/** Two sweeps: the first is clean, then `spoil(copyDir)` changes the copy, then the second sweep must not start the engine. */
async function spoiledSecondSweep(spoil) {
  const { repo, prHead, sha } = repoWithHeads();
  const { w, over } = pinnedWorld(repo, [pullOf(1, { band: 'HIGH', head: prHead })]);
  const argv = ['--engine-sha', sha, '--frozen-sha', sha];
  assert.equal(await sweep(w, argv, over), SWEEP_EXIT.OK, w.logs.join('\n'));
  spoil(path.join(w.stateRoot, 'engine', sha));
  w.pulls = [pullOf(2, { band: 'HIGH', head: prHead, ref: 'feat/two' })];
  w.logs.length = 0;
  const code = await sweep(w, argv, over);
  return { w, code };
}

test('F4b a copy with one changed reviewer-set file: one error line, the engine is not started from it, no new list line, exit 1', async () => {
  // Breaks when: the copy is checked only for its engine file, or the run starts from a changed copy.
  const { w, code } = await spoiledSecondSweep((dir) => appendFileSync(path.join(dir, ...REVIEWER_FILE.split('/')), '// one more line\n'));
  assert.equal(code, SWEEP_EXIT.FAILED, w.logs.join('\n'));
  assert.equal(stubCalls().filter((c) => c.opts.pr === 2).length, 0);
  assert.deepEqual(jsonl(listFile(w)).map((r) => r.pr), [1]);
  assert.equal(w.logs.filter((l) => /engine copy/.test(l) && /cursor-review\.mjs differs/.test(l)).length, 1, w.logs.join('\n'));
});

test('F4c a copy with one reviewer-set file deleted (the engine file still there): the same refusal', async () => {
  // Breaks when: a partial copy passes because the engine file exists.
  const { w, code } = await spoiledSecondSweep((dir) => rmSync(path.join(dir, 'scripts', 'github', 'review-filter.mjs')));
  assert.equal(code, SWEEP_EXIT.FAILED, w.logs.join('\n'));
  assert.equal(stubCalls().filter((c) => c.opts.pr === 2).length, 0);
  assert.equal(w.logs.filter((l) => /engine copy/.test(l) && /review-filter\.mjs is missing/.test(l)).length, 1, w.logs.join('\n'));
});

test('F4d the config or review-router.mjs changed in the copy: the same refusal', async () => {
  // Breaks when: the proof reads the reviewer set only.
  for (const rel of ['review-router.config.json', 'scripts/github/review-router.mjs']) {
    const { w, code } = await spoiledSecondSweep((dir) => appendFileSync(path.join(dir, ...rel.split('/')), '\n'));
    assert.equal(code, SWEEP_EXIT.FAILED, rel);
    assert.equal(stubCalls().filter((c) => c.opts.pr === 2).length, 0, rel);
  }
});

test('F4e the copy changes during a run: that line is not counted (copyChanged), and the next run of the sweep does not start', async () => {
  // Breaks when: the after-run check looks only for the engine file.
  const { repo, prHead, sha } = repoWithHeads();
  const { w, over } = pinnedWorld(repo, [pullOf(1, { band: 'HIGH', head: prHead }), pullOf(2, { band: 'HIGH', head: prHead, ref: 'feat/two' })]);
  const copy = path.join(w.stateRoot, 'engine', sha);
  const onRun = (opts) => { if (opts.pr === 1) appendFileSync(path.join(copy, ...REVIEWER_FILE.split('/')), '// during the run\n'); };
  assert.equal(await sweep(w, ['--engine-sha', sha, '--frozen-sha', sha], { ...over, engineDeps: { onRun } }), SWEEP_EXIT.FAILED);
  const rows = jsonl(listFile(w));
  assert.deepEqual(rows.map((r) => r.pr), [1]);
  assert.equal(rows[0].counted, false);
  assert.equal(rows[0].copyChanged, true);
  assert.match(rows[0].reason, /changed/);
  assert.deepEqual(stubCalls().map((c) => c.opts.pr), [1]);
});

// ---------- F5 strict open-PR checks ----------

test('F5 an open pull whose number is not an integer or whose head is not 40 hex is skipped and counted (badPull), never run', async () => {
  // Breaks when: a bad number or head reaches the engine or a path.
  const bad = [pullOf(1, { band: 'HIGH' }), pullOf(2, { band: 'HIGH' }), pullOf(3, { band: 'HIGH' }), pullOf(4, { band: 'HIGH' })];
  bad[0].number = '1';
  bad[1].number = 2.5;
  bad[2].head.sha = 'abc1234';
  bad[3].head.sha = H('A');
  const w = world({ pulls: [...bad, pullOf(5, { band: 'HIGH' })] });
  assert.equal(await sweep(w), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.deepEqual(stubCalls().map((c) => c.opts.pr), [5]);
  assert.equal(reportOf(w).skipped.badPull, 4);
});

// ---------- F7 open heads follow the run list (card sweep-open-head-repeat) ----------

/** An unpinned world with one open pull (PR 7, HIGH) and list lines seeded for its open head. */
function openWorld(seed, pullOver = {}) {
  const pull = pullOf(7, { band: 'HIGH', ...pullOver });
  const w = world({ pulls: [pull] });
  const ts = new Date(NOW - DAY).toISOString();
  seedList(w, seed.map((r, i) => ({ v: 1, ts, runId: `open-${i}`, pr: 7, head: pull.head.sha, engineSha: null, kind: 'open-head', ...r })));
  return { w, head: pull.head.sha, runs: () => stubCalls().filter((c) => c.opts.pr === 7).length };
}

test('F7 an open head is checked against the run list: an ok line or a void line blocks; one failed line allows one more try, two block', async () => {
  // Breaks when: plan() does not pass open heads through alreadyRun (an open head with only failed lines runs in every sweep).
  const cases = [
    [[{ status: 'ok', audit: 'pass' }], 0],
    [[{ status: 'ok', audit: 'void' }], 0],
    [[{ status: 'failed', audit: 'not-run' }], 1],
    [[{ status: 'failed', audit: 'not-run' }, { status: 'failed', audit: 'not-run' }], 0],
    [[{ status: 'ok', audit: 'pass', copyGone: true }], 1],
    // The key has no kind: a line of an earlier-head run blocks the same head when it is the open head.
    [[{ status: 'ok', audit: 'pass', kind: 'earlier-head' }], 0],
  ];
  for (const [seed, want] of cases) {
    const { w, runs } = openWorld(seed);
    assert.equal(await sweep(w), SWEEP_EXIT.OK, w.logs.join('\n'));
    assert.equal(runs(), want, JSON.stringify(seed));
    assert.equal(reportOf(w).skipped.alreadyRun, 1 - want, JSON.stringify(seed));
  }
});

test('F7b an unpinned (rehearsal) line does not block a pinned run of the same open head', async () => {
  // Breaks when: the open-head check leaves the engine SHA out of the key.
  const { repo, sha } = repoWithHeads();
  const { w, over } = pinnedWorld(repo, [pullOf(7, { band: 'HIGH', head: sha })]);
  seedList(w, [{ v: 1, ts: new Date(NOW - DAY).toISOString(), runId: 'old', pr: 7, head: sha, engineSha: null, status: 'ok', audit: 'pass', kind: 'open-head' }]);
  assert.equal(await sweep(w, ['--engine-sha', sha], over), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.equal(stubCalls().filter((c) => c.opts.pr === 7).length, 1);
  assert.equal(reportOf(w).skipped.alreadyRun, 0);
});

test('F7c a dry run leaves a blocked open head out of the plan, and the text report counts it as already run', async () => {
  // Breaks when: the dry run plans a head that the real run would skip.
  const { w } = openWorld([{ status: 'ok', audit: 'void' }]);
  assert.equal(await sweep(w, ['--dry-run']), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.deepEqual(reportOf(w).planned, []);
  const w2 = openWorld([{ status: 'ok', audit: 'void' }]).w;
  assert.equal(await main(['--cli-dir', w2.cliDir, '--dry-run'], deps(w2)), SWEEP_EXIT.OK, w2.logs.join('\n'));
  assert.match(w2.out.join('\n'), /already run 1/);
});

test('N3 an open pull whose branch name has a bad shape is skipped and counted (badPull); the name reaches no gh call and no engine call', async () => {
  // Breaks when: head.ref of an open pull goes into a target without a shape check.
  const refs = ['../x', '-x', 'a b', 'a..b', 'x/', 'x.lock', 'a//b', `a${'b'.repeat(200)}`, '', 42, null];
  const pulls = refs.map((ref, i) => { const p = pullOf(i + 1, { band: 'HIGH' }); p.head.ref = ref; return p; });
  const w = world({ pulls: [...pulls, pullOf(50, { band: 'HIGH', ref: 'feat/x-1.2_y' })] });
  assert.equal(await sweep(w), SWEEP_EXIT.OK, w.logs.join('\n'));
  assert.deepEqual(stubCalls().map((c) => c.opts.pr), [50]);
  assert.equal(reportOf(w).skipped.badPull, refs.length);
  assert.equal(w.ghCalls.filter((a) => /\/pulls\/(?!50\b)\d+/.test(String(a[1]))).length, 0, 'no gh call for a skipped pull');
});
