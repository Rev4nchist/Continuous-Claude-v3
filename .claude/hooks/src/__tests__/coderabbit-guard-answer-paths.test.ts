/**
 * coderabbit-guard: no `cr review` may start on a diff that holds an answer-key path.
 * Every case runs the real decide() against a temp git repo. Only the "check throws" case mocks the lib.
 *
 * Round 2 turned the check into an allow list: in a CCv3 checkout a counted review passes only as ONE plain call with a literal
 * --base or --base-commit (the second describe block). Tests 1 to 37 keep their round-1 meaning with that shape.
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

import { answerKeyDeny, classifyCommand, decide, effectiveCwd, gitEnv, logDeny, parseInvocation, parseShape, readState, repoBranchKey } from '../coderabbit-guard.js';

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
/** The one allowed review shape (round 2). Every plain call in this file carries a literal --base. */
const REVIEW = 'cr review --agent --base main';
/** The way-out text every shape deny holds. */
const WAY = 'run the review as its own plain command with --base <ref>';

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

const slash = (p: string) => p.replace(/\\/g, '/');

interface Fixture {
  root: string;
  base: string;
  env: NodeJS.ProcessEnv;
  top: string;
  run: (command?: string, opts?: { key?: string; cwd?: string; tool?: string }) => ReturnType<typeof decide>;
}

let dirs: string[] = [];

/** A repo with main and refs/remotes/fork/main at one base commit (REVIEW.md with `globs`, one seed file), then branch `feature`. */
function makeRepo(opts: { globs?: string[] | null; baseFiles?: Record<string, string>; remote?: string | null } = {}): Fixture {
  const top = mkdtempSync(join(tmpdir(), 'cr-ak-'));
  dirs.push(top);
  const root = join(top, 'repo');
  mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  if (opts.remote !== null) git(root, ['remote', 'add', 'fork', opts.remote ?? CCV3_URL]);
  if (opts.globs !== null) put(root, 'REVIEW.md', reviewMd(opts.globs ?? ALL_GLOBS));
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
  const run = (command = REVIEW, o: { key?: string; cwd?: string; tool?: string } = {}) => {
    rmSync(env.CCV3_CODERABBIT_GUARD_STATE as string, { force: true });
    return decide({ tool_name: o.tool ?? 'Bash', cwd: o.cwd ?? root, tool_input: { command } }, { ...env, CCV3_CODERABBIT_GUARD_KEY: o.key ?? NOT_CCV3_KEY });
  };
  return { root, top, base, env, run };
}

function plainFolder(): string {
  const plain = mkdtempSync(join(tmpdir(), 'cr-nogit-'));
  dirs.push(plain);
  return plain;
}

