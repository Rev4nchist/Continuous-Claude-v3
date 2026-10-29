/**
 * checkpoint-shapes-cli tests (PR C, RED). The built CLI that the ccv3-mods lock spawns, so the mod holds no second shell lexer
 * (memory guard-shell-lexer-arms-race). The tests run the built file the way the mod does: a command on stdin, a flag, JSON out.
 *
 * Contract, written before the code (.claude/hooks/src/checkpoint-shapes-cli.ts, built to dist/checkpoint-shapes-cli.mjs):
 *   node dist/checkpoint-shapes-cli.mjs --shell bash|pwsh     the command text on stdin
 *   prints one line of JSON: shapesOf(joinContinuations(text, shell)), the Shapes of shared/checkpoint-shapes.ts, plus `ccv3`, exit 0
 *   `ccv3` (PR C0 contract change, Dave's PR B rule "the hook never names a foreign repo; a visible CCv3 signal gates; else the
 *   checkout decides"): true when namedRepo(text, {}) of pre-pr-gate names the CCv3 fork (a CCv3 -R / --repo / GH_REPO, a CCv3
 *   endpoint, or a CCv3 PR URL anywhere in the text), else false. The CLI prints no list of foreign repos. The ccv3-mods lock
 *   treats a gated command with ccv3 false as the checkout's to decide.
 *   joinContinuations is the one in pr-opened-review-loop.ts (it needs the shell)
 *   exit 2 with a stderr line and nothing on stdout: empty stdin, a missing --shell, or a --shell that is not bash or pwsh
 *
 * How it can fail, and the test that catches it:
 *   the built file is missing (a new src/*.ts that nobody built, or the CLI not written)  -> every test, named in C0
 *   the shape keys drift from Shapes + ccv3                                                  -> C1
 *   a CCv3 signal (-R, --repo, endpoint, PR URL) is missed, or a foreign/compound text reads as CCv3 -> C5
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
    ccv3: boolean;
  };
};

describe('checkpoint-shapes-cli', () => {
  it('C0 the built CLI exists (run npm run build in .claude/hooks)', () => {
    expect(existsSync(CLI), `${CLI} is missing: add src/checkpoint-shapes-cli.ts and build it`).toBe(true);
  });

  it('C1 prints one JSON line with exactly the Shapes keys and ccv3', () => {
    const r = run('gh pr view 201', '--shell', 'bash');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n').length).toBe(1);
    expect(Object.keys(JSON.parse(r.stdout)).sort()).toEqual(['ccv3', 'create', 'label', 'nonDraft', 'nonLiteral', 'ready', 'self']);
    expect(shapes('gh pr view 201', 'bash')).toEqual({ create: false, nonDraft: false, ready: false, label: null, self: false, nonLiteral: false, ccv3: false });
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
    // The flag decides. A bash continuation inside a word joins it; PowerShell has no backslash continuation, so the word stays split.
    expect(shapes('gh pr rea\\\ndy 201', 'bash').ready).toBe(true);
    expect(shapes('gh pr rea\\\ndy 201', 'pwsh').ready).toBe(false);
  });

  it('C5 ccv3: true on a visible CCv3 signal (-R, --repo, endpoint, PR URL); false when the text names no CCv3 repo', () => {
    for (const c of [
      'gh pr ready 201 -R Rev4nchist/Continuous-Claude-v3',
      'gh pr ready 201 --repo rev4nchist/continuous-claude-v3',
      'gh api repos/Rev4nchist/Continuous-Claude-v3/issues/1/labels -f labels[]=review:none',
      'gh pr ready https://github.com/Rev4nchist/Continuous-Claude-v3/pull/9',
      'GH_REPO=Rev4nchist/Continuous-Claude-v3 gh pr ready 1',
      'gh pr ready 1 -R "Rev4nchist/Continuous-Claude-v3"',
      'gh.exe api repos/Rev4nchist/Continuous-Claude-v3/issues/7/labels -f labels[]=review:deep',
      '"gh" api repos/Rev4nchist/Continuous-Claude-v3/issues/1/labels -f labels[]=review:none',
      'gh pr ready 1 \\\n -R Rev4nchist/Continuous-Claude-v3',
    ]) expect(shapes(c, 'bash').ccv3, c).toBe(true);
    for (const c of [
      "$env:GH_REPO='Rev4nchist/Continuous-Claude-v3'; gh pr ready 1",
      'gh pr ready 1 -R "Rev4nchist/Continuous-Claude-v3"',
      'gh.exe api repos/Rev4nchist/Continuous-Claude-v3/issues/7/labels -f labels[]=review:deep',
      '"gh" api repos/Rev4nchist/Continuous-Claude-v3/issues/1/labels -f labels[]=review:none',
      'gh pr ready 1 `\r\n -R Rev4nchist/Continuous-Claude-v3',
    ]) expect(shapes(c, 'pwsh').ccv3, c).toBe(true);
    for (const c of ['gh pr ready 201', 'gh pr ready 201 -R someone/else', 'gh pr ready 1 -R a/b; gh pr ready 2']) {
      expect(shapes(c, 'bash').ccv3, c).toBe(false);
    }
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
