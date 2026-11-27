/**
 * PR C2d step 1 (RED rows). Design note 190-c2d-design-note-carriers.md (Dave's tap 'A: C2d, stop rule kept', seat GO 11-26 19:08). The aegis and critic runs on the C2c head 1404a660
 * found commands that main denies and the C2c source allows. One root cause each: a listed program (git, rg, an env prefix, a PowerShell member call) runs text that the parse
 * does not read, and a guarded word that only a quote-removed view shows ends in isInert, which accepts that program.
 * Every row runs the real parse (withParsed) and the real rule (decide).
 *   A  the 18 aegis forms (a01 to a18), RED on 1404a660
 *   K  the critic forms (c01 to c05) and the claude and sort carriers
 *   O  old holes, the same on main (design note section 5): each must be denied by the next plan
 *   R  an unlisted runner beside a guarded call stays denied (find -exec, awk system, sed e, xargs, parallel, watch, perl, python, source, dot, eval of a variable): GREEN guards
 *   L  controls: a legitimate command stays allowed
 *   G  the carrier register: every listed program has a row that names the options that run another program and its source
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionRecord, offerWrite, type Step } from '../shared/decisions-store.js';
import * as gate from '../decision-gate.js';
import { decide, withParsed, type Deps } from '../decision-gate.js';
import './helpers/walker-timeout.js'; // the long test timeout, scoped to the files that start a pwsh walker

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const R = `repos/${REPO}`;
const HEAD = 'a'.repeat(40);
let dir = '';
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shell-parser-c2d-'));
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = join(dir, 'decisions.json');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

function deps(extra: Record<string, unknown> = {}): Deps {
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
    ...extra,
  } as unknown as Deps;
}
function tap(step: Step, key: string, head: string, label: string): void {
  expect(offerWrite({ step, key, head, spec: { header: 'T', question: 'Q?', options: [{ label }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step, key, head, label })).toEqual({ ok: true });
}
const landTap = (n: number) => tap('land', `${REPO}#${n}`, HEAD, 'Land now (Recommended)');
const openTap = () => tap('open-pr', `${REPO}@feat/x`, HEAD, 'Open draft PR (Recommended)');
type Tool = 'Bash' | 'PowerShell';
const input = (command: string, tool: Tool) => ({ tool_name: tool, tool_input: { command }, cwd: '/repo', session_id: 'c2d' });
/** The verdict with the real parse: deny:<pattern>, warn or allow. */
async function verdict(command: string, tool: Tool = 'Bash'): Promise<string> {
  const inp = input(command, tool);
  const d = decide(inp, { ...(await withParsed(JSON.stringify(inp), deps())) } as Deps);
  return d.action === 'deny' ? `deny:${d.pattern}` : typeof d.warn === 'string' ? 'warn' : 'allow';
}
const denied = (v: string): boolean => v.startsWith('deny:');
type Setup = (() => void) | null;
const none: Setup = null;
const land = (n: number): Setup => () => landTap(n);
const LAND = 'scripts/github/land-pr.ps1';
const MG = 'gh pr mer""ge 6 --admin';
const CR = 'gh pr cre""ate --head evil --base main --title t --body b';

