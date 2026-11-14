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

import { classifyCommand, decide, logDeny, parseInvocation, readState } from '../coderabbit-guard.js';

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

  it('27 R2: the override lifts the run cap only: a gold path is still denied, a clean diff passes', () => {
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

describe('coderabbit-guard answer-key allow list (round 2)', () => {
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

  it('54 in a foreign repo a raw-only review is allowed, but one with an option the parser cannot read is denied (a --dir may reach CCv3)', () => {
    const f = makeRepo({ remote: OTHER_URL });
    expect(f.run('watch -n 5 cr review --agent').allow).toBe(true);
    const r = f.run('watch -n 5 cr review --agent --dir ..');
    expect(r.allow).toBe(false);
    expect((r.reason ?? '').endsWith('answer-key')).toBe(true);
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

describe('coderabbit-guard answer-key log rows (round 2)', () => {
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
