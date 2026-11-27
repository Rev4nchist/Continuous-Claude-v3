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
import { decide, notInertDenies, parserUnavailableDenies, withParsed, type Deps } from '../decision-gate.js';

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

/** The full verdict: deny:<pattern>, warn:<pattern> (an allow that carries a warning) or allow. */
async function full(command: string, tool = 'Bash'): Promise<string> {
  const inp = input(command, tool);
  const d = decide(inp, { ...(await withParsed(JSON.stringify(inp), deps())), ...SEAM } as Deps);
  return d.action === 'deny' ? `deny:${d.pattern}` : typeof d.warn === 'string' ? `warn:${d.warn.split(':')[0]}` : 'allow';
}
describe('W: seat condition 11-26, a wrapper (env, timeout) that carries a guarded call gets the verdict of the bare call, at the same rank', () => {
  // Change that breaks it: a wrapper program on the accounted list hides the guarded call it runs (the call then reads as a plain env or timeout call).
  const LAND = 'scripts/github/land-pr.ps1';
  const rows: [string, string][] = [
    ['env git push origin main', 'git push origin main'],
    ['env FOO=1 gh pr merge 5', 'gh pr merge 5'],
    ['timeout 60 git push', 'git push'],
    ['timeout 5 gh pr create', 'gh pr create'],
    [`env pwsh -File ${LAND} -Pr 1`, `pwsh -File ${LAND} -Pr 1`],
    [`env ${LAND} -Pr 1`, `${LAND} -Pr 1`],
    ['timeout 60 env git push origin main', 'git push origin main'],
    ['env FOO=1 timeout 5 gh pr merge 5', 'gh pr merge 5'],
  ];
  it.each(rows)('%s is judged like %s', async (wrapped, bare) => {
    const want = await full(bare);
    expect(want, `the bare call must be guarded: ${bare}`).not.toBe('allow');
    // The same rank: deny, warn or allow. A deny may name another pattern (a wrapped create has no readable head: head-unresolved, the bare one is open-pr).
    const rank = (v: string): string => v.split(':')[0];
    expect(rank(await full(wrapped)), wrapped).toBe(rank(want));
  });
});

describe('A: CLI run 2 of C2b, a wrapped merge that the parse does not list keeps its unread head (seat 11-26)', () => {
  // Change that breaks it: withAstMerges gives every merge shape of a PR the head of the parsed merges, so the head of a parsed merge hides a wrapped one of the same PR.
  const OWN = `gh pr merge 12 --squash --match-head-commit ${HEAD}`;
  it('A1 (control) the parsed merge alone, tapped for its head: allowed', async () => {
    landTap(12);
    expect(await run(OWN)).toBe('allow');
  });
  it.each(['env gh pr merge 12 --squash', 'env FOO=1 gh pr merge 12 --squash', 'timeout 5 gh pr merge 12 --squash'])(
    'A2 the tapped merge, then %s: denied (the wrapped one has no head of its own)', async (wrapped) => {
      landTap(12);
      expect(await run(`${OWN} ; ${wrapped}`), wrapped).not.toBe('allow');
      expect(await run(`${wrapped} ; ${OWN}`), wrapped).not.toBe('allow');
    });
});

describe('B: CLI run 2 of C2b, the no-parse deny in a covered app reads the home flag', () => {
  it('B1 parserUnavailableDenies sets homeFlags only for a covered folder', () => {
    expect(parserUnavailableDenies(undefined, 'gh pr create --title x', true)[0]).toMatchObject({ pattern: 'parser-unavailable', homeFlags: true });
    expect(parserUnavailableDenies(undefined, 'gh pr create --title x')[0]).not.toHaveProperty('homeFlags');
  });
});

