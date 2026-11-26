/**
 * decision-gate: a command that only APPENDS text naming the land script to a literal document file is not a land (RED step, lane coord-guard-text-false-refusal).
 * Today the raw script name makes landShapesOf add a land shape and a mention with no -Pr is a `no-pr` deny, so the seat's log lines were refused.
 *
 * The rule reads what the segment does and its target, not the guarded word (seat ruling 2026-11-23 12:48 CST):
 *   a DOC APPEND = Add-Content or Set-Content, ONE literal -LiteralPath or -Path ending .md .txt or .log, a value of single-quoted strings only
 *   (or @( single-quoted strings )), no other parameter, no redirect.
 *
 * Failure modes, one test group each:
 *   D1  a doc append that names the land script is denied (false positive)
 *   D2  the exemption lets a real land through (script target, variable target, run text, a chain, a PR number, a lookalike dash, a merge)
 *   D3  the exemption widens past the ruling: a double-quoted or here-string value, two targets, an up path, an unknown parameter
 *   D4  the exemption reaches Desktop Commander
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, docAppendByAst, withParsed, type Deps } from '../decision-gate.js';
import './helpers/walker-timeout.js'; // C2c: the long test timeout, scoped to the files that start a pwsh walker

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const DC = 'mcp__plugin_desktop-commander_desktop-commander__';
let dir = '';
let storeFile = '';
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-gate-docappend-'));
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
/** The verdict the way main reaches it: the text is parsed first (PR B port step 1), then decided. */
const denied = async (input: object): Promise<boolean> => decide(input, await withParsed(JSON.stringify(input), deps())).action === 'deny';

const L = 'scripts/github/land-pr.ps1';
const LOG = String.raw`C:\Users\dkhay\continuous-claude\.claudedocs\coordination\milestones\re-program.md`;
const TOOLS: ReadonlyArray<[string, (c: string) => object]> = [['Bash', bash], ['PowerShell', pwsh]];

describe('D1 a doc append that only names the land script is allowed (PowerShell)', () => {
  const ALLOWED: string[] = [
    `Add-Content -LiteralPath .claudedocs/x.md -Value 'seat: next run land-pr.ps1 after 705'`,
    `Add-Content -LiteralPath '${LOG}' -Value 'run ${L} later'`,
    `Add-Content -Path notes.txt -Value 'land-pr.ps1'`,
    `Set-Content -LiteralPath a.log -Value 'see land-pr.ps1'`,
    `Add-Content -LiteralPath x.md 'land-pr.ps1 is the land step'`,
    `Set-Location -LiteralPath 'C:/Users/dkhay/continuous-claude' -ErrorAction Stop; Add-Content -LiteralPath .claudedocs/x.md -Value 'next land-pr.ps1'`,
    `$t = Get-Date -Format 'HH:mm'; Add-Content -LiteralPath .claudedocs/x.md -Value 'the land script land-pr.ps1 waits'`,
  ];
  for (const cmd of ALLOWED) {
    it(`PowerShell: allows ${JSON.stringify(cmd)}`, async () => {
      expect(await denied(pwsh(cmd))).toBe(false);
    });
  }
});

describe('D2 a real land, or a doc append that can run or names a PR, stays denied', () => {
  const STAY_DENIED: Array<[string, string]> = [
    ['real land, no PR', `pwsh -File ${L}`],
    ['real land with a PR, no tap', `pwsh -File ${L} -Pr 706`],
    ['script target', `Add-Content -LiteralPath run.ps1 -Value 'land-pr.ps1'`],
    ['script target with a PR', `Add-Content -LiteralPath run.ps1 -Value 'pwsh -File ${L} -Pr 706'`],
    ['mjs target', `Add-Content -LiteralPath run.mjs -Value 'land-pr.ps1'`],
    ['cmd target', `Add-Content -LiteralPath run.cmd -Value 'land-pr.ps1'`],
    // 'variable target' ($p = 'x.md'; Add-Content -LiteralPath $p ...) moved to the allowed rows for PowerShell (PB-7, note 03 item 3, F2c); a Bash row below keeps its deny.
    ['paren value', `Add-Content -LiteralPath x.md -Value (pwsh -File ${L})`],
    ['substitution value', `Add-Content -LiteralPath x.md -Value $(pwsh -File ${L} -Pr 5)`],
    ['array value with a paren command', `Add-Content -LiteralPath x.md -Value @((pwsh -File ${L}))`],
    ['chain after the append', `Add-Content -LiteralPath x.md -Value 'a land-pr.ps1'; pwsh -File ${L}`],
    ['chain before the append', `pwsh -File ${L}; Add-Content -LiteralPath x.md -Value 'a note'`],
    ['PR number in the text', `Add-Content -LiteralPath x.md -Value 'land-pr.ps1 -Pr 12'`],
    ['lookalike dash before Pr', `Add-Content -LiteralPath x.md -Value 'land-pr.ps1 \u2013Pr 12'`],
    ['merge text', `Add-Content -LiteralPath x.md -Value 'gh pr merge 12'`],
    ['redirect to a script', `Add-Content -LiteralPath x.md -Value 'land-pr.ps1' > run.ps1`],
    ['backtick in the value', "Add-Content -LiteralPath x.md -Value 'a land-pr.ps1' `\nb"],
  ];
  for (const [name, mk] of TOOLS) {
    for (const [why, cmd] of STAY_DENIED) {
      it(`${name}: denies ${why}`, async () => {
        expect(await denied(mk(cmd))).toBe(true);
      });
    }
  }
});

