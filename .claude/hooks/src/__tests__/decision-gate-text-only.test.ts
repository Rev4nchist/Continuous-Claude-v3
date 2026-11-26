/**
 * decision-gate: a command that only TEXT-MENTIONS the land script must not be denied (RED step, lane fix/gate-landpr-text-fp).
 * Today the raw script name alone makes landShapesOf add a land shape, and a mention with no -Pr is a `no-pr` deny.
 *
 * Scope (Dave's decisions):
 *   class A  every segment is a read head (grep cat head tail Select-String sls Get-Content git log) or a plain head, mention has no PR number
 *   class D  the same with an unquoted echo / printf / Write-Host / Write-Output
 *   class B  a PR number inside the text   -> stays DENIED
 *   class C  merge text (gh pr merge ...)  -> stays DENIED
 *   rg is NOT a read head: rg mentions stay DENIED
 *   the exemption holds ONLY for the tools Bash and PowerShell; the Desktop Commander tools keep the raw-name deny
 *   blankInertQuotes does not blank for a Desktop Commander tool (cmd.exe reads ' as a plain character and & as a separator)
 *
 * Failure modes, one test group each:
 *   F1  a read-head or echo mention of the land script is denied (false positive)
 *   F2  the exemption lets a real land or merge through (a runner, a chain, a pipe into a runner, a head prefix, a redefined head, a trap token)
 *   F3  the exemption reaches Desktop Commander, and a cmd.exe quote/separator trick runs a land
 *   F4  regression: a commit message mention and a quoted echo stay allowed under Bash and PowerShell
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, type Deps } from '../decision-gate.js';
import { blankInertQuotes } from '../shared/inert-quotes.js';
import { FINDING_SHAPES, REAL_SHAPES } from './guard-prompt-text-fp-corpus.js';
import { decideParsed } from './helpers/parse-first.js';
import './helpers/walker-timeout.js'; // C2c: the long test timeout, scoped to the files that start a pwsh walker

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const DC = 'mcp__plugin_desktop-commander_desktop-commander__';
let dir = '';
let storeFile = '';
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-gate-text-'));
  storeFile = join(dir, 'decisions.json');
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = storeFile;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

const HEAD = 'a'.repeat(40);
const TREE = 't'.repeat(40);

/** A fake git and config for a CCv3 checkout at /repo, with enforce on and no tap on record. */
function deps(): Deps {
  const config = JSON.stringify({ decisions: { enforce: true, enforcePush: true } });
  return {
    env: { ...process.env, CCV3_DECISIONS_FILE: storeFile },
    home: '/home/nobody',
    readFile: (p) => (p.replace(/\\/g, '/') === '/repo/review-router.config.json' ? config : null),
    git: (_cwd, args) => {
      const a = args.join(' ');
      if (a === 'remote -v') return { status: 0, stdout: `fork\thttps://github.com/${REPO}.git (push)\n` };
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
      if (a === 'branch --show-current') return { status: 0, stdout: 'feat/x\n' };
      if (/^rev-parse .+\^\{commit\}$/.test(a)) return { status: 0, stdout: `${HEAD}\n` };
      if (/^rev-parse .+\^\{tree\}$/.test(a)) return { status: 0, stdout: `${TREE}\n` };
      return { status: 1, stdout: '' };
    },
  };
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo' });
const pwsh = (command: string) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: '/repo' });
const dcStart = (command: string) => ({ tool_name: `${DC}start_process`, tool_input: { command, shell: 'cmd' }, cwd: '/repo' });
const dcInteract = (input: string) => ({ tool_name: `${DC}interact_with_process`, tool_input: { pid: 1, input }, cwd: '/repo' });
const denied = async (input: object): Promise<boolean> => (await decideParsed(input, deps())).action === 'deny';

const L = 'scripts/github/land-pr.ps1';

/** The commands below are checked under both the Bash and the PowerShell tool. */
const TOOLS: ReadonlyArray<[string, (c: string) => object]> = [['Bash', bash], ['PowerShell', pwsh]];