beforeEach(() => {
  hoisted.throwNow = false;
});

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('coderabbit-guard answer-key check', { timeout: 30_000 }, () => {
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
    const r = f.run('bash -c "cr review --agent --base main"');
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

  it('10 checks a CCv3 repo whatever the env cap key says; a clean repo with another remote passes; a mirror with gold in HEAD is checked', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    expect(f.run(REVIEW, { key: NOT_CCV3_KEY }).allow).toBe(false);
    const ccv3Key = 'github.com/rev4nchist/continuous-claude-v3#feature';
    const other = makeRepo({ remote: OTHER_URL });
    put(other.root, 'src/c.ts', 'export const c = 3;\n');
    commit(other.root, 'clean change');
    expect(other.run(REVIEW, { key: ccv3Key }).allow).toBe(true);
    // Round 2: another remote is no proof. A repo whose HEAD holds the review-eval tree is a mirror and is checked.
    const mirror = makeRepo({ remote: OTHER_URL });
    put(mirror.root, GOLD, '{}\n');
    commit(mirror.root, 'add gold');
    expect(mirror.run(REVIEW, { key: ccv3Key }).allow).toBe(false);
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

  it('12 skips a folder that is not a git repo, and checks a repo with no remote and a review-eval tree in HEAD', () => {
    const plain = plainFolder();
    const f = makeRepo({ remote: null });
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    expect(f.run(REVIEW, { cwd: plain }).allow).toBe(true);
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
    expect(f.run(REVIEW).allow).toBe(true);
    // Round 2: a SHA, not HEAD~2 (the tilde is outside the literal charset, so that form would deny for the shape).
    const gold = f.run(`cr review --agent --base ${f.base}`);
    expect(gold.allow).toBe(false);
    expect(gold.reason).toContain('(1)');
    expect(f.run('cr review --agent --base no-such-branch').allow).toBe(false);
    expect(f.run('cr review --agent --base').allow).toBe(false);
  });

  it('18 --base=value is read like --base value', () => {
    const f = staleMainRepo();
    const r = f.run(`cr review --agent --base=${f.base}`);
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('(1)');
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
    const dir = slash(second.root);
    expect(clean.run(REVIEW).allow).toBe(true);
    expect(clean.run(`${REVIEW} --dir ${dir}`).allow).toBe(false);
    expect(clean.run(`${REVIEW} --dir ${dir}`, { cwd: plainFolder() }).allow).toBe(false);
    expect(clean.run(`${REVIEW} --dir`).allow).toBe(false);
  });

  it('21 -c and --config: deny an answer-key file and a file that does not exist; allow a clean file', () => {
    const f = makeRepo();
    put(f.top, GOLD, 'fake gold\n');
    put(f.top, 'notes/claude.md', 'rules\n');
    const fake = slash(join(f.top, GOLD));
    expect(f.run(`${REVIEW} -c ${slash(join(f.top, 'notes/claude.md'))}`).allow).toBe(true);
    expect(f.run(`${REVIEW} -c REVIEW.md`).allow).toBe(true);
    expect(f.run(`${REVIEW} -c ${fake}`).allow).toBe(false);
    expect(f.run(`${REVIEW} --config REVIEW.md ${fake}`).allow).toBe(false);
    expect(f.run(`${REVIEW} --config=${fake}`).allow).toBe(false);
    expect(f.run(`${REVIEW} -c no-such-file.md`).allow).toBe(false);
    expect(f.run(`${REVIEW} -c`).allow).toBe(false);
  });

  it('22 --remote: denies a CCv3 repo name and a missing value, allows another repo', () => {
    const f = makeRepo();
    const run = (c: string) => f.run(c, { cwd: plainFolder() });
    expect(run('cr review --agent --remote Rev4nchist/Continuous-Claude-v3 --base main --source-branch x').allow).toBe(false);
    expect(run('cr review --agent --remote=parcadei/continuous-claude --base main --source-branch x').allow).toBe(false);
    expect(run('cr review --agent --remote').allow).toBe(false);
    expect(run('cr review --agent --remote acme/app --base main --source-branch x').allow).toBe(true);
  });

  it('23 a review the parser cannot read or that runs inside a wrapper is denied with the way-out; a plain --committed call passes', () => {
    const f = makeRepo();
    put(f.root, 'src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'clean change');
    for (const c of [
      'watch -n 5 cr review --agent --base main',
      'watch -n 5 cr review --agent --dir ..',
      'watch -n 5 cr review --agent',
      'bash -c "cr review --agent"',
      'bash -c "cr review --agent --base main"',
    ]) {
      const r = f.run(c);
      expect(r.allow, c).toBe(false);
      expect(r.reason, c).toContain(WAY);
    }
    expect(f.run('cr review --agent --base main --committed').allow).toBe(true);
  });

  // ---- round 1 additions (seat review R1 to R7) ----

  it('24 R1: a local-path remote is checked; a mirror with another host-form remote and gold in HEAD is checked too', () => {
    const f = makeRepo({ remote: '../elsewhere/local-clone' });
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    expect(f.run().allow).toBe(false);
    const ssh = makeRepo({ remote: 'git@github.com:someone/other-repo.git' });
    put(ssh.root, GOLD, '{}\n');
    commit(ssh.root, 'add gold');
    expect(ssh.run().allow).toBe(false);
  });

  it('25 R1: denies a cd target it cannot read, a missing folder, a cd after the review, and a cd inside a wrapper string', () => {
    const f = makeRepo();
    const here = slash(f.root);
    expect(f.run(`cd "${here}" && ${REVIEW}`).allow).toBe(true);
    for (const target of ['~/repo', '$HOME/repo', '%USERPROFILE%/repo']) expect(f.run(`cd ${target} && ${REVIEW}`).allow).toBe(false);
    expect(f.run(`cd "${here}/no-such-folder" && ${REVIEW}`).allow).toBe(false);
    expect(f.run(`${REVIEW} && cd "${here}"`).allow).toBe(false);
    expect(f.run(`bash -c "cd '${here}' && ${REVIEW}"`).allow).toBe(false);
    expect(f.run(`cd - && ${REVIEW}`).allow).toBe(false);
    expect(f.run(`cd && ${REVIEW}`).allow).toBe(false);
  });

  it('26 R1: a PowerShell cd is followed (into a repo with gold from a plain folder); Push-Location is not the allowed shape', () => {
    const plain = plainFolder();
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    const here = slash(f.root);
    const input = (command: string, tool = 'PowerShell') => ({ tool_name: tool, cwd: plain, tool_input: { command } });
    const viaCd = decide(input(`cd "${here}"; ${REVIEW}`), f.env);
    expect(viaCd.allow).toBe(false);
    expect(viaCd.reason).toContain('(1)');
    const viaPush = decide(input(`Push-Location "${here}"; ${REVIEW}`), f.env);
    expect(viaPush.allow).toBe(false);
    expect(viaPush.reason).toContain(WAY);
    expect(decide(input(`cd "${here}" && ${REVIEW}`, 'Bash'), f.env).allow).toBe(false);
    expect(decide(input(REVIEW, 'Bash'), f.env).allow).toBe(true);
    const clean = makeRepo();
    expect(decide(input(`cd "${slash(clean.root)}"; ${REVIEW}`), clean.env).allow).toBe(true);
  });

  it('27 R2: the override never lifts the answer-key check (it lifts the run cap and the billing and block denies, as on main): a gold path is still denied, a clean diff passes', () => {
    const f = makeRepo();
    put(f.root, 'src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'clean change');
    expect(f.run(`SKIP_CODERABBIT_GUARD=1 ${REVIEW}`).allow).toBe(true);
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    const r = f.run(`SKIP_CODERABBIT_GUARD=1 ${REVIEW}`);
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('answer-key');
  });

  it('28 R3: an error in classify or in the folder step denies a review and lets a non-review command pass', () => {
    const f = makeRepo();
    const boom = () => {
      throw new Error('boom');
    };
    const input = (command: string) => ({ tool_name: 'Bash', cwd: f.root, tool_input: { command } });
    expect(decide(input(REVIEW), f.env).allow).toBe(true);
    expect(decide(input(REVIEW), f.env, { classify: boom }).allow).toBe(false);
    expect(decide(input('git status'), f.env, { classify: boom }).allow).toBe(true);
    expect(decide(input(REVIEW), f.env, { cwdOf: boom }).allow).toBe(false);
    expect(decide(input(`SKIP_CODERABBIT_GUARD=1 ${REVIEW}`), f.env, { classify: boom }).allow).toBe(false);
  });

  it('29 R4: a Task or Agent that carries a review command gets the same check', () => {
    const f = makeRepo();
    const input = (tool: string) => ({ tool_name: tool, cwd: f.root, tool_input: { command: REVIEW, description: 'run a review' } });
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
    const input = { tool_name: 'Bash', session_id: 's31', cwd: f.root, tool_input: { command: `cd "${slash(f.root)}" && ${REVIEW}` } };
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
    expect(decide({ tool_name: 'Bash', cwd: f.root, tool_input: { command: REVIEW } }, env).allow).toBe(false);
  });

  it('33 R7: denies when the git root is unknown inside a repo (a review started inside .git)', () => {
    const f = makeRepo();
    expect(f.run(REVIEW, { cwd: join(f.root, '.git') }).allow).toBe(false);
  });

  it('34 R7: a deny leaves the run count at 0, an allow adds one', () => {
    const f = makeRepo();
    const state = f.env.CCV3_CODERABBIT_GUARD_STATE as string;
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    const input = { tool_name: 'Bash', cwd: f.root, tool_input: { command: REVIEW } };
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
    expect(f.run('SKIP_CODERABBIT_GUARD=1 cr review --base main').allow).toBe(false);
    const clean = makeRepo();
    // Round 2: the shape needs a literal --base, so the clean forms carry one. A billing flag is a plain option of the allowed shape.
    expect(clean.run('SKIP_CODERABBIT_GUARD=1 cr review --use-credits --base main').allow).toBe(true);
    expect(clean.run('SKIP_CODERABBIT_GUARD=1 cr review --use-credits').allow).toBe(false);
    expect(f.run('SKIP_CODERABBIT_GUARD=1 cr review --use-credits --base main').allow).toBe(false);
  });

  it('37 a Task or Agent with a read-only autofix prompt and a review command is still checked', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    const input = { tool_name: 'Agent', cwd: f.root, tool_input: { command: REVIEW, prompt: 'read-only autofix plan for the PR' } };
    expect(decide(input, f.env).allow).toBe(false);
  });

  it('35 R7: the PowerShell tool is checked too (plain call and a gold path)', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    expect(decide({ tool_name: 'PowerShell', cwd: f.root, tool_input: { command: REVIEW } }, f.env).allow).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Round 2: the allow list. One plain review, alone or after one plain cd, with a literal --base or --base-commit.
// ---------------------------------------------------------------------------------------------

function cleanRepo(opts: Parameters<typeof makeRepo>[0] = {}): Fixture {
  const f = makeRepo(opts);
  put(f.root, 'src/b.ts', 'export const b = 2;\n');
  commit(f.root, 'clean change');
  return f;
}

function goldRepo(opts: Parameters<typeof makeRepo>[0] = {}): Fixture {
  const f = makeRepo(opts);
  put(f.root, GOLD, '{}\n');
  commit(f.root, 'add gold');
  return f;
}

function expectWayOut(r: ReturnType<typeof decide>, label = ''): void {
  expect(r.allow, label).toBe(false);
  expect(r.reason, label).toContain(WAY);
  expect((r.reason ?? '').endsWith('answer-key'), label).toBe(true);
}

describe('coderabbit-guard answer-key allow list (round 2)', { timeout: 30_000 }, () => {
  it('38 the allowed shapes pass on a clean diff and count a run', () => {
    const f = cleanRepo();
    const here = slash(f.root);
    const sha = git(f.root, ['rev-parse', 'HEAD']);
    const shapes: Array<[string, string?]> = [
      ['cr review --agent --base main'],
      ['coderabbit review --agent --base main'],
      [`cd ${here} && cr review --agent --base main`],
      [`cd "${here}" ; cr review --agent --base main`],
      [`cd '${here}';cr review --agent --base main`],
      ['cr review --agent --base=main'],
      ['cr review --agent --base "main"'],
      [`cr review --agent --base-commit ${sha}`],
      [`cr review --agent --base-commit=${sha} --committed --fresh`],
      ['cr review --agent --base main --dir src --region eu'],
      ['cr review --agent --base main -c REVIEW.md src/b.ts'],
    ];
    for (const [c] of shapes) {
      const r = f.run(c, { cwd: c.startsWith('cd') ? plainFolder() : undefined });
      expect(r.allow, c).toBe(true);
      expect(r.increment, c).toBe(true);
    }
  });

  const DENY_FORMS: Array<[string, (root: string) => string, string?]> = [
    // The odd character sits in --source-branch, a value the check never reads: only the strict shape test can deny these.
    ['dollar', () => 'cr review --agent --base main --source-branch $B'],
    ['percent', () => 'cr review --agent --base main --source-branch %B%'],
    ['backtick', () => 'cr review --agent --base main --source-branch `x`'],
    ['at sign', () => 'cr review --agent --base main --source-branch a@b'],
    ['braces', () => 'cr review --agent --base main --source-branch {x}'],
    ['parens', () => 'cr review --agent --base main --source-branch (x)'],
    ['subshell', () => '(cr review --agent --base main)'],
    ['dollar in the base', () => 'cr review --agent --base $B'],
    ['pipe', () => 'cr review --agent --base main | tee out.txt'],
    ['xargs', () => 'echo x | xargs cr review --agent --base main'],
    ['bash -c', () => 'bash -c "cr review --agent --base main"'],
    ['bash -ec', () => 'bash -ec "cr review --agent --base main"'],
    ['wsl', () => 'wsl cr review --agent --base main'],
    ['cmd /c', () => 'cmd /c "cr review --agent --base main"'],
    ['pwsh -Command', () => 'pwsh -Command "cr review --agent --base main"'],
    ['Start-Process', () => 'Start-Process cr -ArgumentList "review --agent --base main"', 'PowerShell'],
    ['env -C', (root) => `env -C ${slash(root)} cr review --agent --base main`],
    ['keyword-led', () => 'time cr review --agent --base main'],
    ['second cd', (root) => `cd ${slash(root)} && cd ${slash(root)} && cr review --agent --base main`],
    ['embedded quote', () => 'cr review --agent --ba"se" main'],
    ['quote inside a value', () => 'cr review --agent --base ma"in"'],
    ['quote glued after a -c value', () => 'cr review --agent --base main -c REVIEW.md"x"'],
    ['quote glued before a -c value', () => 'cr review --agent --base main -c "src"b.ts'],
    ['path-led program', () => './cr review --agent --base main'],
    ['exe-led program', () => 'cr.exe review --agent --base main'],
    ['-c value is a folder', (root) => `cr review --agent --base main -c ${slash(root)}`],
    ['--remote not owner/repo', () => 'cr review --agent --base main --remote acme'],
    ['npx coderabbit@latest', () => 'npx coderabbit@latest review --agent --base main'],
    ['wsl coderabbit@latest', () => 'wsl coderabbit@latest review --agent --base main'],
    ['missing --base', () => 'cr review --agent'],
    ['unresolvable --base', () => 'cr review --agent --base no-such-ref'],
    ['unresolvable --base-commit', () => 'cr review --agent --base-commit 0123456789abcdef0123456789abcdef01234567'],
    ['tilde in a value', () => 'cr review --agent --base main --dir ~/x'],
    ['tilde inside a token', () => 'cr review --agent --base main --source-branch a~b'],
    ['empty value', () => 'cr review --agent --base main --source-branch='],
    ['unknown option', () => 'cr review --agent --base main --unknown value'],
    ['cd to another user home', () => 'cd ~root && cr review --agent --base main'],
    ['stray word', () => 'cr review --agent --base main extra'],
    ['trailing separator', () => 'cr review --agent --base main;'],
    ['comment', () => 'cr review --agent --base main # note'],
    ['two lines', () => 'cr review --agent --base main\necho done'],
  ];

  it.each(DENY_FORMS)('39 denies %s with the way-out text, on a clean diff, and uses no run slot', (name, build, tool) => {
    const f = cleanRepo();
    const r = f.run(build(f.root), { tool });
    expectWayOut(r, name);
    expect(readState(f.env.CCV3_CODERABBIT_GUARD_STATE as string).counts, name).toEqual({});
  });

  it('40 a command that only names the words is allowed in a CCv3 folder (gold in the diff) and in a foreign folder', () => {
    const named = [
      `bash -c "grep -rn 'cr review --base' docs"`,
      'time grep -n "cr review --dir" README.md',
      'if grep -q "cr review" notes.md; then echo y; fi',
    ];
    const ccv3 = goldRepo();
    const foreign = makeRepo({ remote: OTHER_URL });
    for (const c of named) {
      expect(ccv3.run(c).allow, `ccv3 ${c}`).toBe(true);
      expect(foreign.run(c).allow, `foreign ${c}`).toBe(true);
      expect(ccv3.run(c, { tool: 'PowerShell' }).allow, `ccv3 ps ${c}`).toBe(true);
      expect(ccv3.run(c, { cwd: plainFolder() }).allow, `plain ${c}`).toBe(true);
    }
  });

  it('41 a shell that runs a string with a review in it is still a call (the names-only rule does not open it)', () => {
    const f = goldRepo();
    for (const c of ['wsl sh -c "cr review --agent --base main"', 'bash -c "echo hi; cr review --agent --base main"', 'eval "cr review --agent --base main"']) {
      expectWayOut(f.run(c), c);
    }
  });

  it('42 a foreign repo with no remote and no review-eval tree is skipped, not denied (even with no REVIEW.md and no --base)', () => {
    const f = makeRepo({ remote: null, globs: null });
    expect(f.run('cr review --agent').allow).toBe(true);
    expect(f.run('bash -c "cr review --agent"').allow).toBe(true);
    const withRemote = makeRepo({ remote: OTHER_URL, globs: null });
    expect(withRemote.run('cr review --agent').allow).toBe(true);
  });

  it('43 a CCv3 mirror (no CCv3 remote, review-eval tree in HEAD) is checked, with the count and with the way-out', () => {
    const f = goldRepo({ remote: 'https://git.example.org/team/renamed-fork.git' });
    const counted = f.run();
    expect(counted.allow).toBe(false);
    expect(counted.reason).toContain('(1)');
    expectWayOut(f.run('cr review --agent'));
    const seeds = makeRepo({ remote: null, baseFiles: { 'scripts/eval/review-eval/seeds/s.json': '{}\n' } });
    expectWayOut(seeds.run('cr review --agent'));
  });

  it('44 cd ~/folder is expanded through the home folder of the env (HOME and USERPROFILE)', () => {
    const foreign = makeRepo({ remote: OTHER_URL });
    const gold = goldRepo();
    const session = goldRepo();
    const inHome = (home: string, command: string) =>
      decide({ tool_name: 'Bash', cwd: session.root, tool_input: { command } }, { ...session.env, HOME: home, USERPROFILE: home });
    expect(inHome(foreign.top, 'cd ~/repo && cr review --agent --base main').allow).toBe(true);
    const bad = inHome(gold.top, 'cd ~/repo && cr review --agent --base main');
    expect(bad.allow).toBe(false);
    expect(bad.reason).toContain('(1)');
    expect(inHome(gold.top, 'cd ~/no-such && cr review --agent --base main').allow).toBe(false);
  });

  it('45 --base also reads X..HEAD: gold unchanged since the merge base, deleted on the base branch', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    const withGold = commit(f.root, 'add gold');
    git(f.root, ['update-ref', 'refs/heads/main', withGold]);
    git(f.root, ['update-ref', 'refs/remotes/fork/main', withGold]);
    git(f.root, ['checkout', '-q', '-b', 'del', withGold]);
    git(f.root, ['rm', '-q', GOLD]);
    commit(f.root, 'delete gold');
    git(f.root, ['checkout', '-q', 'feature']);
    put(f.root, 'src/b.ts', 'export const b = 2;\n');
    const head = commit(f.root, 'clean change');
    expect(git(f.root, ['diff', '--name-only', 'del...HEAD'])).not.toContain('gold');
    expect(git(f.root, ['diff', '--name-only', 'del..HEAD'])).toContain('gold');
    expect(f.run(REVIEW).allow).toBe(true);
    const viaBase = f.run('cr review --agent --base del');
    expect(viaBase.allow).toBe(false);
    expect(viaBase.reason).toContain('(1)');
    expect(f.run(`cr review --agent --base-commit ${git(f.root, ['rev-parse', 'del'])}`).allow).toBe(false);
    expect(head).toBeTruthy();
  });

  it('46 an untracked gold file is denied with a literal --base', () => {
    const f = cleanRepo();
    put(f.root, GOLD, '{}\n');
    const r = f.run();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('(1)');
  });

  it('47 npx coderabbit@latest is seen as a CodeRabbit call (the version suffix is dropped from the program name)', () => {
    expect(parseInvocation('npx coderabbit@latest review --agent')?.exe).toBe('coderabbit');
    expect(parseInvocation('npx -y coderabbit@1.2.3 review --agent')?.exe).toBe('coderabbit');
    expect(classifyCommand('npx coderabbit@latest review --agent --base main').runs).toBe(1);
    expect(classifyCommand('npx coderabbit@latest review --agent --use-credits').verdict).toBe('block');
  });

  it('48 a Task or Agent payload that carries only a prompt is not checked for a review call (the guard sees a subagent Bash call, not its prompt)', () => {
    const f = goldRepo();
    const input = { tool_name: 'Agent', cwd: f.root, tool_input: { prompt: REVIEW, description: 'review' } };
    expect(decide(input, f.env).allow).toBe(true);
  });

  it('53 a repo with no commit yet has no HEAD tree: skipped when the folder has no review-eval tree, checked when it has one', () => {
    const fresh = (): string => {
      const root = join(plainFolder(), 'unborn');
      mkdirSync(root);
      git(root, ['init', '-q', '-b', 'main']);
      return root;
    };
    const foreign = fresh();
    const plain = decide({ tool_name: 'Bash', cwd: foreign, tool_input: { command: 'cr review --agent' } }, { CCV3_CODERABBIT_GUARD_STATE: join(foreign, '..', 'state.json') });
    expect(plain.allow).toBe(true);
    const mirror = fresh();
    put(mirror, GOLD, '{}\n');
    const r = decide({ tool_name: 'Bash', cwd: mirror, tool_input: { command: 'cr review --agent' } }, { CCV3_CODERABBIT_GUARD_STATE: join(mirror, '..', 'state.json') });
    expectWayOut(r);
  });

  it('54 (round 3, M1) in a foreign repo a review the parser cannot place is denied with the way-out text; a wrapper it opens still passes', () => {
    const f = makeRepo({ remote: OTHER_URL });
    // Round 2 allowed the first form here. A raw-only review (a wrapper the parser does not read) may run in a folder the check does not see.
    for (const c of ['watch -n 5 cr review --agent', 'watch -n 5 cr review --agent --dir ..', `env -C ${slash(f.root)} cr review --agent`]) {
      expectWayOut(f.run(c), c);
      expectWayOut(f.run(c, { cwd: plainFolder() }), `plain ${c}`);
    }
    expect(f.run('time cr review --agent').allow).toBe(true);
    expect(f.run('bash -c "cr review --agent"').allow).toBe(true);
  });

  it('54b (R2) in a foreign repo a review that is not the shape, with an option the parser cannot read, gets the way-out text', () => {
    // Breaks when the last branch of answerKeyDeny returns null for an unaccounted option (it may hide a --dir into CCv3).
    // Every command tried through decide() is denied by an earlier step first, so this calls answerKeyDeny with the flag set.
    const f = makeRepo({ remote: OTHER_URL });
    const plain = plainFolder();
    for (const cwd of [f.root, plain]) {
      const run = { command: 'time cr review --agent', ps: false, startCwd: cwd, cwd, home: plain, invocations: [], unplaced: false };
      const reason = answerKeyDeny({ ...run, unaccounted: true });
      expect(reason, cwd).toContain(WAY);
      expect((reason ?? '').endsWith('answer-key'), cwd).toBe(true);
      // The pin: without the flag the same foreign review is not the check's business.
      expect(answerKeyDeny({ ...run, unaccounted: false }), cwd).toBeNull();
    }
  });

  it('55 a cd that the folder step cannot follow gets the way-out: a cd after the review, and a cd inside a wrapper string', () => {
    const ccv3 = goldRepo();
    const foreign = makeRepo({ remote: OTHER_URL });
    // The review runs where the session is (CCv3), while effectiveCwd would follow the later cd into a foreign repo.
    const after = ccv3.run(`${REVIEW} && cd ${slash(foreign.root)}`);
    expectWayOut(after);
    // The review runs in CCv3 inside the string, while the session sits in a foreign repo.
    const inside = foreign.run(`bash -c "cd ${slash(ccv3.root)} && ${REVIEW}"`);
    expectWayOut(inside);
  });

  describe('time budget', () => {
    /** Date.now answers the real time for the first `fresh` calls, then 31 s later: the 30 s budget has run out. */
    function overBudgetAfter(fresh: number): () => void {
      const t0 = Date.now();
      let calls = 0;
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => (++calls <= fresh ? t0 : t0 + 31000));
      return () => spy.mockRestore();
    }

    // The realpathSync row names a file that does not exist: without the check before it, realpathSync would fail and the reason would say so.
    it.each([
      ['before the statSync of the folder', 1, REVIEW],
      ['before the realpathSync of a config file', 2, `${REVIEW} -c no-such-file.md`],
      ['before the statSync of a config file', 3, `${REVIEW} -c REVIEW.md`],
    ])('49 checks the budget %s', (_name, fresh, command) => {
      const f = cleanRepo();
      const restore = overBudgetAfter(fresh);
      let r: ReturnType<typeof decide>;
      try {
        r = f.run(command);
      } finally {
        restore();
      }
      expect(r.allow).toBe(false);
      expect(r.reason).toContain('time budget');
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Round 2: log rows of the answer-key path hold no cwd and no command text, and no reason is cut by the masker.
// ---------------------------------------------------------------------------------------------

describe('coderabbit-guard answer-key log rows (round 2)', { timeout: 30_000 }, () => {
  function rowsOf(f: Fixture, input: Parameters<typeof decide>[0]): { result: ReturnType<typeof decide>; rows: Array<Record<string, unknown>> } {
    const log = join(f.top, 'guard.jsonl');
    rmSync(log, { force: true });
    const env = { ...f.env, CCV3_GUARD_DECISIONS_LOG: log };
    const result = decide(input, env);
    if (!result.allow) logDeny(input, result, env);
    let text = '';
    try {
      text = readFileSync(log, 'utf8');
    } catch {
      /* no row */
    }
    return { result, rows: text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
  }

  const bash = (f: Fixture, command: string) => ({ tool_name: 'Bash', session_id: 's-log', cwd: f.root, tool_input: { command } });

  it('50 every answer-key deny row keeps the whole reason, ends with answer-key, and has no cwd and no command', () => {
    const gold = goldRepo();
    const clean = cleanRepo();
    put(clean.top, GOLD, 'fake gold\n');
    const fake = slash(join(clean.top, GOLD));
    const cases: Array<[string, Fixture, string]> = [
      ['way-out', clean, 'cr review --agent'],
      ['count', gold, REVIEW],
      ['cannot check', clean, 'cr review --agent --base main -c no-such-file.md'],
      ['remote', clean, 'cr review --agent --base main --remote Rev4nchist/Continuous-Claude-v3 --source-branch x'],
      ['config file', clean, `cr review --agent --base main -c ${fake}`],
      ['unresolvable base', clean, 'cr review --agent --base no-such-ref'],
    ];
    for (const [name, f, command] of cases) {
      const { result, rows } = rowsOf(f, bash(f, command));
      expect(result.allow, name).toBe(false);
      expect(rows, name).toHaveLength(1);
      const row = rows[0];
      expect(row.reason, name).toBe(result.reason);
      expect(String(row.reason).endsWith('answer-key'), name).toBe(true);
      expect(row.reason, name).not.toContain('***');
      expect(row, name).not.toHaveProperty('cwd');
      expect(row, name).not.toHaveProperty('command');
      expect(JSON.stringify(row), name).not.toContain('cr review');
    }
  });

  it('51 the override allow row keeps no cwd and no command either', () => {
    const f = cleanRepo();
    const { result, rows } = rowsOf(f, bash(f, `SKIP_CODERABBIT_GUARD=1 ${REVIEW}`));
    expect(result.allow).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: 'override' });
    expect(rows[0]).not.toHaveProperty('cwd');
    expect(rows[0]).not.toHaveProperty('command');
  });

  it('52 a deny that is not about answer-key (a billing flag) still logs its command head', () => {
    const f = cleanRepo();
    const { rows } = rowsOf(f, bash(f, 'cr review --agent --use-credits'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty('command');
  });
});

// ---------------------------------------------------------------------------------------------
// Round 3: ONE call rule for both the answer-key check and the run slot (B1, B2, B4), the folder rules (B3, M1, M2), the key deadline (M3).
// A call: an unquoted cr word followed by review, anywhere; a quoted cr word only when a program that runs a string gets it.
// ---------------------------------------------------------------------------------------------

const WIN = process.platform === 'win32';
const stateOf = (f: Fixture): string => f.env.CCV3_CODERABBIT_GUARD_STATE as string;
/** The run slots used so far, from the state file. f.run deletes that file before every call, so a slot test cannot use it. */
const slots = (f: Fixture): number => Object.values(readState(stateOf(f)).counts).reduce((a, b) => a + b, 0);
/** Like f.run, but the run counter stays: a slot test reads it before and after. */
function keep(f: Fixture, command: string, o: { cwd?: string; tool?: string } = {}): ReturnType<typeof decide> {
  return decide({ tool_name: o.tool ?? 'Bash', cwd: o.cwd ?? f.root, tool_input: { command } }, f.env);
}

describe('coderabbit-guard answer-key round 3', { timeout: 30_000 }, () => {
  const B1: Array<[string, string, string?]> = [
    ['npm exec', 'npm exec coderabbit review --agent'],
    ['pnpm dlx', 'pnpm dlx coderabbit review --agent'],
    ['winpty', 'winpty cr review --agent'],
    ['stdbuf', 'stdbuf -oL cr review --agent'],
    ['command substitution as the program', '"$(command -v cr)" review --agent'],
    ['unquoted substitution as the program', '$(command -v cr) review --agent'],
    ['backtick substitution as the program', '`command -v cr` review --agent'],
    ['PowerShell Get-Command', '& (Get-Command cr) review --agent', 'PowerShell'],
  ];

  it.each(B1)('B1 denies %s with the way-out text, on a clean diff, and uses no slot', (name, command, tool) => {
    const f = cleanRepo();
    expectWayOut(keep(f, command, { tool }), name);
    expect(slots(f), name).toBe(0);
  });

  it.each([
    ['quoted program word', '"cr" review --agent --base main'],
    ['quoted path to the program', '"/opt/tools/cr" review --agent --base main'],
  ])('B1 a quoted program in command position is still a call: %s', (name, command) => {
    const f = cleanRepo();
    expectWayOut(keep(f, command), name);
    expect(slots(f), name).toBe(0);
    const ps = cleanRepo();
    expectWayOut(keep(ps, `& ${command.replace('--base main', '')}`, { tool: 'PowerShell' }), `ps ${name}`);
  });

  // A shell string behind a wrapper the parser does not peel (the first five were denied by the round 2 detector, which read every
  // segment led by a wrapper). The shell word sits unquoted inside the segment, so the string it runs is a call.
  const WRAPPED: Array<[string, string, string?]> = [
    ['nice', 'nice sh -c "cr review --agent"'],
    ['env -i', 'env -i bash -c "cr review --agent"'],
    ['find -exec sh -c', 'find . -maxdepth 0 -exec sh -c "cr review --agent" \\;'],
    ['timeout -k', 'timeout -k 5 60 bash -c "cr review --agent"'],
    ['winpty bash -c', 'winpty bash -c "cr review --agent"'],
    ['stdbuf sh -c', 'stdbuf -oL sh -c "cr review --agent"'],
    ['PowerShell powershell "..."', 'powershell "cr review --agent"', 'PowerShell'],
  ];
  it.each(WRAPPED)('B1 a quoted shell string behind a wrapper the parser does not peel is a call: %s', (name, command, tool) => {
    const f = cleanRepo();
    expectWayOut(keep(f, command, { tool }), name);
    expect(slots(f), name).toBe(0);
  });

  it.each([
    ['winpty bash -c grep', `winpty bash -c "grep 'cr review' docs"`],
    ['find -exec grep', 'find docs -exec grep -l "cr review" {} +'],
    ['bash script path', 'bash run.sh "cr review"'],
    ['nice grep', 'nice grep -rn "cr review" docs'],
    ['env -i grep', 'env -i grep "coderabbit review" notes.md'],
  ])('B2 a quoted string behind a wrapper stays data when the program only reads it: %s', (name, command) => {
    const f = goldRepo();
    expect(keep(f, command).allow, name).toBe(true);
    expect(slots(f), name).toBe(0);
  });

  it.each([
    ['find -exec grep', 'find docs -exec grep -l "cr review" {} +'],
    ['npx vitest -t', 'npx vitest run -t "cr review"'],
    ['pnpm exec vitest -t', "pnpm exec vitest run -t 'cr review --base'"],
  ])('B2 allows %s: the quoted words are data, in a CCv3 folder with gold in the diff, and use no slot', (name, command) => {
    const f = goldRepo();
    expect(keep(f, command).allow, name).toBe(true);
    expect(keep(f, command, { tool: 'PowerShell' }).allow, `ps ${name}`).toBe(true);
    expect(slots(f), name).toBe(0);
  });

  it.each([
    ['time grep', 'time grep -n "cr review --dir" README.md'],
    ['if grep', 'if grep -q "cr review" notes.md; then echo y; fi'],
    ['bash -c grep', `bash -c "grep 'cr review' docs"`],
    ['xargs grep', "xargs grep 'cr review'"],
    ['sudo grep', 'sudo grep -n "coderabbit review" docs'],
  ])('B4 %s names the words: no answer-key check and no run slot', (name, command) => {
    const f = goldRepo();
    expect(keep(f, command).allow, name).toBe(true);
    expect(slots(f), name).toBe(0);
    const foreign = makeRepo({ remote: OTHER_URL });
    expect(keep(foreign, command).allow, `foreign ${name}`).toBe(true);
    expect(slots(foreign), `foreign ${name}`).toBe(0);
  });

  it('B4 a real allowed review uses exactly one slot, and a words-only command next to it adds none', () => {
    const f = cleanRepo();
    expect(keep(f, 'cr review --agent --base main').allow).toBe(true);
    expect(slots(f)).toBe(1);
    expect(keep(f, 'grep -n "cr review" README.md').allow).toBe(true);
    expect(slots(f)).toBe(1);
  });

  it('B4 a quoted word that a shell, eval or starter runs is read again by the same rule', () => {
    const f = goldRepo();
    for (const c of [
      `bash -c "grep -rn 'cr review' docs; cr review --agent --base main"`,
      `bash -ec 'cr review --agent --base main'`,
      `eval "cr review --agent --base main"`,
      'wsl sh -c "cr review --agent --base main"',
    ]) {
      expectWayOut(keep(f, c), c);
    }
    expect(slots(f)).toBe(0);
    expectWayOut(keep(f, 'Start-Process -FilePath "cr.exe" -ArgumentList "review --agent --base main"', { tool: 'PowerShell' }));
    expect(slots(f)).toBe(0);
  });

  // ---- B3 ----

  it('B3 Bash has no CD: a cd in capitals does not move the folder, so the review runs in the session folder (gold) and is denied', () => {
    const gold = goldRepo();
    const clean = cleanRepo({ remote: OTHER_URL });
    const r = keep(gold, `CD ${slash(clean.root)}; cr review --agent --base main`);
    expect(r.allow).toBe(false);
    expect(slots(gold)).toBe(0);
    expect(effectiveCwd(`CD ${slash(clean.root)}`, gold.root, false)).toBe(gold.root);
    expect(effectiveCwd(`cd ${slash(clean.root)}`, gold.root, false)).not.toBe(gold.root);
    // PowerShell cd is not case-sensitive.
    expect(effectiveCwd(`CD ${slash(clean.root)}`, gold.root, true)).not.toBe(gold.root);
  });

  it.skipIf(!WIN)('B3 PowerShell reads /c/x as C:\\c\\x, not as C:\\x: the rewrite is for Bash only', () => {
    expect(effectiveCwd('cd /c/Users/x', 'C:\\start', false).toLowerCase()).toBe('c:\\users\\x');
    expect(effectiveCwd('cd /c/Users/x', 'C:\\start', true).toLowerCase()).toBe('c:\\c\\users\\x');
  });

  it('B3 with ; the review runs even when the cd fails: the start folder is checked too, with && it is not', () => {
    const gold = goldRepo();
    const clean = cleanRepo({ remote: OTHER_URL });
    const target = slash(clean.root);
    const semi = keep(gold, `cd ${target}; cr review --agent --base main`);
    expect(semi.allow).toBe(false);
    expect(semi.reason).toContain('(1)');
    expect(slots(gold)).toBe(0);
    const semiPs = keep(gold, `cd ${target}; cr review --agent --base main`, { tool: 'PowerShell' });
    expect(semiPs.allow).toBe(false);
    expect(semiPs.reason).toContain('(1)');
    // && never reaches the review when the cd fails, so only the target counts (test 44 keeps this).
    expect(keep(gold, `cd ${target} && cr review --agent --base main`).allow).toBe(true);
    // A clean start folder with a ; and a CCv3 target is checked in the target as before.
    const startClean = cleanRepo();
    expect(keep(startClean, `cd ${slash(gold.root)}; cr review --agent --base main`).allow).toBe(false);
  });

  // ---- M1 ----

  it.each([
    ['env -C', (ccv3: string) => `env -C ${ccv3} cr review --agent --base main`],
    ['env --chdir', (ccv3: string) => `env --chdir ${ccv3} cr review --agent --base main`],
    ['env -C after a cd', (ccv3: string) => `cd .. && env -C ${ccv3} cr review --agent`],
    ['bash -ec with a cd inside', (ccv3: string) => `bash -ec 'cd ${ccv3} && cr review --agent --base main'`],
    ['Start-Process -WorkingDirectory', (ccv3: string) => `Start-Process cr -WorkingDirectory ${ccv3} -ArgumentList "review --agent"`],
    ['Start-Process quoted path -WorkingDirectory', (ccv3: string) => `Start-Process -FilePath "cr.exe" -WorkingDirectory ${ccv3} -ArgumentList "review --agent"`],
  ])('M1 %s: a review the check cannot place is denied with the way-out text in a foreign repo and in a plain folder, and uses no slot', (name, build) => {
    const ccv3 = goldRepo();
    const foreign = makeRepo({ remote: OTHER_URL });
    const command = build(slash(ccv3.root));
    expectWayOut(keep(foreign, command), `foreign ${name}`);
    expectWayOut(keep(foreign, command, { tool: 'PowerShell' }), `foreign ps ${name}`);
    expectWayOut(keep(foreign, command, { cwd: plainFolder() }), `plain ${name}`);
    expect(slots(foreign), name).toBe(0);
  });

  it('M1 a wrapper the parser opens and places in the session folder still passes in a foreign folder', () => {
    const foreign = makeRepo({ remote: OTHER_URL });
    // f.run starts every call with an empty counter: the cap of 2 must not decide here.
    for (const c of ['sudo -u root cr review --agent', 'xargs -n 1 cr review --agent', 'time cr review --agent', 'bash -c "cr review --agent"']) {
      const r = foreign.run(c);
      expect(r.allow, c).toBe(true);
      expect(r.increment, c).toBe(true);
    }
  });

  // ---- CLI run 1 findings F2 and F4 (seat ruling 2026-11-14) ----

  it.each([
    ['sudo -D dir bash -c', (c: string) => `sudo -D ${c} bash -c 'cr review --agent --base main'`],
    ['sudo -D dir sh -c', (c: string) => `sudo -D ${c} sh -c "cr review --agent --base main"`],
    ['sudo -D dir sh -c nested bash -c', (c: string) => `sudo -D ${c} sh -c 'bash -c "cr review --agent --base main"'`],
    ['sudo --chdir dir bash -c', (c: string) => `sudo --chdir ${c} bash -c 'cr review --agent --base main'`],
    ['env -C dir sh -c', (c: string) => `env -C ${c} sh -c 'cr review --agent --base main'`],
    ['env -C dir nested sh -c', (c: string) => `env -C ${c} bash -c 'sh -c "cr review --agent --base main"'`],
    ['sudo -D dir bash -euxvc', (c: string) => `sudo -D ${c} bash -euxvc 'cr review --agent --base main'`],
  ])('F2 %s: a folder move in front of a wrapper string that holds a review is denied with the way-out text and uses no slot', (name, build) => {
    const ccv3 = goldRepo();
    const foreign = makeRepo({ remote: OTHER_URL });
    const command = build(slash(ccv3.root));
    expectWayOut(keep(foreign, command), `foreign ${name}`);
    expectWayOut(keep(foreign, command, { cwd: plainFolder() }), `plain ${name}`);
    expect(slots(foreign), name).toBe(0);
  });

  it('F2 parseInvocation marks a folder option on a wrapper that opens a string, and not on one that does not move', () => {
    expect(parseInvocation("sudo -D /x bash -c 'cr review --agent'")).toMatchObject({ exe: 'bash', moves: true });
    expect(parseInvocation("sudo -u root bash -c 'cr review --agent'")?.moves).toBeUndefined();
  });

  it.each([
    ['4 letters before c', "bash -euxvc 'cr review --agent --base main'"],
    ['4 letters before c, sh', "sh -euxvc 'cr review --agent --base main'"],
    ['letters after c', "bash -cxuvz 'cr review --agent --base main'"],
    ['4 before and 4 after c', "bash -euxvcpqrs 'cr review --agent --base main'"],
    ['an upper-case letter in the cluster', "bash -Eeuxvc 'cr review --agent --base main'"],
    ['a second cluster', "bash -eu -xc 'cr review --agent --base main'"],
    ['a second cluster of 4 letters', "bash -eu -xuvec 'cr review --agent --base main'"],
    ['zsh', "zsh -euxvc 'cr review --agent --base main'"],
  ])('F4 %s: the quoted review counts as a call, so a gold diff is denied and a foreign folder counts its run', (_name, command) => {
    expect(parseInvocation(command)?.nested).toBe('cr review --agent --base main');
    const gold = goldRepo();
    // A wrapper string is not the one plain shape, so in a CCv3 checkout it gets the way-out text, as `bash -c` does (the M1 table).
    expectWayOut(keep(gold, command), 'gold');
    expect(keep(gold, "bash -c 'cr review --agent --base main'").reason).toBe(keep(gold, command).reason);
    expect(slots(gold)).toBe(0);
    const foreign = makeRepo({ remote: OTHER_URL });
    const r = foreign.run(command);
    expect(r.allow).toBe(true);
    expect(r.increment).toBe(true);
  });

  it('F4 a text the tokenizer cannot shape is denied with the way-out text, never allowed with 0 runs', () => {
    const f = cleanRepo();
    for (const c of [
      "cr review --agent --base 'main",
      'cr review --agent --base ma"in',
      'cr review --agent --base main --unknown-option x',
      'cr review --agent --base $(echo main)',
      'cr review --agent --base main | cat',
    ]) {
      const r = keep(f, c);
      expect(r.allow, c).toBe(false);
    }
    expect(slots(f)).toBe(0);
  });

  // ---- M2 ----

  const PS_CD: Array<[string, string]> = [
    ['cd with a backslash path', 'cd C:\\Users\\x\\repo; cr review --agent --base main'],
    ['cd with a quoted backslash path', 'cd "C:\\Users\\my repo"; cr review --agent --base main'],
    ['Set-Location', 'Set-Location C:\\Users\\x\\repo; cr review --agent --base main'],
    ['sl', 'sl C:/Users/x/repo; cr review --agent --base main'],
    ['Set-Location -Path', 'Set-Location -Path C:\\Users\\x\\repo; cr review --agent --base main'],
    ['set-location -literalpath', 'set-location -LiteralPath "C:\\Users\\my repo"; cr review --agent --base main'],
    ['cd -Path', 'cd -Path ./repo && cr review --agent --base main'],
  ];

  it.each(PS_CD)('M2 PowerShell: parseShape accepts %s', (_name, command) => {
    const shape = parseShape(command, true);
    expect(shape).not.toBeNull();
    expect(shape?.cd).toBeTruthy();
    // Bash reads a backslash as an escape and has no Set-Location: the same text is not the shape there.
    if (/\\|set-location|^sl /i.test(command)) expect(parseShape(command, false)).toBeNull();
  });

  it('M2 a backslash stays out of every other token, and Bash keeps failing the shape', () => {
    expect(parseShape('cd C:\\x; cr review --agent --base ma\\in', true)).toBeNull();
    expect(parseShape('cd C:\\x; cr review --agent --base main --dir src\\a', true)).toBeNull();
    expect(parseShape('cd C:\\x && cr review --agent --base main', false)).toBeNull();
    expect(parseShape('Set-Location -Path; cr review --agent --base main', true)).toBeNull();
    expect(parseShape('Set-Location -Foo C:\\x; cr review --agent --base main', true)).toBeNull();
  });

  it('M2 Bash: a backslash cd target gets the way-out text and names the cause', () => {
    const f = cleanRepo();
    const r = keep(f, `cd ${slash(f.root).replace(/\//g, '\\')} && cr review --agent --base main`);
    expectWayOut(r);
    expect(r.reason).toContain('backslash');
  });

  it.skipIf(!WIN)('M2 PowerShell on Windows: a backslash cd target is followed (clean repo passes, gold repo is denied)', () => {
    const clean = cleanRepo();
    const gold = goldRepo();
    const back = (p: string) => p.replace(/\//g, '\\');
    const from = plainFolder();
    expect(keep(clean, `cd ${back(clean.root)}; cr review --agent --base main`, { tool: 'PowerShell', cwd: from }).allow).toBe(true);
    expect(slots(clean)).toBe(1);
    expect(keep(clean, `Set-Location -LiteralPath "${back(clean.root)}"; cr review --agent --base main`, { tool: 'PowerShell', cwd: from }).allow).toBe(true);
    const bad = keep(gold, `cd ${back(gold.root)}; cr review --agent --base main`, { tool: 'PowerShell', cwd: from });
    expect(bad.allow).toBe(false);
    expect(bad.reason).toContain('(1)');
  });

  // ---- SMALL ----

  it('a cd target must be absolute or start with ./, ../ or ~: a bare name could move through CDPATH', () => {
    for (const ok of ['/tmp/x', 'C:/x', './x', '../x', '~/x', '~', '..', '.']) {
      expect(parseShape(`cd ${ok} && cr review --agent --base main`, false), ok).not.toBeNull();
    }
    for (const bad of ['repo', 'a/b', '-', '...x']) {
      expect(parseShape(`cd ${bad} && cr review --agent --base main`, false), bad).toBeNull();
    }
    const f = cleanRepo();
    mkdirSync(join(f.root, 'sub'));
    expectWayOut(keep(f, 'cd sub && cr review --agent --base main'));
  });

  it('a missing refs/remotes/fork/main or refs/heads/main is named in the deny text', () => {
    const f = cleanRepo();
    git(f.root, ['update-ref', '-d', 'refs/remotes/fork/main']);
    const noFork = keep(f, REVIEW);
    expect(noFork.allow).toBe(false);
    expect(noFork.reason).toContain('refs/remotes/fork/main');
    expect((noFork.reason ?? '').endsWith('answer-key')).toBe(true);
    git(f.root, ['update-ref', 'refs/remotes/fork/main', f.base]);
    git(f.root, ['branch', '-m', 'main', 'renamed-main']);
    const noMain = keep(f, 'cr review --agent --base renamed-main');
    expect(noMain.allow).toBe(false);
    expect(noMain.reason).toContain('refs/heads/main');
    expect((noMain.reason ?? '').endsWith('answer-key')).toBe(true);
  });

  it('the git calls run with LC_ALL=C and without GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE', () => {
    const env = gitEnv({ LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8', GIT_DIR: 'x', GIT_WORK_TREE: 'y', GIT_INDEX_FILE: 'z', KEEP: '1' });
    expect(env.LC_ALL).toBe('C');
    expect(env.KEEP).toBe('1');
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) expect(env).not.toHaveProperty(name);
  });

  // ---- the parser reads what the call rule relies on ----

  it('parseInvocation skips runner options with values, opens combined shell flags, and marks a folder option', () => {
    expect(parseInvocation('sudo -u root cr review --agent')).toMatchObject({ exe: 'cr' });
    expect(parseInvocation('xargs -n 1 cr review --agent')).toMatchObject({ exe: 'cr' });
    expect(parseInvocation('sudo -u root cr review --agent')?.moves).toBeUndefined();
    expect(parseInvocation('sudo -D /elsewhere cr review --agent')).toMatchObject({ exe: 'cr', moves: true });
    expect(parseInvocation("bash -ec 'cr review --agent'")?.nested).toBe('cr review --agent');
    expect(parseInvocation('sh -xc "cr review --agent"')?.nested).toBe('cr review --agent');
    expect(parseInvocation('bash --noprofile script.sh')?.nested).toBeUndefined();
    expect(parseInvocation('sh -c "bash -c \\"cr review --agent\\""')?.nested).toBe('bash -c "cr review --agent"');
    expect(parseInvocation('Start-Process -FilePath "C:\\Program Files\\CodeRabbit\\cr.exe" -ArgumentList "review --agent"')).toMatchObject({ exe: 'cr' });
    expect(parseInvocation('Start-Process cr -WorkingDirectory x -ArgumentList "review --agent"')).toMatchObject({ exe: 'cr', moves: true });
  });

  // ---- M3 ----

  it('M3 repoBranchKey has the same deadline as the other git calls: a spent budget gives the cwd key, a normal call the repo key', () => {
    const f = cleanRepo();
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CCV3_CODERABBIT_GUARD_KEY;
    expect(repoBranchKey(f.root, env)).toMatch(/#feature$/);
    expect(repoBranchKey(f.root, env)).not.toMatch(/^cwd#/);
    const t0 = Date.now();
    let calls = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => (++calls <= 1 ? t0 : t0 + 61000));
    try {
      expect(repoBranchKey(f.root, env)).toMatch(/^cwd#/);
    } finally {
      spy.mockRestore();
    }
  });

  it('round 3 keeps the log rule: a run-cap deny still logs the command head and the cwd', () => {
    const f = cleanRepo();
    writeFileSync(stateOf(f), JSON.stringify({ counts: { [NOT_CCV3_KEY]: 2 } }));
    const input = { tool_name: 'Bash', session_id: 's-cap', cwd: f.root, tool_input: { command: REVIEW } };
    const result = decide(input, f.env);
    expect(result.allow).toBe(false);
    expect(result.reason).toContain('run cap reached');
    const log = join(f.top, 'cap.jsonl');
    logDeny(input, result, { ...f.env, CCV3_GUARD_DECISIONS_LOG: log });
    const row = JSON.parse(readFileSync(log, 'utf8').split('\n').filter(Boolean)[0]) as Record<string, unknown>;
    expect(row).toHaveProperty('cwd');
    expect(row).toHaveProperty('command');
  });
});
