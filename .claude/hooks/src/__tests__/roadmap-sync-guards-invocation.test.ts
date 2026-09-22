/**
 * Git-invocation parsing + effective-cwd guard for git-commit-roadmap.
 *
 * Closes two PRE-EXISTING gaps found 2026-08-05 while proving the H2 autocommit
 * end-to-end. Both made the hook silently skip real commits, which is why the
 * `## Completed` log looked far sparser than the commit history:
 *
 *  GAP 1 -- `cd /c/Users/dave/repo && git commit` was rejected as "outside this
 *  project". `path.isAbsolute('/c/...')` is true on Windows, so `path.resolve`
 *  kept the leading slash and produced `C:\c\Users\...` -- the drive letter
 *  became a DIRECTORY -- which is not inside the project. `/c/...` is exactly
 *  what the Bash tool produces whenever a command `cd`s first.
 *
 *  GAP 2 -- `isGitCommitCommand` was `command.includes('git commit')`, which is
 *  FALSE for `git -C <path> commit`. That form was invisible to the hook, and
 *  it is the form .claude/rules/windows-platform.md recommends for the
 *  PowerShell tool (the Bash tool hangs on git/network ops).
 *
 * The two fixes are a PAIR, and the `-C` escape tests below are why: teaching
 * the hook to see `git -C <dir> commit` without also checking `-C` in
 * commitRanInProject would have re-opened D2d-10 (a foreign repo's commit
 * recorded into this project's ROADMAP) through a brand-new door.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  normalizeShellPath,
  parseGitCommitInvocations,
  containsGitCommit,
  commitRanInProject,
  extractCdTarget,
  localDateStamp,
} from '../shared/roadmap-sync-guards.js';

const isWin = process.platform === 'win32';
const PROJECT = isWin ? 'C:/Users/dave/continuous-claude' : '/home/dave/continuous-claude';

describe('normalizeShellPath', () => {
  it.runIf(isWin)('translates the Git-Bash /c/ form to a real drive path', () => {
    expect(normalizeShellPath('/c/Users/dave/repo')).toBe('C:/Users/dave/repo');
    // The regression in one line: without this, path.resolve yields C:\c\Users\...
    expect(path.resolve(normalizeShellPath('/c/Users/dave/repo')).toLowerCase())
      .toBe(path.resolve('C:/Users/dave/repo').toLowerCase());
  });

  it.runIf(isWin)('translates the Cygwin /cygdrive/c/ form', () => {
    expect(normalizeShellPath('/cygdrive/d/work')).toBe('D:/work');
  });

  it.runIf(isWin)('uppercases the drive letter and handles a bare drive', () => {
    expect(normalizeShellPath('/c')).toBe('C:/');
  });

  it.runIf(isWin)('leaves multi-letter first segments alone', () => {
    // /tmp and /usr are NOT drive references and must survive untouched.
    expect(normalizeShellPath('/tmp/x')).toBe('/tmp/x');
    expect(normalizeShellPath('/usr/local/bin')).toBe('/usr/local/bin');
  });

  it('leaves Windows and relative paths untouched', () => {
    expect(normalizeShellPath('C:/already/windows')).toBe('C:/already/windows');
    expect(normalizeShellPath('sub/dir')).toBe('sub/dir');
    expect(normalizeShellPath('')).toBe('');
  });
});

describe('parseGitCommitInvocations', () => {
  it('finds a bare git commit', () => {
    const found = parseGitCommitInvocations('git commit -m "feat: x"');
    expect(found).toHaveLength(1);
    expect(found[0].cTarget).toBeNull();
    expect(found[0].hasAmend).toBe(false);
  });

  it('finds git -C <dir> commit and captures the -C target (GAP 2)', () => {
    const found = parseGitCommitInvocations('git -C /c/Users/dave/repo commit -m "fix: y"');
    expect(found).toHaveLength(1);
    expect(found[0].cTarget).toBe('/c/Users/dave/repo');
  });

  it('is FALSE for the old substring test, proving why the gap existed', () => {
    const cmd = 'git -C /c/Users/dave/repo commit -m "fix: y"';
    expect(cmd.includes('git commit')).toBe(false); // the old implementation
    expect(containsGitCommit(cmd)).toBe(true); // the new one
  });

  it('skips value-taking global options without mistaking the value for the subcommand', () => {
    expect(containsGitCommit('git -c user.name=Dave commit -m "x"')).toBe(true);
    expect(containsGitCommit('git --git-dir /repo/.git --work-tree /repo commit -m "x"')).toBe(true);
    expect(containsGitCommit('git --no-pager -P commit -m "x"')).toBe(true);
  });

  it('reads --work-tree=<dir> and --git-dir=<dir> as directory targets', () => {
    expect(parseGitCommitInvocations('git --work-tree=/c/other commit -m "x"')[0].cTarget)
      .toBe('/c/other');
  });

  it('detects --amend per invocation', () => {
    expect(parseGitCommitInvocations('git commit --amend -m "x"')[0].hasAmend).toBe(true);
    expect(parseGitCommitInvocations('git commit -m "mentions --amend in text"')[0].hasAmend).toBe(false);
  });

  it('does not match non-commit subcommands or lookalike binaries', () => {
    expect(containsGitCommit('git status')).toBe(false);
    expect(containsGitCommit('git -C /repo log --oneline')).toBe(false);
    expect(containsGitCommit('mygit commit -m "x"')).toBe(false);
    expect(containsGitCommit('git-commit-helper run')).toBe(false);
    expect(containsGitCommit('')).toBe(false);
  });

  it('finds a commit after a cd in a compound command', () => {
    expect(containsGitCommit('cd /c/Users/dave/repo && git commit -m "x"')).toBe(true);
  });

  it('finds multiple invocations in one compound command', () => {
    const found = parseGitCommitInvocations('git commit -m "a" && git -C sub commit -m "b"');
    expect(found).toHaveLength(2);
    expect(found[0].cTarget).toBeNull();
    expect(found[1].cTarget).toBe('sub');
  });

  it('matches a full path to the git binary', () => {
    expect(containsGitCommit('"C:/Program Files/Git/cmd/git.exe" commit -m "x"')).toBe(true);
  });
});

describe('extractCdTarget', () => {
  it('scopes to before the commit even when the git call carries -C', () => {
    // Regression guard: the scope regex must swallow `-C <value>`, otherwise the
    // whole command becomes the scope and a `cd` inside the MESSAGE registers.
    expect(extractCdTarget('git -C /c/repo commit -m "cd /elsewhere is in the message"'))
      .toBeNull();
  });

  it('still finds a leading cd', () => {
    expect(extractCdTarget('cd /c/Users/dave/repo && git commit -m "x"'))
      .toBe('/c/Users/dave/repo');
  });
});

describe('commitRanInProject', () => {
  it.runIf(isWin)('ALLOWS cd into the project via the /c/ form (GAP 1 -- the live failure)', () => {
    expect(commitRanInProject('cd /c/Users/dave/continuous-claude && git commit -m "x"', PROJECT))
      .toBe(true);
  });

  it.runIf(isWin)('allows the /cygdrive/ form too', () => {
    expect(commitRanInProject('cd /cygdrive/c/Users/dave/continuous-claude && git commit -m "x"', PROJECT))
      .toBe(true);
  });

  it('allows a bare commit (cwd is the project)', () => {
    expect(commitRanInProject('git commit -m "x"', PROJECT)).toBe(true);
  });

  it('allows cd into a subdirectory', () => {
    expect(commitRanInProject('cd .claude/hooks && git commit -m "x"', PROJECT)).toBe(true);
  });

  // ---------------------------------------------------------- D2d-10 preserved
  it.runIf(isWin)('still BLOCKS cd into a foreign repo, in /c/ form', () => {
    expect(commitRanInProject('cd /c/Users/dave/other-repo && git commit -m "x"', PROJECT))
      .toBe(false);
  });

  it.runIf(isWin)('still BLOCKS a sibling sharing a name prefix', () => {
    expect(commitRanInProject('cd /c/Users/dave/continuous-claude-x && git commit -m "x"', PROJECT))
      .toBe(false);
  });

  // ------------------------------------- the hole the paired fix had to close
  it.runIf(isWin)('BLOCKS git -C <foreign repo> commit -- the new door GAP 2 opened', () => {
    // Before -C coverage this returned true: extractCdTarget saw no `cd`, so the
    // guard said "runs in cwd == projectDir" while git actually committed
    // elsewhere. Recognising the form without guarding it = D2d-10 again.
    expect(commitRanInProject('git -C /c/Users/dave/other-repo commit -m "x"', PROJECT))
      .toBe(false);
  });

  it('BLOCKS a relative -C that escapes the project', () => {
    expect(commitRanInProject('git -C ../other-repo commit -m "x"', PROJECT)).toBe(false);
  });

  it('ALLOWS a relative -C that stays inside the project', () => {
    expect(commitRanInProject('git -C .claude/hooks commit -m "x"', PROJECT)).toBe(true);
  });

  it('resolves a relative -C against the cd target, like a real shell', () => {
    expect(commitRanInProject('cd .claude && git -C hooks commit -m "x"', PROJECT)).toBe(true);
    expect(commitRanInProject('cd .claude && git -C ../../elsewhere commit -m "x"', PROJECT)).toBe(false);
  });

  it('blocks when ANY invocation in a compound command escapes', () => {
    expect(commitRanInProject('git commit -m "a" && git -C ../other commit -m "b"', PROJECT))
      .toBe(false);
  });
});

/**
 * localDateStamp: every ROADMAP writer used `toISOString().split('T')[0]`,
 * which is UTC. West of UTC that files evening work a day ahead -- the commit
 * fixing the planning-entry extractor was itself stamped 2026-08-13 on the
 * evening of the 12th. It also let two writers straddling UTC midnight
 * disagree about "today" while both matched same-day blocks by that string.
 *
 * These assertions are timezone-INDEPENDENT by construction: `new Date(y, m,
 * d, ...)` builds in local time and getFullYear/getMonth/getDate read it back
 * in local time, so they hold on any machine.
 */
describe('localDateStamp (UTC-vs-local date drift)', () => {
  it('uses the LOCAL calendar date, not the UTC one', () => {
    // 23:30 local on the 12th. In any timezone west of UTC, toISOString()
    // would already say the 13th here.
    expect(localDateStamp(new Date(2026, 7, 12, 23, 30))).toBe('2026-08-12');
  });

  it('holds at 00:30 local, where timezones EAST of UTC would still say the 11th', () => {
    expect(localDateStamp(new Date(2026, 7, 12, 0, 30))).toBe('2026-08-12');
  });

  it('zero-pads single-digit months and days', () => {
    expect(localDateStamp(new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05');
  });

  it('emits exactly YYYY-MM-DD, the shape the same-day block match depends on', () => {
    expect(localDateStamp(new Date(2026, 11, 31, 18, 45))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('defaults to now when no clock is injected', () => {
    const now = new Date();
    expect(localDateStamp()).toBe(localDateStamp(now));
  });
});
