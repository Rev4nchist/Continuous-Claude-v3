/**
 * coderabbit-guard: no `cr review` may start on a diff that holds an answer-key path.
 * Every case runs the real decide() against a temp git repo. Only the "check throws" case mocks the lib.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

import { decide } from '../coderabbit-guard.js';

const CCV3_KEY = 'github.com/rev4nchist/continuous-claude-v3#test';
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
  run: (command?: string, key?: string) => ReturnType<typeof decide>;
}

let dirs: string[] = [];

/** A repo with main and refs/remotes/fork/main at one base commit (REVIEW.md with `globs`, one seed file), then branch `feature`. */
function makeRepo(opts: { globs?: string[]; baseFiles?: Record<string, string> } = {}): Fixture {
  const top = mkdtempSync(join(tmpdir(), 'cr-ak-'));
  dirs.push(top);
  const root = join(top, 'repo');
  mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  put(root, 'REVIEW.md', reviewMd(opts.globs ?? ALL_GLOBS));
  put(root, 'src/app.ts', 'export const a = 1;\n');
  for (const [rel, text] of Object.entries(opts.baseFiles ?? {})) put(root, rel, text);
  const base = commit(root, 'base');
  git(root, ['update-ref', 'refs/remotes/fork/main', base]);
  git(root, ['checkout', '-q', '-b', 'feature']);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CCV3_CODERABBIT_GUARD_STATE: join(top, 'state.json'),
    CCV3_CODERABBIT_GUARD_KEY: CCV3_KEY,
  };
  const run = (command = 'cr review --agent', key = CCV3_KEY) =>
    decide({ tool_name: 'Bash', cwd: root, tool_input: { command } }, { ...env, CCV3_CODERABBIT_GUARD_KEY: key });
  return { root, base, env, run };
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

  it('10 runs only for the CCv3 repo key (another repo with a gold path is not checked)', () => {
    const f = makeRepo();
    put(f.root, GOLD, '{}\n');
    commit(f.root, 'add gold');
    expect(f.run('cr review --agent', 'github.com/someone/other-repo#feature').allow).toBe(true);
    expect(f.run('cr review --agent', CCV3_KEY).allow).toBe(false);
  });
});
