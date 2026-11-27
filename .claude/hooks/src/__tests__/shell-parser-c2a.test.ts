/**
 * PR C2a of card coord-guard-shell-parser (plan 89-c2-plan.md, seat rulings 17:08 and 17:10 CST 11-25): the parser path alone must deny what the hand reader denies.
 * Every row runs the command with `astOnly` (a TEST-ONLY seam: the hand views of shapesOf are skipped) and the real parse, as main does with withParsed.
 * The corpus of this card is the step 0 list (90-c2-step0-list.txt): 483 calls of the 23 decision-gate test files were deny on main and allow on the parser path.
 *   L  the land script, by call form (direct, pwsh -File, pwsh -Command, bash -c, call operator, substitution, read into a shell, other forms)
 *   LM a text that only names the script stays a mention (allowed); a comment, a Desktop Commander tool and a PR number do not
 *   M  merge reads the hand reader refused: a quoted subcommand, an odd character, a payload, a brace or glob word, a wrapper, a gh api mention
 *   N  named classes (Dave's tap M6b, PB cost removals): allowed ONLY with the same text that main denies; each has a paired row with no tap or a wrong head: denied
 *   C  create reads: a heredoc in the body, a wrapper, a split word
 *   CS the seam is test-only: no env var, payload or config reaches it in the built hook
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionRecord, offerWrite, type Step } from '../shared/decisions-store.js';
import { decide, withParsed, type Deps } from '../decision-gate.js';

vi.setConfig({ testTimeout: 60000 });
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const DC = 'mcp__plugin_desktop-commander_desktop-commander__start_process';
let dir = '';
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shell-parser-c2a-'));
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = join(dir, 'decisions.json');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

function deps(): Deps {
  const config = JSON.stringify({ decisions: { enforce: true } });
  return {
    env: { ...process.env, CCV3_DECISIONS_FILE: join(dir, 'decisions.json') },
    home: '/home/nobody',
    readFile: (p: string) => (p.replace(/\\/g, '/').endsWith('/review-router.config.json') ? config : null),
    git: (_cwd: string, args: string[]) => {
      const a = args.join(' ');
      if (a === 'remote -v') return { status: 0, stdout: `fork\thttps://github.com/${REPO}.git (push)\n` };
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
      if (a === 'branch --show-current') return { status: 0, stdout: 'feat/x\n' };
      return { status: 1, stdout: '' };
    },
    tapScope: {
      registry: () => ({ state: 'ok', file: '/reg.json', entries: [{ key: 'continuous-claude', root: '/repo', status: 'active', tapGate: null, github: null }] }),
      realpath: (p: string) => p,
      readFile: () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }); },
    },
  } as unknown as Deps;
}
function tap(step: Step, key: string, head: string, label: string): void {
  expect(offerWrite({ step, key, head, spec: { header: 'T', question: 'Q?', options: [{ label }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step, key, head, label })).toEqual({ ok: true });
}
const landTap = (n: number) => tap('land', `${REPO}#${n}`, HEAD, 'Land now (Recommended)');
const input = (command: string, tool = 'Bash') => ({ tool_name: tool, tool_input: { command }, cwd: '/repo', session_id: 'c2a' });
const patternOf = (d: ReturnType<typeof decide>): string => (d.action === 'deny' ? d.pattern : 'allow');
/** The verdict of the parser path with the real parse of the text. Since C2b it is the only path: the hand reader and the astOnly seam are gone. */
async function ast(command: string, tool = 'Bash'): Promise<string> {
  const inp = input(command, tool);
  const withP = await withParsed(JSON.stringify(inp), deps());
  return patternOf(decide(inp, withP));
}
/** The verdict with no parse at all (the parser absent): a text that names a guarded call is denied parser-unavailable since C2b (F1-3). */
const noParse = (command: string, tool = 'Bash'): string => patternOf(decide(input(command, tool), deps()));
const M = 'gh pr merge';
/**
 * The texts of the parity rows that the C2a union ALLOWED (read on the RED head 65175236 with the same taps, 11-26). Before C2b `asStrict` asserted a deny
 * only where main denied; main allowed exactly these, so no assertion is made for them. The rest of the parity texts were denied by main.
 */
