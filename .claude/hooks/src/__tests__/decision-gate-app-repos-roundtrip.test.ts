/**
 * The tap round trip in a covered app repo, all real (card coord-decision-gate-app-repos, fix round 1, fixer C; review finding "no test
 * runs the gate's deny text, then the real app-ask.mjs, then the ledger, then the gate allow").
 * Per row: the gate (realDeps, real git) denies; the app-ask command is cut out of the deny text and run as the REAL CLI (node app-ask.mjs,
 * placeholders filled from the deny's own note); its JSON goes to AskUserQuestion through the REAL decision-ledger hook with the first label;
 * then the same command must pass the gate. No key, tree or head is built by hand.
 * Every path is in one temp folder: the registry (LANE_REGISTRY_PATH), the store (CCV3_DECISIONS_FILE, under the temp folder, so the merge
 * facts seam of app-ask is on) and the router config (one copy above the repos, one under the gate's home, which is the temp folder too:
 * deps()), so the real home config is never read. Nothing in a payload runs; no network.
 * Fixer E (Dave 11-13): every remote's HEAD names feat, so each push row pushes a default branch and needs the tap.
 *
 * Each row names the source change that turns it red:
 *   RT1 bare push with an upstream           -> app-ask keys a bare push on another branch than the gate, or the gate drops --remote
 *   RT2 git push up feat while on main       -> drop --branch or --src from the push text (app-ask then keys main, or binds the HEAD tree)
 *   RT3 git push up HEAD:main                -> drop --src (app-ask then binds the tree of main, not of HEAD = feat)
 *   RT4 a URL remote                         -> app-ask refuses a URL remote again
 *   RT5 nothing ahead (a push of main)       -> app-ask refuses "nothing to push" again
 *   RT6 create and merge                     -> a create or merge offer without --remote or --branch
 *   RT7 two remotes, no @{push}, -R one      -> compare -R with the @{push} key only (F4)
 *   RT8 an SSH host alias and a github field -> ignore the github field in either side (F5)
 *   RT9 fetch and push URL differ, -R fetch  -> key the create on the push URL in either side (F6)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle as ledger } from '../decision-ledger.js';
import { realDeps } from '../decision-gate.js';
import { decideParsed } from './helpers/parse-first.js';
import './helpers/walker-timeout.js'; // C2c: the long test timeout, scoped to the files that start a pwsh walker

const APP_ASK = fileURLToPath(new URL('../../../../scripts/github/app-ask.mjs', import.meta.url));
// An empty global git config and no system config: a developer's commit.gpgsign or hooksPath cannot break the fixture commits.
const GITCONFIG = join(mkdtempSync(join(tmpdir(), 'dg-gitcfg-')), 'gitconfig');
writeFileSync(GITCONFIG, '');
const FIXED = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@example.invalid', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@example.invalid', GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: '1' };
const ENV_KEYS = ['CCV3_DECISIONS_FILE', 'LANE_REGISTRY_PATH', 'CLAUDE_AGENT_ID', 'APP_ASK_TEST'];
const saved: Record<string, string | undefined> = {};
let home = '';
const projects: { key: string; path: string; github?: string }[] = [];

const git = (cwd: string, ...a: string[]): string => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...FIXED } });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
};
/** A covered repo: one commit on main, then branch feat with one more commit (a file, so feat and main have other trees). */
function makeRepo(name: string, remotes: Record<string, string>, github?: string): string {
  const d = `${home}/${name}`;
  mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  for (const [n, u] of Object.entries(remotes)) {
    git(d, 'remote', 'add', n, u);
    // Fixer E (Dave 11-13): feat is the default branch of each remote (its remote HEAD, as develop often is), so a push of feat needs the tap.
    git(d, 'symbolic-ref', `refs/remotes/${n}/HEAD`, `refs/remotes/${n}/feat`);
  }
  git(d, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(d, 'checkout', '-q', '-b', 'feat');
  writeFileSync(`${d}/f.txt`, `${name}\n`);
  git(d, 'add', 'f.txt');
  git(d, 'commit', '-q', '-m', 'feat');
  projects.push({ key: name, path: d, ...(github ? { github } : {}) });
  writeFileSync(`${home}/project-registry.json`, JSON.stringify({ projects }));
  return d;
}

// Card tests-flaky-under-load-1115: one home per ATTEMPT. vitest --retry=2 re-runs a failed row and its beforeEach, but never its beforeAll.
// A home made in beforeAll kept the repos of the failed attempt, so the retry died at `git remote add ... already exists` and hid the first error.
// The paths are recorded, and afterEach removes only those (no folder is found by name or age).
const madeHomes: string[] = [];
beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dg-rt-')).replace(/\\/g, '/');
  madeHomes.push(home);
  projects.length = 0;
  delete process.env.CLAUDE_AGENT_ID;
  delete process.env.APP_ASK_TEST;
  process.env.CCV3_DECISIONS_FILE = `${home}/decisions.json`;
  process.env.LANE_REGISTRY_PATH = `${home}/project-registry.json`;
  // Two copies: the one above the repos (read from the cwd upward) and the home copy (a create or merge deny reads only that one).
  const cfg = JSON.stringify({ decisions: { enforce: true } });
  writeFileSync(`${home}/review-router.config.json`, cfg);
  mkdirSync(`${home}/continuous-claude`, { recursive: true });
  writeFileSync(`${home}/continuous-claude/review-router.config.json`, cfg);
});
afterEach(() => {
  for (const h of madeHomes.splice(0)) rmSync(h, { recursive: true, force: true });
});
afterAll(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const bash = (cwd: string, command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: 's-rt' });
/** The real Deps with the temp folder as home, so the gate never reads the developer's home config (absent on a CI runner). */
const deps = () => ({ ...realDeps(), home });
const verdict = async (cwd: string, command: string) => await decideParsed(bash(cwd, command), deps());

