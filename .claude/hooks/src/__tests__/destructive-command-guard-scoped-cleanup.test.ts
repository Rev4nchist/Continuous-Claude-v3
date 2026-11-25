/**
 * Scoped cleanup allow rule (item 9.1 of the 2026-10-31 guard replay).
 *
 * destructive-command-guard allows ONE shape: the whole command is exactly one bare recursive
 * delete of one literal absolute path, and that path lies under (a) the current session's
 * scratchpad or (b) <primary repo>/.claude/worktrees/<name>. Everything else keeps today's
 * ask (interactive) / deny (unattended) behaviour.
 *
 * Failure modes this file pins, one test each (the doubt cases must all fall through):
 *   escape by `..`, a junction inside a root, a sibling that only shares a prefix, the roots
 *   themselves, another session's scratchpad, a missing session id, variables, globs, two paths,
 *   chaining, redirection, unbalanced quotes, a leading env assignment, a `cd` first, a relative
 *   path, `git worktree remove`, a path outside both roots, an unusable realpath, no git.
 * Plus the allow cases for both roots in the bash and PowerShell forms.
 *
 * Real directories, real junctions and a real git repo with a linked worktree are created under a
 * temp dir. The guard is told that temp dir as its tmpdir (deps.tmpdir), so nothing touches the
 * real <tmp>/claude tree. Nothing here runs a delete.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { decide } from '../destructive-command-guard.js';
import type { ScopedCleanupDeps } from '../shared/scoped-cleanup.js';

const WIN = process.platform === 'win32';
const SID = '11111111-2222-3333-4444-555555555555';
const OTHER_SID = '99999999-8888-7777-6666-555555555555';
const SLUG = 'C--Users-someone-project';

let TMP = '';
let SCRATCH = '';
let REPO = '';
let WT = '';
let WT_ROOT = '';
let OUTSIDE = '';
let LINKED_WT = '';
let REPO_JW = '';
let REPO_JC = '';
const OUTSIDE_CLAUDE_NAME = 'outside-claude';
let OUTSIDE_CLAUDE = '';
const deps = () => ({ tmpdir: TMP });

type Tool = 'Bash' | 'PowerShell';
const input = (tool: Tool, extra: Record<string, unknown> = {}) =>
  ({ tool_name: tool, permission_mode: 'default', session_id: SID, cwd: REPO, ...extra });

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, stdio: 'ignore', windowsHide: true,
  });
}

beforeAll(() => {
  TMP = mkdtempSync(join(realpathSync.native(tmpdir()), 'scoped-cleanup-'));
  SCRATCH = join(TMP, 'claude', SLUG, SID, 'scratchpad');
  mkdirSync(join(SCRATCH, 'sub', 'deep'), { recursive: true });
  mkdirSync(join(TMP, 'claude', SLUG, SID, 'scratchpad2', 'sub'), { recursive: true });
  mkdirSync(join(TMP, 'claude', SLUG, OTHER_SID, 'scratchpad', 'sub'), { recursive: true });
  OUTSIDE = join(TMP, 'outside');
  mkdirSync(join(OUTSIDE, 'precious'), { recursive: true });
  symlinkSync(OUTSIDE, join(SCRATCH, 'link'), 'junction');

  REPO = join(TMP, 'repo');
  mkdirSync(REPO, { recursive: true });
  git(REPO, 'init', '-q');
  writeFileSync(join(REPO, 'a.txt'), 'a');
  git(REPO, 'add', 'a.txt');
  git(REPO, 'commit', '-q', '-m', 'x');
  WT_ROOT = join(REPO, '.claude', 'worktrees');
  WT = join(WT_ROOT, 'foo');
  mkdirSync(join(WT, 'src'), { recursive: true });
  mkdirSync(join(WT_ROOT, 'foo-x', 'src'), { recursive: true });
  mkdirSync(join(REPO, '.claude', 'worktrees2', 'bar'), { recursive: true });
  LINKED_WT = join(WT_ROOT, 'linked');
  git(REPO, 'worktree', 'add', '-q', '-b', 'linked-branch', LINKED_WT);
  mkdirSync(join(LINKED_WT, 'pkg'), { recursive: true });
  symlinkSync(OUTSIDE, join(WT_ROOT, 'jx'), 'junction');

  // A junction NESTED inside an otherwise allowed directory (a recursive delete may follow it).
  mkdirSync(join(SCRATCH, 'haslink'), { recursive: true });
  symlinkSync(OUTSIDE, join(SCRATCH, 'haslink', 'link'), 'junction');
  mkdirSync(join(WT_ROOT, 'nested', 'inner'), { recursive: true });
  symlinkSync(OUTSIDE, join(WT_ROOT, 'nested', 'inner', 'link'), 'junction');
  mkdirSync(join(SCRATCH, 'wide'), { recursive: true });
  for (let i = 0; i < 6; i++) writeFileSync(join(SCRATCH, 'wide', `f${i}.txt`), 'x');

  // A second repo whose .claude/worktrees (or .claude itself) is a junction to OUTSIDE the repo.
  REPO_JW = join(TMP, 'repo-jw');
  mkdirSync(join(REPO_JW, '.claude'), { recursive: true });
  git(REPO_JW, 'init', '-q');
  symlinkSync(OUTSIDE, join(REPO_JW, '.claude', 'worktrees'), 'junction');
  REPO_JC = join(TMP, 'repo-jc');
  mkdirSync(REPO_JC, { recursive: true });
  git(REPO_JC, 'init', '-q');
  OUTSIDE_CLAUDE = join(TMP, OUTSIDE_CLAUDE_NAME);
  mkdirSync(join(OUTSIDE_CLAUDE, 'worktrees', 'precious'), { recursive: true });
  symlinkSync(OUTSIDE_CLAUDE, join(REPO_JC, '.claude'), 'junction');

  buildRedirectFixtures();
}, 60_000);

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

// Fixtures for the planted-.git redirect class (TREX verify N3). REPO_B is the victim repo: a
// second, genuine repo whose .claude/worktrees/victim must never be deletable from another cwd.
let REPO_B = '';
let VICTIM = '';
let PLANT_TO_GIT = '';
let PLANT_TO_WT = '';
let PLANT_REL = '';
let PLANT_SUB = '';
let PLANT_DIR_EMPTY = '';
let PLANT_DIR_COMMONDIR = '';
let PLANT_MISSING = '';
let WT_NOLINK = '';
let WT_BADLINK = '';
let WT_BADCOMMON = '';
let WT_NOCOMMON = '';
let WT_REL = '';
let WT_CASE = '';
let JUNC_TO_B = '';
let JUNC_TO_B_WT = '';
let JUNC_IN_REPO = '';
let JUNC_TO_REPO = '';

const plantFile = (dir: string, text: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.git'), text);
};
const gitText = (p: string) => `gitdir: ${forward(p)}\n`;
/** Git marks a worktree's .git file hidden on Windows; a plain write to a hidden file is EPERM. */
const rewrite = (file: string, text: string) => {
  rmSync(file, { force: true });
  writeFileSync(file, text);
};

