/**
 * PR C2c (closed world, Dave's tap 'D5 closed world' 11-26). The rows of the hole suite: the forms that the aegis and critic reviews of the stopped C2b branch found
 * (main denies each, the C2b source allowed them), plus controls, the relaxation rows, the timeout row and one row per wrapper with a wrong arity.
 * Every row runs the real parse (withParsed) and the real rule (decide). RED on the C2b base, GREEN on the closed-world fix.
 *   H  holes: a command that main denies must be denied (no tap unless the row names one)
 *   C  controls and the wrapper cost row (a tapped env gh pr merge is judged like the bare call)
 *   B  relaxation rows: pwsh -File with the land script (plain, quoted, spliced), and with a path that holds a guarded word; each keeps main's verdict
 *   N  the no-parse cleanup land: the only raw-text allow stays anchored (a newline row denies)
 *   T  a real walker timeout still denies (fail closed)
 *   W  wrapper table: a correct arity is judged like the bare call, a wrong arity denies
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionRecord, offerWrite, type Step } from '../shared/decisions-store.js';
import { decide, withParsed, type Deps } from '../decision-gate.js';

vi.setConfig({ testTimeout: 120000 });
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const R = `repos/${REPO}`;
const HEAD = 'a'.repeat(40);
let dir = '';
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shell-parser-c2c-'));
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
const input = (command: string, tool: Tool) => ({ tool_name: tool, tool_input: { command }, cwd: '/repo', session_id: 'c2c' });
/** The verdict with the real parse: deny:<pattern>, warn or allow. */
async function verdict(command: string, tool: Tool = 'Bash', extra: Record<string, unknown> = {}): Promise<string> {
  const inp = input(command, tool);
  const d = decide(inp, { ...(await withParsed(JSON.stringify(inp), deps(extra))) } as Deps);
  return d.action === 'deny' ? `deny:${d.pattern}` : typeof d.warn === 'string' ? 'warn' : 'allow';
}
/** The verdict of a call whose parse never answered (a late or thrown parse). */
const noParse = (command: string, tool: Tool = 'Bash'): string => {
  const d = decide(input(command, tool), deps({ parseLate: command }));
  return d.action === 'deny' ? `deny:${d.pattern}` : typeof d.warn === 'string' ? 'warn' : 'allow';
};
const denied = (v: string): boolean => v.startsWith('deny:');

const CREATE_API = `gh api ${R}/pulls -X POST -f head=feat/x -f base=main -f title=t`;
const LAND = 'scripts/github/land-pr.ps1';
type Setup = (() => void) | null;
const none: Setup = null;
const land = (n: number): Setup => () => landTap(n);