describe('A: the 18 aegis forms (main denies each, 1404a660 allows each)', () => {
  // Change that breaks it: git, rg or a prefixed call is accepted as inert with any argument, or a spliced word ends in isInert.
  const rows: [string, Tool, string, Setup][] = [
    ['a01 git rebase --exec with a spliced merge', 'Bash', `git rebase --exec '${MG}' HEAD~1`, none],
    ['a02 git rebase -x with a spliced merge', 'Bash', `git rebase -x '${MG}' HEAD~1`, none],
    ['a03 git rebase --exec with a backslash verb', 'Bash', "git rebase --exec 'g\\h pr merge 6 --admin' HEAD~1", none],
    ['a04 git rebase --exec with a spliced api merge', 'Bash', `git rebase --exec 'gh a""pi -X PUT ${R}/pulls/6/merge' HEAD~1`, none],
    ['a05 git rebase --exec with a spliced create', 'Bash', `git rebase --exec '${CR}' HEAD~1`, none],
    ['a06 git rebase --exec with a spliced land script', 'Bash', `git rebase --exec 'pwsh -File scripts/github/land\\-pr.ps1 -Pr 6' HEAD~1`, none],
    ['a07 GIT_EXTERNAL_DIFF holds a spliced merge', 'Bash', `GIT_EXTERNAL_DIFF='${MG} #' git diff`, none],
    ['a08 GIT_EXTERNAL_DIFF holds a spliced create', 'Bash', `GIT_EXTERNAL_DIFF='${CR} #' git diff`, none],
    ['a09 git -c diff.external holds a spliced merge', 'Bash', `git -c diff.external='${MG} #' diff`, none],
    ['a10 git bisect run sh -c with a spliced merge', 'Bash', `git bisect run sh -c '${MG}'`, none],
    ['a11 git submodule foreach with a spliced merge', 'Bash', `git submodule foreach '${MG}'`, none],
    ['a12 scriptblock Create and Invoke with a spliced merge', 'PowerShell', `[scriptblock]::Create('${MG}').Invoke()`, none],
    ['a13 scriptblock Create and Invoke with a spliced create', 'PowerShell', `[scriptblock]::Create('${CR}').Invoke()`, none],
    ['a14 InvokeScript with a spliced merge', 'PowerShell', "$ExecutionContext.InvokeCommand.InvokeScript('g''h'' pr merge 6 --admin')", none],
    ['a15 a script written, then rg --pre pwsh (PowerShell)', 'PowerShell', "Set-Content m.ps1 'gh pr mer\"\"ge 6'; rg --pre pwsh x m.ps1", none],
    ['a16 a script written, then rg --pre pwsh (Bash)', 'Bash', "printf 'gh pr mer\"\"ge 6' > m.ps1; rg --pre pwsh x m.ps1", none],
    ['a17 a tapped land of PR 5, then a spliced merge in git rebase --exec', 'Bash', `git rebase --exec '${MG}' HEAD~1; pwsh -File ${LAND} -Pr 5`, land(5)],
    ['a18 a tapped create, then a spliced create in git rebase --exec', 'Bash', `gh pr create --head feat/x --base main --title t --body b && git rebase --exec '${CR}' HEAD~1`, openTap],
  ];
  it.each(rows)('%s', async (_name, tool, text, setup) => {
    if (setup) setup();
    expect(denied(await verdict(text, tool)), `${tool}: ${text}`).toBe(true);
  });
});

describe('K: the critic forms and the carriers of the register', () => {
  const rows: [string, Tool, string, Setup][] = [
    ['c01 rg --pre runs a merge (plain)', 'Bash', "rg --pre 'gh pr merge 9' x .", none],
    ['c02 pwsh -File with a path that holds a push: denied, not a warn (the skipped -File value keeps scope other)', 'Bash', "pwsh -File './git push (x.ps1'", none],
    ['c03 GH_PAGER prefix on gh holds a spliced merge', 'Bash', `GH_PAGER='${MG} #' gh pr list`, none],
    ['c04 git -c core.pager holds a spliced merge', 'Bash', `git -c core.pager='${MG} #' log`, none],
    ['c05 GIT_SSH_COMMAND prefix holds a spliced merge', 'Bash', `GIT_SSH_COMMAND='${MG} #' git fetch fork`, none],
    ['c06 git config alias stores a merge, then runs it', 'Bash', "git config alias.zz '!gh pr merge 6'; git zz", none],
    ['c07 sort --compress-program runs a merge', 'Bash', "sort --compress-program='gh pr merge 6' f; echo ok", none],
    ['c08 claude --bare child session with a merge', 'Bash', "claude --bare -p 'gh pr merge 6 --admin'", none],
    ['c09 gh codespace ssh runs the text after --', 'Bash', "gh codespace ssh -c x -- 'gh pr merge 6'", none],
    ['c10 env: drive GH_REPO, then a merge', 'PowerShell', 'Set-Content env:GH_REPO acme/app; gh pr merge 6 --squash', none],
    ['c11 an export of GH_CONFIG_DIR before a merge (as whom gh runs)', 'Bash', 'export GH_CONFIG_DIR=/tmp/other; gh pr merge 6 --squash', none],
    ['c12 GH_CONFIG_DIR prefix on a merge', 'Bash', 'GH_CONFIG_DIR=/tmp/other gh pr merge 6 --squash', none],
    ['c13 a PowerShell env assignment of GH_HOST, then a merge', 'PowerShell', '$env:GH_HOST = "ghe.example.com"; gh pr merge 6 --squash', none],
    ['c14 git -c alias with a spliced create', 'Bash', `git -c alias.pc='${CR}' pc`, none],
    ['c15 PowerShell static member Start with a merge', 'PowerShell', "[Diagnostics.Process]::Start('gh','pr merge 9')", none],
  ];
  it.each(rows)('%s', async (_name, tool, text, setup) => {
    if (setup) setup();
    expect(denied(await verdict(text, tool)), `${tool}: ${text}`).toBe(true);
  });
});