describe('E: CLI run 2 of C2b, a standalone cleanup land passes with no parse', () => {
  const CLEAN = 'pwsh -NoProfile -File scripts/github/land-pr.ps1 -Pr 12 -CleanupOnly';
  it('E1 a standalone land call with -Pr N and -CleanupOnly, no parse: allowed', () => {
    expect(patternOf(noParse(CLEAN, { parseLate: CLEAN }))).toBe('allow');
    expect(patternOf(noParse('scripts/github/land-pr.ps1 -CleanupOnly -Pr 12', { parseLate: 'x' }))).toBe('allow');
  });
  it('E2 (paired) no -Pr N, a chained command, or a land with no -CleanupOnly: denied parser-unavailable', () => {
    for (const c of ['scripts/github/land-pr.ps1 -CleanupOnly', `${CLEAN} ; gh pr merge 5`, `${CLEAN} && git push fork x`, 'scripts/github/land-pr.ps1 -Pr 12']) expect(patternOf(noParse(c, { parseLate: c })), c).toBe('parser-unavailable');
  });
});

describe('R: the not-inert reason names the real lists (seat 11-26)', () => {
  // Change that breaks it: the reason is a fixed text again and drifts from the sets that decide (INERT_PROGRAMS, READ_ONLY_PROGRAMS, DATA_ARG_PROGRAMS, RUNS_TEXT_PROGRAMS).
  it('R1 a denied not-inert text gives a reason that names a data program, a read-only program, an accounted caller and a runner of text', async () => {
    const inp = input(`$s='C:/tmp/o.ps1'\n@'\ngh api repos/${REPO}/pulls -X POST -f title=x\n'@ | Set-Content -LiteralPath $s\n& $s`, 'PowerShell');
    // Deny floor: main's hand reader denies this text first (head cannot be read), so decide() shows that reason. The not-inert reason is the parser's own deny: read it from notInertDenies.
    const d = decide(inp, { ...(await withParsed(JSON.stringify(inp), deps())), ...SEAM } as Deps);
    expect(d.action).toBe('deny');
    const parsedDeps = await withParsed(JSON.stringify(inp), deps());
    const ni = notInertDenies(parsedDeps.parsed, false);
    expect(ni.length).toBeGreaterThan(0);
    const why = ni[0].reason;
    expect(why).toContain('Fix: run the guarded call as its own command');
    for (const name of ['echo', 'set-content', 'cat', 'head', 'get-content', 'sls', 'get-ciminstance', 'gh', 'git', 'claude', 'curl', 'ntn', 'pr', 'api', 'env', 'timeout']) expect(why, name).toContain(name);
  });
});

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