describe('H: a command that main denies is denied (aegis and critic forms, 10 classes)', () => {
  // Change that breaks it: a wrapper (env, timeout) is an accounted caller, a raw regex reads quotes in place, mentions are counted instead of every call being a listed program.
  const rows: [string, Tool, string, Setup][] = [
    ['H01 wrapper env hides an api create', 'Bash', `env ${CREATE_API}`, none],
    ['H02 wrapper timeout hides an api create', 'Bash', `timeout 30 gh api ${R}/pulls -f head=feat/x -f base=main -f title=t`, none],
    ['H03 a piped payload into timeout sh', 'Bash', `echo '${CREATE_API}' | timeout 5 sh`, none],
    ['H04 env with a quote-spliced merge verb', 'Bash', 'env gh pr "merge" 7', none],
    ['H05 timeout with a spliced merge verb', 'Bash', "timeout 60 gh pr me''rge 7", none],
    ['H06 env with a spliced create verb', 'Bash', 'env gh pr "create" --head feat/x --base main --title t --body b', none],
    ['H07 env bash -c with a spliced merge', 'Bash', `env bash -c 'gh pr "merge" 7'`, none],
    ['H08 pwsh -File with a spliced land script name (Bash)', 'Bash', `pwsh -File scripts/github/land-pr''.ps1 -Pr 7`, none],
    ['H08b pwsh -File with a spliced land script name (PowerShell)', 'PowerShell', `pwsh -File scripts/github/land-pr''.ps1 -Pr 7`, none],
    ['H09 call operator on a spliced land script name', 'PowerShell', `& scripts/github/land-pr''.ps1 -Pr 7`, none],
    ['H10 gh alias set --shell holds a create', 'Bash', `gh alias set --shell pc '${CREATE_API}' && gh pc`, none],
    ['H11 gh alias set --shell holds a spliced merge', 'Bash', `gh alias set --shell pm 'gh pr "merge" 7' && gh pm`, none],
    ['H12 count offset: tapped spliced merge, then an env merge of another PR', 'Bash', `gh pr "merge" 5 --squash --match-head-commit ${HEAD} ; env gh pr merge 7`, land(5)],
    ['H13 count offset: tapped spliced create, then an env create of another head', 'Bash', 'gh pr "create" --head feat/x --base main -t t -b b ; env gh pr create --head evil --base main -t t -b b', openTap],
    ['H14 a second api merge of another PR', 'Bash', `gh api -X PUT ${R}/pulls/5/merge -f sha=${HEAD} ; env gh api -X PUT ${R}/pulls/7/merge`, land(5)],
    ['H16 name spoofing: a written script named like a data program', 'PowerShell', `Set-Content ./echo.ps1 '${CREATE_API}'; ./echo.ps1`, none],
    ['H17 a parsed -c payload plus a heredoc script run by nohup', 'Bash', `bash -c 'rg "gh api ${R}/pulls" f'; cat > x.sh <<'EOF'\n${CREATE_API}\nEOF\nnohup bash x.sh`, none],
    ['H19 a push shape beside a hidden create piped to sh', 'Bash', `git push fork feat/x; echo '${CREATE_API}' | sh`, none],
    ['H20 count offset: an env merge of PR 99, then a tapped spliced merge of PR 12', 'Bash', `env gh pr merge 99 --squash ; gh pr "merge" 12 --squash --match-head-commit ${HEAD}`, land(12)],
    ['H24 a backslash splice of the gh program (bash leaves the word with no literal)', 'Bash', 'g\\h pr merge 7', none],
    ['H25 a backslash splice inside the merge verb', 'Bash', 'gh pr mer\\ge 7', none],
    ['H26 a backslash before the merge verb', 'Bash', 'gh pr \\merge 7', none],
    ['H27 env with a backslash splice of gh', 'Bash', 'env g\\h pr merge 7', none],
    ['H28 pwsh -File with a backslash in the land script name', 'Bash', `pwsh -File scripts/github/land\\-pr.ps1 -Pr 7`, none],
    ['H29 a tapped merge, then a backslash splice merge of another PR', 'Bash', `gh pr merge 7 --squash --match-head-commit ${HEAD} ; g\\h pr merge 9 --squash`, land(7)],
    ['H21 a written script run by a script runner (PowerShell)', 'PowerShell', `Set-Content x.js '${CREATE_API}'; node x.js`, none],
    ['H22 a heredoc script run by a script runner (Bash)', 'Bash', `cat > x.js <<'EOF'\n${CREATE_API}\nEOF\nnode x.js`, none],
    ['H23 inline code of a script runner', 'Bash', `node -e "require('child_process').execSync('${CREATE_API}')"`, none],
  ];
  it.each(rows)('%s', async (_name, tool, text, setup) => {
    if (setup) setup();
    expect(denied(await verdict(text, tool)), `${tool}: ${text}`).toBe(true);
  });
  it('H15 no parse, a land call with a newline before -CleanupOnly: denied (the cleanup exemption is one line)', () => {
    expect(denied(noParse(`${LAND} -Pr 5\n-CleanupOnly`)), 'Bash').toBe(true);
    expect(denied(noParse(`${LAND} -Pr 5\n-CleanupOnly`, 'PowerShell')), 'PowerShell').toBe(true);
  });
  it('H18 no parse, a gh.exe merge: denied', () => {
    expect(denied(noParse('gh.exe pr merge 12')), 'Bash').toBe(true);
    expect(denied(noParse('gh.exe pr merge 12', 'PowerShell')), 'PowerShell').toBe(true);
  });
});

