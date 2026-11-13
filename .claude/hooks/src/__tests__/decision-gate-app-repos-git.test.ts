/**
 * decision-gate in app folders, with real git and the REAL Deps (realDeps): card coord-decision-gate-app-repos, section 6 items 2 to 4.
 * Every path is in one temp folder: the registry (LANE_REGISTRY_PATH), the decision store (CCV3_DECISIONS_FILE) and the router
 * config (one copy above the repos, read from each repo upward; one under the gate's home, which is the temp folder too: deps()), so the
 * real home config is never read. Nothing in a payload runs.
 *
 * Folders: X and Y are covered app repos with the SAME branch, tree and head (fixed commit dates); WT is a worktree of X; X/nested is a
 * repo of its own with an inactive entry; OLD is inactive, OFF has tapGate off, STRAY is not registered; CC is a CCv3 checkout whose
 * entry is continuous-claude, and CC/plain is a plain repo inside it.
 *
 * Each case names the source change that turns it red:
 *   K1 a tap for X licenses Y (same branch, tree, head, PR)                 -> a constant key repo
 *   K2 two open offers on one branch (CCv3 and covered): a tap records into the other key -> a key without the repo
 *   W1 a worktree of a covered root is not judged                           -> drop the --git-common-dir main root
 *   N1 an inactive nested repo, OLD, OFF, STRAY or CC/plain is judged      -> skip a coverage reason
 *   D1 the real Deps ignores LANE_REGISTRY_PATH (reads the home mirror)    -> realDeps without the registry field, or a fixed path
 *   U1 @{push} is not read, or a push with no remote is judged on a guess  -> drop the @{push} lookup
 *   F7 a push from inside <root>/.git passes untapped                      -> drop the --git-common-dir fallback in appPlace
 *      a bare live root passes untapped                                    -> return NOT_COVERED when no root can be read
 *   T1 the real Deps runs git after the 7 s deadline                       -> realDeps without the deadline, or makeGit ignores it
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decisionRecord, offerWrite } from '../shared/decisions-store.js';
import { handle as ledger } from '../decision-ledger.js';
import { decide, handle as gateHandle, realDeps } from '../decision-gate.js';

const CCV3 = 'https://github.com/Rev4nchist/continuous-claude-v3.git';
const FIXED = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@example.invalid', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@example.invalid' };
let home = '';
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['CCV3_DECISIONS_FILE', 'LANE_REGISTRY_PATH', 'CLAUDE_AGENT_ID'];
const R: Record<string, string> = {};
let head = '';
let tree = '';

const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...FIXED } });
/**
 * A remote whose remote HEAD names feat (refs/remotes/<n>/HEAD, as develop often is), so a push of feat is a default-branch push and needs
 * the tap (Dave 11-13, fixer E). Without it feat is no default branch and passes untapped, and these rows would test nothing.
 */
