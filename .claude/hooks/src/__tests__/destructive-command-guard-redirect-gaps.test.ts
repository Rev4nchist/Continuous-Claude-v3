/**
 * Redirect gaps (lane destructive-guard-redirect-gaps, 2026-11-08).
 *
 * A destructive command stayed allowed when a redirect sat between its words, or before a shell-wrapper
 * payload. Two causes:
 *   1. The patterns scan with `[^;&|\n]*`, which stops at the `&` of `2>&1`, `&>`, `>&2` and the `|` of `>|`.
 *      Glued forms (`rm>log -rf x`) also hide the word boundary the patterns need.
 *   2. The Fabric patterns and the shell-wrapper regexes are anchored at a segment start. A redirect before
 *      the first word, between the words, or between `-c` and the quoted payload breaks the anchor.
 *      parseExecutable also cuts a segment at the `&` of `2>&1`.
 *
 * Evidence level per group (honest scope):
 *   - G1-G6 and the Bash rows of G4: the shapes come from a generated probe matrix, and each shape was
 *     confirmed in a REAL shell (Git Bash) with a harmless stand-in (a function that records its argv, or
 *     `echo MARK >> marker.txt` for a wrapper payload): the redirect does not stop the command from running.
 *     `cmd /c` rows were confirmed through a `bash -c` stand-in, not cmd.exe.
 *   - G7 (PowerShell): `2>&1`, `*>&1`, `3>&1`, `2>$null`, `>log`, `*>log` between words were confirmed in pwsh
 *     for Remove-Item, git, az and rd. The `pwsh -c ...` and Suspend-AzFabricCapacity rows were not run in pwsh.
 *   - G5b, G8 (quoted, `$( )`, backtick and `${ }` targets: confirmed in Git Bash by hand), G9, the "stay
 *     flagged" block and the legit block are regression pins, not shell-confirmed one by one.
 * Probe + real-shell scripts: .claude/cache/e2e/2026-11-08-redirect-gaps-*.mjs (gitignored).
 * Nothing here runs a command; the classifier only reads text.
 *
 * Failure classes, one describe each:
 *   G1 an `&`/`|` redirect between the words (2>&1, &>, &>>, >&, >&N, N>&-, >|)
 *   G2 a redirect glued to a word (rm>log -rf x, git&>log reset --hard)
 *   G3 an fd-less or fd-numbered file redirect between words (>, >>, 2>, 3>, <, <<<, <>)
 *   G4 a redirect before the first word or inside a Fabric command (the segment anchor)
 *   G5 a redirect between the exec flag and the wrapper payload (seed (a): bash -c&>log "...")
 *   G6 a redirect before or inside a wrapper's launcher, interpreter or flag
 *   G7 PowerShell native redirects (2>&1, *>&1, 3>&1, 2>$null, >log, *>log)
 *   G8 a quoted redirect target, several redirects, a redirect inside $( ), `bash -c` inside a payload
 *   G9 seed (b): `>&` followed by a word stays fail-closed
 * Plus: legit commands with redirects stay allowed, and the scan stays linear.
 */

import { describe, it, expect } from 'vitest';
import { classifyDestructive, decide, extractShellWrapperPayloads } from '../destructive-command-guard.js';
import { cpuMs } from './helpers/cpu-time.js';

const bash = (c: string): string | null => classifyDestructive(c, 0, 'Bash');
const pwsh = (c: string): string | null => classifyDestructive(c, 0, 'PowerShell');

describe('G1 an &/| redirect between the words of a destructive command', () => {
  it.each([
    'rm 2>&1 -rf build',
    'rm >&2 -rf build',
    'rm 1>&2 -rf build',
    'rm &>log -rf build',
    'rm &>>log -rf build',
    'rm >&log -rf build',
    'rm >& log -rf build',
    'rm &> log -rf build',
    'rm 2>&- -rf build',
    'rm >|log -rf build',
    'git reset 2>&1 --hard HEAD~1',
    'git reset &>log --hard',
    'git push 2>&1 --force origin main',
    'git push >&2 --force origin main',
    'git clean 2>&1 -fd',
    'git checkout 2>&1 -- .',
    'git branch >|log -D feature',
    'git stash 2>&1 clear',
    'git rebase 2>&1 main',
    'rd 2>&1 /s /q build',
    'del >&2 /f x.txt',
    'find . 2>&1 -delete',
    'docker volume 2>&1 rm v1',
    'rsync -a >&2 --delete src/ dst/',
  ])('flags %s', (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });
});