describe('C: controls and the wrapper cost row', () => {
  it('C01 a read-only gh api GET piped to head: allowed', async () => {
    expect(await verdict(`gh api ${R}/pulls/705 --jq .title | head -c 200`)).toBe('allow');
  });
  it('C02 quoted text in a gh pr comment: allowed as data', async () => {
    expect(await verdict('gh pr comment 5 --body "do not run gh pr merge 5 yet"')).toBe('allow');
  });
  it('C03 the tapped merge alone: allowed', async () => {
    landTap(12);
    expect(await verdict(`gh pr merge 12 --squash --match-head-commit ${HEAD}`)).toBe('allow');
  });
  it('C05 (cost row) a tapped merge behind env is judged like the bare call: allowed with the tap, denied without', async () => {
    const text = `env gh pr merge 12 --squash --match-head-commit ${HEAD}`;
    expect(denied(await verdict(text))).toBe(true);
    landTap(12);
    expect(await verdict(text)).toBe('allow');
  });
});

describe('B: pwsh -File is not parsed as PowerShell any more (a relaxation): each row keeps the verdict of main', () => {
  // Main's verdicts, measured with the live main hook (file 147 of the lane evidence): the land script in any spelling is a land (deny); a path that holds a merge and a PR number is a no-pr deny.
  const keep: [string, Tool, string][] = [
    ['plain land script, Bash', 'Bash', `pwsh -File ${LAND} -Pr 7`],
    ['plain land script, PowerShell', 'PowerShell', `pwsh -File ${LAND} -Pr 7`],
    ['single-quoted land script, Bash', 'Bash', `pwsh -File '${LAND}' -Pr 7`],
    ['double-quoted land script, PowerShell', 'PowerShell', `pwsh -File "${LAND}" -Pr 7`],
    ['spliced land script, Bash', 'Bash', "pwsh -File scripts/github/land-pr''.ps1 -Pr 7"],
    ['spliced land script, PowerShell', 'PowerShell', "pwsh -File scripts/github/land-pr''.ps1 -Pr 7"],
    ['a path that holds a merge and a PR number, Bash', 'Bash', "pwsh -File 'C:/tmp/gh pr merge 7.ps1'"],
    ['a path that holds a merge and a PR number, PowerShell', 'PowerShell', "pwsh -File 'C:/tmp/gh pr merge 7.ps1'"],
    ['a script with a quoted merge argument', 'Bash', "pwsh -File C:/tmp/run-notes.ps1 'gh pr merge 7'"],
  ];
  it.each(keep)('%s: denied, as on main', async (_n, tool, text) => {
    expect(denied(await verdict(text, tool)), `${tool}: ${text}`).toBe(true);
  });
  // Named cost: main allows a pwsh -File whose only guarded words sit in the PATH (no PR number). The closed world does not allow any pwsh beside a guarded word: an allow-to-deny (a warn when only a push is named,
  // while decisions.enforcePush is unset), counted in the corpus.
  it.each([
    ['a path that holds a push', 'Bash', "pwsh -File './git push notes.ps1'"],
    ['a path that holds an api create', 'PowerShell', `pwsh -File 'C:/tmp/gh api ${R}/pulls.ps1'`],
  ] as [string, Tool, string][])('%s: not allowed (a named cost; main allows)', async (_n, tool, text) => {
    expect(await verdict(text, tool), `${tool}: ${text}`).not.toBe('allow');
  });
  it('a standalone land call with -CleanupOnly keeps the allow of main', async () => {
    expect(await verdict(`pwsh -File ${LAND} -Pr 12 -CleanupOnly`)).toBe('allow');
  });
});

describe('T: a real walker timeout still denies (fail closed)', () => {
  // The test helper may lengthen the walker timeout for a loaded runner. The provider here answers the way the walker does on a timeout.
  it('T1 the PowerShell walker times out on a text with a create: denied parse-error, not allowed', async () => {
    const v = await verdict('gh pr create --head feat/x --title t', 'PowerShell', { parseOpts: { pwshProvider: () => ({ error: 'pwsh timeout' }) } });
    expect(v).toBe('deny:parse-error');
  });
  it('T2 the walker times out on a text with a merge: denied, not allowed', async () => {
    const v = await verdict(`gh pr merge 12 --squash --match-head-commit ${HEAD}`, 'PowerShell', { parseOpts: { pwshProvider: () => ({ error: 'pwsh timeout' }) } });
    expect(denied(v)).toBe(true);
  });
});