describe('O: old holes, the same on main (design note section 5)', () => {
  // Each is denied by the next plan. The cost of each is named in the note.
  it('o01 the land script with -CleanupOnly:$false merges, and is denied with no tap', async () => {
    expect(denied(await verdict(`pwsh -File ${LAND} -Pr 6 -CleanupOnly:$false`)), 'Bash').toBe(true);
  });
  it('o02 a backtick inside -Pr binds another PR (tap for 5, text binds 56): denied', async () => {
    landTap(5);
    expect(denied(await verdict(`& ${LAND} -Pr 5\`6`, 'PowerShell')), 'PowerShell').toBe(true);
  });
  it('o03 a brace that holds the gh program words: denied', async () => {
    expect(denied(await verdict('{"gh",pr} merge 6 --admin')), 'Bash').toBe(true);
  });
  it('o04 a brace that holds the verb words: denied', async () => {
    expect(denied(await verdict('gh {"pr",merge} 6 --admin')), 'Bash').toBe(true);
  });
  it('o05 a brace in --body that expands to another head, under a tap: denied', async () => {
    openTap();
    expect(denied(await verdict('gh pr create --head feat/x --base main --title t --body {b,"--head=evil"}')), 'Bash').toBe(true);
  });
});

describe('R: an unlisted runner beside a guarded call stays denied (guards, GREEN on 1404a660)', () => {
  // Change that breaks it: a runner is added to a list because it looked read-only.
  const rows: [string, Tool, string][] = [
    ['r01 find -exec', 'Bash', 'find . -name x -exec gh pr merge 6 --squash {} \\;'],
    ['r02 awk system()', 'Bash', "awk 'BEGIN{system(\"gh pr merge 6 --squash\")}'"],
    ['r03 sed e command', 'Bash', "echo x | sed 's/x/gh pr merge 6/e'"],
    ['r04 xargs', 'Bash', 'echo 6 | xargs gh pr merge --squash'],
    ['r05 parallel', 'Bash', 'echo 6 | parallel gh pr merge --squash'],
    ['r06 watch', 'Bash', 'watch -n 5 gh pr merge 6 --squash'],
    ['r07 perl -e', 'Bash', "perl -e 'system(\"gh pr merge 6 --squash\")'"],
    ['r08 python -c', 'Bash', "python -c \"import os; os.system('gh pr merge 6 --squash')\""],
    ['r09 source a file', 'Bash', 'source ./run.sh; gh pr merge 6 --squash'],
    ['r10 dot a file', 'Bash', '. ./run.sh; gh pr merge 6 --squash'],
    ['r11 eval of a variable', 'Bash', 'cmd="gh pr merge 6 --squash"; eval "$cmd"'],
    ['r12 Invoke-Expression (PowerShell)', 'PowerShell', "Invoke-Expression 'gh pr merge 6 --squash'"],
    ['r13 call operator on a variable (PowerShell)', 'PowerShell', '$c = "gh"; & $c pr merge 6 --squash'],
    ['r14 Start-Process (PowerShell)', 'PowerShell', "Start-Process gh -ArgumentList 'pr merge 6 --squash'"],
  ];
  it.each(rows)('%s', async (_name, tool, text) => {
    expect(denied(await verdict(text, tool)), `${tool}: ${text}`).toBe(true);
  });
});