const addRemote = (d: string, n: string, u: string): void => {
  git(d, 'remote', 'add', n, u);
  git(d, 'symbolic-ref', `refs/remotes/${n}/HEAD`, `refs/remotes/${n}/feat`);
};
function makeRepo(d: string, remotes: Record<string, string>): string {
  mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  for (const [n, u] of Object.entries(remotes)) addRemote(d, n, u);
  git(d, 'commit', '-q', '--allow-empty', '-m', 'x');
  git(d, 'checkout', '-q', '-b', 'feat');
  return d;
}
const store = (): string => `${home}/decisions.json`;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'dg-app-git-')).replace(/\\/g, '/');
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.CLAUDE_AGENT_ID;
  process.env.CCV3_DECISIONS_FILE = store();
  // Two copies: the one above the repos (read from the cwd upward) and the home copy (a create or merge deny reads only that one).
  const cfg = JSON.stringify({ decisions: { enforce: true } });
  writeFileSync(`${home}/review-router.config.json`, cfg);
  mkdirSync(`${home}/continuous-claude`, { recursive: true });
  writeFileSync(`${home}/continuous-claude/review-router.config.json`, cfg);
  R.x = makeRepo(`${home}/app-x`, { up: 'https://github.com/acme/app-x.git' });
  R.y = makeRepo(`${home}/app-y`, { up: 'https://github.com/acme/app-y.git' });
  R.nested = makeRepo(`${home}/app-x/nested`, { up: 'https://github.com/acme/nested.git' });
  R.old = makeRepo(`${home}/old-app`, { up: 'https://github.com/acme/old-app.git' });
  R.off = makeRepo(`${home}/off-app`, { up: 'https://github.com/acme/off-app.git' });
  R.stray = makeRepo(`${home}/stray`, { up: 'https://github.com/acme/stray.git' });
  R.cc = makeRepo(`${home}/cc`, { fork: CCV3 });
  R.plain = makeRepo(`${home}/cc/plain`, { up: 'https://github.com/acme/plain.git' });
  R.wt = `${home}/wt-x`;
  git(R.x, 'worktree', 'add', '-q', '-b', 'wtb', R.wt);
  R.bare = `${home}/bare-app.git`;
  git(home, 'init', '-q', '--bare', '-b', 'feat', R.bare);
  addRemote(R.bare, 'up', 'https://github.com/acme/bare-app.git');
  head = git(R.x, 'rev-parse', 'feat').stdout.trim();
  tree = git(R.x, 'rev-parse', 'feat^{tree}').stdout.trim();
  const projects = [
    { key: 'app-x', path: R.x }, { key: 'app-y', path: R.y }, { key: 'nested', path: R.nested, status: 'inactive' },
    { key: 'old-app', path: R.old, status: 'inactive' }, { key: 'off-app', path: R.off, tapGate: 'off' }, { key: 'continuous-claude', path: R.cc },
    { key: 'bare-app', path: R.bare },
  ];
  writeFileSync(`${home}/project-registry.json`, JSON.stringify({ projects }));
  process.env.LANE_REGISTRY_PATH = `${home}/project-registry.json`;
  // Builds several real git repos: under full-suite load this passed the 10 s default hook timeout (2026-11-13).
}, 120_000);
afterAll(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(home, { recursive: true, force: true });
});

const bash = (cwd: string, command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: 's-app-git', ...extra });
/** The real Deps with the temp folder as home, so the gate never reads the developer's home config (absent on a CI runner). */
const deps = (opts?: Parameters<typeof realDeps>[0]) => ({ ...realDeps(opts), home });
const verdict = (input: object): string => {
  const d = decide(input, deps());
  return d.action === 'deny' ? `deny:${d.pattern}` : d.warn ? `warn:${d.warn.split(':')[0]}` : 'allow';
};
const handleGate = (input: object): string => gateHandle(JSON.stringify(input), deps());
const clearStore = (): void => { rmSync(store(), { force: true }); };
const tapShip = (key: string): void => {
  expect(offerWrite({ step: 'ship', key, head, tree, spec: { header: 'T', question: `Q ${key}?`, options: [{ label: 'Commit and push' }, { label: 'Stop here' }] } }).ok).toBe(true);
  expect(decisionRecord({ step: 'ship', key, head, label: 'Commit and push' })).toEqual({ ok: true });
};

describe('D1 the real Deps reads the registry at LANE_REGISTRY_PATH', () => {
  it('the registry field reads that file', () => {
    const reg = realDeps().tapScope!.registry();
    expect(reg.state).toBe('ok');
    expect(reg.file.replace(/\\/g, '/')).toBe(`${home}/project-registry.json`);
    expect(reg.entries.map((e) => e.key)).toContain('app-x');
  });
  it('a covered push is denied; with LANE_REGISTRY_PATH at a missing file it passes (registry missing = not covered)', () => {
    clearStore();
    expect(verdict(bash(R.x, 'git push up feat'))).toBe('deny:ship');
    process.env.LANE_REGISTRY_PATH = `${home}/missing-registry.json`;
    try {
      expect(verdict(bash(R.x, 'git push up feat'))).toBe('allow');
    } finally {
      process.env.LANE_REGISTRY_PATH = `${home}/project-registry.json`;
    }
  });
  it('a corrupt registry passes with one warning line', () => {
    writeFileSync(`${home}/bad-registry.json`, '{"projects": 3}');
    process.env.LANE_REGISTRY_PATH = `${home}/bad-registry.json`;
    try {
      const out = JSON.parse(handleGate(bash(R.x, 'git push up feat')));
      expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
      expect(out.hookSpecificOutput.additionalContext).toContain('bad-registry.json');
    } finally {
      process.env.LANE_REGISTRY_PATH = `${home}/project-registry.json`;
    }
  });
});

