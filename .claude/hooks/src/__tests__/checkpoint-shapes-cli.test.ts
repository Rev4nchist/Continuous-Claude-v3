/**
 * checkpoint-shapes-cli tests (PR C, RED). The built CLI that the ccv3-mods lock spawns, so the mod holds no second shell lexer
 * (memory guard-shell-lexer-arms-race). The tests run the built file the way the mod does: a command on stdin, a flag, JSON out.
 *
 * Contract, written before the code (.claude/hooks/src/checkpoint-shapes-cli.ts, built to dist/checkpoint-shapes-cli.mjs):
 *   node dist/checkpoint-shapes-cli.mjs --shell bash|pwsh     the command text on stdin
 *   prints one line of JSON: shapesOf(joinContinuations(text, shell)), the Shapes of shared/checkpoint-shapes.ts, plus `repos`, exit 0
 *   `repos` (Fill round, critic finding 1): one entry per gated invocation in the text (a ready, a label add, a self-confirm), in
 *   order. An entry is the lower case owner/repo that invocation names with a literal -R, --repo or GH_REPO value, or null when it
 *   names none or a non-literal one (the checkout decides). The ccv3-mods lock passes a gated command through only when `repos` is
 *   not empty and every entry is a literal repo other than the CCv3 fork. So the lock reads no -R from raw text itself.
 *   joinContinuations is the one in pr-opened-review-loop.ts (it needs the shell)
 *   exit 2 with a stderr line and nothing on stdout: empty stdin, a missing --shell, or a --shell that is not bash or pwsh
 *
 * How it can fail, and the test that catches it:
 *   the built file is missing (a new src/*.ts that nobody built, or the CLI not written)  -> every test, named in C0
 *   the shape keys drift from Shapes + repos                                                 -> C1
 *   a compound command lets one -R cover a second gated command, or a CCv3 -R reads as foreign -> C5
 *   a ready/label/self/graphql shape is not read, or --undo reads as a ready               -> C2
 *   a PowerShell backtick continuation or a bash backslash continuation is not joined      -> C3
 *   the shell flag is ignored (the same text reads the same in both)                        -> C3
 *   the SKIP_PRE_PR_GATE prefix hides a ready                                              -> C2
 *   empty stdin or a bad shell exits 0 (the mod would read "no shape" and allow)            -> C4
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'checkpoint-shapes-cli.mjs');

type Run = { status: number | null; stdout: string; stderr: string };
const run = (stdin: string, ...args: string[]): Run => {
  const r = spawnSync(process.execPath, [CLI, ...args], { input: stdin, encoding: 'utf8', timeout: 20_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const shapes = (stdin: string, shell: 'bash' | 'pwsh') => {
  const r = run(stdin, '--shell', shell);
  expect(r.status, `exit ${r.status}, stderr: ${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout) as {
    create: boolean; nonDraft: boolean; ready: boolean; label: { labels: string[]; blind: boolean } | null; self: boolean; nonLiteral: boolean;
    repos: (string | null)[];
  };
};

describe('checkpoint-shapes-cli', () => {
  it('C0 the built CLI exists (run npm run build in .claude/hooks)', () => {
    expect(existsSync(CLI), `${CLI} is missing: add src/checkpoint-shapes-cli.ts and build it`).toBe(true);
  });

  it('C1 prints one JSON line with exactly the Shapes keys and repos', () => {
    const r = run('gh pr view 201', '--shell', 'bash');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n').length).toBe(1);
    expect(Object.keys(JSON.parse(r.stdout)).sort()).toEqual(['create', 'label', 'nonDraft', 'nonLiteral', 'ready', 'repos', 'self']);
    expect(shapes('gh pr view 201', 'bash')).toEqual({ create: false, nonDraft: false, ready: false, label: null, self: false, nonLiteral: false, repos: [] });
  });

  it('C2 reads the gated shapes: ready, --undo, a label add, GraphQL, self-confirm, and the override prefix', () => {
    expect(shapes('gh pr ready 201', 'bash').ready).toBe(true);
    expect(shapes('gh pr ready 201 --undo', 'bash').ready).toBe(false);
    expect(shapes('SKIP_PRE_PR_GATE=1 gh pr ready 201', 'bash').ready).toBe(true);
    expect(shapes('$env:SKIP_PRE_PR_GATE=1; gh pr ready 201', 'pwsh').ready).toBe(true);
    expect(shapes('gh pr edit 201 --add-label review:none', 'bash').label).toEqual({ labels: ['review:none'], blind: false });
    const graphql = shapes("gh api graphql -f query='mutation { addLabelsToLabelable(input: {labelableId: \"x\", labelIds: [\"y\"]}) { clientMutationId } }'", 'bash');
    expect(graphql.label?.blind).toBe(true);
    expect(shapes('node scripts/github/pr-checkpoint.mjs --confirm none --by dave --body b.md', 'pwsh').self).toBe(true);
    expect(shapes('node scripts/github/pr-checkpoint.mjs --json', 'bash').self).toBe(false);
  });

  it('C3 joins continued lines by the shell it is told: PowerShell backtick, bash backslash', () => {
    expect(shapes('gh pr `\r\n  ready 201', 'pwsh').ready).toBe(true);
    expect(shapes('gh pr \\\nready 201', 'bash').ready).toBe(true);
    expect(shapes('gh pr edit 201 `\r\n  --add-label review:coderabbit', 'pwsh').label?.labels).toEqual(['review:coderabbit']);
    expect(shapes('gh pr edit 201 \\\n  --add-label review:coderabbit', 'bash').label?.labels).toEqual(['review:coderabbit']);
  });

  it('C5 repos: one entry per gated invocation; an unnamed or non-literal repo is null; a compound command cannot hide a second one', () => {
    const CCV3 = 'rev4nchist/continuous-claude-v3';
    expect(shapes('gh pr ready 201', 'bash').repos).toEqual([null]);
    expect(shapes('gh pr ready 201 -R someone/else', 'bash').repos).toEqual(['someone/else']);
    expect(shapes('gh pr edit 201 --repo Someone/Else --add-label review:none', 'pwsh').repos).toEqual(['someone/else']);
    expect(shapes('gh pr ready 201 -R Rev4nchist/Continuous-Claude-v3', 'bash').repos).toEqual([CCV3]);
    expect(shapes('gh pr ready 201 -R "$TARGET"', 'bash').repos).toEqual([null]);
    // The critic's compound case: the first command is foreign, the second names nothing, so the checkout (CCv3) decides it.
    expect(shapes('gh pr ready 1 -R a/b; gh pr ready 2', 'bash').repos).toEqual(['a/b', null]);
    expect(shapes('gh pr ready 1 -R a/b && gh pr edit 2 --add-label review:none', 'bash').repos).toEqual(['a/b', null]);
    // A mention inside quotes cannot be told from a command in raw text, so it fails closed: a null entry is present.
    expect(shapes("echo 'gh pr ready 1 -R a/b'; gh pr ready 2", 'bash').repos).toContain(null);
  });

  it('C4 empty stdin, a missing --shell and a bad --shell exit 2 with a stderr line and no stdout', () => {
    for (const [stdin, args] of [
      ['', ['--shell', 'bash']],
      ['   \n', ['--shell', 'pwsh']],
      ['gh pr ready 201', []],
      ['gh pr ready 201', ['--shell', 'zsh']],
      ['gh pr ready 201', ['--shell']],
    ] as [string, string[]][]) {
      const r = run(stdin, ...args);
      expect(r.status, `${JSON.stringify(stdin)} ${args.join(' ')}`).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr.trim().length).toBeGreaterThan(0);
    }
  });
});