// ---------------------------------------------------------------------------------------------------------------------------
// F1: false positives. Each is denied today (no-pr). After the fix each is allowed under Bash and PowerShell.
// ---------------------------------------------------------------------------------------------------------------------------
describe('F1 a read head or an unquoted echo that only mentions the land script is allowed (classes A and D)', () => {
  const BOTH: string[] = [
    `grep -rn land-pr.ps1 .claude/rules-src`,
    `grep -n 'land-pr.ps1' CLAUDE.md`,
    `cat ${L}`,
    `head -n 20 ${L} 2>&1`,
    `tail -n 20 ${L}`,
    `git log --oneline -S land-pr.ps1`,
    `git log -S 'land-pr.ps1' -- scripts/github`,
    `echo see ${L} for the land step`,
    `cd /c/Users/dkhay/continuous-claude && grep -c land-pr.ps1 CLAUDE.md`,
    `grep -n land-pr.ps1 a.md; grep -l land-pr.ps1 docs`,
    `cat a.md && grep -n land-pr.ps1 b.md && head -n 5 c.md`,
    `echo see ${L} && grep -c land-pr.ps1 a.md`,
  ];
  for (const [name, mk] of TOOLS) {
    for (const cmd of BOTH) {
      it(`${name}: allows ${JSON.stringify(cmd)}`, async () => {
        expect(await denied(mk(cmd))).toBe(false);
      });
    }
  }
  const PS_ONLY: string[] = [
    `Get-Content ${L} -TotalCount 40`,
    `Select-String -Path docs/x.md -Pattern 'land-pr.ps1'`,
    `sls 'land-pr.ps1 -Pr' docs/x.md`,
    `Write-Host see ${L} for the land step`,
    `Write-Output ${L}`,
    `Set-Location C:\\Users\\dkhay\\continuous-claude; Select-String -Pattern land-pr.ps1 -Path CLAUDE.md`,
  ];
  for (const cmd of PS_ONLY) {
    it(`PowerShell: allows ${JSON.stringify(cmd)}`, async () => {
      expect(await denied(pwsh(cmd))).toBe(false);
    });
  }
  it('Bash: allows an unquoted printf mention', async () => {
    expect(await denied(bash(`printf %s ${L}`))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// F2: must stay denied under Bash and PowerShell. Most pass today; they guard the fix.
// ---------------------------------------------------------------------------------------------------------------------------
describe('F2 a real land, a merge, or a mention the exemption must not cover stays denied', () => {
  const STAY_DENIED: Array<[string, string]> = [
    // plain run
    ['plain run, no PR', `.\\scripts\\github\\land-pr.ps1`],
    ['plain run with PR', `.\\scripts\\github\\land-pr.ps1 -Pr 12`],
    // interpreter
    ['pwsh -File', `pwsh -File ${L} -Pr 12`],
    ['pwsh with no -File', `pwsh ${L} -Pr 12`],
    ['powershell -File, backslashes', `powershell -File scripts\\github\\land-pr.ps1 -Pr 12`],
    // call operator and dot source
    ['call operator', `& ${L} -Pr 12`],
    ['call operator, quoted absolute path', `& "C:\\Users\\dkhay\\continuous-claude\\scripts\\github\\land-pr.ps1" -Pr 12`],
    ['dot source', `. ./${L} -Pr 12`],
    // wrappers
    ['bash -c', `bash -c "pwsh -File ${L} -Pr 12"`],
    ['cmd /c', `cmd /c pwsh -File scripts\\github\\land-pr.ps1 -Pr 12`],
    ['ssh', `ssh host "pwsh -File ${L} -Pr 12"`],
    // variable path
    ['variable path', `$s = '${L}'; & $s -Pr 12`],
    // chains: a runner in any segment
    ['chain: git status then land', `git status; pwsh -File ${L}`],
    ['chain: cat && land', `cat x.md && pwsh -File ${L} -Pr 12`],
    ['chain: grep mention then land', `grep -n land-pr.ps1 a.md; pwsh -File ${L}`],
    ['chain: echo mention then land', `echo see ${L} && pwsh -File ${L}`],
    // a read piped into a runner
    ['cat piped to pwsh', `cat ${L} | pwsh -Command -`],
    ['Get-Content piped to Invoke-Expression', `Get-Content ${L} -Raw | Invoke-Expression`],
    ['grep piped to sh', `grep -h land-pr.ps1 notes.txt | sh`],
    ['xargs', `xargs -a l.txt pwsh -File ${L}`],
    // trap tokens
    ['git log --output', `git log --output=x.ps1 -S land-pr.ps1`],
    ['git show --output', `git show --output=x.ps1 HEAD:${L}`],
    // head prefixes
    ['path prefix on the head', `./grep land-pr.ps1 -Pr 12`],
    ['VAR= prefix with a pager', `GIT_PAGER='pwsh -File ${L}' git log`],
    ['git -c core.pager', `git -c core.pager="pwsh -File ${L}" log`],
    // redefined head
    ['alias grep to eval', `alias grep=eval; grep pwsh -File ${L} -Pr 12`],
    ['Set-Alias grep', `Set-Alias grep Invoke-Expression; grep '${L} -Pr 12'`],
    ['function grep', `grep() { eval "$@"; }; grep pwsh -File ${L}`],
    // substitution and write
    ['command substitution', `echo $(pwsh -File ${L} -Pr 12)`],
    ['write then run', `grep land-pr.ps1 a.md > run.ps1; pwsh run.ps1`],
    ['find -exec', `find . -name land-pr.ps1 -exec pwsh {} \\;`],
    // a continuation that the two shells read differently
    ['continuation then land', `grep x \\\npwsh -File ${L} -Pr 12`],
    // comments stay denied by design
    ['comment line', `# then run land-pr.ps1\ngit status`],
    ['trailing comment', `echo x # land-pr.ps1`],
    // rg is not a read head: every rg mention stays denied
    ['rg quoted mention', `rg -n "land-pr.ps1" scripts docs`],
    ['rg plain mention', `rg -l land-pr.ps1 docs`],
    ['rg --pre', `rg --pre pwsh x ${L}`],
    ['rg "--pre" quoted', `rg "--pre" pwsh x ${L}`],
    ['rg --hostname-bin', `rg --hostname-bin pwsh x ${L}`],
    ['rg as the second head of a chain', `grep -n land-pr.ps1 a.md; rg -l land-pr.ps1 docs`],
    // class B: a PR number inside the text stays denied
    ['class B, quoted grep', `grep -rn "land-pr.ps1 -Pr 12" docs`],
    ['class B, unquoted grep', `grep -rn land-pr.ps1 -Pr 12 docs`],
    ['class B, cat', `cat ${L} -Pr 12`],
    ['class B, unquoted echo', `echo run ${L} -Pr 12`],
    // class B with the -Pr quoted: the inert echo head blanks "-Pr 12", so the PR number is not read from the blanked text
    ['class B, echo quoted -Pr then name', `echo "-Pr 12" ${L}`],
    ['class B, printf quoted -Pr then name', `printf "%s" "-Pr 12" ${L}`],
    ['class B, Write-Host quoted -Pr then name', `Write-Host "-Pr 12" ${L}`],
    ['class B, echo name then quoted -Pr', `echo ${L} "-Pr 12"`],
    ['class B, echo single-quoted -Pr then name', `echo '-Pr 12' ${L}`],
    // class C: the api merge text stays denied (Dave's tap M6b covers the words of gh pr merge only)
    ['class C, api merge text', `grep -n "gh api repos/${REPO}/pulls/12/merge -X PUT" docs`],
    // C2b: a real merge beside a data reader is still judged (no tap for PR 12), whatever the reader names
    ['class C, grep merge text then a real merge', `grep -n "gh pr merge" scripts/x.md && gh pr merge 12 --squash --match-head-commit ${'a'.repeat(40)}`],
    ['class C, echo merge text then a real merge', `echo gh pr merge 12 --squash; gh pr merge 12 --squash --match-head-commit ${'a'.repeat(40)}`],
  ];
  for (const [name, mk] of TOOLS) {
    for (const [label, cmd] of STAY_DENIED) {
      it(`${name}: denies ${label}`, async () => {
        expect(await denied(mk(cmd))).toBe(true);
      });
    }
  }
});

// C2b, class A (Dave's tap M6b, 11-25 "Allow it"): a grep, rg or echo that only names gh pr merge is data. These four rows used to be in the F2 list above
// ("class C ... stays denied"); the hand reader that denied them is deleted. Each row keeps its name after "class C".
describe('F2 class C (C2b): a data reader that only names gh pr merge is allowed (Dave tap M6b)', () => {
  const ALLOWED_M6B: Array<[string, string]> = [
    ['class C, rg', `rg -n "gh pr merge" scripts`],
    ['class C, grep quoted', `grep -n "gh pr merge" scripts/x.md`],
    ['class C, grep unquoted', `grep -rn gh pr merge docs`],
    ['class C, echo unquoted', `echo gh pr merge 12 --squash`],
  ];
  for (const [name, mk] of TOOLS) {
    for (const [label, cmd] of ALLOWED_M6B) {
      it(`${name}: allows ${label}`, async () => {
        expect(await denied(mk(cmd))).toBe(false);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// F2b: the shared corpus (REAL_SHAPES, FINDING_SHAPES) with a bare script name or a read-head mention as the inner word.
// Every shape runs the inner word in some way, so every one must stay denied under Bash and PowerShell.
// ---------------------------------------------------------------------------------------------------------------------------
describe('F2b every corpus shape that runs the inner word stays denied', () => {
  const INNER: string[] = ['land-pr.ps1', 'grep land-pr.ps1 x'];
  // With the read-head inner word these shapes put it in a bare segment next to other read or print heads: that is class A text, allowed by design.
  const PLAIN_SEGMENT_SHAPES = new Set(['bare', 'after echo ;', 'after echo &&', 'after echo ||', 'after echo |', 'after newline']);
  for (const [name, mk] of TOOLS) {
    for (const inner of INNER) {
      for (const [label, shape] of [...REAL_SHAPES, ...FINDING_SHAPES]) {
        if (inner.startsWith('grep') && PLAIN_SEGMENT_SHAPES.has(label)) continue;
        it(`${name}: denies ${label} with inner ${JSON.stringify(inner)}`, async () => {
          expect(await denied(mk(shape(inner)))).toBe(true);
        });
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// F2c (round 3): the masked text hides a quoted word, so a quoted wrapper before a head (or a quoted git option between git and log)
// made the NEXT word look like the head. Each head must match the RAW segment too. Every row below runs the land script
// (a quoted program word, then its arguments) and must stay denied under Bash and PowerShell.
// ---------------------------------------------------------------------------------------------------------------------------
describe('F2c a quoted word before or inside a head does not make a land look like text', () => {
  const QUOTED_RUN = `"pwsh" "-File" "${L}"`;
  const QUOTED_HEAD: Array<[string, string]> = [
    ['quoted program word before cat', `${QUOTED_RUN} cat x.md`],
    ['quoted program word before grep', `${QUOTED_RUN} grep -n x a.md`],
    ['quoted program word before echo', `${QUOTED_RUN} echo hello`],
    ['quoted program word before cd', `${QUOTED_RUN} cd docs`],
    ['quoted program word before git status', `${QUOTED_RUN} git status`],
    ['quoted -c and core.pager between git and log', `git "-c" "core.pager=pwsh -File ${L}" log`],
    ['single-quoted -c and core.pager between git and log', `git '-c' 'core.pager=pwsh -File ${L}' log`],
    ['head glued to a quoted word', `cat"x" ${L}`],
    ['grep glued to a quoted word', `grep"x" -n ${L} a.md`],
    ['-Pr then a shell variable, quoted wrapper', `${QUOTED_RUN} cat -Pr $n`],
    ['quoted wrapper before echo with a quoted -Pr', `${QUOTED_RUN} echo "-Pr 12"`],
    ['quoted wrapper after a read head segment', `cat a.md; ${QUOTED_RUN} grep x a.md`],
  ];
  for (const [name, mk] of TOOLS) {
    for (const [label, cmd] of QUOTED_HEAD) {
      it(`${name}: denies ${label}`, async () => {
        expect(await denied(mk(cmd))).toBe(true);
      });
    }
  }
  // PowerShell reads U+2013, U+2014 and U+2015 as a dash, so an en dash before Pr is a parameter that no ASCII regex sees.
  for (const [name, mk] of TOOLS) {
    for (const dash of ['–', '—', '―']) {
      it(`${name}: denies a mention with U+${dash.codePointAt(0)!.toString(16).toUpperCase()} before Pr`, async () => {
        expect(await denied(mk(`cat ${L} ${dash}Pr 12`))).toBe(true);
        expect(await denied(mk(`grep -n ${L} ${dash}Pr $n`))).toBe(true);
      });
    }
  }
  it('blankInertQuotes keeps every string when a quoted word comes before the inert head', () => {
    const cmd = `"pwsh" "-File" "${L}" echo "gh pr create"`;
    for (const tool of ['Bash', 'PowerShell', undefined]) {
      expect(blankInertQuotes(cmd, tool)).toBe(cmd);
    }
  });
  it('blankInertQuotes keeps every string when a quoted word comes before a plain head', () => {
    const cmd = `"x" cd docs; echo "gh pr create"`;
    for (const tool of ['Bash', 'PowerShell', undefined]) {
      expect(blankInertQuotes(cmd, tool)).toBe(cmd);
    }
  });
  it('blankInertQuotes still blanks a bare echo string (no regression)', () => {
    expect(blankInertQuotes('cd docs; echo "gh pr create"', 'Bash')).not.toContain('gh pr create');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// F3: Desktop Commander. The exemption is for Bash and PowerShell only. cmd.exe reads ' as a plain character and & as a separator.
// ---------------------------------------------------------------------------------------------------------------------------
describe('F3 Desktop Commander keeps the raw-name deny, and a cmd.exe quote trick does not hide a land', () => {
  const CMD_TRICK_GREP = `grep 'a & pwsh -File ${L} -Pr 12 & rem '`;
  const CMD_TRICK_ECHO = `echo 'a & pwsh -File ${L} -Pr 12 & rem '`;
  const DC_TOOLS: ReadonlyArray<[string, (c: string) => object]> = [['start_process', dcStart], ['interact_with_process', dcInteract]];
  for (const [name, mk] of DC_TOOLS) {
    it(`${name}: denies the cmd.exe bypass through a read head`, async () => {
      expect(await denied(mk(CMD_TRICK_GREP))).toBe(true);
    });
    it(`${name}: denies the cmd.exe bypass through echo (blankInertQuotes must not blank here)`, async () => {
      expect(await denied(mk(CMD_TRICK_ECHO))).toBe(true);
    });
    it(`${name}: denies a plain grep mention (no exemption for this tool)`, async () => {
      expect(await denied(mk(`grep -rn land-pr.ps1 .claude/rules-src`))).toBe(true);
    });
    it(`${name}: denies an unquoted echo mention`, async () => {
      expect(await denied(mk(`echo see ${L} for the land step`))).toBe(true);
    });
    it(`${name}: denies a quoted echo of the script name (no blanking for this tool)`, async () => {
      expect(await denied(mk(`echo "land-pr.ps1"`))).toBe(true);
    });
    it(`${name}: denies a real land`, async () => {
      expect(await denied(mk(`pwsh -File ${L} -Pr 12`))).toBe(true);
    });
  }
  it('start_process: still allows a command with no land text', async () => {
    expect(await denied(dcStart('git status'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// F3b: blankInertQuotes itself (shared by decision-gate and pre-pr-gate). A named Desktop Commander tool gets the command back unchanged.
// pre-pr-gate calls it with the DC tool name only at pre-pr-gate.ts:759 (the `gated` pre-check). Its decide() reads a DC command as
// Bash and as PowerShell, so a cmd.exe quote trick on a PR create through DC is a separate, pre-existing gap there (see the report).
// ---------------------------------------------------------------------------------------------------------------------------
describe('F3b blankInertQuotes does not blank for a Desktop Commander tool', () => {
  const CMD_TRICK = `echo 'a & pwsh -File ${L} -Pr 12 & rem '`;
  it('returns the command unchanged for each Desktop Commander shell tool', () => {
    for (const tool of [`${DC}start_process`, `${DC}interact_with_process`]) {
      expect(blankInertQuotes(CMD_TRICK, tool)).toBe(CMD_TRICK);
      expect(blankInertQuotes('echo "gh pr create"', tool)).toBe('echo "gh pr create"');
    }
  });
  it('still blanks an inert quoted string for Bash, PowerShell and no tool (the same length)', () => {
    for (const tool of ['Bash', 'PowerShell', undefined]) {
      const out = blankInertQuotes('echo "gh pr create"', tool);
      expect(out).not.toContain('gh pr create');
      expect(out).toHaveLength('echo "gh pr create"'.length);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// F4: regression guards. Allowed today, must stay allowed.
// ---------------------------------------------------------------------------------------------------------------------------
describe('F4 regression: allowed today, allowed after the fix', () => {
  for (const [name, mk] of TOOLS) {
    it(`${name}: allows a commit message that mentions the script`, async () => {
      expect(await denied(mk(`git commit -m "docs: explain land-pr.ps1"`))).toBe(false);
    });
    it(`${name}: allows a quoted echo of the script name`, async () => {
      expect(await denied(mk(`echo "land-pr.ps1"`))).toBe(false);
    });
    it(`${name}: allows a quoted echo of a full land line (inert text)`, async () => {
      expect(await denied(mk(`echo "pwsh -File ${L} -Pr 12"`))).toBe(false);
    });
    it(`${name}: allows -CleanupOnly (it never merges)`, async () => {
      expect(await denied(mk(`pwsh -File ${L} -Pr 12 -CleanupOnly`))).toBe(false);
    });
    it(`${name}: allows a command with no land text`, async () => {
      expect(await denied(mk('git status'))).toBe(false);
    });
  }
});
