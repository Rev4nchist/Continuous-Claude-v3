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

/** main: the text of fork/main's config, localMain: the committed local branch main, primary: the primary checkout's WORKING TREE file (served on purpose: the hook must never read it). */
// Full ref names (fail-closed fix): an abbreviated fork/main can be shadowed by a local branch or a tag.
const FORK_REF = 'refs/remotes/fork/main';
const LOCAL_REF = 'refs/heads/main';
/** forkRef / localRef: the ref exists even when its text is null (a ref that exists and whose show fails). Default: the ref exists when its text is given. */
interface Setup { branch: string; main?: string | null; localMain?: string | null; primary?: string | null; calls?: string[]; forkRef?: boolean; localRef?: boolean }
function deps({ branch, main = null, localMain = null, primary = null, calls = [], forkRef = main !== null, localRef = localMain !== null }: Setup): Deps {
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
      if (key === `rev-parse --verify --quiet ${FORK_REF}`) return { status: forkRef ? 0 : 1, stdout: '' };
      if (key === `rev-parse --verify --quiet ${LOCAL_REF}`) return { status: localRef ? 0 : 1, stdout: '' };
      if (key === `show ${FORK_REF}:review-router.config.json`) return main === null ? { status: 128, stdout: '' } : { status: 0, stdout: main };
      if (key === `show ${LOCAL_REF}:review-router.config.json`) return localMain === null ? { status: 128, stdout: '' } : { status: 0, stdout: localMain };
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
  it('A5a: no fork/main ref, the committed local main enforces: the local main is the main side', () => {
    expect(act({ branch: cfg(false), main: null, localMain: cfg(true) }).action).toBe('deny');
  });
  it('A5e: the primary working-tree file says false and the local main says true: enforce (the working tree is never read)', () => {
    expect(act({ branch: cfg(false), main: null, localMain: cfg(true), primary: cfg(false) }).action).toBe('deny');
  });
  it('A5f: the primary working-tree file says true and both refs are missing: still enforce, from the missing main side, not from that file', () => {
    const calls: string[] = [];
    act({ branch: cfg(false), main: null, localMain: null, primary: cfg(true), calls });
    expect(calls.filter((c) => c === 'rev-parse --git-common-dir')).toEqual([]);
  });
  it('A5b: neither ref is readable: enforce', () => {
    expect(act({ branch: cfg(false), main: null, localMain: null }).action).toBe('deny');
  });
  it('A5d: a missing branch config still fails closed as before (the caller decides)', () => {
    expect(act({ branch: null as unknown as string, main: cfg(false) }).action).toBe('deny');
  });
  it('A10: the main read runs no git fetch, pull or remote update', () => {
    const calls: string[] = [];
    act({ branch: cfg(false), main: cfg(true), calls });
    expect(calls.some((c) => c.startsWith(`show ${FORK_REF}:`))).toBe(true);
    expect(calls.filter((c) => /^(fetch|pull|remote update)\b/.test(c))).toEqual([]);
  });
  it('B1 (finding 2): a main-side enforce that is present and not false ("true", null, 0, an object) counts as true: the deny stays', () => {
    for (const v of ['true', null, 0, {}]) expect(act({ branch: cfg(false), main: cfg(v) }).action, String(v)).toBe('deny');
  });
  it('B1e: control: a main checkpoint with no enforce key and a branch false is warn mode, allowed', () => {
    expect(act({ branch: cfg(false), main: JSON.stringify({ checkpoint: {} }) }).action).toBe('allow');
  });
  it('A15 (finding 1): the main read uses the full ref names, never fork/main or main alone', () => {
    const calls: string[] = [];
    act({ branch: cfg(false), main: null, localMain: cfg(true), calls });
    expect(calls).toContain(`rev-parse --verify --quiet ${FORK_REF}`);
    expect(calls).toContain(`show ${LOCAL_REF}:review-router.config.json`);
    expect(calls.filter((c) => /^show (fork\/main|main):/.test(c) || /^rev-parse --verify --quiet (fork\/main|main)$/.test(c))).toEqual([]);
  });
  it('A5a3 (finding 3): fork/main exists and its text is not JSON, the local main says false: the deny stays (strict, no fallback)', () => {
    expect(act({ branch: cfg(false), main: '{not json', localMain: cfg(false) }).action).toBe('deny');
  });
  it('A5a4 (finding 3): fork/main exists, git show fails, the local main says false: the deny stays', () => {
    expect(act({ branch: cfg(false), main: null, forkRef: true, localMain: cfg(false) }).action).toBe('deny');
  });
  it('A5a6: fork/main is absent, the local main exists and is not JSON: the deny stays', () => {
    expect(act({ branch: cfg(false), main: null, localMain: '{not json' }).action).toBe('deny');
  });
  it('A5a7: control: fork/main is absent and the local main is a good false: warn mode, allowed', () => {
    expect(act({ branch: cfg(false), main: null, localMain: cfg(false) }).action).toBe('allow');
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
  function repoWith(mainEnforce: boolean, branchEnforce: boolean, forkRef = true): string {
    const dir = mkdtempSync(join(tmpdir(), 'stricter-hook-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.invalid');
    git(dir, 'config', 'user.name', 't');
    writeFileSync(join(dir, 'review-router.config.json'), cfg(mainEnforce));
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'main');
    git(dir, 'remote', 'add', 'fork', 'https://github.com/Rev4nchist/Continuous-Claude-v3.git');
    if (forkRef) git(dir, 'update-ref', 'refs/remotes/fork/main', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'feat/x');
    writeFileSync(join(dir, 'review-router.config.json'), cfg(branchEnforce));
    git(dir, 'commit', '-q', '--allow-empty', '-am', 'branch');
    const head = git(dir, 'rev-parse', 'HEAD');
    mkdirSync(join(dir, dirname(STAMP_REL)), { recursive: true });
    writeFileSync(join(dir, STAMP_REL), JSON.stringify({ head, branch: 'feat/x', at: new Date().toISOString(), body_sha256: sha256(BODY), results: [] }));
    return dir;
  }
  /** The hook's JSON answer. A failed hook (a non-zero exit, a spawn error or output that is not JSON) is a test failure, never an allow. */
  const run = (dir: string): { permissionDecision?: string } => {
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: READY }, cwd: dir, session_id: 's-stricter' });
    // The built hook does not run under VITEST (its auto-run test), and a probe sets its own log file (guard-log.ts).
    const env: NodeJS.ProcessEnv = { ...process.env, CCV3_GUARD_DECISIONS_LOG: join(dir, 'guard.jsonl') };
    delete env.VITEST;
    const r = spawnSync('node', [DIST], { input: payload, encoding: 'utf8', windowsHide: true, env });
    expect(r.error, 'the hook did not start').toBeUndefined();
    expect(r.status, `exit code; stderr: ${r.stderr}`).toBe(0);
    const parsed = JSON.parse(r.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
    return parsed.hookSpecificOutput ?? {};
  };
  const denied = (dir: string): boolean => run(dir).permissionDecision === 'deny';
  /** A deny must carry a reason: an empty object is not a deny. */
  const allowed = (dir: string): boolean => Object.keys(run(dir)).length === 0;

  /** A repo with a local main, an optional fork/main remote-tracking ref holding its own text, and an optional LOCAL BRANCH named fork/main (the shadow). */
  function repoRefs(o: { mainText: string; forkText?: string; shadowText?: string; branchText: string }): string {
    const dir = mkdtempSync(join(tmpdir(), 'stricter-refs-'));
    const put = (text: string, msg: string) => { writeFileSync(join(dir, 'review-router.config.json'), text); git(dir, 'add', '.'); git(dir, 'commit', '-q', '--allow-empty', '-m', msg); };
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.invalid');
    git(dir, 'config', 'user.name', 't');
    put(o.mainText, 'main');
    const mainSha = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'remote', 'add', 'fork', 'https://github.com/Rev4nchist/Continuous-Claude-v3.git');
    if (o.forkText !== undefined) {
      git(dir, 'checkout', '-q', '-b', 'forktmp'); put(o.forkText, 'fork');
      git(dir, 'update-ref', 'refs/remotes/fork/main', 'HEAD');
      git(dir, 'checkout', '-q', 'main'); git(dir, 'branch', '-q', '-D', 'forktmp');
    }
    if (o.shadowText !== undefined) {
      git(dir, 'checkout', '-q', '-b', 'shadowtmp'); put(o.shadowText, 'shadow');
      git(dir, 'branch', 'fork/main', 'HEAD');
      git(dir, 'checkout', '-q', 'main'); git(dir, 'branch', '-q', '-D', 'shadowtmp');
    }
    git(dir, 'checkout', '-q', '-b', 'feat/x', mainSha);
    put(o.branchText, 'branch');
    const head = git(dir, 'rev-parse', 'HEAD');
    mkdirSync(join(dir, dirname(STAMP_REL)), { recursive: true });
    writeFileSync(join(dir, STAMP_REL), JSON.stringify({ head, branch: 'feat/x', at: new Date().toISOString(), body_sha256: sha256(BODY), results: [] }));
    return dir;
  }

  it('the dist file exists', () => { expect(existsSync(DIST)).toBe(true); });
  it('A15 built (finding 1): a LOCAL BRANCH named fork/main with enforce false does not shadow the remote ref: deny stays', () => {
    expect(denied(repoRefs({ mainText: cfg(true), forkText: cfg(true), shadowText: cfg(false), branchText: cfg(false) }))).toBe(true);
  });
  it('A5a3 built (finding 3): fork/main holds text that is not JSON, the local main says false: deny stays', () => {
    expect(denied(repoRefs({ mainText: cfg(false), forkText: '{not json', branchText: cfg(false) }))).toBe(true);
  });
  it('B1 built (finding 2): fork/main enforce is the string "true", the branch says false: deny stays', () => {
    expect(denied(repoRefs({ mainText: cfg(false), forkText: cfg('true'), branchText: cfg(false) }))).toBe(true);
  });
  it('control built: fork/main absent, the local main is a good false, the branch false: allowed', () => {
    expect(allowed(repoRefs({ mainText: cfg(false), branchText: cfg(false) }))).toBe(true);
  });
  it('deny stays', () => { expect(denied(repoWith(true, false))).toBe(true); });
  it('A5e built: no fork/main ref, the committed local main enforces, the branch says false: deny stays', () => { expect(denied(repoWith(true, false, false))).toBe(true); });
  it('control: main false, branch true still denies', () => { expect(denied(repoWith(false, true))).toBe(true); });
  it('control: main false, branch false is warn mode, allowed ({})', () => { expect(allowed(repoWith(false, false))).toBe(true); });
});
