/**
 * coderabbit-guard: no `cr review` may start on a diff that holds an answer-key path.
 * Every case runs the real decide() against a temp git repo. Only the "check throws" case mocks the lib.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const hoisted = vi.hoisted(() => ({ throwNow: false }));

// A cast, not importOriginal<typeof import('x')>(): the CI semgrep ratchet counts that form as a scan error.
vi.mock('../../../../scripts/github/lib/answer-paths.mjs', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const realCheck = real.answerKeyCheck as (input: unknown) => unknown;
  return {
    ...real,
    answerKeyCheck: (input: unknown) => {
      if (hoisted.throwNow) throw new Error('boom');
      return realCheck(input);
    },
  };
});

import { decide, logDeny, readState } from '../coderabbit-guard.js';

// The env key stays non-CCv3 in every case: the check must come from the git remotes, never from the cap key.
const NOT_CCV3_KEY = 'x#feature';
const CCV3_URL = 'https://github.com/Rev4nchist/Continuous-Claude-v3.git';
const OTHER_URL = 'https://github.com/someone/other-repo.git';
const GOLD = 'scripts/eval/review-eval/gold/case-a.json';
const GOLD_DIR = 'scripts/eval/review-eval/gold';
const ALL_GLOBS = [
  'scripts/eval/review-eval/gold/**',
  'scripts/eval/review-eval/seeds/**',
  'scripts/eval/review-eval/rubrics/**',
  'scripts/eval/review-eval/linktype-labels.json',
];

const reviewMd = (globs: string[]) => `# Review rules\n\n## Skip paths\n\n\`\`\`\n${globs.join('\n')}\n\`\`\`\n\n## Other\n\nText.\n`;

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function put(root: string, rel: string, text: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function commit(root: string, msg: string): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', msg]);
  return git(root, ['rev-parse', 'HEAD']);
}

interface Fixture {
  root: string;
  base: string;
  env: NodeJS.ProcessEnv;
  top: string;
  run: (command?: string, opts?: { key?: string; cwd?: string }) => ReturnType<typeof decide>;
}

let dirs: string[] = [];

/** A repo with main and refs/remotes/fork/main at one base commit (REVIEW.md with `globs`, one seed file), then branch `feature`. */
function makeRepo(opts: { globs?: string[]; baseFiles?: Record<string, string>; remote?: string | null } = {}): Fixture {
  const top = mkdtempSync(join(tmpdir(), 'cr-ak-'));
  dirs.push(top);
  const root = join(top, 'repo');
  mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  if (opts.remote !== null) git(root, ['remote', 'add', 'fork', opts.remote ?? CCV3_URL]);
  put(root, 'REVIEW.md', reviewMd(opts.globs ?? ALL_GLOBS));
  put(root, 'src/app.ts', 'export const a = 1;\n');
  for (const [rel, text] of Object.entries(opts.baseFiles ?? {})) put(root, rel, text);
  const base = commit(root, 'base');
  git(root, ['update-ref', 'refs/remotes/fork/main', base]);
  git(root, ['checkout', '-q', '-b', 'feature']);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CCV3_CODERABBIT_GUARD_STATE: join(top, 'state.json'),
    CCV3_CODERABBIT_GUARD_KEY: NOT_CCV3_KEY,
  };
  // A fresh run counter for every call: a deny from the run cap must never look like a deny from the answer-key check.
  const run = (command = 'cr review --agent', o: { key?: string; cwd?: string } = {}) => {
    rmSync(env.CCV3_CODERABBIT_GUARD_STATE as string, { force: true });
    return decide({ tool_name: 'Bash', cwd: o.cwd ?? root, tool_input: { command } }, { ...env, CCV3_CODERABBIT_GUARD_KEY: o.key ?? NOT_CCV3_KEY });
  };
  return { root, top, base, env, run };
}

