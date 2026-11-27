/**
 * decision-gate push rule: a quoted cd target under Desktop Commander cmd must name its folder (RED step, lane g7-ppg-bodyflag).
 *
 * The flaw: `cd "A" && git push zza br-a` through start_process (shell cmd) is denied "position-unknown" even from a checkout
 * where A has a valid ship decision. The third reading (quotes NOT blanked, cmd.exe) does not read a quoted cd target as a cd,
 * so the cd looks like an unknown move ("popd, Pop-Location, cd - or a bare cd ..."). An unquoted target works today.
 * Proof: scratchpad/proof7/decision-gate-cd-target-proof.mjs (the built hook, real temp repos A, B, P).
 *
 * Folders: A is a CCv3 checkout with a ship decision for its branch and tree. B is a CCv3 checkout with none. P has a plain remote.
 * enforcePush is on in all three.
 *
 * Failure modes, one test group each:
 *   C1  the quoted cd target of a push in a folder WITH a decision is denied as position-unknown (the gap, rows b, c, d)
 *   C2  the quoted cd target of a push to a plain repo is denied the same way (the gap, row e)
 *   C3  the fix reads the cd and judges the wrong folder: B stays denied, from every start and every quote form (must stay denied)
 *   C4  the fix reads a variable, subshell or chained cd as a known folder: it must not ALLOW a push B has no decision for
 *   C5  popd, `cd -` and a bare cd lose their position-unknown deny (must stay denied)
 *   C6  Bash and PowerShell, which read the quoted cd today, change (must stay allowed)
 *
 * Real git and real temp repos (as the proof). Nothing in a payload runs.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeGit, type Deps } from '../decision-gate.js';
import { decideParsed } from './helpers/parse-first.js';

const DC = 'mcp__plugin_desktop-commander_desktop-commander__';
const SESSION = '3c9a1d52-7e44-4b0f-8a6d-1f2e3d4c5b6a';
const CCV3 = 'https://github.com/Rev4nchist/continuous-claude-v3.git';

interface Repo { d: string; tree: string }
let home = '';
let A: Repo;
let B: Repo;
let P: Repo;
let saved: string | undefined;

function makeRepo(name: string, remote: string, url: string, branch: string): Repo {
  const d = `${home}/${name}`;
  mkdirSync(d);
  const g = (...a: string[]) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  g('init', '-q');
  g('remote', 'add', remote, url);
  g('-c', 'user.name=p', '-c', 'user.email=p@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x');
  g('checkout', '-q', '-b', branch);
  writeFileSync(`${d}/review-router.config.json`, JSON.stringify({ decisions: { enforcePush: true } }));
  return { d, tree: g('rev-parse', `${branch}^{tree}`).stdout.trim() };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'dg-cd-target-')).replace(/\\/g, '/');
  // The quoted-cd rewrite refuses a path with a space (it would split the path). Every target here is built from this folder.
  if (/\s/.test(home)) throw new Error(`the temp folder path has a space (${home}): set TEMP to a path without spaces to run this test`);
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = `${home}/decisions.json`;
  A = makeRepo('repoA', 'zza', CCV3, 'br-a');
  B = makeRepo('repoB', 'zzb', CCV3, 'br-b');
  P = makeRepo('repoP', 'zzp', 'https://example.invalid/plain/repo.git', 'br-p');
  // One ship decision, for repo A's branch and tree only (the store format of scripts/github/lib/decisions.mjs).
  const id = `ship\nRev4nchist/Continuous-Claude-v3@br-a\n${'a'.repeat(40)}`;
  writeFileSync(`${home}/decisions.json`, JSON.stringify({ version: 1, offers: {}, decisions: { [id]: { label: 'Commit and push', at: new Date().toISOString(), tree: A.tree, nonce: 'n' } }, misses: {} }));
});
afterAll(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(home, { recursive: true, force: true });
});

const deps = (): Deps => ({
  git: makeGit(),
  readFile: (p) => { try { return existsSync(p) ? readFileSync(p, 'utf8') : null; } catch { return null; } },
  env: { ...process.env, CCV3_DECISIONS_FILE: `${home}/decisions.json` },
  home,
});

const pushA = 'git push zza br-a';
const pushB = 'git push zzb br-b';
const pushP = 'git push zzp br-p';

const dcCmd = (cwd: string, command: string) => ({ tool_name: `${DC}start_process`, tool_input: { command, shell: 'cmd', timeout_ms: 1000 }, cwd, session_id: SESSION });
const bashIn = (cwd: string, command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: SESSION });
const pwshIn = (cwd: string, command: string) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd, session_id: SESSION });
/** The verdict with the reason, so a failed row names the reason text. */
const verdict = async (input: object): Promise<string> => {
  // A thrown error (a folder that does not exist, a git error) is a deny: handle() turns it into one (fail closed).
  try {
    const r = await decideParsed(input, deps());
    return r.action === 'deny' ? `deny: ${r.reason.replace(/\s+/g, ' ').slice(0, 120)}` : 'allow';
  } catch (err) {
    return `deny: thrown ${(err as Error).name}`;
  }
};
const allowed = async (input: object, label: string): Promise<void> => { expect(await verdict(input), label).toBe('allow'); };
const denied = async (input: object, label: string): Promise<void> => { expect(await verdict(input), label).toMatch(/^deny/); };
const wrap = (inner: string) => `echo 'x & ${inner} & rem '`;
/**
 * A relative quoted target: every repo sits in the same parent. A drive-letter target is never rewritten (cd without /d keeps the current drive).
 * A forward slash: cmd.exe accepts it, and it names the same folder on Windows and on the Linux CI runner (a backslash is a name character there).
 */
