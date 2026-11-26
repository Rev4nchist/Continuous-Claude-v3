/**
 * The whole tap chain in a covered app repo (card coord-decision-gate-app-repos, fix round 1, fixer D; review finding F9, critic major 6).
 * Per row: the gate (decide with realDeps, real git) denies; the app-ask command is parsed out of the deny text; the REAL scripts/github/app-ask.mjs
 * runs under node with --json (APP_ASK_TEST seam, store under os.tmpdir(), for the gh facts of a merge); its offer goes to the REAL decision-ledger
 * hook as an AskUserQuestion answer (the first label); then the same command must pass the gate. No key, tree or head is built by hand.
 * Everything lives in one temp folder: registry (LANE_REGISTRY_PATH), store (CCV3_DECISIONS_FILE), router config. The gate's home is that
 * folder too (deps()), so the real home config is never read. No network.
 * Two negative rows prove that a tap is bound to its repo and to its pushed branch.
 *
 * Each row names the source change that turns it red:
 *   CH1 bare push, upstream up/feat  -> the push deny text drops --branch, or app-ask keys a bare push on another branch than the gate reads
 *   CH2 git push up feat on main     -> the push deny text drops --branch or --src (app-ask keys main or binds the HEAD tree); app-ask keys on 'main'
 *   CH3 git push up HEAD:main        -> the push deny text drops --src (app-ask binds the tree of main, not of HEAD = feat)
 *   CH4 URL remote                   -> app-ask refuses a URL remote, or the deny text drops --remote
 *   CH5 nothing ahead                -> app-ask refuses "nothing to push" again
 *   CH6 create                       -> the open-pr text drops --branch or --remote
 *   CH7 merge                        -> the merge text drops --remote, or app-ask ignores the facts seam
 *   CH8 tap of repo A, same command in repo B -> the key drops the repo (both repos have the same files and branch, so only the repo differs)
 *   CH9 tap of 'Push only' for feat, push of main -> the key drops the branch
 *   CH10 a push of a branch that is no default branch (topic) -> drop the branch test: the push is denied and needs app-ask again
 *   CH11 no remote HEAD (symbolic-ref exits 1): feat and main need the tap (fixer F) -> let a missing remote HEAD mean main and master only
 *   CH12 git push up @ on feat: the offer --branch feat --src @ keys and binds what the gate reads -> read @ as a branch name
 *   CH13 commit && git push up @ on main: the tap clears it -> the gate reads @^{tree}, or app-ask counts no staged file for --src @
 *   CH14 a bare push widened by push.default=matching, remote.up.push or remote.up.mirror -> drop the config read of a bare push
 *   CH15 git push up v1.0 with a local tag v1.0 -> drop the tag test
 *   CH16 a bare push of a branch with U+2019 (fixer G): the offer leaves --branch out -> keep a placeholder or a quoting rule for it
 *   CH17 (fix round 3, fixer H) real config: push.followTags, a colon-less remote.up.push mapping, git -c and --follow-tags take the tap
 *        path; a + mapping is push-unsafe -> read config for a bare push only; compare the key in mixed case; skip the call's options
 *   Re-pinned by fixer H (strict allow-list): CH10 feat:topic and HEAD:topic take the tap path; CH14 remote.up.mirror is push-unsafe.
 *   Re-pinned by fixer K (fix round 4, critic major 1): CH14 and CH17 config that widens a push is a hard deny (push-target-unresolved),
 *   not the tap path; CH17 adds the recursion keys, push.default=matching on a positional push (allowed), git -p push and the way out
 *   (feat:feat --no-recurse-submodules through the real chain).
 * Fixer E (Dave 11-13): every remote's HEAD names feat, so the push rows CH1 to CH9 push a default branch and need the tap.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle as ledger } from '../decision-ledger.js';
import { decide, realDeps } from '../decision-gate.js';
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
const projects: { key: string; path: string }[] = [];

const git = (cwd: string, ...a: string[]): string => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...FIXED } });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
};
/** A covered repo: one commit on main, then branch feat with one more commit (file content `body`; same body in two repos gives the same tree). */
function makeRepo(name: string, remotes: Record<string, string>, body = name, remoteHead = true): string {
  const d = `${home}/${name}`;
  mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  for (const [n, u] of Object.entries(remotes)) {
    git(d, 'remote', 'add', n, u);
    if (!remoteHead) continue;
    // Fixer E (Dave 11-13): feat is the default branch of each remote (its remote HEAD, as develop often is), so a push of feat needs the tap.
    git(d, 'symbolic-ref', `refs/remotes/${n}/HEAD`, `refs/remotes/${n}/feat`);
  }
  git(d, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(d, 'checkout', '-q', '-b', 'feat');
  writeFileSync(`${d}/f.txt`, `${body}\n`);
  git(d, 'add', 'f.txt');
  git(d, 'commit', '-q', '-m', 'feat');
  projects.push({ key: name, path: d });
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
  home = mkdtempSync(join(tmpdir(), 'dg-ch-')).replace(/\\/g, '/');
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

/** The real Deps with the temp folder as home, so the gate never reads the developer's home config (absent on a CI runner). */
const deps = () => ({ ...realDeps(), home });
const verdict = async (cwd: string, command: string) => await decideParsed({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: 's-ch' }, deps());
type Verdict = Awaited<ReturnType<typeof verdict>>;
const denied = (v: Verdict): { reason: string; pattern: string } => {
  if (v.action !== 'deny') throw new Error(`not denied: ${JSON.stringify(v)}`);
  return v as unknown as { reason: string; pattern: string };
};

/** The words of the app-ask command in a deny text (sub-command to the last flag). Fixer G: no placeholder to fill in. */
function askWords(reason: string): string[] {
  // .*? and not \S*: the home path (the temp folder here) may hold a space.
  const m = /node .*?app-ask\.mjs'? (.*?) --json/.exec(reason);
  if (!m) throw new Error(`no app-ask command in: ${reason}`);
  return (m[1].match(/'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^'(.*)'$/, '$1'));
}

/**
 * Run the real app-ask CLI on the deny's own command, in the payload cwd (fixer G: a command may leave out --dir, --remote or --branch
 * when app-ask reads them there itself); answer its question through the real ledger with the first label. Returns the label.
 */
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
  const out = ledger(JSON.stringify({ tool_name: 'AskUserQuestion', session_id: 's-ch', tool_input: { questions: [spec] }, tool_response: { answers: { [spec.question]: label } } }));
  expect(out, 'the ledger recorded the tap').toMatch(/record/i);
  return label;
}

/** Deny with `pattern`; tap through the real chain; then the same command must be allowed. */
async function chain(cwd: string, command: string, pattern: string, facts?: object): Promise<string> {
  const before = denied(await verdict(cwd, command));
  expect(before.pattern).toBe(pattern);
  const label = tapThroughAsk(cwd, before.reason, facts);
  expect(await verdict(cwd, command), command).toEqual({ action: 'allow' });
  return label;
}

// Each row starts git and node several times (about 1 s each): a long limit keeps a loaded machine from a false red.
describe('gate deny -> parsed app-ask command -> real app-ask -> real ledger -> gate allow (fix round 1, fixer D, F9)', { timeout: 30_000 }, () => {
  // Card tests-flaky-under-load-1115. CI and pre-pr run vitest with --retry=2. A retried row runs again in the SAME home (beforeAll),
  // so its fixed repo name exists and `git remote add` fails "remote already exists": the first error is gone.
  // Change that turns it red: one home for all attempts (a repo built twice in one home fails).
  let retryAttempt = 0;
  it('CHR a retried row can build its repo again (one home per attempt)', { retry: 1 }, () => {
    retryAttempt += 1;
    makeRepo('ch-retry', { up: 'https://github.com/acme/ch-retry.git' });
    if (retryAttempt === 1) throw new Error('first attempt fails on purpose, to force the retry');
    expect(retryAttempt, 'the retry ran').toBe(2);
  });
  it('CH1 a bare push with an upstream (@{push} = up/feat)', async () => {
    const d = makeRepo('ch-bare', { up: 'https://github.com/acme/ch-bare.git' });
    git(d, 'update-ref', 'refs/remotes/up/feat', 'main');
    git(d, 'config', 'branch.feat.remote', 'up');
    git(d, 'config', 'branch.feat.merge', 'refs/heads/feat');
    expect(await chain(d, 'git push', 'ship')).toMatch(/^Push only/);
  });
  it('CH2 git push up feat while on main: the tap is for feat', async () => {
    const d = makeRepo('ch-other', { up: 'https://github.com/acme/ch-other.git' });
    git(d, 'checkout', '-q', 'main');
    await chain(d, 'git push up feat', 'ship');
  });
  // Fixer E: HEAD:main, not HEAD:release (release is no default branch and passes with no tap). The source HEAD is feat, the destination main.
  it('CH3 a refspec: git push up HEAD:main', async () => {
    const d = makeRepo('ch-spec', { up: 'https://github.com/acme/ch-spec.git' });
    await chain(d, 'git push up HEAD:main', 'ship');
  });
  // Fixer E: main, not feat (a URL target has no remote HEAD: only main and master are default branches there).
  it('CH4 a URL remote', async () => {
    const d = makeRepo('ch-url', { up: 'https://github.com/acme/ch-url.git' });
    await chain(d, 'git push https://github.com/acme/ch-url.git main', 'ship');
  });
  it('CH5 nothing ahead: a push of main that the remote already has', async () => {
    const d = makeRepo('ch-none', { up: 'https://github.com/acme/ch-none.git' });
    git(d, 'checkout', '-q', 'main');
    git(d, 'update-ref', 'refs/remotes/up/main', 'HEAD');
    await chain(d, 'git push up main', 'ship');
  });
  it('CH6 gh pr create', async () => {
    const d = makeRepo('ch-create', { origin: 'https://github.com/acme/ch-create.git' });
    await chain(d, 'gh pr create --draft --title t --body-file b.md', 'open-pr');
  });
  it('CH7 gh pr merge with the head sha and the gh facts of the test seam', async () => {
    const d = makeRepo('ch-merge', { origin: 'https://github.com/acme/ch-merge.git' });
    const head = git(d, 'rev-parse', 'feat');
    await chain(d, `gh pr merge 7 --squash --match-head-commit ${head}`, 'land', { headRefOid: head, state: 'OPEN', isDraft: false, title: 't' });
  });
  it('CH8 a tap for repo A does not allow the same command in repo B (same branch, same files, same tree)', async () => {
    const a = makeRepo('ch-a', { up: 'https://github.com/acme/ch-a.git' }, 'same');
    const b = makeRepo('ch-b', { up: 'https://github.com/acme/ch-b.git' }, 'same');
    expect(git(a, 'rev-parse', 'feat^{tree}'), 'the trees must match, so that only the repo differs').toBe(git(b, 'rev-parse', 'feat^{tree}'));
    expect(await chain(a, 'git push up feat', 'ship')).toMatch(/^Push only/);
    expect(denied(await verdict(b, 'git push up feat')).pattern).toBe('ship');
    expect(await verdict(a, 'git push up feat'), 'repo A keeps its tap').toEqual({ action: 'allow' });
  });
  it('CH9 a Push only tap for feat does not allow a push of main', async () => {
    const d = makeRepo('ch-branch', { up: 'https://github.com/acme/ch-branch.git' });
    expect(await chain(d, 'git push up feat', 'ship')).toMatch(/^Push only/);
    expect(denied(await verdict(d, 'git push up main')).pattern).toBe('ship');
    expect(await verdict(d, 'git push up feat'), 'the tap for feat stays').toEqual({ action: 'allow' });
  });
  it('CH10 a push of topic (no default branch: not main, master or the remote HEAD branch feat) passes with no app-ask run and no tap', async () => {
    const d = makeRepo('ch-topic', { up: 'https://github.com/acme/ch-topic.git' });
    git(d, 'checkout', '-q', '-b', 'topic');
    // Fix round 3 re-pin (fixer H, strict allow-list): feat:topic and HEAD:topic were no-tap allows; a colon refspec now takes the tap path.
    for (const cmd of ['git push up topic', 'git push -u up topic']) expect(await verdict(d, cmd), cmd).toEqual({ action: 'allow' });
    for (const cmd of ['git push up feat:topic', 'git push up HEAD:topic']) expect(denied(await verdict(d, cmd)).pattern, cmd).toBe('ship');
    expect(denied(await verdict(d, 'git push up topic:main')).pattern, 'the same source to main still needs the tap').toBe('ship');
  });
  // Fixer F re-pin (principal minor, critic minor): feat passed with no tap here. With no remote HEAD the default branch is not known, so
  // feat takes the tap path too (fail closed), through the full chain; after set-head, feat passes with no tap again.
  it('CH11 a remote with no remote HEAD (a fresh clone without set-head): feat and main both need the tap; after set-head feat passes', async () => {
    const d = makeRepo('ch-nohead', { up: 'https://github.com/acme/ch-nohead.git' }, 'ch-nohead', false);
    expect(spawnSync('git', ['symbolic-ref', '--quiet', 'refs/remotes/up/HEAD'], { cwd: d }).status, 'no remote HEAD').not.toBe(0);
    expect(denied(await verdict(d, 'git push up feat')).reason).toContain('git remote set-head up --auto');
    await chain(d, 'git push up feat', 'ship');
    await chain(d, 'git push up main', 'ship');
    git(d, 'symbolic-ref', 'refs/remotes/up/HEAD', 'refs/remotes/up/main');
    expect(await verdict(d, 'git push up topic'), 'a readable remote HEAD (main): topic is no default branch').toEqual({ action: 'allow' });
  });
  it('CH12 git push up @ on feat (git reads @ as HEAD): a push of feat, a default branch here, through the real chain', async () => {
    const d = makeRepo('ch-at', { up: 'https://github.com/acme/ch-at.git' });
    await chain(d, 'git push up @', 'ship');
  });
  it('CH13 git push up @ after a chained commit on main: the gate reads the index and app-ask binds the staged tree, so the tap clears it', async () => {
    const d = makeRepo('ch-at-commit', { up: 'https://github.com/acme/ch-at-commit.git' });
    git(d, 'checkout', '-q', 'main');
    writeFileSync(`${d}/g.txt`, 'staged\n');
    git(d, 'add', 'g.txt');
    expect(await chain(d, 'git commit -q -m next && git push up @', 'ship')).toMatch(/^Commit and push/);
  });
  // Fix round 3 re-pin (fixer H, critic major 4): remote.up.mirror true was the tap path; it is push-unsafe now (a mirror push, tap or not).
  it('CH14 a bare push that git config widens (push.default=matching, remote.up.push) takes the tap path; remote.up.mirror is push-unsafe', async () => {
    const d = makeRepo('ch-config', { up: 'https://github.com/acme/ch-config.git' });
    git(d, 'checkout', '-q', '-b', 'topic');
    git(d, 'update-ref', 'refs/remotes/up/topic', 'HEAD');
    git(d, 'config', 'branch.topic.remote', 'up');
    git(d, 'config', 'branch.topic.merge', 'refs/heads/topic');
    expect(await verdict(d, 'git push'), 'no config: topic is no default branch').toEqual({ action: 'allow' });
    // Fix round 4 re-pin (fixer K, critic major 1): push.default=matching and a remote.up.push mapping of a bare push are hard denies now.
    const widened: [string, string, string][] = [['push.default', 'matching', 'push-target-unresolved'], ['remote.up.push', 'refs/heads/*:refs/heads/*', 'push-target-unresolved'], ['remote.up.mirror', 'true', 'push-unsafe']];
    for (const [key, value, pattern] of widened) {
      git(d, 'config', key, value);
      expect(denied(await verdict(d, 'git push')).pattern, `${key}=${value}`).toBe(pattern);
      git(d, 'config', '--unset', key);
    }
    expect(await verdict(d, 'git push'), 'config cleared again').toEqual({ action: 'allow' });
  });
  it('CH15 a local tag v1.0 pushed by its bare name takes the tap path', async () => {
    const d = makeRepo('ch-tag', { up: 'https://github.com/acme/ch-tag.git' });
    git(d, 'checkout', '-q', '-b', 'topic');
    expect(await verdict(d, 'git push up v1.0'), 'no tag v1.0 yet').toEqual({ action: 'allow' });
    git(d, 'tag', 'v1.0');
    expect(denied(await verdict(d, 'git push up v1.0')).pattern).toBe('ship');
  });
  // Fixer G (item 4): the branch holds U+2019, a PowerShell quote mark, so it never goes into a command. It is the current branch, so the
  // deny command leaves --branch out and the real app-ask reads it in the folder. Change that breaks it: keep a placeholder or a quoting
  // rule (the command then holds <branch>), or app-ask keys a bare push on another branch than the gate reads.
  it('CH16 a bare push of a branch with U+2019: the offer leaves --branch out, and the tap app-ask writes clears the push', async () => {
    const odd = 'feat\u2019x';
    const d = makeRepo('ch-odd', { up: 'https://github.com/acme/ch-odd.git' }, 'ch-odd', false);
    git(d, 'checkout', '-q', '-b', odd);
    git(d, 'symbolic-ref', 'refs/remotes/up/HEAD', `refs/remotes/up/${odd}`);
    git(d, 'config', `branch.${odd}.remote`, 'up');
    git(d, 'config', `branch.${odd}.merge`, `refs/heads/${odd}`);
    git(d, 'update-ref', `refs/remotes/up/${odd}`, 'main');
    const before = denied(await verdict(d, 'git push'));
    expect(/node .*?app-ask\.mjs'? (.*?) --json/.exec(before.reason)?.[1], before.reason).toBe(`push --remote up --src HEAD --dir '${d}'`);
    expect(before.reason).toContain('app-ask reads the branch itself');
    await chain(d, 'git push', 'ship');
  });
  // Fix round 3 (fixer H): real git config, so the key case git prints (push.followtags, lowercased) is what the gate reads.
  // Change that breaks it: read only a bare push's config, match push.followTags in mixed case, or skip the global options of the call.
  it('CH17 real config: push.followTags, a colon-less remote.up.push mapping and git -c take the tap path; a + mapping is push-unsafe', async () => {
    const d = makeRepo('ch-strict', { up: 'https://github.com/acme/ch-strict.git' });
    git(d, 'checkout', '-q', '-b', 'topic');
    git(d, 'update-ref', 'refs/remotes/up/topic', 'HEAD');
    git(d, 'config', 'branch.topic.remote', 'up');
    git(d, 'config', 'branch.topic.merge', 'refs/heads/topic');
    expect(await verdict(d, 'git push up topic'), 'no config: topic is no default branch').toEqual({ action: 'allow' });
    // Fix round 4 re-pin (fixer K, critic major 1): push.followTags, the colon-less mapping, git -c with a push key and --follow-tags were
    // the tap path; each is a hard deny now (push-target-unresolved). push.recurseSubmodules and submodule.recurse join them.
    const rows: [string, string, string][] = [
      ['push.followTags', 'true', 'push-target-unresolved'], ['remote.up.push', 'refs/heads/topic:refs/heads/main', 'push-target-unresolved'],
      ['remote.up.push', '+refs/heads/topic:refs/heads/topic', 'push-unsafe'], ['push.recurseSubmodules', 'on-demand', 'push-target-unresolved'],
      ['submodule.recurse', 'true', 'push-target-unresolved'],
    ];
    for (const [key, value, pattern] of rows) {
      git(d, 'config', key, value);
      expect(denied(await verdict(d, 'git push up topic')).pattern, `${key}=${value}`).toBe(pattern);
      git(d, 'config', '--unset', key);
    }
    // push.default=matching widens a bare push only: a positional push of topic passes (no over-deny).
    git(d, 'config', 'push.default', 'matching');
    expect(await verdict(d, 'git push up topic'), 'push.default=matching, positional push').toEqual({ action: 'allow' });
    git(d, 'config', '--unset', 'push.default');
    expect(denied(await verdict(d, 'git -c push.default=matching push')).pattern).toBe('push-target-unresolved');
    expect(denied(await verdict(d, 'git push --follow-tags up topic')).pattern).toBe('push-target-unresolved');
    expect(denied(await verdict(d, 'git -p push up topic')).pattern, 'a global option the shape reader does not read').toBe('push-target-unresolved');
    // Fix round 4 (fixer K): the way out the deny text names is no dead end. With feat mapped to main, git push up feat is a hard deny;
    // naming both sides (feat:feat --no-recurse-submodules) takes the tap path and clears through the real app-ask and ledger.
    // Change that breaks it: read remote.<r>.push for a colon refspec too, or ignore --no-recurse-submodules.
    git(d, 'config', 'remote.up.push', 'refs/heads/feat:refs/heads/main');
    git(d, 'config', 'push.recurseSubmodules', 'on-demand');
    expect(denied(await verdict(d, 'git push up feat')).pattern).toBe('push-target-unresolved');
    await chain(d, 'git push up feat:feat --no-recurse-submodules', 'ship');
    git(d, 'config', '--unset', 'remote.up.push');
    git(d, 'config', '--unset', 'push.recurseSubmodules');
    // The gate reads @{push} of topic now; the shell would switch to main first and push main.
    // Round 3 C4 (Dave 2026-11-15, "Strict here, soft in apps"): a step before the push that the gate does not model is push-state-unknown, on the tap path.
    expect(denied(await verdict(d, 'git checkout -q main && git push')).pattern, 'a branch switch before a bare push').toBe('push-state-unknown');
    expect(await verdict(d, 'git push'), 'config cleared again: the bare push passes').toEqual({ action: 'allow' });
  });
});
