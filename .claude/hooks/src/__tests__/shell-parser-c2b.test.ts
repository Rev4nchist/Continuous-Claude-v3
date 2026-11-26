/**
 * PR C2b of card coord-guard-shell-parser (seat plan word 18:17 CST 11-25, GO for step 3 at 18:38): the hand reader of the create, land and merge guards goes.
 * RED rows, one group each (every row runs the command with the real parse, as main does with withParsed):
 *   D  the doc-append rule reads a Set-Location or Get-Date leader (two rows of decision-gate-doc-append.test.ts are allowed on main by the hand rule)
 *   F  F1-3: no parse (absent, late or thrown) and a text that names a guarded call is denied `parser-unavailable`; a text with no guarded call is not
 *   M  M6b (Dave's tap, Allow it): a grep, rg or echo that only names `gh pr merge` is data; a real merge beside it stays denied
 *   L  the two C2a limits: a literal `<<` in a create title is no heredoc; an env-prefixed merge before a tapped merge is not dropped
 * SEAM spreads `astOnly` while the field exists: the parser path alone is the state C2b makes real. After the field is removed it is a no-op.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionRecord, offerWrite, type Step } from '../shared/decisions-store.js';
import { decide, withParsed, type Deps } from '../decision-gate.js';

vi.setConfig({ testTimeout: 60000 });
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
let dir = '';
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shell-parser-c2b-'));
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
      if (a.startsWith('rev-parse feat/x')) return { status: 0, stdout: `${HEAD}\n` };
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
const input = (command: string, tool = 'Bash') => ({ tool_name: tool, tool_input: { command }, cwd: '/repo', session_id: 'c2b' });
const SEAM = { astOnly: true } as Record<string, unknown>;
const patternOf = (d: ReturnType<typeof decide>): string => (d.action === 'deny' ? d.pattern : 'allow');
/** The verdict with the real parse (withParsed) and the parser path alone. */
async function run(command: string, tool = 'Bash'): Promise<string> {
  const inp = input(command, tool);
  return patternOf(decide(inp, { ...(await withParsed(JSON.stringify(inp), deps())), ...SEAM } as Deps));
}
/** The verdict with the given deps and no parse at all, as a hook that never parsed. */
const noParse = (command: string, extra: Record<string, unknown> = {}, tool = 'Bash'): ReturnType<typeof decide> => decide(input(command, tool), { ...deps(), ...extra } as Deps);

describe('D: the doc-append rule reads a Set-Location or Get-Date leader', () => {
  it('D1 Set-Location, then Add-Content of a literal that names the land script: allowed (a mention)', async () => {
    expect(await run("Set-Location -LiteralPath 'C:/Users/dkhay/continuous-claude' -ErrorAction Stop; Add-Content -LiteralPath .claudedocs/x.md -Value 'next land-pr.ps1'", 'PowerShell')).toBe('allow');
  });
  it('D2 a Get-Date assignment, then Add-Content of a literal that names the land script: allowed', async () => {
    expect(await run("$t = Get-Date -Format 'HH:mm'; Add-Content -LiteralPath .claudedocs/x.md -Value 'the land script land-pr.ps1 waits'", 'PowerShell')).toBe('allow');
  });
  it('D3 (paired) the same leader with a real land call after the append: denied', async () => {
    expect(await run("Set-Location -LiteralPath 'C:/Users/dkhay/continuous-claude' -ErrorAction Stop; Add-Content -LiteralPath .claudedocs/x.md -Value 'note'; & scripts/github/land-pr.ps1 -Pr 12", 'PowerShell')).not.toBe('allow');
  });
  it('D4 (paired) the leader with a PR number inside the appended text keeps the land shape: denied', async () => {
    expect(await run("Set-Location -LiteralPath 'C:/Users/dkhay/continuous-claude' -ErrorAction Stop; Add-Content -LiteralPath .claudedocs/x.md -Value 'land-pr.ps1 -Pr 12'", 'PowerShell')).not.toBe('allow');
  });
  it('D5 (paired) a leader that is not Set-Location or Get-Date (Invoke-Expression of a variable) does not make the append a mention', async () => {
    expect(await run("$s = 'scripts/github/land-pr.ps1'; Invoke-Expression $s; Add-Content -LiteralPath .claudedocs/x.md -Value 'x'", 'PowerShell')).not.toBe('allow');
  });
});