const OK_CALL = `${M} 5 --squash --match-head-commit ${HEAD}`;
const MAIN_ALLOWED = new Set<string>([OK_CALL, `gh pr "merge" 5 --squash --match-head-commit ${HEAD}`, `bash -c '${OK_CALL}'`, `${OK_CALL} {x}`, `time ${OK_CALL}`, `${OK_CALL}\r`,
  `gh pr\nmerge 5 --squash --match-head-commit ${HEAD}`, `cd /tmp/other-repo; gh pr\nmerge 5 --squash --match-head-commit ${HEAD}`]);
/** Parity row: where the C2a union denied this text, the parser path denies it too (C2b may not turn a deny into an allow). The pattern name may differ. */
async function asStrict(command: string, tool = 'Bash'): Promise<void> {
  if (MAIN_ALLOWED.has(command)) return;
  expect(await ast(command, tool), `the C2a union denied ${command}`).not.toBe('allow');
}
const LAND = 'scripts/github/land-pr.ps1';

describe('L: the land script, every call form the corpus shows, is denied by the parser path (no tap)', () => {
  it('L1 direct path and L2 pwsh or powershell -File', async () => {
    for (const c of [`./${LAND} -Pr 12`, `${LAND} -Pr 12`, `pwsh -File ${LAND} -Pr 12`, `pwsh -File ${LAND}`, `pwsh -File ${LAND} -Pr 12 && pwsh -File ${LAND} -Pr 13`]) {
      expect(await ast(c), c).not.toBe('allow');
    }
    for (const c of [`.\\scripts\\github\\land-pr.ps1 -Pr 12`, `powershell -File scripts\\github\\land-pr.ps1 -Pr 12`, `pwsh -File ${LAND} -Pr 12`]) {
      expect(await ast(c, 'PowerShell'), c).not.toBe('allow');
    }
  });
  it('L3 pwsh with -Command or no -File, L4 bash or sh -c, L5 other programs that run it', async () => {
    for (const c of [`pwsh -NoProfile -Command "land-pr.ps1"`, `pwsh ${LAND} -Pr 12`, `bash -c "pwsh -File ${LAND} -Pr 12"`, `sh -c 'land-pr.ps1'`,
      `cmd /c pwsh -File scripts\\github\\land-pr.ps1 -Pr 12`, `ssh host "pwsh -File ${LAND} -Pr 12"`, `git status; pwsh -File ${LAND}`]) {
      expect(await ast(c), c).not.toBe('allow');
    }
  });
  it('L6 a substitution or a variable holds the script, L7 a text is read into a shell', async () => {
    for (const c of [`echo $(pwsh -File ${LAND} -Pr 12)`, `git commit -m "$(land-pr.ps1)"`, `echo "a $(grep land-pr.ps1 x)"`, `echo "gh pr create for fix $(grep land-pr.ps1 x)"`,
      `cat x.md && pwsh -File ${LAND} -Pr 12`, `cat ${LAND} | pwsh -Command -`, `grep -n land-pr.ps1 a.md | sh`, `echo \`grep land-pr.ps1 x\``]) {
      expect(await ast(c), c).not.toBe('allow');
    }
    for (const c of [`$s = '${LAND}'; & $s -Pr 12`, `Get-Content ${LAND} -Raw | Invoke-Expression`, `printf -v x 'land-pr.ps1'; $x`]) {
      expect(await ast(c, 'PowerShell'), c).not.toBe('allow');
    }
  });
  it('LM a text that only names the script stays a mention; a comment, a PR number and a Desktop Commander tool do not', async () => {
    for (const c of [`grep -n land-pr.ps1 notes.md`, `git commit -m "docs: explain land-pr.ps1"`, `echo "pwsh -File ${LAND} -Pr 12"`]) {
      expect(await ast(c), c).toBe('allow');
      expect(noParse(c), c).toBe('parser-unavailable'); // control (C2b F1-3): with no parse the same text is denied, not read by hand
    }
    for (const c of [`echo x # land-pr.ps1`, `# then run land-pr.ps1`, `grep -n land-pr.ps1 notes.md -Pr 12`]) expect(await ast(c), c).not.toBe('allow');
    for (const c of [`grep -rn land-pr.ps1 docs`, `echo see ${LAND}`]) expect(await ast(c, DC), c).not.toBe('allow');
  });
});

