/**
 * coord-cap-override, PR A: the pre-pr-gate hook reads checkpoint.enforce as the stricter of fork/main and the checkout.
 * Failure list (each is a test below, each fails on main before the change):
 *   (A7, the twin against the .mjs helper and the fixture, is in config-stricter-twin.test.ts)
 *   - main enforces, the branch config says false: the hook warns           -> A8
 *   - main false, branch true: still enforces (control)                     -> A2
 *   - no main side at all (no ref, no primary file): enforce               -> A5b
 *   - the main read runs a fetch                                            -> A10
 *   - the built hook, a real repo, branch false, main true: deny stays      -> A8b
 * Rows of the stricter rule: scripts/github/fixtures/stricter-config-cases.json (shared with scripts/github/config-stricter.test.mjs).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decide, STAMP_REL, type Deps } from '../pre-pr-gate.js';

// ---- the hook: decide() with a git stub that serves a fork/main config ----
const NOW = Date.parse('2026-10-27T12:00:00Z');
const HEAD = 'a'.repeat(40);
const ROOT = '/work/ccv3';
const CONFIG_FILE = join(ROOT, 'review-router.config.json');
const CCV3_REMOTES = 'fork\thttps://github.com/Rev4nchist/Continuous-Claude-v3.git (fetch)\nfork\thttps://github.com/Rev4nchist/Continuous-Claude-v3.git (push)\n';
const BODY = 'default body\n';
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
const READY = 'gh pr ready 201';
const cfg = (enforce: unknown) => JSON.stringify({ checkpoint: { enforce } });

interface Setup { branch: string; main?: string | null; primary?: string | null; calls?: string[] }
function deps({ branch, main = null, primary = null, calls = [] }: Setup): Deps {
  const stamp = JSON.stringify({ head: HEAD, branch: 'feat/x', at: new Date(NOW - 3_600_000).toISOString(), body_sha256: sha256(BODY), results: [] });
  return {
    git: (cwd, args) => {
      const key = args.join(' ');
      calls.push(key);
      if (key === 'rev-parse --show-toplevel') return { status: 0, stdout: `${cwd}\n` };
      if (key === 'remote -v') return { status: 0, stdout: CCV3_REMOTES };
      if (key === 'worktree list --porcelain') return { status: 0, stdout: '' };
      if (key === 'rev-parse HEAD') return { status: 0, stdout: `${HEAD}\n` };
      if (key === 'branch --show-current') return { status: 0, stdout: 'feat/x\n' };
      if (key === 'show fork/main:review-router.config.json') return main === null ? { status: 128, stdout: '' } : { status: 0, stdout: main };
      if (key === 'rev-parse --git-common-dir') return { status: 0, stdout: '/primary/.git\n' };
      if (args[0] === 'rev-parse' && args[1]?.endsWith('^{commit}')) return { status: 0, stdout: `${HEAD}\n` };
      return { status: 1, stdout: '' };
    },
    readFile: (p) => {
      if (p === CONFIG_FILE) return branch;
      if (p === join(ROOT, STAMP_REL)) return stamp;
      if (p === resolve('/primary', 'review-router.config.json')) return primary;
      return null;
    },
    now: () => NOW,
    env: {},
  };
}
const act = (s: Setup) => decide({ tool_name: 'Bash', tool_input: { command: READY }, cwd: ROOT }, deps(s));

describe('the hook reads the stricter checkpoint.enforce', () => {
  it('A8: main enforces and the branch config says false: the deny stays', () => {
    expect(act({ branch: cfg(false), main: cfg(true) }).action).toBe('deny');
  });
  it('A2: main false and branch true: still enforces (control)', () => {
    expect(act({ branch: cfg(true), main: cfg(false) }).action).toBe('deny');
  });
  it('A2b: main false and branch false: warn mode, the command is allowed (control)', () => {
    expect(act({ branch: cfg(false), main: cfg(false) }).action).toBe('allow');
  });
  it('A11: a branch enforce that is the string "false", null or 0 counts as true', () => {
    for (const v of ['false', null, 0]) expect(act({ branch: cfg(v), main: cfg(false) }).action, String(v)).toBe('deny');
  });
  it('A12: the branch deletes the key: main true stays', () => {
    expect(act({ branch: JSON.stringify({ checkpoint: {} }), main: cfg(true) }).action).toBe('deny');
  });
  it('A5a: no fork/main ref, the primary checkout file enforces: the primary value is the main side', () => {
    expect(act({ branch: cfg(false), main: null, primary: cfg(true) }).action).toBe('deny');
  });
  it('A5b: no fork/main ref and no primary file: enforce', () => {
    expect(act({ branch: cfg(false), main: null, primary: null }).action).toBe('deny');
  });
  it('A5d: a missing branch config still fails closed as before (the caller decides)', () => {
    expect(act({ branch: null as unknown as string, main: cfg(false) }).action).toBe('deny');
  });
  it('A10: the main read runs no git fetch, pull or remote update', () => {
    const calls: string[] = [];
    act({ branch: cfg(false), main: cfg(true), calls });
    expect(calls.some((c) => c.startsWith('show fork/main:'))).toBe(true);
    expect(calls.filter((c) => /^(fetch|pull|remote update)\b/.test(c))).toEqual([]);
  });
});

// ---- the built hook against a real repo ----
describe('A8b: the built hook, a real repo, branch enforce false, fork/main enforce true', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const REPO = resolve(HERE, '..', '..', '..', '..');
  const DIST = join(REPO, '.claude', 'hooks', 'dist', 'pre-pr-gate.mjs');
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  function repoWith(mainEnforce: boolean, branchEnforce: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'stricter-hook-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.invalid');
    git(dir, 'config', 'user.name', 't');
    writeFileSync(join(dir, 'review-router.config.json'), cfg(mainEnforce));
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'main');
    git(dir, 'remote', 'add', 'fork', 'https://github.com/Rev4nchist/Continuous-Claude-v3.git');
    git(dir, 'update-ref', 'refs/remotes/fork/main', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'feat/x');
    writeFileSync(join(dir, 'review-router.config.json'), cfg(branchEnforce));
    git(dir, 'commit', '-q', '--allow-empty', '-am', 'branch');
    const head = git(dir, 'rev-parse', 'HEAD');
    mkdirSync(join(dir, dirname(STAMP_REL)), { recursive: true });
    writeFileSync(join(dir, STAMP_REL), JSON.stringify({ head, branch: 'feat/x', at: new Date().toISOString(), body_sha256: sha256(BODY), results: [] }));
    return dir;
  }
  const run = (dir: string): string => {
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: READY }, cwd: dir, session_id: 's-stricter' });
    // The built hook does not run under VITEST (its auto-run test), and a probe sets its own log file (guard-log.ts).
    const env: NodeJS.ProcessEnv = { ...process.env, CCV3_GUARD_DECISIONS_LOG: join(dir, 'guard.jsonl') };
    delete env.VITEST;
    const r = spawnSync('node', [DIST], { input: payload, encoding: 'utf8', windowsHide: true, env });
    return r.stdout;
  };
  const verdict = (out: string): string => (JSON.parse(out || '{}').hookSpecificOutput?.permissionDecision as string | undefined) ?? 'allow';

  it('the dist file exists', () => { expect(existsSync(DIST)).toBe(true); });
  it('deny stays', () => { expect(verdict(run(repoWith(true, false)))).toBe('deny'); });
  it('control: main false, branch true still denies', () => { expect(verdict(run(repoWith(false, true)))).toBe('deny'); });
  it('control: main false, branch false is warn mode, allowed', () => { expect(verdict(run(repoWith(false, false)))).toBe('allow'); });
});