describe('K1 K2 the key: X and Y share branch, tree and head; only the repo in the key separates them', () => {
  it('X and Y have the same head and tree (the precondition of this test)', () => {
    expect(git(R.y, 'rev-parse', 'feat').stdout.trim()).toBe(head);
    expect(git(R.y, 'rev-parse', 'feat^{tree}').stdout.trim()).toBe(tree);
  });
  it('a ship, open-pr and land tap for X licenses X only', () => {
    clearStore();
    tapShip('acme/app-x@feat');
    expect(offerWrite({ step: 'open-pr', key: 'acme/app-x@feat', head, spec: { header: 'T', question: 'Q?', options: [{ label: 'Open draft PR' }, { label: 'Stop here' }] } }).ok).toBe(true);
    expect(decisionRecord({ step: 'open-pr', key: 'acme/app-x@feat', head, label: 'Open draft PR' })).toEqual({ ok: true });
    expect(offerWrite({ step: 'land', key: 'acme/app-x#7', head, spec: { header: 'T', question: 'Q?', options: [{ label: 'Merge now (no READY check)' }, { label: 'Stop here' }] } }).ok).toBe(true);
    expect(decisionRecord({ step: 'land', key: 'acme/app-x#7', head, label: 'Merge now (no READY check)' })).toEqual({ ok: true });
    const create = 'gh pr create --draft --title t --body-file b.md';
    const merge = `gh pr merge 7 --squash --match-head-commit ${head}`;
    expect([verdict(bash(R.x, 'git push up feat')), verdict(bash(R.x, create)), verdict(bash(R.x, merge))]).toEqual(['allow', 'allow', 'allow']);
    expect([verdict(bash(R.y, 'git push up feat')), verdict(bash(R.y, create)), verdict(bash(R.y, merge))]).toEqual(['deny:ship', 'deny:open-pr', 'deny:land']);
  });
  it('two open offers on branch feat, one CCv3 and one covered: each tap through the real ledger records only its own key', () => {
    clearStore();
    const spec = (header: string, question: string) => ({ header, question, options: [{ label: 'Commit and push' }, { label: 'Stop here' }] });
    const ccv3 = spec('Ship', 'Commit and push feat?');
    const app = spec('App ship', 'Commit and push feat of acme/app-x?');
    expect(offerWrite({ step: 'ship', key: 'Rev4nchist/Continuous-Claude-v3@feat', head, tree, spec: ccv3 }).ok).toBe(true);
    expect(offerWrite({ step: 'ship', key: 'acme/app-x@feat', head, tree, spec: app }).ok).toBe(true);
    const answer = (q: typeof app) => ledger(JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: { questions: [q] }, tool_response: { answers: { [q.question]: 'Commit and push' } } }));
    expect(answer(app)).toContain('acme/app-x@feat');
    expect(verdict(bash(R.x, 'git push up feat'))).toBe('allow');
    expect(verdict(bash(R.cc, 'git push fork feat'))).toBe('warn:ship');
    expect(answer(ccv3)).toContain('Rev4nchist/Continuous-Claude-v3@feat');
    expect(verdict(bash(R.cc, 'git push fork feat'))).toBe('allow');
    expect(verdict(bash(R.y, 'git push up feat'))).toBe('deny:ship');
  });
});

