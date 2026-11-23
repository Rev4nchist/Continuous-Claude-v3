/**
 * Card coord-file-guard-hint-line: the hint lines of the file-claims deny text. Message text only. No verdict changes.
 *
 * Ways it can fail (one test or row each):
 *  R1. The printed release command starts with `~/` (PowerShell passes `~` to a native command as plain text), or the form
 *      differs between the shell deny and the Edit deny.
 *  R2. A claim with a repo-relative path gets no `Repo:` line (a holder with one relative path in two repos can free the
 *      wrong claim), or the --list form (a stored absolute path) gets one.
 *  R4. A shell deny that keeps the whole text (a `$(`, a `( )`, a `#`, a line before it that is no note command, such as
 *      `$t = ...`) gives no hint about the scratch-file way, or the hint shows for an Edit or Write deny.
 *  R5. A change of the text moves a verdict. The table runs the real classifier: every deny stays deny, every none stays none.
 *      It runs before and after the text change; both outputs go in the PR Evidence.
 *
 * The DB module is mocked (pattern of file-claims-all-writers.test.ts); the repo is a real temp git repo.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveRepoContext } from '../shared/claim-target.js';
import { classifyShellText } from '../shared/write-targets.js';

const seen = vi.hoisted(() => ({
  payload: '',
  blocked: new Set<string>(),
  held: [] as Array<{ filePath: string; sessionId: string; project: string }>,
}));

vi.mock('../shared/db-utils-pg.js', () => ({
  resolveFileClaim: async (filePath: string) =>
    seen.blocked.has(filePath)
      ? { outcome: 'blocked', holder: 'other-session', leaseClass: 'edit', leaseExpired: false }
      : { outcome: 'granted' },
  listBlockingClaims: async () => ({ claims: seen.held, degraded: false }),
}));
vi.mock('../shared/holder-lane.js', () => ({ holderHoldsOpenLane: async () => true }));
vi.mock('fs', async (importOriginal) => {
  const real = (await importOriginal()) as typeof import('fs');
  return {
    ...real,
    readFileSync: ((p: unknown, ...rest: unknown[]) =>
      p === 0 ? seen.payload : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.readFileSync,
  };
});

let root: string;
let repo: string;
let project: string;
const saved: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd, stdio: 'ignore' });
}

type Out = { result?: string; message?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };

async function run(tool: string, toolInput: unknown): Promise<Out> {
  seen.payload = JSON.stringify({ tool_name: tool, session_id: 'me', cwd: repo, tool_input: toolInput });
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.resetModules();
  await import('../file-claims.js');
  await vi.waitFor(() => expect(out).toHaveBeenCalled());
  const text = out.mock.calls[0][0] as string;
  out.mockRestore();
  return JSON.parse(text) as Out;
}

const reason = (o: Out): string => o.hookSpecificOutput?.permissionDecisionReason ?? '';
const abs = (rel: string): string => join(repo, rel).replace(/\\/g, '/');

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fc-hint-')));
  repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'src', 'held.ts'), 'x');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  for (const k of ['CCV3_GUARD_DECISIONS_LOG', 'CCV3_FILE_CLAIMS_STATE_DIR']) saved[k] = process.env[k];
  process.env.CCV3_GUARD_DECISIONS_LOG = join(root, 'guard.jsonl');
  process.env.CCV3_FILE_CLAIMS_STATE_DIR = join(root, 'state');
  seen.blocked = new Set(['src/held.ts']);
  project = resolveRepoContext(repo)!.project;
  seen.held = [{ filePath: 'src/held.ts', sessionId: 'other-session', project }];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const HINT = 'Write the note text to a scratch file';
const HOME_CMD = 'node "$HOME/.claude/hooks/dist/release-claim.mjs"';

describe('R1: the release command works in PowerShell and Git Bash', () => {
  it('a shell deny prints the $HOME form and no ~/ form', async () => {
    const r = reason(await run('PowerShell', { command: 'Set-Content src/held.ts "x"' }));
    expect(r).toContain(`${HOME_CMD} 'src/held.ts'`);
    expect(r).not.toContain('node ~/');
  });
  it('an Edit deny prints the same form', async () => {
    const r = reason(await run('Edit', { file_path: abs('src/held.ts') }));
    expect(r).toContain(`${HOME_CMD} 'src/held.ts'`);
    expect(r).not.toContain('node ~/');
  });
  it('the --list form uses $HOME too', async () => {
    const inP = abs('.claude/cache/pre-pr/summary.md');
    seen.held = [{ filePath: inP, sessionId: 'other-session', project }];
    const r = reason(await run('Bash', { command: `echo x > '${inP}'` }));
    expect(r).toContain(`${HOME_CMD} --list`);
    expect(r).not.toContain('node ~/');
  });
});

describe('R2: the deny names the repo of a repo-relative claim', () => {
  it('a shell deny has a Repo line with the project key', async () => {
    const r = reason(await run('PowerShell', { command: 'Set-Content src/held.ts "x"' }));
    expect(r).toContain(`Repo: ${project}`);
  });
  it('an Edit deny has the same Repo line', async () => {
    const r = reason(await run('Edit', { file_path: abs('src/held.ts') }));
    expect(r).toContain(`Repo: ${project}`);
  });
  it('the --list form (a stored absolute path) has no Repo line', async () => {
    const inP = abs('.claude/cache/pre-pr/summary.md');
    seen.held = [{ filePath: inP, sessionId: 'other-session', project }];
    const r = reason(await run('Bash', { command: `echo x > '${inP}'` }));
    expect(r).toContain('--list');
    expect(r).not.toContain('Repo:');
  });
});

// The note text names a held file. These keep the whole text, so the shell deny stands. The text says why and what to do.
const KEPT_WHOLE: Array<[string, string]> = [
  ['a $( ) in the note', 'Add-Content log.md "at $(Get-Date -Format HH:mm) see src/held.ts"'],
  ['parentheses around the value', 'Add-Content log.md ("17:00 " + (Get-Date -Format HH:mm) + " read src/held.ts")'],
  ['a # comment', 'Add-Content log.md "see src/held.ts" # note'],
  // The seat case (ruling 17:45 CST): a $variable for the clock time, assigned on a line before the write.
  ['a $variable set on a line before', '$t = Get-Date -Format HH:mm\nAdd-Content log.md "$t see src/held.ts"'],
];

describe('R4: a shell deny that kept the whole note text says how to go on', () => {
  it.each(KEPT_WHOLE)('%s: the deny stands and has the scratch-file hint', async (_name, command) => {
    const o = await run('PowerShell', { command });
    expect(o.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(reason(o)).toContain(HINT);
    expect(reason(o)).toContain('#other-se');
  });
  it('a real write to the held file is denied and still names the holder', async () => {
    const o = await run('PowerShell', { command: 'Add-Content src/held.ts "x"' });
    expect(o.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(reason(o)).toContain('#other-se');
  });
  it('an Edit deny has no hint line', async () => {
    const r = reason(await run('Edit', { file_path: abs('src/held.ts') }));
    expect(r).toContain('FILE CONFLICT BLOCKED');
    expect(r).not.toContain(HINT);
  });
  it('a Write deny has no hint line', async () => {
    const r = reason(await run('Write', { file_path: abs('src/held.ts'), content: 'x' }));
    expect(r).toContain('FILE CONFLICT BLOCKED');
    expect(r).not.toContain(HINT);
  });
});

// R5: no verdict moves. The real classifier; the same rows before and after the text change.
describe('R5: the verdict of every shape stays as it is', () => {
  const held = [{
    filePath: 'src/held.ts',
    holder: 'other-session',
    project: 'p',
    forms: ['C:/p/src/held.ts', 'src/held.ts'],
    ciForms: [] as string[],
  }];
  const P = 'src/held.ts';
  const rows: Array<[string, string, string]> = [
    ['plain quoted note', `Add-Content log.md "see ${P}"`, 'none'],
    ['here-string note', `Add-Content log.md @'\nsee ${P}\n'@`, 'none'],
    ['two lines, note on the second', `Add-Content log.md "line1"\nAdd-Content log.md "see ${P}"`, 'none'],
    ['lane note', `node C:/Users/dkhay/.claude/scripts/lane.mjs note x "see ${P}"`, 'none'],
    ['variable as the value', `$t = "see ${P}"; Add-Content log.md $t`, 'mention'],
    ['$variable inside the quotes, no line before', `Add-Content log.md "$t see ${P}"`, 'none'],
    ['a $( ) in the note', `Add-Content log.md "at $(Get-Date -Format HH:mm) see ${P}"`, 'deny'],
    ['parentheses around the value', `Add-Content log.md ("17:00 " + (Get-Date -Format HH:mm) + " read ${P}")`, 'deny'],
    ['a # comment', `Add-Content log.md "see ${P}" # note`, 'deny'],
    ['$variable set on a line before', `$t = Get-Date -Format HH:mm\nAdd-Content log.md "$t see ${P}"`, 'deny'],
    ['unquoted path next to a cue', `Add-Content log.md see ${P}`, 'deny'],
    ['real write: path operand', `Add-Content ${P} "x"`, 'deny'],
    ['real write: quoted path', `Add-Content -Path '${P}' -Value 'x'`, 'deny'],
    ['real write: redirect', `echo hi > ${P}`, 'deny'],
  ];
  it.each(rows)('%s -> %s', (_name, text, want) => {
    expect(classifyShellText(text, held, true, true).kind).toBe(want);
  });
});