describe('M: merge reads the hand reader refused stay denied on the parser path (the tap is for PR 5 and the right head)', () => {
  it('M1 the clean call passes with its tap; a head the parser cannot read, a second head, a variable and a glob word deny, as main does', async () => {
    landTap(5);
    const ok = `${M} 5 --squash --match-head-commit ${HEAD}`;
    expect(await ast(ok)).toBe('allow'); // control: the clean call passes with its tap
    for (const c of [`${M} 5 --squash --match-head-commit ${HEAD} --match-head-commit ${OTHER}`, `${M} 5 --squash --match-head-commit $H`, `${M} 5 --squash`,
      `${ok} *.md`, `${ok} $EXTRA`, `${ok} --weird x`, `${ok} (x)`]) {
      expect(await ast(c), c).not.toBe('allow');
      await asStrict(c);
    }
  });
  it('M2 a quoted subcommand, an odd character, a payload, a wrapper program and a word split over lines: never a deny to allow against main', async () => {
    landTap(5);
    const ok = `${M} 5 --squash --match-head-commit ${HEAD}`;
    for (const c of [`gh pr "merge" 5 --squash --match-head-commit ${HEAD}`, `${M} 5 --squash --match-head-commit ${HEAD}`, `${M} 5 --squash\f--match-head-commit ${HEAD}`, `bash -c '${ok}'`, `${ok} {x}`,
      `time ${ok}`, // C2c: `env NAME=value ${ok}` is read through and judged like the bare call (allowed with the tap, rows W and C05 of shell-parser-c2c-holes)
      `gh pr\nmerge 5 --squash --match-head-commit ${HEAD}`, `${ok}\r`, `cd /tmp/other-repo; gh pr\nmerge 5 --squash --match-head-commit ${HEAD}`]) {
      await asStrict(c);
    }
  });
  it('M3 a gh api merge that a grep names is not data (the tap M6b covered gh pr merge words only)', async () => {
    for (const c of [`grep -n "gh api repos/${REPO}/pulls/12/merge -X PUT" docs`]) {
      expect(await ast(c), c).not.toBe('allow');
      expect(await ast(c, 'PowerShell'), c).not.toBe('allow');
    }
  });
});

describe('N: named classes. Allowed only as main-style real calls with their tap or as data; each has a paired row that stays denied', () => {
  it('N1 (M3 of PR B) a redirect after a merge: allowed with the tapped head, denied with no tap or a wrong head', async () => {
    landTap(5);
    for (const r of ['2>&1', '2>err.txt', '&>log']) expect(await ast(`${M} 5 --squash --match-head-commit ${HEAD} ${r}`), r).toBe('allow');
    for (const r of ['2>&1', '2>err.txt']) {
      expect(await ast(`${M} 5 --squash --match-head-commit ${OTHER} ${r}`), `wrong head ${r}`).not.toBe('allow');
      expect(await ast(`${M} 9 --squash --match-head-commit ${HEAD} ${r}`), `no tap for PR 9 ${r}`).not.toBe('allow');
    }
  });
  it('N2 (M4, Dave tap M6b) a grep, rg or echo that only names gh pr merge is data; any other program, and a real merge beside it, is not', async () => {
    for (const c of [`grep -n "${M}" notes.md`, `rg -n "${M}" scripts`, `grep -rn gh pr merge docs`, `echo gh pr merge 12 --squash`]) {
      // DENY FLOOR (card coord-guard-deny-floor, Dave's tap 11-27 "Floor wins, no exception"): main denies these, so they are denied again.
      expect(await ast(c), c).not.toBe('allow');
      expect(await ast(c, 'PowerShell'), c).not.toBe('allow');
    }
    for (const c of [`grep -n "${M}" notes.md &&${M} 12 --squash --match-head-commit ${HEAD}`, `grep -n "${M}" notes.md; ${M} 12 --squash --match-head-commit ${HEAD}`,
      `Add-Content -LiteralPath x.md -Value '${M} 12'`, `$p = 'x.md'; Add-Content -LiteralPath $p -Value '${M} 12'`, `grep -n "${M}" notes.md > out.txt`]) {
      expect(await ast(c, 'PowerShell'), c).not.toBe('allow');
    }
  });
});