const rel = (r: Repo): string => `../${r.d.split('/').pop()}`;

describe('C1 a quoted cd to the folder WITH a decision is allowed under cmd (the gap)', () => {
  it('baseline: cwd A, plain push, no cd (control: passes today)', async () => {
    await allowed(dcCmd(A.d, pushA), 'plain push in A');
  });
  it('baseline: cwd B, plain push, no decision (control: denied today)', async () => {
    await denied(dcCmd(B.d, pushB), 'plain push in B');
  });
  it('b: cwd B, cd "A" && git push, double quotes', async () => {
    await allowed(dcCmd(B.d, `cd "${rel(A)}" && ${pushA}`), 'double-quoted cd to A');
  });
  // cmd.exe reads 'A' as a folder name, not as a quoted path. The shell may not move, so `cd 'A' & git push` pushes in the old folder.
  // The break view keeps it a bare cd (position-unknown): an accepted over-deny, stricter than the first test draft (Dave's yes was for a plain double-quoted path).
  it("c: cwd B, cd 'A' && git push, single quotes stays denied (cmd.exe reads 'A' as a name)", async () => {
    await denied(dcCmd(B.d, `cd '${A.d}' && ${pushA}`), 'single-quoted cd to A');
  });
  it('d: cwd B, the wrapped form echo \'x & cd "A" && git push & rem \'', async () => {
    await allowed(dcCmd(B.d, wrap(`cd "${rel(A)}" && ${pushA}`)), 'wrapped double-quoted cd to A');
  });
  it('control: cwd B, an UNQUOTED cd to A is allowed today', async () => {
    await allowed(dcCmd(B.d, `cd ${A.d} && ${pushA}`), 'unquoted cd to A');
  });
});

describe('C2 a quoted cd to a plain, non-CCv3 repo is allowed under cmd (the gap)', () => {
  it('e: cwd A, cd "P" && git push', async () => {
    await allowed(dcCmd(A.d, `cd "${rel(P)}" && ${pushP}`), 'double-quoted cd to P');
  });
  it('control: cwd P (plain), cd "A" && git push is allowed today (A has a decision)', async () => {
    await allowed(dcCmd(P.d, `cd "${rel(A)}" && ${pushA}`), 'cwd P, cd to A');
  });
});

describe('C3 a quoted cd to the folder WITHOUT a decision stays denied (must pass today and after the fix)', () => {
  it('a: cwd A, cd "B" && git push', async () => {
    await denied(dcCmd(A.d, `cd "${rel(B)}" && ${pushB}`), 'double-quoted cd to B from A');
  });
  it("a2: cwd A, cd 'B' && git push, single quotes", async () => {
    await denied(dcCmd(A.d, `cd '${B.d}' && ${pushB}`), 'single-quoted cd to B from A');
  });
  it('a3: cwd A, the wrapped form with cd "B"', async () => {
    await denied(dcCmd(A.d, wrap(`cd "${rel(B)}" && ${pushB}`)), 'wrapped cd to B from A');
  });
  it('f: cwd P, cd "B" && git push', async () => {
    await denied(dcCmd(P.d, `cd "${rel(B)}" && ${pushB}`), 'double-quoted cd to B from P');
  });
  it('f2: cwd B, cd "B" && git push (a cd to the folder it is already in)', async () => {
    await denied(dcCmd(B.d, `cd "${rel(B)}" && ${pushB}`), 'cd to B from B');
  });
  // The branch of A has no tree in B (B has no br-a, git would fail the push), and the gate reads an unquoted known cd the same way: ALLOW.
  // The rule is parity: a plain double-quoted cd reads exactly like the unquoted cd, so the fix adds no new ALLOW of its own.
  it('f3: parity, cwd A, cd "B" && git push zza br-a reads like the unquoted cd', async () => {
    expect(await verdict(dcCmd(A.d, `cd "${rel(B)}" && ${pushA}`)), 'quoted').toBe(await verdict(dcCmd(A.d, `cd ${rel(B)} && ${pushA}`)));
  });
});