describe('G2 a redirect glued to a word', () => {
  it.each([
    'rm>log -rf build',
    'rm>>log -rf build',
    'rm&>log -rf build',
    'rm>&2 -rf build',
    'rm>|log -rf build',
    'rm<in -rf build',
    'git>log reset --hard HEAD~1',
    'git&>log reset --hard',
    'git reset>&2 --hard',
    'git push --force>log origin main',
    'rd>&2 /s /q build',
    'docker>log volume rm v1',
  ])('flags %s', (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });
});

describe('G3 a plain file redirect between the words', () => {
  it.each([
    'git >log reset --hard HEAD~1',
    'git > log reset --hard',
    'git >>log reset --hard',
    'git 2>log reset --hard',
    'git 3>log reset --hard',
    'git <in reset --hard',
    'git < in reset --hard',
    'git <<<x reset --hard',
    'git <>log reset --hard',
    'git 2>/dev/null reset --hard',
    'git branch 2>log -D feature',
    'git push 2>/dev/null --force origin main',
    'git checkout < in -- .',
  ])('flags %s', (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });
});

describe('G4 a redirect before the first word, or inside a Fabric command', () => {
  it.each([
    '>log az fabric capacity suspend --name cap1',
    '2>&1 az fabric capacity suspend --name cap1',
    '&>log az fabric capacity suspend --name cap1',
    '>&2 az fabric capacity suspend --name cap1',
    'az >log fabric capacity suspend --name cap1',
    'az 2>&1 fabric capacity suspend --name cap1',
    'az fabric &>log capacity suspend --name cap1',
    'az fabric capacity >&2 suspend --name cap1',
    'az fabric capacity>log suspend --name cap1',
    'fab >log stop x.capacities/cap1.Capacity',
    '2>&1 fab stop x.capacities/cap1.Capacity',
  ])('flags %s', (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });
});

describe('G5 a redirect between the exec flag and the wrapper payload', () => {
  it.each([
    'bash -c >log "rm -rf build"', // seed (a) family: the payload follows a redirect
    'bash -c&>log "rm -rf build"', // seed (a) as reported: `bash -c&>log "npm install zz"`
    'bash -c > log "rm -rf build"',
    'bash -c 2>&1 "rm -rf build"',
    'bash -c &>log "rm -rf build"',
    'bash -c >&2 "rm -rf build"',
    'bash -c <in "rm -rf build"',
    'bash -c <<<x "rm -rf build"',
    "sh -c >log 'rm -rf build'",
    'bash -lc 2>&1 "git reset --hard"',
    'bash -c >log "git push --force origin main"',
    'cmd /c >log "rd /s /q build"',
    'bash -c >log "az fabric capacity suspend --name cap1"',
    'bash -c 2>&1 "az fabric capacity suspend --name cap1"',
    'sh -c >|log "az fabric capacity suspend --name cap1"',
  ])('flags %s', (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });
});

describe('G5b the shared payload reader (package-install-guard reads it too) sees the payload after a redirect', () => {
  // Seed (a) as reported: `bash -c&>log "npm install zz"` gave 0 install plans, because the payload was a bare tail.
  it.each([
    ['bash -c&>log "npm install zz"', 'npm install zz'],
    ['bash -c >log "npm install zz"', 'npm install zz'],
    ['bash -c &> log "npm install zz"', 'npm install zz'],
    ["sh -c 2>/dev/null 'npm install zz'", 'npm install zz'],
    ['bash -c "npm install zz" >log', 'npm install zz'],
  ])('%s -> %s', (cmd, payload) => {
    expect(extractShellWrapperPayloads(cmd)).toEqual([payload]);
  });
});