/** The words of the app-ask command in a deny text (sub-command to the last flag). Fixer G: no placeholder to fill in. */
function askWords(reason: string): string[] {
  // .*? and not \S*: the home path (the temp folder here) may hold a space.
  const m = /node .*?app-ask\.mjs'? (.*?) --json/.exec(reason);
  if (!m) throw new Error(`no app-ask command in: ${reason}`);
  return (m[1].match(/'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^'(.*)'$/, '$1'));
}

/** Run the real app-ask CLI on the deny's own command in the payload cwd, then answer its question through the real ledger with the first label. */
function tapThroughAsk(cwd: string, reason: string, facts?: object): string {
  const words = askWords(reason);
  const extra: string[] = [];
  if (facts) {
    const file = `${home}/facts-${Math.random().toString(36).slice(2)}.json`;
    writeFileSync(file, JSON.stringify(facts));
    extra.push('--facts', file);
  }
  const env = { ...process.env, APP_ASK_TEST: '1', ...FIXED };
  const r = spawnSync(process.execPath, [APP_ASK, ...words, ...extra, '--json'], { cwd, env, encoding: 'utf8' });
  expect(r.status, `app-ask ${words.join(' ')}: ${r.stderr}`).toBe(0);
  const spec = JSON.parse(r.stdout) as { header: string; question: string; options: { label: string }[] };
  const label = spec.options[0].label;
  return ledger(JSON.stringify({ tool_name: 'AskUserQuestion', session_id: 's-rt', tool_input: { questions: [spec] }, tool_response: { answers: { [spec.question]: label } } }));
}

/** Denied with `pattern`; allowed after the round trip. */
async function roundTrip(cwd: string, command: string, pattern: string, facts?: object): Promise<void> {
  const before = await verdict(cwd, command);
  expect(before.action === 'deny' ? before.pattern : `not denied: ${JSON.stringify(before)}`).toBe(pattern);
  const recorded = tapThroughAsk(cwd, (before as { reason: string }).reason, facts);
  expect(recorded, 'the ledger recorded the tap').toMatch(/record/i);
  expect(await verdict(cwd, command), command).toEqual({ action: 'allow' });
}

// Each row starts git and node several times (0.7 to 1.6 s on Windows when idle): a long limit keeps a loaded machine from a false red.
describe('the deny text, the real app-ask CLI and the real ledger give the key the gate reads (fix round 1, fixer C)', { timeout: 30_000 }, () => {
  // Card tests-flaky-under-load-1115. Same defect as the chain test: vitest --retry=2 runs a retried row in the SAME home (beforeAll),
  // so its fixed repo name exists and `git remote add` fails "remote already exists". Change that turns it red: one home for all attempts.
  let retryAttempt = 0;
  it('RTR a retried row can build its repo again (one home per attempt)', { retry: 1 }, () => {
    retryAttempt += 1;
    makeRepo('rt-retry', { up: 'https://github.com/acme/rt-retry.git' });
    if (retryAttempt === 1) throw new Error('first attempt fails on purpose, to force the retry');
    expect(retryAttempt, 'the retry ran').toBe(2);
  });
  it('RT1 a bare push with an upstream (@{push} = up/feat)', async () => {
    const d = makeRepo('rt-bare', { up: 'https://github.com/acme/rt-bare.git' });
    git(d, 'update-ref', 'refs/remotes/up/feat', 'main');
    git(d, 'config', 'branch.feat.remote', 'up');
    git(d, 'config', 'branch.feat.merge', 'refs/heads/feat');
    await roundTrip(d, 'git push', 'ship');
  });
  it('RT2 git push up feat while on main: key feat, tree of feat', async () => {
    const d = makeRepo('rt-other', { up: 'https://github.com/acme/rt-other.git' });
    git(d, 'checkout', '-q', 'main');
    await roundTrip(d, 'git push up feat', 'ship');
  });
  // Fixer E: HEAD:main, not HEAD:release (release is no default branch and passes with no tap). The source HEAD is feat, the destination main.
  it('RT3 a refspec: git push up HEAD:main', async () => {
    const d = makeRepo('rt-spec', { up: 'https://github.com/acme/rt-spec.git' });
    await roundTrip(d, 'git push up HEAD:main', 'ship');
  });
  // Fixer E: main, not feat (a URL target has no remote HEAD: only main and master are default branches there).
  it('RT4 a URL remote', async () => {
    const d = makeRepo('rt-url', { up: 'https://github.com/acme/rt-url.git' });
    await roundTrip(d, 'git push https://github.com/acme/rt-url.git main', 'ship');
  });
  it('RT5 nothing ahead of the remote: a push of main that the remote already has', async () => {
    const d = makeRepo('rt-none', { up: 'https://github.com/acme/rt-none.git' });
    git(d, 'checkout', '-q', 'main');
    git(d, 'update-ref', 'refs/remotes/up/main', 'HEAD');
    await roundTrip(d, 'git push up main', 'ship');
  });
  it('RT6 a create and a merge with one remote', async () => {
    const d = makeRepo('rt-pr', { origin: 'https://github.com/acme/rt-pr.git' });
    await roundTrip(d, 'gh pr create --draft --title t --body-file b.md', 'open-pr');
    const head = git(d, 'rev-parse', 'feat');
    await roundTrip(d, `gh pr merge 7 --squash --match-head-commit ${head}`, 'land', { headRefOid: head, state: 'OPEN', isDraft: false, title: 't' });
  });
  it('RT7 two remotes and no @{push}: a create that names the repo of the second remote', async () => {
    const d = makeRepo('rt-two', { origin: 'https://github.com/acme/rt-two.git', mirror: 'https://github.com/acme/rt-two-m.git' });
    await roundTrip(d, 'gh pr create -R acme/rt-two-m --draft --title t', 'open-pr');
    expect(await verdict(d, 'gh pr create --draft --title t')).toMatchObject({ action: 'deny', pattern: 'repo-unnamed' });
  });
  it('RT8 an SSH host alias remote with the github field of the entry', async () => {
    const d = makeRepo('rt-alias', { origin: 'git@github-work:Acme/RT-Alias.git' }, 'acme/rt-alias');
    await roundTrip(d, 'gh pr create --draft --title t', 'open-pr');
  });
  it('RT9 a remote that fetches from one repo and pushes to another: -R of the fetch repo', async () => {
    const d = makeRepo('rt-split', { origin: 'https://github.com/acme/rt-up.git' });
    git(d, 'remote', 'set-url', '--push', 'origin', 'https://github.com/me/rt-fork.git');
    expect(await verdict(d, 'gh pr create --draft --title t')).toMatchObject({ action: 'deny', pattern: 'fetch-push-differ' });
    await roundTrip(d, 'gh pr create -R acme/rt-up --draft --title t', 'open-pr');
    await roundTrip(d, 'git push origin feat', 'ship');
  });
  // Reviewer-2 round, seat 3d: the deny prints the remote with no user:token part, and that printed remote keys the same tap.
  // Change that breaks it: drop noCreds in askCmd (the token is printed), or strip the remote before pushKey in either side.
  it('RT10 a user:token URL remote: no token in the deny, and its printed --remote round-trips', async () => {
    const d = makeRepo('rt-tok', { up: 'https://github.com/acme/rt-tok.git' });
    const cmd = 'git push https://user:ghp_SECRETTOKEN123@github.com/acme/rt-tok.git main';
    const before = await verdict(d, cmd);
    expect(before.action === 'deny' ? before.reason : '').not.toContain('ghp_SECRETTOKEN123');
    expect(askWords((before as { reason: string }).reason)).toContain('https://github.com/acme/rt-tok.git');
    await roundTrip(d, cmd, 'ship');
  });
});