describe('L: controls, a legitimate command stays allowed', () => {
  const rows: [string, Tool, string][] = [
    ['l01 a commit message that names a merge', 'Bash', 'git commit -m "docs: how gh pr merge works"'],
    ['l02 an rg pattern that names a create, then git log', 'Bash', "rg -n 'pr create' docs/ ; git log --oneline -3"],
    ['l03 gh pr view, then git status', 'Bash', 'gh pr view 6 --json state; git status --short'],
    ['l04 an echo of a spliced word (data)', 'Bash', "echo 'gh pr mer\"\"ge 6'"],
    ['l05 git -C dir log, then gh pr view', 'Bash', 'git -C /repo log -3; gh pr view 6'],
    ['l06 Get-Date, then a gh api read', 'PowerShell', `Get-Date -Format "HH:mm"; gh api ${R}/pulls/6 --jq .state`],
    ['l07 [datetime]::Now, then gh pr view', 'PowerShell', '[datetime]::Now; gh pr view 6'],
    ['l08 an env prefix of a safe name on gh', 'Bash', 'NO_COLOR=1 gh pr view 6'],
  ];
  it.each(rows)('%s', async (_name, tool, text) => {
    expect(await verdict(text, tool), `${tool}: ${text}`).toBe('allow');
  });
});

describe('E: the carrier rules decide a TAPPED merge (the tap makes the merge itself allowed, so only the carrier rule can deny)', () => {
  // Change that breaks it: an env name, a git subcommand, an ntn subcommand or a writer target is accepted that runs another program or changes the account.
  const M = `gh pr merge 6 --squash --match-head-commit ${HEAD}`;
  const rows: [string, Tool, string, boolean][] = [
    ['e01 baseline: the tapped merge alone', 'Bash', M, false],
    ['e02 a safe env name on the merge', 'Bash', `NO_COLOR=1 ${M}`, false],
    ['e03 GH_CONFIG_DIR prefix (as whom gh runs)', 'Bash', `GH_CONFIG_DIR=/tmp/other ${M}`, true],
    ['e04 GH_PAGER prefix on a read call before the merge', 'Bash', `GH_PAGER=less gh pr list; ${M}`, true],
    ['e05 env wrapper with GH_REPO', 'Bash', `env GH_REPO=acme/app ${M}`, true],
    ['e06 a PowerShell env write of GH_HOST', 'PowerShell', `$env:GH_HOST = "ghe.example.com"; ${M}`, true],
    ['e07 a PowerShell env write of a safe name', 'PowerShell', `$env:NO_COLOR = "1"; ${M}`, false],
    ['e08 a write to the env: drive', 'PowerShell', `Set-Content env:GH_REPO acme/app; ${M}`, true],
    ['e09 a write to the function: drive', 'PowerShell', `Set-Content function:gh 'echo x'; ${M}`, true],
    ['e10 a write to a plain file', 'PowerShell', `Set-Content notes.txt 'text'; ${M}`, false],
    ['e11 git log before the merge', 'Bash', `git log --oneline -3; ${M}`, false],
    ['e12 git rebase --exec before the merge', 'Bash', `git rebase --exec 'echo x' HEAD~1; ${M}`, true],
    ['e13 git -c before the merge', 'Bash', `git -c core.pager=less log; ${M}`, true],
    ['e14 git bisect before the merge', 'Bash', `git bisect run echo; ${M}`, true],
    ['e15 git config alias before the merge', 'Bash', `git config alias.zz 'status'; ${M}`, true],
    ['e16 git config a plain key before the merge', 'Bash', `git config --get user.name; ${M}`, false],
    ['e17 rg a plain pattern before the merge', 'Bash', `rg -n foo docs/; ${M}`, false],
    ['e18 rg --pre before the merge', 'Bash', `rg --pre cat foo docs/; ${M}`, true],
    ['e19 sort --compress-program before the merge', 'Bash', `sort --compress-program=gzip f; ${M}`, true],
    ['e20 claude -p before the merge', 'Bash', `claude -p "say hi"; ${M}`, false],
    ['e21 claude --bare -p before the merge', 'Bash', `claude --bare -p "say hi"; ${M}`, true],
    ['e22 gh codespace before the merge', 'Bash', `gh codespace list; ${M}`, true],
    ['e23 gh text after a bare -- before the merge', 'Bash', `gh repo clone acme/app -- --depth 1; ${M}`, true],
    ['e24 ntn pages get before the merge', 'Bash', `ntn pages get abc123; ${M}`, false],
    ['e25 ntn pages create with --content before the merge', 'Bash', `ntn pages create --content "text"; ${M}`, false],
    ['e26 ntn pages create with no content (opens the editor)', 'Bash', `ntn pages create; ${M}`, true],
    ['e27 ntn workers deploy before the merge', 'Bash', `ntn workers deploy; ${M}`, true],
    ['e28 ntn notion-as-code apply before the merge', 'Bash', `ntn notion-as-code apply ./proj; ${M}`, true],
  ];
  it.each(rows)('%s', async (_name, tool, text, deny) => {
    landTap(6);
    const v = await verdict(text, tool);
    expect(denied(v), `${tool}: ${text} -> ${v}`).toBe(deny);
  });
});