describe('D2b the exemption is PowerShell only: the Bash tool keeps the deny for a target set by an assignment', () => {
  it('Bash: denies a variable target', async () => {
    expect(await denied(bash(`$p = 'x.md'; Add-Content -LiteralPath $p -Value 'land-pr.ps1'`))).toBe(true);
  });
});

describe('D3 the exemption is no wider than the ruling', () => {
  const STAY_DENIED: Array<[string, string]> = [
    // PR B (note 03 section 1 items 3 and 4): a double-quoted and a here-string value with no variable moved to the allowed rows (PB-7 in decision-gate-parser-b.test.ts).
    ['double-quoted value with a variable', `Add-Content -LiteralPath x.md -Value "$t land-pr.ps1"`],
    ['double-quoted here-string value', `$e = @"\nland-pr.ps1\n"@; Add-Content -LiteralPath x.md -Value $e`],
    // Seat ruling 12:49: the @( ) array form is a Known limit (an anchored wrapper strip is parser growth, V7.6).
    ['array of single-quoted strings', `Add-Content -LiteralPath x.md -Value @('', 'line one land-pr.ps1', 'line two')`],
    ['name set in an assignment, then a bare variable value', `$e = 'land-pr.ps1'; Add-Content -LiteralPath x.md -Value $e`],
    ['two targets', `Add-Content -LiteralPath x.md,run.ps1 -Value 'land-pr.ps1'`],
    ['up path', `Add-Content -LiteralPath ..\\x.md -Value 'land-pr.ps1'`],
    ['glob target', `Add-Content -Path *.md -Value 'land-pr.ps1'`],
    ['txt target with no extension', `Add-Content -LiteralPath notes -Value 'land-pr.ps1'`],
    ['json target', `Add-Content -LiteralPath x.json -Value 'land-pr.ps1'`],
    ['unknown parameter', `Add-Content -LiteralPath x.md -Value 'land-pr.ps1' -Stream y`],
    ['Out-File', `Out-File -LiteralPath x.md -InputObject 'land-pr.ps1'`],
    ['pipe into Add-Content', `'land-pr.ps1' | Add-Content -LiteralPath x.md`],
    ['tee', `echo 'land-pr.ps1' | tee x.md`],
  ];
  for (const [why, cmd] of STAY_DENIED) {
    it(`PowerShell: denies ${why}`, async () => {
      expect(await denied(pwsh(cmd))).toBe(true);
    });
  }
});

describe('D3b seat ruling C1 (11-25): a double-quoted or here-string value that holds a subexpression RUNS it, so it is no literal and stays denied', () => {
  const RUN = `$(pwsh -File ${L} -Pr 5)`;
  const RUN_NO_PR = `$(pwsh -File ${L})`;
  const ROWS: Array<[string, string]> = [];
  for (const cmdlet of ['Add-Content', 'Set-Content']) {
    for (const run of [RUN, RUN_NO_PR]) {
      ROWS.push([`${cmdlet} double-quoted value with ${run}`, `${cmdlet} -LiteralPath x.md -Value "note ${run}"`]);
      ROWS.push([`${cmdlet} here-string value with ${run}`, `${cmdlet} -LiteralPath x.md -Value @"\nnote ${run}\n"@`]);
    }
  }
  for (const [why, cmd] of ROWS) {
    it(`PowerShell: denies ${why}`, async () => {
      expect(await denied(pwsh(cmd))).toBe(true);
    });
  }
  // The union of two readers also denies these texts, so the rows above stay green when the walker drops the nested walk.
  // These rows ask the AST reader alone: it must NOT call such an append a data-only doc append.
  for (const [why, cmd] of ROWS) {
    it(`AST reader alone: no doc append for ${why}`, async () => {
      const input = pwsh(cmd);
      const d = await withParsed(JSON.stringify(input), deps());
      expect(docAppendByAst(d.parsed, 'PowerShell', cmd)).toBe(false);
    });
  }
  it('AST reader alone: a double-quoted value with no subexpression is a doc append (control)', async () => {
    const cmd = `Add-Content -LiteralPath x.md -Value "the land script ${L} waits"`;
    const d = await withParsed(JSON.stringify(pwsh(cmd)), deps());
    expect(docAppendByAst(d.parsed, 'PowerShell', cmd)).toBe(true);
  });
  it('PowerShell: a double-quoted value with no subexpression stays allowed (the Ask A widening, shape only)', async () => {
    expect(await denied(pwsh(`Add-Content -LiteralPath x.md -Value "the land script ${L} waits"`))).toBe(false);
  });
});

describe('D4 the exemption does not reach Desktop Commander', () => {
  it('denies a doc append that names the land script under a cmd shell', async () => {
    expect(await denied(dcStart(`Add-Content -LiteralPath x.md -Value 'land-pr.ps1'`))).toBe(true);
  });
});