describe('G6 a redirect before or inside the launcher, interpreter or flag', () => {
  it.each([
    '>log bash -c "rm -rf build"',
    'bash 2>&1 -c "rm -rf build"',
    'bash >&log -c "rm -rf build"',
    'bash>&2 -c "rm -rf build"',
    'bash -c>&2 "rm -rf build"',
    'env >log bash -c "az fabric capacity suspend --name cap1"',
    'env 2>&1 bash -c "az fabric capacity suspend --name cap1"',
    'nohup &>log bash -c "az fabric capacity suspend --name cap1"',
    '>log nohup bash -c "az fabric capacity suspend --name cap1"',
    'time 2>&1 bash -c "git reset --hard"',
    'sudo >&2 bash -c "rm -rf build"',
    'timeout 5 2>&1 bash -c "git push --force origin main"',
    'env FOO=1 >log sh -c "rd /s /q build"',
    'bash -c "rm -rf build" 2>&1',
    'bash -c "az fabric capacity suspend --name cap1" 2>&1 >log',
  ])('flags %s', (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });
});

describe('G7 PowerShell native redirects', () => {
  it.each([
    'Remove-Item 2>&1 -Recurse -Force build',
    'Remove-Item *>&1 -Recurse -Force build',
    'Remove-Item 3>&1 -Recurse build',
    'Remove-Item 2>$null -Recurse build',
    'Remove-Item >log -Recurse build',
    'Remove-Item *>log -Recurse build',
    'Remove-Item -Recurse 2>&1 build',
    'git reset 2>&1 --hard',
    'git clean *>&1 -fd',
    'az 2>&1 fabric capacity suspend --name cap1',
    'az 2>$null fabric capacity suspend --name cap1',
    'az fabric >log capacity suspend --name cap1',
    'Suspend-AzFabricCapacity 2>&1 -Name cap1',
    'pwsh -c 2>&1 "Remove-Item -Recurse build"',
    'pwsh -Command 2>&1 "Suspend-AzFabricCapacity -Name cap1"',
    'rd 2>&1 /s /q build',
  ])('flags %s', (cmd) => {
    expect(pwsh(cmd)).not.toBeNull();
  });
});

describe('G8 quoted target, several redirects, nested payloads', () => {
  it.each([
    'rm >"my log" -rf build',
    "rm >'my log' -rf build",
    'rm 2>&1 >log -rf build',
    'rm >log 2>&1 -rf build',
    'bash -c >"my log" "rm -rf build"',
    'bash -c >$(echo log) "rm -rf build"', // a $( ) target must not hide the payload
    'bash -c >`echo log` "rm -rf build"',
    'bash -c >${LOG:-x} "rm -rf build"',
    'bash -c >C:\\logs\\a.txt "rm -rf build"',
    'echo "$(rm 2>&1 -rf build)"',
    'echo $(git >log reset --hard)',
    'bash -c "git 2>&1 reset --hard"',
    'bash -c "rm >log -rf build"',
    'bash -c "bash -c >log \\"rm -rf build\\""',
    'ls | rm 2>&1 -rf build',
    'ls && git >log reset --hard',
    'ls; >log az fabric capacity suspend --name cap1',
  ])('flags %s', (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });
});

describe('G9 seed (b): `>&` followed by a word stays fail-closed', () => {
  // In Bash, `>& az` writes to a file named az, so this does not run az. The guard has asked on it before
  // this lane and keeps asking: when in doubt (zsh, other shells), ask. Pinned so a stricter design that
  // keeps `>&` whole cannot silently drop it.
  it('still asks on `true >& az fabric capacity suspend`', () => {
    expect(bash('true >& az fabric capacity suspend --name cap1')).not.toBeNull();
  });
  it('asks on `a 2>&1 b` split into a destructive second word', () => {
    expect(bash('true 2>&1 rm -rf build')).not.toBeNull();
    expect(bash('true 2>&1 git reset --hard')).not.toBeNull();
  });
  it('decide() asks (interactive) and denies (unattended) for a redirect-split command', () => {
    expect(decide('git reset 2>&1 --hard', { permission_mode: 'default' }, {}).decision).toBe('ask');
    expect(decide('bash -c >log "rm -rf build"', { permission_mode: 'bypassPermissions' }, {}).decision).toBe('deny');
  });
});