describe('G: the carrier register (design note section 2)', () => {
  // Change that breaks it: a program is added to a list with no row that says which of its options, subcommands or variables run another program, and why none does.
  const g = gate as unknown as { CARRIER_REGISTER?: Record<string, { runs: string[]; source: string }>; LISTED_PROGRAMS?: ReadonlySet<string> };
  it('g01 the register and the set of listed programs are exported', () => {
    expect(g.CARRIER_REGISTER, 'CARRIER_REGISTER').toBeTypeOf('object');
    expect(g.LISTED_PROGRAMS instanceof Set, 'LISTED_PROGRAMS is a Set').toBe(true);
  });
  it('g02 every listed program has a row with its run paths (an empty list says none) and a documentation source', () => {
    const reg = g.CARRIER_REGISTER ?? {};
    const listed = [...(g.LISTED_PROGRAMS ?? [])];
    expect(listed.length, 'listed programs').toBeGreaterThan(40);
    const missing = listed.filter((p) => !reg[p] || !Array.isArray(reg[p].runs) || typeof reg[p].source !== 'string' || reg[p].source.length < 8);
    expect(missing, 'listed programs with no register row').toEqual([]);
  });
  it('g03 the carriers of the note are in their rows', () => {
    const reg = g.CARRIER_REGISTER ?? {};
    const has = (p: string, w: string): boolean => (reg[p]?.runs ?? []).some((x) => x.includes(w));
    expect(has('git', '-c'), 'git -c').toBe(true);
    expect(has('git', 'rebase'), 'git rebase -x').toBe(true);
    expect(has('rg', '--pre'), 'rg --pre').toBe(true);
    expect(has('sort', '--compress-program'), 'sort --compress-program').toBe(true);
    expect(has('claude', '--bare'), 'claude --bare').toBe(true);
    expect(has('gh', 'codespace'), 'gh codespace').toBe(true);
  });
  it('g04 a row for a program that is not listed fails: no stray rows', () => {
    const reg = g.CARRIER_REGISTER ?? {};
    const listed = g.LISTED_PROGRAMS ?? new Set<string>();
    expect(Object.keys(reg).filter((p) => !listed.has(p)), 'rows with no listed program').toEqual([]);
  });
});