describe('F: F1-3, no parse and a text that names a guarded call', () => {
  const MERGE = `gh pr merge 12 --squash --match-head-commit ${HEAD}`;
  it('F1-3a no parse, a guarded text: denied parser-unavailable, and the reason says to run it again', () => {
    const d = noParse(MERGE);
    expect(d.action === 'deny' && d.pattern).toBe('parser-unavailable');
    expect(d.action === 'deny' && d.reason).toMatch(/parser was late, run it again/);
  });
  it('F1-3b no parse, no guarded word: not denied by this rule', () => {
    expect(patternOf(noParse('ls -la'))).toBe('allow');
  });
  it('F1-3c a late parse (parseLate set) and a guarded text: denied parser-unavailable', () => {
    expect(patternOf(noParse('git push fork feat/x', { parseLate: 'git push fork feat/x' }))).toBe('parser-unavailable');
  });
  it('F1-3d withParsed with a provider that never answers inside the budget, and a guarded text: denied parser-unavailable', async () => {
    const inp = input(MERGE);
    const w = await withParsed(JSON.stringify(inp), { ...deps(), parseBudgetMs: 50, parseOpts: { bashProvider: () => new Promise(() => undefined) } } as Deps);
    expect(w.parsed).toBeUndefined();
    expect(patternOf(decide(inp, w))).toBe('parser-unavailable');
  });
  it('F1-3e (control) a rejecting provider is a parse error, denied parse-error as on C1', async () => {
    const inp = input(MERGE);
    const w = await withParsed(JSON.stringify(inp), { ...deps(), parseOpts: { bashProvider: () => Promise.reject(new Error('no wasm')) } } as Deps);
    expect(patternOf(decide(inp, w))).toBe('parse-error');
  });
});

describe('M: M6b, a grep, rg or echo that only names a merge is data', () => {
  it('M1 grep naming gh pr merge: allowed', async () => { expect(await run('grep -n "gh pr merge" notes.md')).toBe('allow'); });
  it('M2 rg naming gh pr merge, PowerShell: allowed', async () => { expect(await run('rg -n "gh pr merge" scripts', 'PowerShell')).toBe('allow'); });
  it('M3 echo naming gh pr merge 12: allowed', async () => { expect(await run('echo gh pr merge 12 --squash')).toBe('allow'); });
  it('M4 (paired) a real merge after the grep, no tap: denied', async () => {
    expect(await run(`grep -n "gh pr merge" notes.md; gh pr merge 12 --squash --match-head-commit ${HEAD}`)).not.toBe('allow');
  });
  it('M5 (paired) a real merge in the echo substitution: denied', async () => {
    expect(await run(`echo $(gh pr merge 12 --squash --match-head-commit ${HEAD})`)).not.toBe('allow');
  });
});

describe('L: the two C2a limits', () => {
  it('L1 a create whose literal title holds << is no heredoc: denied for the missing tap (open-pr), not as head-unresolved', async () => {
    expect(await run('gh pr create --draft --title "a << b" --body x')).toBe('open-pr');
  });
  it('L2 (paired) a create with a real heredoc body stays head-unresolved', async () => {
    expect(await run("gh pr create --draft --title t --body-file - <<'EOF'\nbody\nEOF")).toBe('head-unresolved');
  });
  it('L3 an env-prefixed merge of PR 12 before a tapped merge of PR 5: PR 12 has no tap, denied', async () => {
    landTap(5);
    expect(await run(`env FOO=1 gh pr merge 12 --squash --match-head-commit ${HEAD}; gh pr merge 5 --squash --match-head-commit ${HEAD}`)).not.toBe('allow');
  });
  it('L4 (control) the tapped merge of PR 5 alone is allowed', async () => {
    landTap(5);
    expect(await run(`gh pr merge 5 --squash --match-head-commit ${HEAD}`)).toBe('allow');
  });
});