beforeEach(() => {
  hoisted.throwNow = false;
});

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('coderabbit-guard answer-key check', () => {
  it('1 denies when the diff holds a gold path', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    const r = f.run();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('answer-key');
  });

  it('2 denies when a file moves out of gold/ (the old path counts: --no-renames)', () => {
    const f = makeRepo({ baseFiles: { [GOLD]: '{"same":"content for rename detection","n":1}\n' } });
    mkdirSync(join(f.root, 'docs'));
    git(f.root, ['mv', GOLD, 'docs/moved-case.json']);
    commit(f.root, 'move out');
    const r = f.run();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('answer-key');
    expect(r.reason).toContain('(1)');
  });

  it('3 denies when REVIEW.md lacks one of the four globs (a closed check)', () => {
    const f = makeRepo({ globs: ALL_GLOBS.slice(0, 3) });
    put(f.root, 'src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'clean change');
    const r = f.run();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('answer-key');
  });

  it('4 denies when the fork/main ref is missing, and when main is missing', () => {
    const f = makeRepo();
    put(f.root, 'src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'clean change');
    git(f.root, ['update-ref', '-d', 'refs/remotes/fork/main']);
    const noFork = f.run();
    expect(noFork.allow).toBe(false);
    expect(noFork.reason).toContain('answer-key');
    git(f.root, ['update-ref', 'refs/remotes/fork/main', f.base]);
    git(f.root, ['branch', '-m', 'main', 'renamed-main']);
    const noMain = f.run();
    expect(noMain.allow).toBe(false);
    expect(noMain.reason).toContain('answer-key');
  });

  it('5 denies a path that is only in fork/main...HEAD (local main already holds it)', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    const head = commit(f.root, 'add gold');
    git(f.root, ['update-ref', 'refs/heads/main', head]);
    expect(git(f.root, ['diff', '--name-only', 'main...HEAD'])).toBe('');
    const r = f.run();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('answer-key');
  });

  it('6 denies when the check throws (the outer catch of the hook would allow)', () => {
    const f = makeRepo();
    put(f.root, 'src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'clean change');
    expect(f.run().allow).toBe(true);
    hoisted.throwNow = true;
    const r = f.run();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('answer-key');
    expect(r.reason).not.toContain('boom');
  });

  it('7 denies bash -c "cr review --agent" with a gold path in the diff', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    const r = f.run('bash -c "cr review --agent"');
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('answer-key');
  });

  it('8 allows a clean diff and still counts the run', () => {
    const f = makeRepo();
    put(f.root, 'src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'clean change');
    const r = f.run();
    expect(r.allow).toBe(true);
    expect(r.increment).toBe(true);
  });

  it('9 puts the count in the reason and never a path name', () => {
    const f = makeRepo();
    put(f.root, `${GOLD_DIR}/case-a.json`, '{}\n');
    put(f.root, `${GOLD_DIR}/case-b.json`, '{}\n');
    put(f.root, 'scripts/eval/review-eval/linktype-labels.json', '{}\n');
    commit(f.root, 'add three');
    const r = f.run();
    expect(r.allow).toBe(false);
    const reason = r.reason ?? '';
    expect(reason).toContain('answer-key');
    expect(reason).toContain('(3)');
    for (const leak of ['gold', 'case-a', 'case-b', 'linktype', 'review-eval', 'scripts/']) expect(reason).not.toContain(leak);
  });

  // ---- fix 1: CCv3 comes from the git remotes, never from the cap key ----

  it('10 checks a CCv3 repo whatever the env cap key says, and skips a repo with another remote', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    expect(f.run('cr review --agent', { key: NOT_CCV3_KEY }).allow).toBe(false);
    const other = makeRepo({ remote: OTHER_URL });
    put(other.root, GOLD, '{}\n');
    commit(other.root, 'add gold');
    const ccv3Key = 'github.com/rev4nchist/continuous-claude-v3#feature';
    expect(other.run('cr review --agent', { key: ccv3Key }).allow).toBe(true);
  });

  it('11 denies when the git config is broken (the remote read fails inside a repo)', () => {
    const f = makeRepo();
    put(f.root, 'src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'clean change');
    appendFileSync(join(f.root, '.git', 'config'), '\nthis line is not valid git config\n');
    const r = f.run();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('answer-key');
  });

  it('12 skips a folder that is not a git repo, and checks a repo with no remote (unknown, not another repo)', () => {
    const plain = mkdtempSync(join(tmpdir(), 'cr-nogit-'));
    dirs.push(plain);
    const f = makeRepo({ remote: null });
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    expect(f.run('cr review --agent', { cwd: plain }).allow).toBe(true);
    expect(f.run().allow).toBe(false);
  });

  // ---- fix 2: the working tree counts ----

  it('13 denies an untracked gold file', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    const r = f.run();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('(1)');
  });

  it('14 denies a staged gold file', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    git(f.root, ['add', '-A']);
    expect(f.run().allow).toBe(false);
  });

  it('15 denies an unstaged edit of a gold file that main already holds', () => {
    const f = makeRepo({ baseFiles: { [GOLD]: '{"n":1}\n' } });
    expect(f.run().allow).toBe(true);
    put(f.root, GOLD, '{"n":2}\n');
    expect(f.run().allow).toBe(false);
  });

  it('16 denies a staged rename out of gold/ (the old name counts)', () => {
    const f = makeRepo({ baseFiles: { [GOLD]: '{"same":"content for rename detection","n":1}\n' } });
    mkdirSync(join(f.root, 'docs'));
    git(f.root, ['mv', GOLD, 'docs/moved-case.json']);
    const r = f.run();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('(1)');
  });

  // ---- fix 3: CLI options ----

  /** main and fork/main sit at a commit that already holds gold; the branch adds one clean commit. `f.base` is the older commit. */
  function staleMainRepo(): Fixture {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    const withGold = commit(f.root, 'add gold');
    put(f.root, 'src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'clean change');
    git(f.root, ['update-ref', 'refs/heads/main', withGold]);
    git(f.root, ['update-ref', 'refs/remotes/fork/main', withGold]);
    return f;
  }

  it('17 --base: denies a base whose range holds gold, a base that does not resolve, and a missing value', () => {
    const f = staleMainRepo();
    expect(f.run('cr review --agent').allow).toBe(true);
    expect(f.run('cr review --agent --base HEAD~2').allow).toBe(false);
    expect(f.run('cr review --agent --base no-such-branch').allow).toBe(false);
    expect(f.run('cr review --agent --base').allow).toBe(false);
  });

  it('18 --base=value is read like --base value', () => {
    const f = staleMainRepo();
    expect(f.run('cr review --agent --base=HEAD~2').allow).toBe(false);
  });

  it('19 --base-commit: denies a commit whose range holds gold, and one that does not resolve', () => {
    const f = staleMainRepo();
    expect(f.run(`cr review --agent --base-commit ${f.base}`).allow).toBe(false);
    expect(f.run('cr review --agent --base-commit 0123456789abcdef0123456789abcdef01234567').allow).toBe(false);
  });

  it('20 --dir: checks that directory too (a second CCv3 repo with gold), from a clean repo and from a plain folder', () => {
    const clean = makeRepo();
    const second = makeRepo();
    put(second.root, GOLD, '{}\n');
    commit(second.root, 'add gold');
    const dir = second.root.replace(/\\/g, '/');
    expect(clean.run('cr review --agent').allow).toBe(true);
    expect(clean.run(`cr review --agent --dir ${dir}`).allow).toBe(false);
    const plain = mkdtempSync(join(tmpdir(), 'cr-nogit-'));
    dirs.push(plain);
    expect(clean.run(`cr review --agent --dir ${dir}`, { cwd: plain }).allow).toBe(false);
    expect(clean.run('cr review --agent --dir').allow).toBe(false);
  });

  it('21 -c and --config: deny an answer-key file and a file that does not exist; allow a clean file', () => {
    const f = makeRepo();
    put(f.top, GOLD, 'fake gold\n');
    put(f.top, 'notes/claude.md', 'rules\n');
    const abs = (p: string) => p.replace(/\\/g, '/');
    const fake = abs(join(f.top, GOLD));
    expect(f.run(`cr review --agent -c ${abs(join(f.top, 'notes/claude.md'))}`).allow).toBe(true);
    expect(f.run('cr review --agent -c REVIEW.md').allow).toBe(true);
    expect(f.run(`cr review --agent -c ${fake}`).allow).toBe(false);
    expect(f.run(`cr review --agent --config REVIEW.md ${fake}`).allow).toBe(false);
    expect(f.run(`cr review --agent --config=${fake}`).allow).toBe(false);
    expect(f.run('cr review --agent -c no-such-file.md').allow).toBe(false);
    expect(f.run('cr review --agent -c').allow).toBe(false);
  });

  it('22 --remote: denies a CCv3 repo name and a missing value, allows another repo', () => {
    const plain = mkdtempSync(join(tmpdir(), 'cr-nogit-'));
    dirs.push(plain);
    const f = makeRepo();
    const run = (c: string) => f.run(c, { cwd: plain });
    expect(run('cr review --agent --remote Rev4nchist/Continuous-Claude-v3 --base main --source-branch x').allow).toBe(false);
    expect(run('cr review --agent --remote=parcadei/continuous-claude --base main --source-branch x').allow).toBe(false);
    expect(run('cr review --agent --remote').allow).toBe(false);
    expect(run('cr review --agent --remote acme/app --base main --source-branch x').allow).toBe(true);
  });

  it('23 denies an option the parser cannot read (a raw-only hit), with no false hit on bash -c or --committed', () => {
    const f = makeRepo();
    put(f.root, 'src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'clean change');
    expect(f.run('watch -n 5 cr review --agent --base main').allow).toBe(false);
    expect(f.run('watch -n 5 cr review --agent --dir ..').allow).toBe(false);
    expect(f.run('watch -n 5 cr review --agent').allow).toBe(true);
    expect(f.run('bash -c "cr review --agent"').allow).toBe(true);
    expect(f.run('cr review --agent --committed').allow).toBe(true);
    expect(f.run('bash -c "cr review --agent --base main"').allow).toBe(true);
  });

  // ---- round 1 additions (seat review R1 to R7) ----

  it('24 R1: a local-path remote is unknown, so the check runs; a host-form remote of another repo is skipped', () => {
    const f = makeRepo({ remote: '../elsewhere/local-clone' });
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    expect(f.run().allow).toBe(false);
    const ssh = makeRepo({ remote: 'git@github.com:someone/other-repo.git' });
    put(ssh.root, GOLD, '{}\n');
    commit(ssh.root, 'add gold');
    expect(ssh.run().allow).toBe(true);
  });

  it('25 R1: denies a cd target it cannot read, a missing folder, a cd after the review, and a cd inside a wrapper string', () => {
    const f = makeRepo();
    const here = f.root.replace(/\\/g, '/');
    expect(f.run(`cd "${here}" && cr review --agent`).allow).toBe(true);
    for (const target of ['~/repo', '$HOME/repo', '%USERPROFILE%/repo']) expect(f.run(`cd ${target} && cr review --agent`).allow).toBe(false);
    expect(f.run(`cd "${here}/no-such-folder" && cr review --agent`).allow).toBe(false);
    expect(f.run(`cr review --agent && cd "${here}"`).allow).toBe(false);
    expect(f.run(`bash -c "cd '${here}' && cr review --agent"`).allow).toBe(false);
    expect(f.run('cd - && cr review --agent').allow).toBe(false);
    expect(f.run('cd && cr review --agent').allow).toBe(false);
  });

  it('26 R1: the cd of a PowerShell Push-Location is followed (into a repo with gold from a plain folder)', () => {
    const plain = mkdtempSync(join(tmpdir(), 'cr-nogit-'));
    dirs.push(plain);
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    const here = f.root.replace(/\\/g, '/');
    const input = (command: string, tool = 'PowerShell') => ({ tool_name: tool, cwd: plain, tool_input: { command } });
    expect(decide(input(`Push-Location "${here}"; cr review --agent`), f.env).allow).toBe(false);
    expect(decide(input(`cd "${here}" && cr review --agent`, 'Bash'), f.env).allow).toBe(false);
    expect(decide(input('cr review --agent', 'Bash'), f.env).allow).toBe(true);
    const clean = makeRepo();
    expect(decide(input(`Push-Location "${clean.root.replace(/\\/g, '/')}"; cr review --agent`), clean.env).allow).toBe(true);
  });

  it('27 R2: the override lifts the run cap only: a gold path is still denied, a clean diff passes', () => {
    const f = makeRepo();
    put(f.root, 'src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'clean change');
    expect(f.run('SKIP_CODERABBIT_GUARD=1 cr review --agent').allow).toBe(true);
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    const r = f.run('SKIP_CODERABBIT_GUARD=1 cr review --agent');
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('answer-key');
  });

  it('28 R3: an error in classify or in the folder step denies a review and lets a non-review command pass', () => {
    const f = makeRepo();
    const boom = () => {
      throw new Error('boom');
    };
    const input = (command: string) => ({ tool_name: 'Bash', cwd: f.root, tool_input: { command } });
    expect(decide(input('cr review --agent'), f.env, { classify: boom }).allow).toBe(false);
    expect(decide(input('git status'), f.env, { classify: boom }).allow).toBe(true);
    expect(decide(input('cr review --agent'), f.env, { cwdOf: boom }).allow).toBe(false);
    expect(decide(input('SKIP_CODERABBIT_GUARD=1 cr review --agent'), f.env, { classify: boom }).allow).toBe(false);
  });

  it('29 R4: a Task or Agent that carries a review command gets the same check', () => {
    const f = makeRepo();
    const input = (tool: string) => ({ tool_name: tool, cwd: f.root, tool_input: { command: 'cr review --agent', description: 'run a review' } });
    expect(decide(input('Agent'), f.env).allow).toBe(true);
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    expect(decide(input('Agent'), f.env).allow).toBe(false);
    expect(decide(input('Task'), f.env).allow).toBe(false);
  });

  it('30 R5: a tag named main does not hide the branch, and a file named like the range does not break the diff', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    const head = commit(f.root, 'add gold');
    git(f.root, ['update-ref', 'refs/remotes/fork/main', head]);
    git(f.root, ['tag', 'main', head]);
    expect(f.run().allow).toBe(false);
    const g = makeRepo();
    put(g.root, 'refs/heads/main...HEAD', 'a file that looks like a range\n');
    put(g.root, 'refs/remotes/fork/main...HEAD', 'another one\n');
    commit(g.root, 'odd file name');
    expect(g.run().allow).toBe(true);
  });

  it('31 R6: an answer-key deny writes a guard log line with the count and no command text', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    const input = { tool_name: 'Bash', session_id: 's31', cwd: f.root, tool_input: { command: `cd "${f.root.replace(/\\/g, '/')}" && cr review --agent` } };
    const result = decide(input, f.env);
    expect(result.allow).toBe(false);
    const log = join(f.top, 'guard.jsonl');
    logDeny(input, result, { ...f.env, CCV3_GUARD_DECISIONS_LOG: log });
    const line = readFileSync(log, 'utf8');
    expect(line).toContain('(1)');
    expect(line).not.toContain('"command"');
    expect(line).not.toContain('cr review');
    expect(line).not.toContain('gold');
  });

  it('32 R7: with no env key at all (the real key path) a CCv3 remote and a gold path deny', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    const env = { ...f.env };
    delete env.CCV3_CODERABBIT_GUARD_KEY;
    expect(decide({ tool_name: 'Bash', cwd: f.root, tool_input: { command: 'cr review --agent' } }, env).allow).toBe(false);
  });

  it('33 R7: denies when the git root is unknown inside a repo (a review started inside .git)', () => {
    const f = makeRepo();
    expect(f.run('cr review --agent', { cwd: join(f.root, '.git') }).allow).toBe(false);
  });

  it('34 R7: a deny leaves the run count at 0, an allow adds one', () => {
    const f = makeRepo();
    const state = f.env.CCV3_CODERABBIT_GUARD_STATE as string;
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    const input = { tool_name: 'Bash', cwd: f.root, tool_input: { command: 'cr review --agent' } };
    expect(decide(input, f.env).allow).toBe(false);
    expect(readState(state).counts).toEqual({});
    git(f.root, ['reset', '-q', '--hard', 'HEAD~1']);
    expect(decide(input, f.env).allow).toBe(true);
    expect(Object.values(readState(state).counts)).toEqual([1]);
  });

  it('36 an override with a blocked review (no --agent, a billing flag) is still checked for gold', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    expect(f.run('SKIP_CODERABBIT_GUARD=1 cr review').allow).toBe(false);
    const clean = makeRepo();
    expect(clean.run('SKIP_CODERABBIT_GUARD=1 cr review --use-credits').allow).toBe(true);
    expect(clean.run('SKIP_CODERABBIT_GUARD=1 cr review --use-credits --base main').allow).toBe(false);
  });

  it('37 a Task or Agent with a read-only autofix prompt and a review command is still checked', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    const input = { tool_name: 'Agent', cwd: f.root, tool_input: { command: 'cr review --agent', prompt: 'read-only autofix plan for the PR' } };
    expect(decide(input, f.env).allow).toBe(false);
  });

  it('35 R7: the PowerShell tool is checked too (plain call and a gold path)', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    expect(decide({ tool_name: 'PowerShell', cwd: f.root, tool_input: { command: 'cr review --agent' } }, f.env).allow).toBe(false);
  });
});