describe('S: Policy P (Dave 11-26): a guarded text the parse does not resolve is allowed only when inert, else denied at the rank of the named call', () => {
  // The shape the corpus differential found (a PR-create script saved to a scratch .ps1): main denied head-unresolved. Dave's tap: a script WRITTEN as data is allowed.
  const BODY = `$ErrorActionPreference = 'Stop'\nSet-Location -LiteralPath 'C:/Users/dkhay/continuous-claude/.claude/worktrees/x' -ErrorAction Stop\ngh api repos/${REPO}/pulls -X POST \`\n  -f title='feat(x): y' -f head=feat/x -f base=main`;
  const WRITE = `$s='C:/tmp/scratch/open-pr.ps1'\n@'\n${BODY}\n'@ | Set-Content -LiteralPath $s -Encoding utf8`;
  const CREATE = `gh api repos/${REPO}/pulls -X POST -f title=x`;
  // Deny floor: main's hand reader denies these first, so the pattern shown is main's. The row asserts the deny, not the parser's pattern name.
  const notInert = async (text: string, tool = 'PowerShell'): Promise<void> => { expect(await run(text, tool), text).not.toBe('allow'); };
  const denied = async (text: string, tool: string): Promise<void> => { expect(await run(text, tool), `${tool} ${text}`).not.toBe('allow'); };
  // DENY FLOOR (card coord-guard-deny-floor, Dave tap 11-27 "Floor wins, no exception"): main denies S1, A, D1, D2 and L1c to L1e (probe 09-policyP-probe.txt), so they are denied again.
  it('S1 a PR-create script written to a scratch .ps1 by a here-string and Set-Content: denied (deny floor; the parser alone calls it inert)', async () => {
    expect(await run(WRITE, 'PowerShell')).not.toBe('allow');
  });
  // A script that the same command then runs is not data: the run is a call that is off the data list, so the text is not inert.
  it('S2 write + call operator on the variable: denied not-inert', async () => { await notInert(`${WRITE}\n& $s`); });
  it('S3 write + Get-Content piped to Invoke-Expression: denied not-inert', async () => { await notInert(`${WRITE}\nGet-Content -LiteralPath $s -Raw | Invoke-Expression`); });
  it('S5 write + dot-source of the variable: denied not-inert', async () => { await notInert(`${WRITE}\n. $s`); });
  it('S6 write + pwsh -File on the variable: denied not-inert', async () => { await notInert(`${WRITE}\npwsh -NoProfile -File $s`); });
  it('S7 write + iex of the file content: denied not-inert', async () => { await notInert(`${WRITE}\niex (Get-Content -LiteralPath $s -Raw)`); });
  it('S8 write + call operator on the literal path the same command writes: denied not-inert', async () => { await notInert(`${WRITE}\n& 'C:/tmp/scratch/open-pr.ps1'`); });
  // A bash text keeps the deny of an older, more precise rule when one exists (it is listed first); the property here is a deny, not the pattern name.
  it('S9 bash: a heredoc writes the script, then bash runs the file: denied', async () => { await denied(`cat > /tmp/x.sh <<'EOF'\ngh pr merge 12 --squash\nEOF\nbash /tmp/x.sh`, 'Bash'); });
  it('S10 bash: sh -c on a variable beside a guarded text: denied', async () => { await denied(`c='gh pr merge 12'; sh -c "$c"`, 'Bash'); });
  it('S10b bash: a literal file run beside a guarded text: denied (no path is tracked: any off-list program beside guarded text is not inert)', async () => { await denied(`bash /tmp/y.sh; echo 'gh pr merge 12'`, 'Bash'); });
  it('S11 a dynamic run with no guarded text keeps its main result: allowed', async () => {
    expect(await run("$s = 'C:/tmp/scratch/hello.ps1'\n& $s", 'PowerShell')).toBe('allow');
    expect(await run('iex (Get-Date)', 'PowerShell')).toBe('allow');
  });
  it('S4 (paired) a real create beside the write: denied', async () => {
    expect(await run(`${WRITE}\ngh api repos/${REPO}/pulls -X POST -f title=x -f head=feat/x -f base=main`, 'PowerShell')).not.toBe('allow');
  });
  // Seat ruling 11-26 (corpus run 2) and Dave's decision: the rank is the one the guarded call has. A push warns while decisions.enforcePush is unset; a create denies.
  const verdictOf = async (command: string, extra: Record<string, unknown> = {}): Promise<ReturnType<typeof decide>> => {
    // A folder outside the registered repo root: the older cd-unexpanded rule of a variable -C folder has nothing to judge there, as in the corpus text.
    const inp = { ...input(command, 'PowerShell'), cwd: '/elsewhere' };
    return decide(inp, { ...(await withParsed(JSON.stringify(inp), deps())), ...SEAM, ...extra } as Deps);
  };
  const warnsNotInert = async (command: string): Promise<void> => {
    const d = await verdictOf(command);
    expect(d.action, command).toBe('allow');
    expect(d.action === 'allow' && d.warn, command).toMatch(/^not-inert:/);
    expect(d.action === 'allow' && d.scope, command).toBe('push');
  };
  // A push is only NAMED here (a string), so no older push rule judges it: the rank comes from not-inert alone.
  const GIT_SAFE_VAR = "$s = 'C:/r/wt/scripts/git-safe.ps1'; Write-Output 'next: git push fork coord/x'; & $s";
  it('S12 a git-safe push through a path built from a variable: warns not-inert (enforcePush unset), does not deny; no exemption by script name', async () => { await warnsNotInert(GIT_SAFE_VAR); });
  it('S12b the corpus shape (-C $wt after the script path): a warn, as on main (the older cd-unexpanded warn is first), not a deny', async () => {
    const d = await verdictOf('$wt = "C:/r/wt"; pwsh -File "$wt/scripts/git-safe.ps1" -C $wt push fork coord/x 2>&1 | Select-Object -Last 4');
    expect(d.action).toBe('allow');
    expect(d.action === 'allow' && d.warn).toMatch(/^cd-unexpanded:/);
  });
  it('S13 (paired) the same push with decisions.enforcePush true: denied not-inert, as a push on main would be', async () => {
    const d = await verdictOf(GIT_SAFE_VAR, { readFile: (p: string) => (p.replace(/\\/g, '/').endsWith('/review-router.config.json') ? JSON.stringify({ decisions: { enforce: true, enforcePush: true } }) : null) });
    expect(d.action === 'deny' && d.pattern).toBe('not-inert');
  });
  it('S14 (paired) the same command with a gh pr create named in its text: denied, scope other', async () => {
    const d = await verdictOf(`${GIT_SAFE_VAR}; Write-Output 'then: gh pr create --base main'`);
    // An older, more precise create rule (head-unresolved) can be the first deny; the property is a deny, at scope other, so enforcePush plays no part.
    expect(d.action).toBe('deny');
    expect(d.action === 'deny' && d.scope).toBe('other');
  });
  // A script written by a redirection and then run: the run is an off-list call, so the push-only text warns and the create text denies. No path is tracked.
  it('S15 echo of a create redirected to x.ps1, then & ./x.ps1: denied', async () => { await denied("echo 'gh pr create --title x' > x.ps1; & ./x.ps1", 'PowerShell'); });
  it('S15b an expression statement redirected (a string > file), then the file run: denied', async () => { await denied("'gh pr merge 5 --squash' > x.ps1; & ./x.ps1", 'PowerShell'); });
  it('S16 echo of a push redirected to x.ps1, then & ./x.ps1: warns not-inert (enforcePush unset)', async () => { await warnsNotInert("echo 'git push fork coord/x' > x.ps1; & ./x.ps1"); });
  it('S16b an expression statement (a string > file), then the file run: a warn at the push flag, not a deny (an older push rule words it)', async () => {
    const d = await verdictOf("'git push fork coord/x' > x.ps1; & ./x.ps1");
    expect(d.action).toBe('allow');
    expect(d.action === 'allow' && d.warn).toBeTruthy();
    expect(d.action === 'allow' && d.scope).toBe('push');
  });
  it('S16c the redirect target is a variable, then a literal file run: warns not-inert', async () => { await warnsNotInert("echo 'git push fork coord/x' > $f; & ./other.ps1"); });
  it('S16d a run of ANY file beside a guarded text is not inert, whichever file the redirect wrote: warns not-inert', async () => { await warnsNotInert("echo 'git push fork coord/x' > a.txt; & ./b.ps1"); });
  it('S17 bash: echo of a merge redirected to /tmp/x.sh, then bash /tmp/x.sh: denied', async () => { await denied("echo 'gh pr merge 5 --squash' > /tmp/x.sh; bash /tmp/x.sh", 'Bash'); });
  it('S17b bash: an append (>>) then source of the file: denied', async () => { await denied("echo 'gh pr merge 5' >> /tmp/x.sh; source /tmp/x.sh", 'Bash'); });
  // The hidden-run forms the parity probe found (27 of the 41 rows main denied and the head allowed): each is an off-list call, so each is denied.
  it('S20 a pipe into a shell: denied (sh, bash, pwsh -Command -, printf into sh)', async () => {
    for (const tool of ['Bash', 'PowerShell']) {
      for (const c of [`echo "${CREATE}" | sh`, `echo '${CREATE}' | bash`, `echo "${CREATE}" | pwsh -Command -`, `printf "%s" "${CREATE}" | sh`]) await denied(c, tool);
    }
  });
  it('S20b ssh with a quoted command, and a dynamic program word on Bash: denied', async () => {
    await denied(`ssh host "${CREATE}"`, 'Bash');
    await denied(`ssh host "${CREATE}"`, 'PowerShell');
    await denied(`$(echo a; echo '${CREATE}')`, 'Bash');
    await denied(`printf -v x '${CREATE}'; $x`, 'Bash');
  });
  it('S20c an alias of echo to eval or iex, then echo of the text: denied', async () => {
    await denied(`alias echo=eval; echo '${CREATE}'`, 'Bash');
    await denied(`Set-Alias echo Invoke-Expression; echo "${CREATE}"`, 'PowerShell');
    await denied(`sal echo iex; Write-Output '${CREATE}'; echo '${CREATE}'`, 'PowerShell');
  });
  it('S20d a redirect through ../ to a file that is then run: denied', async () => {
    await denied(`echo '${CREATE}' > /dev/null/../x.sh; sh x.sh`, 'Bash');
    await denied(`Write-Output "${CREATE}" > nul\\..\\x.ps1; & .\\x.ps1`, 'PowerShell');
  });
  it('S20e tee of the text to a file is not on the data list: denied', async () => {
    for (const tool of ['Bash', 'PowerShell']) await denied(`echo "${CREATE}" | tee run.sh`, tool);
  });
  // Dave's two taps (11-26): the 10 leftover rows. Class A: a script WRITTEN as data and not run. Class D: the parse proves the text is data in that tool (named, 10 rows).
  it('A: echo of a create written to a file with > or >> is denied, Bash and PowerShell (4 rows, deny floor)', async () => {
    for (const tool of ['Bash', 'PowerShell']) for (const op of ['>', '>>']) expect(await run(`echo "${CREATE}" ${op} run.sh`, tool), `${tool} ${op}`).not.toBe('allow');
  });
  it('D1 PowerShell: echo `gh ...` in backticks is denied as on main (create and merge, 2 rows, deny floor)', async () => {
    expect(await run(`echo \`${CREATE}\``, 'PowerShell')).not.toBe('allow');
    expect(await run('echo `gh pr merge 5 --squash`', 'PowerShell')).not.toBe('allow');
  });
  it('D2 PowerShell: a subexpression of echo and a bare variable statement are denied as on main (4 rows, deny floor)', async () => {
    for (const c of ['gh api repos/x/pulls', 'gh pr merge 5 --squash']) {
      const text = c.startsWith('gh api') ? `gh api repos/${REPO}/pulls -X POST -f title=x` : c;
      expect(await run(`$(echo a; echo '${text}')`, 'PowerShell'), text).not.toBe('allow');
      expect(await run(`printf -v x '${text}'; $x`, 'PowerShell'), text).not.toBe('allow');
    }
  });
  it('D2b (paired) the same four texts on the Bash tool stay denied: there a substitution output and a variable are run', async () => {
    for (const text of [CREATE, 'gh pr merge 5 --squash']) {
      await denied(`$(echo a; echo '${text}')`, 'Bash');
      await denied(`printf -v x '${text}'; $x`, 'Bash');
    }
  });
  // The data list (one named constant) and its two argument forms.
  it('L1 the data list: Write-Output, Write-Host, Add-Content, Select-String, Out-File and printf beside a guarded text are inert', async () => {
    for (const c of [`Write-Output '${CREATE}'`, `Write-Host '${CREATE}'`]) expect(await run(c, 'PowerShell'), c).toBe('allow');
    // Deny floor: main denies these three (probe 09-policyP-probe.txt), so the floor denies them again.
    for (const c of [`Add-Content -LiteralPath x.md -Value '${CREATE}'`, `Select-String -Pattern 'gh pr merge' -Path x.md`, `'${CREATE}' | Out-File x.txt`]) expect(await run(c, 'PowerShell'), c).not.toBe('allow');
    expect(await run(`printf '%s' '${CREATE}'`, 'Bash')).toBe('allow');
  });
  it('L2 git commit with -m or -F beside a guarded text is inert', async () => {
    for (const c of ["git commit -m 'next: gh pr merge 5'", 'git commit -F msg.txt -m "land-pr.ps1 waits"']) expect(await run(c, 'Bash'), c).toBe('allow');
  });
  it('L2b node lane.mjs say and note are on the data list, so P adds no deny (the C1 script-runner rule, the same on main, still denies a note that names a merge)', async () => {
    for (const c of ["node C:/Users/dkhay/.claude/scripts/lane.mjs note x 'gh pr merge 5 then land-pr.ps1'", "node lane.mjs say 'gh pr create next'"]) expect(await run(c, 'Bash'), c).not.toBe('not-inert');
  });
  it('L3 (paired) node lane.mjs add is NOT on the list: denied beside a guarded text; a git call is an accounted call (the parsed rules judge it), so git add and commit --amend beside echo text allow', async () => {
    await denied("node lane.mjs add x --title 'gh pr merge 5'", 'Bash');
    for (const c of ["git commit --amend; echo 'gh pr merge 5'", "git add x; echo 'gh pr merge 5'"]) expect(await run(c, 'Bash'), c).toBe('allow');
  });
  it('L4 (paired) a clean parse is required: a text that does not parse is not inert', async () => {
    expect(await run(`echo 'gh pr merge 5' ; ;; echo`, 'Bash')).not.toBe('allow');
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
  it('F1-3c a late parse (parseLate set) and a push only: parser-unavailable at the push flag, so it warns while decisions.enforcePush is unset', () => {
    const d = noParse('git push fork feat/x', { parseLate: 'git push fork feat/x' });
    expect(d.action).toBe('allow');
    expect(d.action === 'allow' && d.warn).toMatch(/^parser-unavailable:/);
    expect(d.action === 'allow' && d.scope).toBe('push');
  });
  it('F1-3c2 (paired) the same late push with decisions.enforcePush true: denied parser-unavailable', () => {
    const readFile = (p: string): string | null => (p.replace(/\\/g, '/').endsWith('/review-router.config.json') ? JSON.stringify({ decisions: { enforce: true, enforcePush: true } }) : null);
    expect(patternOf(noParse('git push fork feat/x', { parseLate: 'git push fork feat/x', readFile }))).toBe('parser-unavailable');
  });
  it('F1-3c3 (paired) a late create, land or merge is denied parser-unavailable at the other flag, enforcePush unset', () => {
    for (const c of ['gh pr create --title x', MERGE, '.\\scripts\\github\\land-pr.ps1 -Pr 12']) expect(patternOf(noParse(c, { parseLate: c })), c).toBe('parser-unavailable');
  });
  it('F1-3f no parse and a quote-spliced gh (g""h pr merge 5, gh pr cre""ate): denied parser-unavailable, Bash and PowerShell', () => {
    // The hand reader of main read the splice as the command. With no parse, the quote-blanked text no longer names it, so the quote-removed text is read too.
    for (const tool of ['Bash', 'PowerShell']) for (const c of ['g""h pr merge 5', 'gh pr cre""ate --title x', "g''h pr merge 5"]) expect(patternOf(noParse(c, {}, tool)), `${tool} ${c}`).toBe('parser-unavailable');
  });
  it('F1-3d withParsed with a provider that never answers inside the budget, and a guarded text: denied parser-unavailable', async () => {
    const inp = input(MERGE);
    const w = await withParsed(JSON.stringify(inp), { ...deps(), parseBudgetMs: 50, parseOpts: { bashProvider: () => new Promise(() => undefined) } } as Deps);
    expect(w.parsed).toBeUndefined();
    expect(w.parseLate, 'the parse must have started and been late, not skipped').toBeDefined();
    expect(patternOf(decide(inp, w))).toBe('parser-unavailable');
  });
  it('F1-3e (control) a rejecting provider is a parse error, denied parse-error as on C1', async () => {
    const inp = input(MERGE);
    const w = await withParsed(JSON.stringify(inp), { ...deps(), parseOpts: { bashProvider: () => Promise.reject(new Error('no wasm')) } } as Deps);
    expect(patternOf(decide(inp, w))).toBe('parse-error');
  });
});

describe('M: M6b, a grep, rg or echo that only names a merge is data', () => {
  // DENY FLOOR (card coord-guard-deny-floor, Dave's tap 11-27 "Floor wins, no exception"): main denies M1 to M3, so they are denied again.
  it('M1 grep naming gh pr merge: denied (deny floor)', async () => { expect(await run('grep -n "gh pr merge" notes.md')).not.toBe('allow'); });
  it('M2 rg naming gh pr merge, PowerShell: denied (deny floor)', async () => { expect(await run('rg -n "gh pr merge" scripts', 'PowerShell')).not.toBe('allow'); });
  it('M3 echo naming gh pr merge 12: denied (deny floor)', async () => { expect(await run('echo gh pr merge 12 --squash')).not.toBe('allow'); });
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
