/**
 * Redirect gaps, round 2 (lane destructive-guard-redirect-gaps, 2026-11-08).
 *
 * Round 1 (destructive-command-guard-redirect-gaps.test.ts) blanked a redirect and its target with one regex.
 * Two reviewers then found shapes that regex could not read, and every one stayed ALLOWED:
 *   R1 a heredoc marker between words (`git <<EOF reset --hard`, `bash -c <<EOF "rm -rf x"`)
 *   R2 a redirect target the regex cannot take whole: `$( )` nested twice, more than 300 items, `${...}` with a
 *      space, a backtick pair longer than 300, `$("a" + ...)` in PowerShell. The old regex took part of the
 *      target and the rest of it hid the next word.
 *   R3 `{fd}>file` (a named descriptor)
 *   R4 a line continuation (`git \<newline>push --force`; PowerShell: backtick-newline)
 *   R5 a bare POSIX wrapper payload that follows leftover redirect text: its quotes blanked the payload
 *   R6 `bash -c -- "..."`
 *   R7 `eval "..."` (also with a redirect). eval was never read at all.
 *   R8 process substitution as a redirect target (`bash -c > >(cat) "..."`)
 * The failing text can only be read here; nothing in this file runs a command.
 */

import { describe, it, expect } from 'vitest';
import { classifyDestructive } from '../destructive-command-guard.js';

const bash = (c: string): string | null => classifyDestructive(c, 0, 'Bash');
const pwsh = (c: string): string | null => classifyDestructive(c, 0, 'PowerShell');
const A320 = 'a'.repeat(320);

describe('R1 a heredoc marker between words', () => {
  it.each([
    'git <<EOF reset --hard\nhi\nEOF',
    "git <<'EOF' reset --hard\nhi\nEOF",
    'git <<-EOF reset --hard\nhi\nEOF',
    'git <<EOF >log reset --hard\nhi\nEOF',
    'git push <<EOF --force origin main\nhi\nEOF',
    'rm <<EOF -rf build\nhi\nEOF',
    'bash -c <<EOF "rm -rf build"\nhi\nEOF',
    "bash -c <<'EOF' \"rm -rf zz\"\nhi\nEOF",
    'sh -c <<EOF "git reset --hard"\nhi\nEOF',
  ])('flags %j', (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });
});

describe('R2 a redirect target the regex cannot take whole', () => {
  it.each([
    'git >$(echo $(echo $(echo t4.log))) push --force origin main',
    `git >$(echo t5.log; : ${A320}) reset --hard`,
    `git >\`: ${A320}\` reset --hard`,
    'git >${PWD:-a b}/t8.log push --force origin main',
    'git >${PWD# }/log reset --hard',
    'git >a$(echo $(echo $(echo b))) reset --hard',
    'git >$(( ( 1 ) )) reset --hard',
    `bash -c >$(: ${A320}; echo log7) "rm -rf zz"`,
    `bash -c >\`: ${A320}; echo log8\` "rm -rf zz"`,
    'bash -c >${PWD# }/log "rm -rf zz"',
    'bash -c >$(echo $(echo $(echo log))) "rm -rf zz"',
  ])('flags %j', (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });
  it('flags a PowerShell target the regex cannot take', () => {
    expect(pwsh('git >$("p2" + $("." + $("log"))) reset --hard')).not.toBeNull();
  });
  it('names the fail-closed row', () => {
    expect(bash('git >${PWD:-a b}/t8.log push origin main')).toBe('unparsed redirect target');
  });
});

describe('R2b the fail-closed row asks only when a guarded verb is present', () => {
  it.each([
    'echo hi >${PWD:-a b}/log',
    'ls >$(echo $(echo $(echo log)))',
    `echo hi >$(echo t; : ${A320})`,
    'git status >$(echo $(echo $(echo log)))',
    'git log >${PWD:-a b}/x.log',
    'docker ps >$(echo $(echo $(echo log)))',
  ])('allows %j', (cmd) => {
    expect(bash(cmd)).toBeNull();
  });
});

describe('R3 a named descriptor {fd}>file', () => {
  it.each([
    'git {fd}>t11.log push --force',
    'git {fd}>t11.log reset --hard',
    'rm {fd}>log -rf build',
    'bash -c {fd}>log "rm -rf zz"',
    'sh -c {fd}>log "rm -rf zz"',
    'bash -c {fd}>log "git reset --hard"',
    'sh -c {fd}>log "git reset --hard"',
  ])('flags %j', (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });
});