describe('W1 N1 coverage with real folders', () => {
  it('a worktree of a covered root is judged with the root repo key', () => {
    clearStore();
    // Fixer E: wtb is no default branch of up (its remote HEAD names feat), so the row pushes wtb to main, which needs the tap.
    expect(verdict(bash(R.wt, 'git push up wtb:main'))).toBe('deny:ship');
    tapShip('acme/app-x@main');
    expect(verdict(bash(R.wt, 'git push up wtb:main'))).toBe('allow');
  });
  it('a subfolder of a covered root is judged', () => {
    clearStore();
    mkdirSync(`${R.x}/src`, { recursive: true });
    expect(verdict(bash(`${R.x}/src`, 'git push up feat'))).toBe('deny:ship');
  });
  for (const name of ['nested', 'old', 'off', 'stray', 'plain']) {
    it(`${name}: push, create and merge pass (not covered)`, () => {
      clearStore();
      for (const cmd of ['git push up feat', 'gh pr create --draft --title t', `gh pr merge 7 --match-head-commit ${head}`]) expect(verdict(bash(R[name], cmd)), `${name}: ${cmd}`).toBe('allow');
    });
  }
  it('position unknown before a push in a covered folder is denied; in STRAY it passes', () => {
    expect(verdict(bash(R.x, 'popd && git push up feat'))).toBe('deny:position-unknown');
    expect(verdict(bash(R.stray, 'popd && git push up feat'))).toBe('allow');
  });
});

describe('U1 remotes with real git', () => {
  it('two remotes: the key is the repo of the remote the push names; no remote and no @{push} is denied', () => {
    clearStore();
    addRemote(R.x, 'mirror', 'https://github.com/acme/app-x-mirror.git');
    try {
      tapShip('acme/app-x@feat');
      expect(verdict(bash(R.x, 'git push up feat'))).toBe('allow');
      expect(verdict(bash(R.x, 'git push mirror feat'))).toBe('deny:ship');
      expect(verdict(bash(R.x, 'git push'))).toBe('deny:push-remote-unresolved');
    } finally {
      git(R.x, 'remote', 'remove', 'mirror');
    }
  });
  it('no remote named: @{push} names it (upstream set with no network)', () => {
    clearStore();
    tapShip('acme/app-x@feat');
    git(R.x, 'update-ref', 'refs/remotes/up/feat', 'HEAD');
    git(R.x, 'config', 'branch.feat.remote', 'up');
    git(R.x, 'config', 'branch.feat.merge', 'refs/heads/feat');
    try {
      expect(git(R.x, 'rev-parse', '--abbrev-ref', '@{push}').stdout.trim()).toBe('up/feat');
      expect(verdict(bash(R.x, 'git push'))).toBe('allow');
    } finally {
      git(R.x, 'config', '--unset', 'branch.feat.remote');
      git(R.x, 'config', '--unset', 'branch.feat.merge');
    }
  });
  it('F7: a push from inside the .git folder of a covered repo is judged (git -C <root>/.git, cd <root>/.git)', () => {
    clearStore();
    // Quoted: the temp folder may hold a space.
    expect(verdict(bash(R.stray, `git -C '${R.x}/.git' push up feat`))).toBe('deny:ship');
    expect(verdict(bash(R.stray, `cd '${R.x}/.git' && git push up feat`))).toBe('deny:ship');
    expect(verdict(bash(`${R.x}/.git`, 'git push up feat'))).toBe('deny:ship');
    tapShip('acme/app-x@feat');
    expect(verdict(bash(`${R.x}/.git`, 'git push up feat'))).toBe('allow');
  });
  it('F7: a live root whose common dir is not <root>/.git (a bare repo) cannot be judged: denied, scope app-push', () => {
    clearStore();
    const out = JSON.parse(handleGate(bash(R.bare, 'git push up feat')));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("could not verify Dave's tap");
  });
  it('item 5: the real Deps stops git at 7 s from the hook start: a late call is denied unjudgeable, not run', () => {
    clearStore();
    tapShip('acme/app-x@feat');
    const late = gateHandle(JSON.stringify(bash(R.x, 'git push up feat')), deps({ start: Date.now() - 8000 }));
    const out = JSON.parse(late);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/time limit/);
    expect(verdict(bash(R.x, 'git push up feat'))).toBe('allow');
  });
  it('a push of main needs a tap; a force push and a subagent push are denied', () => {
    clearStore();
    expect(verdict(bash(R.x, 'git push up main'))).toBe('deny:ship');
    tapShip('acme/app-x@feat');
    expect(verdict(bash(R.x, 'git push --force up feat'))).toBe('deny:push-unsafe');
    expect(verdict(bash(R.x, 'git push up feat', { agent_id: 'sub' }))).toBe('deny:subagent');
  });
});