describe('D: a wrapper option that moves the directory, or changes how the program is read, keeps the wrapper off the lists (CLI run 1 of the C2c pre-pr)', () => {
  // Change that breaks it: the unwrap skips -C or --chdir and judges the inner call in the OLD cwd, so env -C <a CCv3 repo> gh pr merge from another folder is judged there (main denies it).
  const MERGE = `gh pr merge 7 --squash --match-head-commit ${HEAD}`;
  const dirOptions = [
    ['env -C DIR', `env -C /repo ${MERGE}`],
    ['env -C attached', `env -C/repo ${MERGE}`],
    ['env --chdir=DIR', `env --chdir=/repo ${MERGE}`],
    ['env --chdir DIR', `env --chdir /repo ${MERGE}`],
    ['env -S (a split string runs another command line)', `env -S 'gh pr merge 7' ${MERGE}`],
    ['sudo -D DIR', `sudo -D /repo ${MERGE}`],
    ['sudo --chdir=DIR', `sudo --chdir=/repo ${MERGE}`],
    ['sudo -R DIR (chroot)', `sudo -R /srv ${MERGE}`],
    ['sudo --chroot=DIR', `sudo --chroot=/srv ${MERGE}`],
    ['sudo -s (a shell)', `sudo -s ${MERGE}`],
    ['sudo -i (a login shell)', `sudo -i ${MERGE}`],
  ] as const;
  it.each(dirOptions)('%s: denied, even with the tap', async (_name, text) => {
    landTap(7);
    expect(denied(await verdict(text)), text).toBe(true);
  });
  it('(paired) the same wrappers with no such option are read through and allowed with the tap', async () => {
    landTap(7);
    expect(await verdict(`env FOO=1 ${MERGE}`)).toBe('allow');
    expect(await verdict(`sudo -u root ${MERGE}`)).toBe('allow');
  });
});

describe('W: the wrapper table fails closed (a correct arity is judged like the bare call, a wrong one is denied)', () => {
  const MERGE = `gh pr merge 7 --squash --match-head-commit ${HEAD}`;
  // `time` is a reserved word of bash (a TimeClause in the parse), not a call, so it is not in the table. [wrapper, a correct form, a wrong arity form]. With a tap for PR 7 the correct form is allowed. The wrong form hands the wrapper's option value to the program word, so it must be denied.
  const table: [string, string, string][] = [
    ['env', `env -u FOO ${MERGE}`, `env -u ${MERGE}`],
    ['timeout', `timeout -k 5 60 ${MERGE}`, `timeout -k ${MERGE}`],
    ['nice', `nice -n 5 ${MERGE}`, `nice -n ${MERGE}`],
    ['sudo', `sudo -u root ${MERGE}`, `sudo -u ${MERGE}`],
    ['stdbuf', `stdbuf -o L ${MERGE}`, `stdbuf -o ${MERGE}`],
    ['exec', `exec -a name ${MERGE}`, `exec -a ${MERGE}`],
    ['nohup', `nohup ${MERGE}`, `nohup FOO=1 ${MERGE}`],
    ['command', `command ${MERGE}`, `command FOO=1 ${MERGE}`],
    ['builtin', `builtin ${MERGE}`, `builtin FOO=1 ${MERGE}`],
  ];
  it.each(table)('%s: the correct arity is allowed with a tap', async (_w, good) => {
    landTap(7);
    expect(await verdict(good), good).toBe('allow');
  });
  it.each(table)('%s: a wrong arity is denied, even with a tap', async (_w, _good, bad) => {
    landTap(7);
    expect(denied(await verdict(bad)), bad).toBe(true);
  });
  it('a wrapper with a word that no literal gives is denied, even with a tap', async () => {
    landTap(7);
    expect(denied(await verdict(`env $X ${MERGE}`)), 'env $X').toBe(true);
    expect(denied(await verdict(`timeout "$D" ${MERGE}`)), 'timeout "$D"').toBe(true);
  });
});