describe('R4 a line continuation', () => {
  it.each(['git \\\npush --force origin main', 'git reset \\\n--hard', 'rm \\\n-rf build', 'git \\\r\npush --force'])(
    'flags Bash %j',
    (cmd) => {
      expect(bash(cmd)).not.toBeNull();
    },
  );
  it.each(['git `\npush --force', 'git reset `\n--hard', 'git `\r\npush --force'])('flags PowerShell %j', (cmd) => {
    expect(pwsh(cmd)).not.toBeNull();
  });
  it('still allows a continuation of a harmless command', () => {
    expect(bash('git \\\nstatus')).toBeNull();
    expect(bash('git \\\npush origin main')).toBeNull();
  });
});

describe('R5 a POSIX wrapper payload after leftover redirect text', () => {
  it.each([
    'bash -c > >(cat) "rm -rf zz"',
    'bash -c 2> >(cat) "rm -rf zz"',
    'sh -c > >(cat) "rm -rf zz"',
    'bash -c > >(cat) "git reset --hard"',
    'sh -c 2> >(cat) "git reset --hard"',
    'bash -c < <(echo) "rm -rf zz"',
    'sh -c < <(echo) "rm -rf zz"',
    'bash -c < <(echo) "git reset --hard"',
    'bash -c <<EOF "rm -rf zz"\nhi\nEOF',
    "bash -c <<'EOF' \"rm -rf zz\"\nhi\nEOF",
    'sh -c <<EOF "git reset --hard"\nhi\nEOF',
  ])('flags %j', (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });
});

describe('R6 bash -c -- "..."', () => {
  it.each([
    'bash -c -- "rm -rf zz"',
    'bash -c -- 2>&1 "rm -rf zz"',
    'sh -c -- "git reset --hard"',
    'bash -c -- >log "git push --force origin main"',
  ])('flags %j', (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });
});

describe('R7 eval', () => {
  it.each([
    'eval "rm -rf zz"',
    'eval >log "rm -rf zz"',
    'eval 2>&1 "rm -rf zz"',
    'eval &>log "rm -rf zz"',
    'eval <in "rm -rf zz"',
    "eval 'git reset --hard'",
    'sudo eval "rm -rf zz"',
    'FOO=1 eval "git push --force origin main"',
  ])('flags %j', (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });
  it('allows eval of a harmless payload', () => {
    expect(bash('eval "$(ssh-agent -s)"')).toBeNull();
    expect(bash('eval "echo hi"')).toBeNull();
    expect(bash('echo eval "rm -rf zz"')).toBeNull();
  });
});

describe('legit commands near the new rows stay allowed', () => {
  it.each([
    'git push origin main >log',
    'git checkout -b new 2>&1 >/dev/null',
    'git status <<EOF\nhi\nEOF',
    'cat <<EOF\nbody\nEOF',
    "cat > notes.md <<'EOF'\naz fabric capacity suspend --name c -g g\nEOF",
    'echo $((1<2))',
    'echo hi >${HOME}/log',
    'echo hi >$(date +%s).log',
    'echo hi > >(tee log)',
    'exec > >(tee log)',
    'diff <(ls a) <(ls b)',
    'bash -c "echo hi" >log',
    'bash -c "echo hi" 2>&1',
  ])('allows %j', (cmd) => {
    expect(bash(cmd)).toBeNull();
  });
  it.each(['Get-ChildItem *>log', 'Remove-Item x.txt 2>$null; Get-ChildItem', 'git status >$null', 'git log >${env:TEMP}\\x.log'])(
    'allows PowerShell %j',
    (cmd) => {
      expect(pwsh(cmd)).toBeNull();
    },
  );
});

describe('the new scans stay fast', () => {
  const timed = (cmd: string, tool: 'Bash' | 'PowerShell'): number => {
    const t0 = Date.now();
    classifyDestructive(cmd, 0, tool);
    return Date.now() - t0;
  };
  it.each([
    ['>$(a '.repeat(3000), 'Bash'],
    ['>${a '.repeat(3000), 'Bash'],
    ['>`a '.repeat(3000), 'Bash'],
    ['{fd}> '.repeat(3000), 'Bash'],
    ['<<EOF '.repeat(3000), 'Bash'],
    ['git <<EOF x\n'.repeat(1000), 'Bash'],
    ['\\\n'.repeat(5000), 'Bash'],
    ['`\n'.repeat(5000), 'PowerShell'],
    ['>$(a '.repeat(3000), 'PowerShell'],
    [`bash -c ${'>$(a '.repeat(500)} "echo hi"`, 'Bash'],
    [`${'bash -c "'.repeat(5)}echo hi${'"'.repeat(5)}`, 'Bash'],
  ] as const)('runs %j quickly', (cmd, tool) => {
    expect(timed(cmd, tool)).toBeLessThan(4000);
  });
});
