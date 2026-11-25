/**
 * Twin test (card coord-test-suite, PR 2): canonProject() of scripts/coordination/canon-home.mjs (the project key a probe seeds
 * into file_claims) must equal resolveRepoContext().project of shared/claim-target.ts (the key the file-claims hook writes), for the
 * path run-probes.mjs gives a probe: $CCV3_USER_HOME/continuous-claude, a plain folder or a link. Both are the REAL functions: no
 * logic is copied here. A real `git init` and a real `git worktree add`, real links (junctions on Windows).
 *
 * Rows, with the source change that breaks each:
 *  1. a plain clone: breaks when canonProject stops lower-casing / normalising the path (normalizeProjectKey).
 *  2. a link to a clone: breaks when canonProject keeps the link path instead of the real path (the first Linux CI failure of the
 *     probes: lease 27 of 46, degradation 5 of 14).
 *  3. a link to a linked worktree: the hook key is the PRIMARY checkout (the git common dir). Breaks when canonProject uses the plain
 *     realpath (it gives the worktree path), or reads `.git` but skips the `gitdir:` file or its `commondir` step.
 *  4. a folder that does not exist: the hook gives null; canonProject keeps the plain path (probe-scratch-guard test Q2). Breaks
 *     when canonProject throws or returns another form for a missing folder.
 *
 * Cleanup never deletes recursively over a link: a recursive delete follows a Windows junction and empties its target
 * (memory worktree-junction-remove). Each link is removed first and checked, then the root.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-ignore TS7016: canon-home.mjs has no declaration file. The REAL .mjs helper of the probes.
import { canonProject } from '../../../../scripts/coordination/canon-home.mjs';
import { resolveRepoContext } from '../shared/claim-target.js';
import { normalizeProjectKey } from '../shared/session-id.js';

let root: string;
let links: string[];

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd, stdio: 'ignore' });
}
function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}
/** A stand-in home that holds `continuous-claude` as a link to `target`. Returns the home. */
function homeLinkedTo(name: string, target: string): string {
  const home = join(root, name);
  mkdirSync(home);
  const link = join(home, 'continuous-claude');
  symlinkSync(target, link, 'junction');
  links.push(link);
  return home;
}
const hookProject = (home: string): string | undefined => resolveRepoContext(join(home, 'continuous-claude'))?.project;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'canon-twin-')));
  links = [];
});
afterEach(() => {
  for (const link of links) {
    unlinkSync(link); // the link only, never its target
    expect(() => lstatSync(link)).toThrow(); // gone: only then is a recursive delete of root safe
  }
  rmSync(root, { recursive: true, force: true }); // no link is left under root now
});

describe('canonProject twins the project key of the file-claims hook', () => {
  it('1. a plain clone', () => {
    const home = join(root, 'h1');
    makeRepo(join(home, 'continuous-claude'));
    expect(hookProject(home)).toBeTruthy();
    expect(canonProject(home)).toBe(hookProject(home));
  });

  it('2. a link to a clone', () => {
    const clone = makeRepo(join(root, 'clone-a'));
    const home = homeLinkedTo('h2', clone);
    expect(canonProject(home)).toBe(hookProject(home));
    expect(canonProject(home)).toBe(normalizeProjectKey(clone.replace(/\\/g, '/')));
    expect(canonProject(home)).not.toContain('h2'); // not the link path
  });

  it('3. a link to a linked worktree gives the key of the PRIMARY checkout', () => {
    const clone = makeRepo(join(root, 'clone-b'));
    const wt = join(root, 'clone-b-wt');
    git(clone, 'worktree', 'add', '-q', wt, '-b', 'b-wt');
    const home = homeLinkedTo('h3', wt);
    expect(canonProject(home)).toBe(hookProject(home));
    expect(canonProject(home)).toBe(normalizeProjectKey(clone.replace(/\\/g, '/')));
    expect(canonProject(home)).not.toBe(normalizeProjectKey(wt.replace(/\\/g, '/'))); // the plain realpath would give this
  });

  it('4. a folder that does not exist keeps the plain path (the hook gives null)', () => {
    const home = join(root, 'h4-none');
    expect(hookProject(home)).toBeUndefined();
    expect(canonProject(home)).toBe(normalizeProjectKey(join(home, 'continuous-claude')));
  });
});