function linkedWorktree(name: string): string {
  const dir = join(WT_ROOT, name);
  git(REPO, 'worktree', 'add', '-q', '-b', `b-${name}`, dir);
  return dir;
}

function buildRedirectFixtures(): void {
  REPO_B = join(TMP, 'repo-b');
  mkdirSync(REPO_B, { recursive: true });
  git(REPO_B, 'init', '-q');
  writeFileSync(join(REPO_B, 'a.txt'), 'a');
  git(REPO_B, 'add', 'a.txt');
  git(REPO_B, 'commit', '-q', '-m', 'x');
  VICTIM = join(REPO_B, '.claude', 'worktrees', 'victim');
  mkdirSync(join(VICTIM, 'src'), { recursive: true });

  // A plain folder with a planted .git FILE: to a primary .git, to a real worktrees/<name>, relative.
  PLANT_TO_GIT = join(TMP, 'plant-git');
  plantFile(PLANT_TO_GIT, gitText(join(REPO_B, '.git')));
  PLANT_TO_WT = join(TMP, 'plant-wt');
  git(REPO_B, 'worktree', 'add', '-q', '-b', 'b-linked', join(TMP, 'repo-b-linked'));
  plantFile(PLANT_TO_WT, gitText(join(REPO_B, '.git', 'worktrees', 'repo-b-linked')));
  PLANT_REL = join(TMP, 'plant-rel');
  plantFile(PLANT_REL, 'gitdir: ../repo-b/.git\n');
  PLANT_MISSING = join(TMP, 'plant-missing');
  plantFile(PLANT_MISSING, gitText(join(TMP, 'nowhere', '.git')));
  // A planted file in a SUBFOLDER of the cwd path, above a cwd that sits inside a real repo's tree.
  PLANT_SUB = join(REPO, 'plant-sub');
  plantFile(PLANT_SUB, gitText(join(REPO_B, '.git')));
  mkdirSync(join(PLANT_SUB, 'deep'), { recursive: true });

  // A .git DIRECTORY in a plain folder: empty (points nowhere), and one that redirects by commondir.
  PLANT_DIR_EMPTY = join(TMP, 'plant-dir-empty');
  mkdirSync(join(PLANT_DIR_EMPTY, '.git'), { recursive: true });
  PLANT_DIR_COMMONDIR = join(TMP, 'plant-dir-commondir');
  mkdirSync(join(PLANT_DIR_COMMONDIR, '.git', 'objects'), { recursive: true });
  mkdirSync(join(PLANT_DIR_COMMONDIR, '.git', 'refs'), { recursive: true });
  writeFileSync(join(PLANT_DIR_COMMONDIR, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(PLANT_DIR_COMMONDIR, '.git', 'commondir'), `${forward(join(REPO_B, '.git'))}\n`);

  // Real linked worktrees of REPO with one thing broken or rewritten each.
  const meta = (name: string) => join(REPO, '.git', 'worktrees', name);
  WT_NOLINK = linkedWorktree('nolink');
  rmSync(join(meta('nolink'), 'gitdir'));
  WT_BADLINK = linkedWorktree('badlink');
  rewrite(join(meta('badlink'), 'gitdir'), `${forward(join(LINKED_WT, '.git'))}\n`);
  WT_BADCOMMON = linkedWorktree('badcommon');
  rewrite(join(meta('badcommon'), 'commondir'), `${forward(join(REPO_B, '.git'))}\n`);
  WT_NOCOMMON = linkedWorktree('nocommon');
  rmSync(join(meta('nocommon'), 'commondir'));
  WT_REL = linkedWorktree('rel');
  rewrite(join(WT_REL, '.git'), 'gitdir: ../../../.git/worktrees/rel\n');
  rewrite(join(meta('rel'), 'gitdir'), '../../../.claude/worktrees/rel/.git\n');
  WT_CASE = linkedWorktree('case');
  const gd = meta('case');
  rewrite(join(WT_CASE, '.git'), gitText(WIN ? gd.toUpperCase() : gd));
  if (WIN) rewrite(join(gd, 'gitdir'), `${forward(join(WT_CASE, '.git')).toLowerCase()}\n`);

  // A cwd that is itself a link: to another repo, to another repo's linked worktree, a link planted
  // inside a real repo, and a link to the repo that would otherwise own the cwd.
  JUNC_TO_B = join(TMP, 'junc-to-b');
  symlinkSync(REPO_B, JUNC_TO_B, 'junction');
  JUNC_TO_B_WT = join(TMP, 'junc-to-b-wt');
  symlinkSync(join(TMP, 'repo-b-linked'), JUNC_TO_B_WT, 'junction');
  JUNC_IN_REPO = join(REPO, 'evil-j');
  symlinkSync(REPO_B, JUNC_IN_REPO, 'junction');
  JUNC_TO_REPO = join(TMP, 'junc-to-repo');
  symlinkSync(REPO, JUNC_TO_REPO, 'junction');
}

const forward = (p: string) => p.replace(/\\/g, '/');
/** Git Bash spells C:\x as /c/x. */
const msys = (p: string) => forward(p).replace(/^([a-zA-Z]):/, (_m, d: string) => `/${d.toLowerCase()}`);

/** The command is allowed in every mode and carries the scoped marker. */
function expectScoped(command: string, tool: Tool, which: 'scratchpad' | 'worktree', extra: Record<string, unknown> = {}): void {
  for (const permission_mode of ['default', 'bypassPermissions']) {
    const d = decide(command, input(tool, { permission_mode, ...extra }), {}, deps());
    expect({ command, mode: permission_mode, decision: d.decision }).toEqual({ command, mode: permission_mode, decision: 'allow' });
    expect(d.scoped).toBe(which);
    expect(d.override).toBeUndefined();
  }
}

/** Today's behaviour: ask when interactive, deny when unattended. No scoped marker. */
function expectGated(command: string, tool: Tool, extra: Record<string, unknown> = {}, d2: ScopedCleanupDeps = deps()): void {
  const ask = decide(command, input(tool, { permission_mode: 'default', ...extra }), {}, d2);
  expect({ command, decision: ask.decision }).toEqual({ command, decision: 'ask' });
  expect(ask.scoped).toBeUndefined();
  const deny = decide(command, input(tool, { permission_mode: 'bypassPermissions', ...extra }), {}, d2);
  expect({ command, decision: deny.decision }).toEqual({ command, decision: 'deny' });
  expect(deny.scoped).toBeUndefined();
}

describe('scoped cleanup: allow cases', () => {
  it('bash: rm -rf of a double-quoted path inside the session scratchpad', () => {
    expectScoped(`rm -rf "${join(SCRATCH, 'sub')}"`, 'Bash', 'scratchpad');
  });

  it('bash: single-quoted and unquoted forward-slash paths, and the flag spellings -fr, -r -f, -f -r', () => {
    const p = join(SCRATCH, 'sub');
    expectScoped(`rm -rf '${p}'`, 'Bash', 'scratchpad');
    expectScoped(`rm -rf ${forward(p)}`, 'Bash', 'scratchpad');
    expectScoped(`rm -fr ${forward(p)}`, 'Bash', 'scratchpad');
    expectScoped(`rm -r -f ${forward(p)}`, 'Bash', 'scratchpad');
    expectScoped(`rm -f -r ${forward(p)}`, 'Bash', 'scratchpad');
  });

  it.runIf(WIN)('bash on Windows: the Git Bash drive form /c/Users/... is understood', () => {
    expectScoped(`rm -rf ${msys(join(SCRATCH, 'sub'))}`, 'Bash', 'scratchpad');
    expectScoped(`rm -rf "${msys(join(WT, 'src'))}"`, 'Bash', 'worktree');
  });

  it('bash: a worktree directory itself, and a path inside it', () => {
    expectScoped(`rm -rf "${WT}"`, 'Bash', 'worktree');
    expectScoped(`rm -rf "${join(WT, 'src')}"`, 'Bash', 'worktree');
  });

  it('powershell: Remove-Item -Recurse with -Path, -LiteralPath, a positional path and any order', () => {
    const p = join(SCRATCH, 'sub');
    expectScoped(`Remove-Item -Recurse -Force -Path '${p}'`, 'PowerShell', 'scratchpad');
    expectScoped(`Remove-Item -LiteralPath "${p}" -Recurse`, 'PowerShell', 'scratchpad');
    expectScoped(`remove-item -force -recurse -path ${p}`, 'PowerShell', 'scratchpad');
    expectScoped(`Remove-Item '${p}' -Recurse -Force`, 'PowerShell', 'scratchpad');
    expectScoped(`Remove-Item -Path '${WT}' -Recurse -Force`, 'PowerShell', 'worktree');
    expectScoped(`Remove-Item -Path '${join(WT, 'src')}' -Recurse`, 'PowerShell', 'worktree');
  });

  it('worktree root comes from the primary checkout even when cwd is inside a linked worktree or a subfolder', () => {
    const target = `rm -rf "${join(WT, 'src')}"`;
    expectScoped(target, 'Bash', 'worktree', { cwd: LINKED_WT });
    expectScoped(target, 'Bash', 'worktree', { cwd: join(LINKED_WT, 'pkg') });
    expectScoped(`rm -rf "${LINKED_WT}"`, 'Bash', 'worktree', { cwd: join(LINKED_WT, 'pkg') });
  });

  it('a trailing separator on an allowed target still allows', () => {
    expectScoped(`rm -rf "${forward(join(WT, 'src'))}/"`, 'Bash', 'worktree');
    expectScoped(`Remove-Item -Recurse -Path '${join(SCRATCH, 'sub')}${WIN ? '\\' : '/'}'`, 'PowerShell', 'scratchpad');
  });

  it('scratchpad needs no cwd at all', () => {
    expectScoped(`rm -rf "${join(SCRATCH, 'sub')}"`, 'Bash', 'scratchpad', { cwd: undefined });
  });

  it.runIf(WIN)('windows: mixed slashes, a lower-case drive letter and an upper-cased path all match', () => {
    const p = join(SCRATCH, 'sub');
    expectScoped(`rm -rf "${p[0].toLowerCase()}${p.slice(1)}"`, 'Bash', 'scratchpad');
    expectScoped(`rm -rf "${p.replace(/\\/g, '/')}"`, 'Bash', 'scratchpad');
    expectScoped(`rm -rf "${p.replace(/\\(?=[^\\]*$)/, '/')}"`, 'Bash', 'scratchpad');
    expectScoped(`Remove-Item -Recurse -Path '${p.toUpperCase()}'`, 'PowerShell', 'scratchpad');
    expectScoped(`rm -rf "${join(WT, 'src').toUpperCase()}"`, 'Bash', 'worktree');
  });
});

describe('scoped cleanup: path boundaries stay gated', () => {
  it('a .. segment is refused, also when the lexical result is still inside the root', () => {
    expectGated(`rm -rf "${SCRATCH}${WIN ? '\\' : '/'}..${WIN ? '\\' : '/'}..${WIN ? '\\' : '/'}evil"`, 'Bash');
    expectGated(`rm -rf "${forward(WT)}/src/../../../../evil"`, 'Bash');
    // lexically `scratchpad/sub`; physically `link/..` is outside the root. Never normalise it away.
    expectGated(`rm -rf "${forward(SCRATCH)}/link/../sub"`, 'Bash');
    expectGated(`rm -rf "${forward(SCRATCH)}/sub/../sub"`, 'Bash');
    expectGated(`Remove-Item -Recurse -Path '${SCRATCH}\\..\\..\\evil'`, 'PowerShell');
  });

  it('a junction inside the scratchpad that points outside is denied, as the link and as a parent', () => {
    expectGated(`rm -rf "${join(SCRATCH, 'link')}"`, 'Bash');
    expectGated(`rm -rf "${join(SCRATCH, 'link', 'precious')}"`, 'Bash');
    expectGated(`Remove-Item -Recurse -Force -Path '${join(SCRATCH, 'link', 'precious')}'`, 'PowerShell');
  });

  it('a junction inside .claude/worktrees that points outside is denied', () => {
    expectGated(`rm -rf "${join(WT_ROOT, 'jx')}"`, 'Bash');
    expectGated(`rm -rf "${join(WT_ROOT, 'jx', 'precious')}"`, 'Bash');
  });

  // Critic blocker: the root itself was realpath-followed, so a repo whose .claude/worktrees is a
  // junction made everything under the junction target deletable in every mode.
  it('a worktrees root that is itself a junction to outside the repo is denied', () => {
    expectGated(`rm -rf "${join(REPO_JW, '.claude', 'worktrees', 'precious')}"`, 'Bash', { cwd: REPO_JW });
    expectGated(`Remove-Item -Recurse -Force -Path '${join(REPO_JW, '.claude', 'worktrees', 'precious')}'`, 'PowerShell', { cwd: REPO_JW });
  });

  it('a .claude folder that is itself a junction to outside the repo is denied', () => {
    expectGated(`rm -rf "${join(REPO_JC, '.claude', 'worktrees', 'precious')}"`, 'Bash', { cwd: REPO_JC });
  });

  // Critic major: a recursive delete can descend into a junction nested below an allowed directory.
  it('a junction nested inside an allowed directory is denied: the scratchpad and a worktree', () => {
    expectGated(`rm -rf "${join(SCRATCH, 'haslink')}"`, 'Bash');
    expectGated(`Remove-Item -Recurse -Force -Path '${join(SCRATCH, 'haslink')}'`, 'PowerShell');
    expectGated(`rm -rf "${join(WT_ROOT, 'nested')}"`, 'Bash');
  });

  it('a tree with more entries than the scan cap is denied; under the cap it is allowed', () => {
    const p = `rm -rf "${join(SCRATCH, 'wide')}"`;
    expectGated(p, 'Bash', {}, { tmpdir: TMP, maxEntries: 3 });
    expectScoped(p, 'Bash', 'scratchpad');
  });

  // Critic minor: toLowerCase folds U+212A (Kelvin) to k, which NTFS does not.
  it('a non-ASCII look-alike of a root segment is denied', () => {
    expectGated(`rm -rf "${join(REPO, '.claude', 'worKtrees', 'foo')}"`, 'Bash');
    expectGated(`rm -rf "${join(TMP, 'claude', SLUG, SID, 'scratchpad', 'süb')}"`, 'Bash');
  });

  it('a path that only shares a prefix with a root is denied: scratchpad2, worktrees2', () => {
    expectGated(`rm -rf "${join(TMP, 'claude', SLUG, SID, 'scratchpad2', 'sub')}"`, 'Bash');
    expectGated(`rm -rf "${join(REPO, '.claude', 'worktrees2', 'bar')}"`, 'Bash');
    expectGated(`rm -rf "${join(TMP, 'claude', SLUG, SID, 'scratchpadX')}"`, 'Bash');
  });

  it('the roots themselves are denied: the scratchpad, .claude/worktrees, <tmp>/claude and the session folder', () => {
    expectGated(`rm -rf "${SCRATCH}"`, 'Bash');
    expectGated(`rm -rf "${forward(SCRATCH)}/"`, 'Bash');
    expectGated(`rm -rf "${WT_ROOT}"`, 'Bash');
    expectGated(`rm -rf "${forward(WT_ROOT)}/"`, 'Bash');
    expectGated(`rm -rf "${join(REPO, '.claude')}"`, 'Bash');
    expectGated(`rm -rf "${REPO}"`, 'Bash');
    expectGated(`rm -rf "${join(TMP, 'claude')}"`, 'Bash');
    expectGated(`rm -rf "${join(TMP, 'claude', SLUG, SID)}"`, 'Bash');
    expectGated(`Remove-Item -Recurse -Force -Path '${WT_ROOT}'`, 'PowerShell');
    expectGated(`Remove-Item -Recurse -Force -Path '${SCRATCH}'`, 'PowerShell');
  });

  it("another session's scratchpad is denied", () => {
    expectGated(`rm -rf "${join(TMP, 'claude', SLUG, OTHER_SID, 'scratchpad', 'sub')}"`, 'Bash');
  });

  it('a missing, empty or path-like session id never matches a scratchpad', () => {
    const p = `rm -rf "${join(SCRATCH, 'sub')}"`;
    expectGated(p, 'Bash', { session_id: undefined });
    expectGated(p, 'Bash', { session_id: '' });
    expectGated(p, 'Bash', { session_id: '..' });
    expectGated(p, 'Bash', { session_id: `${SID}/..` });
  });

  it('a path outside both roots keeps today\'s behaviour: tmp elsewhere, the repo, a sibling folder', () => {
    expectGated(`rm -rf "${join(TMP, 'other')}"`, 'Bash');
    expectGated(`rm -rf "${join(REPO, 'node_modules')}"`, 'Bash');
    expectGated(`Remove-Item -Recurse -Force -Path '${join(REPO, 'src')}'`, 'PowerShell');
  });

  it('a relative path is denied even when it would land inside a root', () => {
    expectGated('rm -rf .claude/worktrees/foo', 'Bash');
    expectGated(`Remove-Item -Recurse -Path .\\.claude\\worktrees\\foo`, 'PowerShell');
  });

  it.runIf(WIN)('windows: a trailing dot or space on a segment, an alternate data stream and a UNC path are denied', () => {
    expectGated(`rm -rf "${join(SCRATCH, 'sub') + '.'}"`, 'Bash');
    expectGated(`rm -rf "${join(SCRATCH, 'sub') + ' '}"`, 'Bash');
    expectGated(`rm -rf "${join(SCRATCH, 'sub') + ':stream'}"`, 'Bash');
    expectGated(`Remove-Item -Recurse -Path '\\\\server\\share\\claude\\${SLUG}\\${SID}\\scratchpad\\x'`, 'PowerShell');
  });
});

describe('scoped cleanup: anything but one literal path falls through', () => {
  const p = () => forward(join(SCRATCH, 'sub'));

  it('variables and expansions: $VAR, ${VAR}, %VAR%, $env:X, $(...), backticks', () => {
    expectGated('rm -rf "$HOME/x"', 'Bash');
    expectGated(`rm -rf "\${TMPDIR}/claude/${SLUG}/${SID}/scratchpad/x"`, 'Bash');
    expectGated(`rm -rf "%TEMP%/claude/${SLUG}/${SID}/scratchpad/x"`, 'Bash');
    expectGated(`rm -rf "${p()}/$X"`, 'Bash');
    expectGated(`rm -rf "$(echo ${p()})"`, 'Bash');
    expectGated('rm -rf "`echo x`"', 'Bash');
    expectGated(`Remove-Item -Recurse -Force -Path $env:TEMP\\claude\\${SLUG}\\${SID}\\scratchpad\\x`, 'PowerShell');
    expectGated(`Remove-Item -Recurse -Force -Path "$env:TEMP\\x"`, 'PowerShell');
    expectGated(`Remove-Item -Recurse -Force -Path '${join(SCRATCH, 'sub')}' -Confirm:$false`, 'PowerShell');
  });

  it('globs and tilde: * ? [ ] ~', () => {
    expectGated(`rm -rf "${p()}/*"`, 'Bash');
    expectGated(`rm -rf ${p()}/*`, 'Bash');
    expectGated(`rm -rf "${p()}/?"`, 'Bash');
    expectGated(`rm -rf "${p()}/[a]"`, 'Bash');
    expectGated('rm -rf ~/x', 'Bash');
    expectGated(`Remove-Item -Recurse -Path '${join(SCRATCH, 'sub')}\\*'`, 'PowerShell');
    expectGated(`Remove-Item -Recurse -Path '${join(SCRATCH, 'sub')}\\[a]'`, 'PowerShell');
  });

  it('two paths: bash, PowerShell array with a comma, PowerShell -Path plus positional', () => {
    expectGated(`rm -rf ${p()} ${p()}`, 'Bash');
    expectGated(`rm -rf "${p()}" "${p()}"`, 'Bash');
    expectGated(`Remove-Item -Recurse -Path '${join(SCRATCH, 'sub')}','${join(SCRATCH, 'sub', 'deep')}'`, 'PowerShell');
    expectGated(`Remove-Item -Recurse -Path '${join(SCRATCH, 'sub')}' '${join(SCRATCH, 'sub', 'deep')}'`, 'PowerShell');
    expectGated(`Remove-Item -Recurse -Path '${join(SCRATCH, 'sub')}' -LiteralPath '${join(SCRATCH, 'sub', 'deep')}'`, 'PowerShell');
  });

  it('chained or piped commands: ;  &&  ||  |  &  newline', () => {
    const rm = `rm -rf ${p()}`;
    expectGated(`${rm}; echo done`, 'Bash');
    expectGated(`${rm} && echo done`, 'Bash');
    expectGated(`${rm} || true`, 'Bash');
    expectGated(`${rm} | cat`, 'Bash');
    expectGated(`${rm} &`, 'Bash');
    expectGated(`${rm}\necho done`, 'Bash');
    expectGated(`echo hi && ${rm}`, 'Bash');
    expectGated(`Remove-Item -Recurse -Path '${join(SCRATCH, 'sub')}'; Get-Date`, 'PowerShell');
    expectGated(`Remove-Item -Recurse -Path '${join(SCRATCH, 'sub')}' | Out-Null`, 'PowerShell');
    expectGated(`Remove-Item -Recurse -Path '${join(SCRATCH, 'sub')}'\nGet-Date`, 'PowerShell');
  });

  it('redirection, a cd first, a leading env assignment, a subshell and a wrapper', () => {
    expectGated(`rm -rf ${p()} > out.txt`, 'Bash');
    expectGated(`rm -rf ${p()} 2>/dev/null`, 'Bash');
    expectGated(`cd ${p()} && rm -rf ${p()}/deep`, 'Bash');
    expectGated(`FOO=1 rm -rf ${p()}`, 'Bash');
    expectGated(`(rm -rf ${p()})`, 'Bash');
    expectGated(`sudo rm -rf ${p()}`, 'Bash');
    expectGated(`bash -c "rm -rf ${p()}"`, 'Bash');
  });

  it('unbalanced or glued quotes', () => {
    expectGated(`rm -rf "${p()}`, 'Bash');
    expectGated(`rm -rf '${p()}`, 'Bash');
    expectGated(`rm -rf ${p()}"`, 'Bash');
    expectGated(`rm -rf "${p()}"x`, 'Bash');
    expectGated(`rm -rf "${p()}"'/deep'`, 'Bash');
    expectGated(`Remove-Item -Recurse -Path '${join(SCRATCH, 'sub')}`, 'PowerShell');
    expectGated(`Remove-Item -Recurse -Path '${join(SCRATCH, 'sub')}''x'`, 'PowerShell');
  });

  it('a backslash that bash would eat, in an unquoted path or before the closing quote', () => {
    if (WIN) expectGated(`rm -rf ${join(SCRATCH, 'sub')}`, 'Bash');
    expectGated(`rm -rf "${join(SCRATCH, 'sub')}\\"`, 'Bash');
  });

  it('extra flags, a missing -f is not part of the shape, and other verbs', () => {
    expectGated(`rm -rf -v ${p()}`, 'Bash');
    expectGated(`rm -rf --no-preserve-root ${p()}`, 'Bash');
    expectGated(`rm -r ${p()}`, 'Bash');
    expectGated(`rm --recursive --force ${p()}`, 'Bash');
    expectGated(`Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -Path '${join(SCRATCH, 'sub')}'`, 'PowerShell');
    expectGated(`Remove-Item -r -Force -Path '${join(SCRATCH, 'sub')}'`, 'PowerShell');
    expectGated(`ri -Recurse -Path '${join(SCRATCH, 'sub')}'`, 'PowerShell');
  });

  it('each shape is only accepted on its own tool', () => {
    expectGated(`rm -rf ${p()}`, 'PowerShell');
  });
});

describe('scoped cleanup: nothing else changes', () => {
  it('git worktree remove --force stays gated even on a worktree path', () => {
    expectGated(`git worktree remove --force "${WT}"`, 'Bash');
    expectGated(`git -C "${REPO}" worktree remove --force "${WT}"`, 'PowerShell');
  });

  it('a command with no destructive pattern is still plainly allowed, with no scoped marker', () => {
    const d = decide('git status', input('Bash'), {}, deps());
    expect(d).toEqual({ decision: 'allow' });
  });

  it('the override prefix keeps its own result: allow with override, no scoped marker', () => {
    const d = decide(`SKIP_DESTRUCTIVE_GUARD=1 rm -rf "${join(SCRATCH, 'sub')}"`, input('Bash', { permission_mode: 'default' }), {}, deps());
    expect(d.decision).toBe('allow');
    expect(d.override).toBe(true);
    expect(d.scoped).toBeUndefined();
  });

  it('CLAUDE_AGENT_ID (subagent) keeps denying a non-matching delete and allows a matching one', () => {
    const env = { CLAUDE_AGENT_ID: 'a' };
    expect(decide('rm -rf x', input('Bash'), env, deps()).decision).toBe('deny');
    const ok = decide(`rm -rf "${join(SCRATCH, 'sub')}"`, input('Bash'), env, deps());
    expect(ok.decision).toBe('allow');
    expect(ok.scoped).toBe('scratchpad');
  });
});

describe('scoped cleanup: fails closed when it cannot check', () => {
  it('a realpath that throws for everything denies', () => {
    const broken = { tmpdir: TMP, realpath: () => { throw new Error('EPERM'); } };
    expectGated(`rm -rf "${join(SCRATCH, 'sub')}"`, 'Bash', {}, broken);
    expectGated(`rm -rf "${WT}"`, 'Bash', {}, broken);
  });

  it('no git (or no repo) denies the worktree root but still allows the scratchpad', () => {
    const noGit = { tmpdir: TMP, gitCommonDir: () => null };
    expectGated(`rm -rf "${WT}"`, 'Bash', {}, noGit);
    const ok = decide(`rm -rf "${join(SCRATCH, 'sub')}"`, input('Bash'), {}, noGit);
    expect(ok.decision).toBe('allow');
  });

  it('a missing cwd denies the worktree root', () => {
    expectGated(`rm -rf "${WT}"`, 'Bash', { cwd: undefined });
  });

  it('a cwd that is not inside a git repo denies the worktree root', () => {
    expectGated(`rm -rf "${WT}"`, 'Bash', { cwd: OUTSIDE });
  });
});

// TREX verify N3 (CRITICAL): worktreesRoot trusted `git rev-parse --git-common-dir` for the payload
// cwd, so a planted `.git` FILE made git report ANOTHER repo and the allow ran under that repo.
// The repo that owns cwd must be proven genuine from the files on disk.
describe('scoped cleanup: a planted .git cannot redirect the worktrees root', () => {
  const victim = () => `rm -rf "${join(VICTIM, 'src')}"`;
  const own = () => `rm -rf "${join(WT, 'src')}"`;

  it('a .git file naming another repo .git is refused (the primary-.git redirect)', () => {
    expectGated(victim(), 'Bash', { cwd: PLANT_TO_GIT });
    expectGated(`Remove-Item -Recurse -Force -Path '${VICTIM}'`, 'PowerShell', { cwd: PLANT_TO_GIT });
  });

  it('a .git file naming a real worktrees/<name> of another repo is refused (the backlink names a different file)', () => {
    expectGated(victim(), 'Bash', { cwd: PLANT_TO_WT });
  });

  it('a relative gitdir in a planted file is refused', () => {
    expectGated(victim(), 'Bash', { cwd: PLANT_REL });
  });

  it('a planted file naming a gitdir that does not exist is refused', () => {
    expectGated(victim(), 'Bash', { cwd: PLANT_MISSING });
  });

  it('a planted .git file in a subfolder above the cwd wins over the real repo further up (nearest .git, as git does)', () => {
    expectGated(victim(), 'Bash', { cwd: join(PLANT_SUB, 'deep') });
    expectGated(own(), 'Bash', { cwd: join(PLANT_SUB, 'deep') });
  });

  it('a .git directory with nothing in it, planted in a plain folder, is refused', () => {
    expectGated(`rm -rf "${join(PLANT_DIR_EMPTY, '.claude', 'worktrees', 'x')}"`, 'Bash', { cwd: PLANT_DIR_EMPTY });
    expectGated(victim(), 'Bash', { cwd: PLANT_DIR_EMPTY });
  });

  it('a .git directory whose commondir file redirects to another repo is refused', () => {
    expectGated(victim(), 'Bash', { cwd: PLANT_DIR_COMMONDIR });
  });

  it('a real linked worktree with no backlink, a backlink to another file, a wrong commondir or no commondir is refused', () => {
    for (const cwd of [WT_NOLINK, WT_BADLINK, WT_BADCOMMON, WT_NOCOMMON]) {
      expectGated(own(), 'Bash', { cwd });
    }
  });

  it('a wrong commondir does not move the allow to the other repo either', () => {
    expectGated(victim(), 'Bash', { cwd: WT_BADCOMMON });
  });

  it('legit: cwd in the primary checkout (real .git directory), its subfolder, and a second genuine repo', () => {
    expectScoped(own(), 'Bash', 'worktree', { cwd: REPO });
    expectScoped(own(), 'Bash', 'worktree', { cwd: join(REPO, '.claude') });
    expectScoped(victim(), 'Bash', 'worktree', { cwd: REPO_B });
  });

  it('legit: cwd in a linked worktree with a verified backlink and commondir', () => {
    expectScoped(own(), 'Bash', 'worktree', { cwd: LINKED_WT });
    expectScoped(own(), 'Bash', 'worktree', { cwd: join(LINKED_WT, 'pkg') });
  });

  it('legit: a linked worktree whose gitdir and backlink are relative paths', () => {
    expectScoped(own(), 'Bash', 'worktree', { cwd: WT_REL });
  });

  it.runIf(WIN)('legit on Windows: an upper-cased gitdir path and a lower-cased backlink still verify', () => {
    expectScoped(own(), 'Bash', 'worktree', { cwd: WT_CASE });
    expectScoped(own(), 'Bash', 'worktree', { cwd: WT_CASE.toUpperCase() });
  });

  it('a genuine repo is not the owner of another repo path: the victim is not reachable from REPO', () => {
    expectGated(victim(), 'Bash', { cwd: REPO });
    expectGated(victim(), 'Bash', { cwd: LINKED_WT });
  });

  // Reviewer finding: git follows a cwd junction to the other repo and names its .git, and the
  // on-disk proof of that repo passes. The cwd must be a real path, not reached through a link.
  it('a cwd that is a junction to another repo or to its linked worktree is refused', () => {
    expectGated(victim(), 'Bash', { cwd: JUNC_TO_B });
    expectGated(`Remove-Item -Recurse -Force -LiteralPath '${VICTIM}'`, 'PowerShell', { cwd: JUNC_TO_B });
    expectGated(victim(), 'Bash', { cwd: JUNC_TO_B_WT });
  });

  it('a junction planted inside a real repo that points to another repo is refused as a cwd', () => {
    expectGated(victim(), 'Bash', { cwd: JUNC_IN_REPO });
    expectGated(own(), 'Bash', { cwd: JUNC_IN_REPO });
  });

  it('a cwd reached through a link to its own repo is refused too (fail closed)', () => {
    expectGated(own(), 'Bash', { cwd: JUNC_TO_REPO });
    expectGated(own(), 'Bash', { cwd: join(JUNC_TO_REPO, '.claude') });
  });
});