describe('previously flagged commands stay flagged (the second scan only adds)', () => {
  it.each([
    ['echo x > /dev/sda', 'write to block device'],
    ['cat img >/dev/nvme0n1', 'write to block device'],
    ['dd if=/dev/zero of=/dev/sda', 'dd to/from device'],
    ['rm -rf build > log 2>&1', 'recursive rm'],
    ['git push --force origin main 2>&1 | tail -3', 'git push --force'],
  ])('%s -> %s', (cmd, name) => {
    expect(bash(cmd)).toBe(name);
  });
});

describe('legit commands with redirects stay allowed', () => {
  it.each([
    'echo hi > out.txt',
    'echo hi >> out.txt',
    'ls 2>&1',
    'ls -la 2>/dev/null',
    'git status &> log',
    'git status &>log',
    'npm test 2>&1 | tee out.txt',
    'git push origin main > log',
    'git push origin main 2>&1 | tail -3',
    'git push origin main &>log',
    'rm -f file 2>&1',
    'rm -f file.txt >log',
    'git branch -d x 2>&1',
    'git checkout main 2>&1',
    'git log --oneline >log 2>&1',
    'git diff HEAD~1 > patch.diff',
    'git commit -m "x" 2>&1',
    'bash -c >log "echo hi"',
    'bash -c 2>&1 "ls -la"',
    "env sh -c &>log 'ls'",
    '>log bash -c "echo hi"',
    'cmd /c >log "dir"',
    'make >log 2>&1 && echo done',
    'node x.js </dev/null >out 2>&1 &',
    'docker ps 2>&1',
    'az fabric capacity show --name cap1 2>&1',
    'az >log fabric capacity list',
    'echo "2>&1 rm -rf x"',
    'echo "bash -c >log rm -rf x"',
    'cat a.txt 2>&1 >out.txt',
    'rm -f x 2>&1; ls',
    'echo a>b; echo c',
    'echo a2>f',
  ])('allows %s', (cmd) => {
    expect(bash(cmd)).toBeNull();
  });

  it.each([
    'Get-ChildItem -Recurse 2>&1',
    'Get-ChildItem -Recurse *>&1',
    'Remove-Item x.txt 2>&1',
    'Remove-Item x.txt >log',
    'Write-Output hi > out.txt',
    'git status 2>&1',
    'git push origin main 2>&1',
    'az fabric capacity show --name cap1 2>&1',
    'pwsh -c 2>&1 "Get-ChildItem"',
  ])('allows on the PowerShell tool: %s', (cmd) => {
    expect(pwsh(cmd)).toBeNull();
  });
});

describe('the second scan stays linear', () => {
  // CPU time of the process, not wall time (card hooks-timing-tests-under-load): a busy suite stalls wall time. Limits unchanged.
  const timed = (cmd: string): number => {
    const t0 = cpuMs();
    bash(cmd);
    pwsh(cmd);
    return cpuMs() - t0;
  };
  it.each([
    ['2>&1 x ', 1500],
    ['&>x ', 2500],
    ['> ', 5000],
    ['>&2 ', 2500],
    ['<<< ', 2500],
    ['>"a b" ', 1500],
    ['>$( ', 2500],
    ['>`x ', 2500],
    ['>$(a(b ', 1500],
    ['bash -c >x ', 800],
  ])('10 KB of %j repeats stays under 2 s', (unit, n) => {
    expect(timed('rm ' + unit.repeat(n) + ' -rf x')).toBeLessThan(2000);
    expect(timed('echo ' + unit.repeat(n))).toBeLessThan(2000);
  });
});