describe('C4 a cd the text cannot name, or a chain of cds, is never read as a known folder with a decision', () => {
  it('g: cwd A, cd "%X%" && git push zzb br-b (a variable target)', async () => {
    await denied(dcCmd(A.d, `cd "%X%" && ${pushB}`), 'variable target');
  });
  it('g2: cwd A, cd "$(echo B)" && git push (a subshell target)', async () => {
    await denied(dcCmd(A.d, `cd "$(echo ${B.d})" && ${pushB}`), 'subshell target');
  });
  it('g3: cwd A, cd "A" & cd "B" && git push (the last cd wins)', async () => {
    await denied(dcCmd(A.d, `cd "${rel(A)}" & cd "${rel(B)}" && ${pushB}`), 'chained cds, B last');
  });
  it('g4: parity, cwd B, cd "A" & cd "B" && git push zza br-a reads like the unquoted chain (the last cd wins)', async () => {
    expect(await verdict(dcCmd(B.d, `cd "${rel(A)}" & cd "${rel(B)}" && ${pushA}`)), 'quoted chain').toBe(await verdict(dcCmd(B.d, `cd ${rel(A)} & cd ${rel(B)} && ${pushA}`)));
  });
  it('g6: cwd B, a quoted path with a space is never split into a known folder: cd "A x" && git push zza br-a', async () => {
    await denied(dcCmd(B.d, `cd "${rel(A)} x" && ${pushA}`), 'quoted path with a space');
  });
  it('g7: cwd B, text after the closing quote: cd "A"x && git push zza br-a', async () => {
    await denied(dcCmd(B.d, `cd "${rel(A)}"x && ${pushA}`), 'text glued to the closing quote');
  });
  // cmd.exe pairs the double quotes: the `& cd "A" &` below sits inside a quoted span, so it is no cd. The push after it runs in the cwd (B, no decision).
  it('g8: cwd B, a quoted cd inside a double-quoted span is no cd: echo \'x & "& cd "A" &" & git push zza br-a & rem \'', async () => {
    await denied(dcCmd(B.d, `echo 'x & "& cd "${rel(A)}" &" & ${pushA} & rem '`), 'cd inside a double-quoted span');
  });
  it('g9: cwd B, a ^ anywhere keeps every quote: cd "A" && git push zza br-a ^', async () => {
    await denied(dcCmd(B.d, `cd "${rel(A)}" && ${pushA} ^`), 'caret in the text');
  });
  // cmd.exe: cd "D:\A" without /d changes the folder of drive D only. The current drive stays and the push runs in the cwd (B, no decision).
  it('g10: cwd B, a quoted drive-letter target is never read as a known folder: cd "C:/.../repoA" && git push zza br-a', async () => {
    if (!/^[A-Za-z]:/.test(A.d)) return; // a drive letter exists on Windows only
    await denied(dcCmd(B.d, `cd "${A.d}" && ${pushA}`), 'quoted drive-letter target');
  });
  it('g5: cwd A, a relative quoted cd "..\\\\repoB" && git push zzb br-b', async () => {
    await denied(dcCmd(A.d, `cd "..\\repoB" && ${pushB}`), 'relative quoted cd to B');
  });
});

describe('C5 popd, cd - and a bare cd stay denied as position-unknown (must pass today and after the fix)', () => {
  it('popd && git push', async () => {
    await denied(dcCmd(A.d, `popd && ${pushA}`), 'popd');
  });
  it('cd - && git push', async () => {
    await denied(dcCmd(A.d, `cd - && ${pushA}`), 'cd -');
  });
  it('bare cd && git push', async () => {
    await denied(dcCmd(A.d, `cd && ${pushA}`), 'bare cd');
  });
  it('the wrapped form with popd', async () => {
    await denied(dcCmd(A.d, wrap(`popd & ${pushA}`)), 'wrapped popd');
  });
  it('a quoted cd to A AFTER a popd: the popd still makes the position unknown', async () => {
    await denied(dcCmd(B.d, `popd & cd "${A.d}" && ${pushA}`), 'popd then quoted cd');
  });
});

describe('C6 Bash and PowerShell read the quoted cd already (must pass today and after the fix)', () => {
  it('i: Bash, cwd B, cd "A" && git push', async () => {
    await allowed(bashIn(B.d, `cd "${A.d}" && ${pushA}`), 'Bash cd to A');
  });
  it('i2: PowerShell, cwd B, cd "A" && git push', async () => {
    await allowed(pwshIn(B.d, `cd "${A.d}" && ${pushA}`), 'PowerShell cd to A');
  });
  it('Bash, cwd A, cd "B" && git push stays denied', async () => {
    await denied(bashIn(A.d, `cd "${B.d}" && ${pushB}`), 'Bash cd to B');
  });
  it('PowerShell, cwd A, cd "B" && git push stays denied', async () => {
    await denied(pwshIn(A.d, `cd "${B.d}" && ${pushB}`), 'PowerShell cd to B');
  });
});