describe('C: create reads', () => {
  it('C1 a heredoc in a title or body, a wrapper program and a word split over lines are denied (no tap)', async () => {
    for (const c of [`gh pr create --head feat/x --title t --body "$(cat <<'EOF'\nbody\nEOF\n)"`, `env FOO=1 gh pr create --draft --title t --body-file b.md`, `gh pr\ncreate --draft --title t --body-file b.md`,
      `cd /tmp/other-repo; gh pr\ncreate --draft --title t --body-file b.md`]) {
      expect(await ast(c), c).not.toBe('allow');
      await asStrict(c);
    }
  });
  it('C2 (named, PR B) a redirect or a $( ) title or body does not let a create pass without its tap', async () => {
    for (const c of [`gh pr create --head feat/x --base main 2>&1`, `gh pr create --head feat/x --base main --title t --body "$(cat notes.md)"`, `gh pr create --head feat/x --title t 2>&1`]) {
      expect(await ast(c), c).not.toBe('allow');
    }
  });
});

describe('LP: a late parse leaves one log row (the cost of the parser-unavailable deny of C2b can be counted)', () => {
  it('LP-1 a parse that ends after the budget writes one row that says the parse was late (no parsed result, parseLate set)', async () => {
    const logFile = join(dir, 'guard.jsonl');
    const slow = { bashProvider: () => new Promise((res) => setTimeout(() => res({}), 400)) } as unknown as NonNullable<Deps['parseOpts']>;
    const d = { ...deps(), env: { ...deps().env, CCV3_GUARD_DECISIONS_LOG: logFile }, parseBudgetMs: 20, parseOpts: slow } as Deps;
    const inp = input(`gh pr merge 5 --squash --match-head-commit ${HEAD}`);
    const w = await withParsed(JSON.stringify(inp), d);
    expect(w.parseLate).toBeDefined();
    expect(w.parsed).toBeUndefined();
    const rows = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { message: string; hook: string });
    expect(rows.length).toBe(1);
    expect(rows[0].message).toMatch(/parse was late/);
  });
  it('LP-2 a parse that ends in time leaves no row', async () => {
    const logFile = join(dir, 'guard2.jsonl');
    const d = { ...deps(), env: { ...deps().env, CCV3_GUARD_DECISIONS_LOG: logFile } } as Deps;
    const w = await withParsed(JSON.stringify(input(`gh pr merge 5 --squash --match-head-commit ${HEAD}`)), d);
    expect(w.parsed).toBeDefined();
    expect(existsSync(logFile)).toBe(false);
  });
});

describe('CS: the astOnly seam is retired (C2b) and no name of it opens a gate', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const BUILT = join(ROOT, '.claude', 'hooks', 'dist', 'decision-gate.mjs');
  it('CS-1 the source no longer names the seam, and no line reads an AST switch from the environment or the payload', () => {
    const src = readFileSync(join(ROOT, '.claude', 'hooks', 'src', 'decision-gate.ts'), 'utf8');
    expect(src).not.toMatch(/\bastOnly\b/);
    expect(src).not.toMatch(/process\.env\.[A-Z0-9_]*AST[A-Z0-9_]*/);
    expect(src).not.toMatch(/env\[\s*['"][A-Z0-9_]*AST/);
  });
  // A control, not a proof of retirement: an untapped merge is denied with or without the old selector, so no result here tells the two paths apart.
  // The retirement itself is proved by CS-1 (the source no longer names the seam).
  it('CS-2 (control) the built hook with every old name of the seam set in the environment and the payload still denies a merge with no tap', () => {
    if (!existsSync(BUILT)) return; // the built hook is part of the PR; a checkout without a build has nothing to run
    const env: NodeJS.ProcessEnv = { ...process.env, ASTONLY: '1', AST_ONLY: '1', CCV3_AST_ONLY: '1', C2_PROTO: '1', DECISION_GATE_AST_ONLY: '1', STEP0_MODE: 'proto' };
    delete env.VITEST;
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: `${M} 5 --squash --match-head-commit ${HEAD}`, astOnly: true }, cwd: ROOT, session_id: 'c2a-cs2', astOnly: true });
    const r = spawnSync(process.execPath, [BUILT], { input: payload, encoding: 'utf8', env, timeout: 30000, cwd: ROOT });
    expect(r.stdout, r.stderr).toMatch(/"permissionDecision"\s*:\s*"deny"/);
  });
});
