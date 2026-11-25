/**
 * PR C1 of card coord-guard-shell-parser (plan 78-pr-c-plan.md, seat ruling 12:5x CST 11-25): RED rows. C1 only ADDS denies.
 *   F1    a text that does not parse and holds a guarded call is denied (kind parse-error), also inside bash -c and pwsh -Command
 *   B1    a script runner call whose inline code names a guarded call is denied on the raw text, with no list of flag spellings
 *   B2    when the parse is late the raw text still gets the script-runner deny
 *   A1-U  a remote is local when its fetch URL OR any push URL is local (`git remote get-url --push --all <name>`)
 *   A3-U  a remote name is local when it is local in the payload folder OR in the folder of the earlier push (cd, -C)
 *   A2    the remote lookups stop when the hook time left is under the reserve; the push is denied on the clock
 * Texts that main (770cf2f7) allows are the RED rows. Texts that main already denies are controls: C1 must not turn them into an allow.
 * The git fake answers `remote get-url [--push --all] <name>`; the lookups are counted (A2).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionKey, decisionRecord, offerWrite } from '../shared/decisions-store.js';
import * as gate from '../decision-gate.js';
import { decide, scriptRunnerDenies, withParsed, type Deps } from '../decision-gate.js';

vi.setConfig({ testTimeout: 20000 });
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const TREE = 't'.repeat(40);
const NET = 'https://example.invalid/';
let dir = '';
let saved: string | undefined;
let lookups: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shell-parser-c1-'));
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = join(dir, 'decisions.json');
  lookups = [];
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

/** [fetch URL, push URLs] by remote name, as `git remote get-url <name>` and `git remote get-url --push --all <name>` print them. `.` is a local path. */
const REMOTES: Record<string, (inSub: boolean) => [string, string]> = {
  fork: () => [`https://github.com/${REPO}.git`, `https://github.com/${REPO}.git`],
  plain: () => [`${NET}p.git`, `${NET}p.git`],
  cacheb: () => [`${NET}y.git`, '.'], // network fetch URL, local push URL
  cachel: () => ['.', `${NET}x.git`], // local fetch URL, network push URL
  multi: () => [`${NET}m.git`, `${NET}m.git\n.`], // two push URLs, one local
  cachesub: (inSub) => (inSub ? ['.', '.'] : [`${NET}z.git`, `${NET}z.git`]), // local only in the folder sub
  cachecwd: (inSub) => (inSub ? [`${NET}c.git`, `${NET}c.git`] : ['.', '.']), // local only in the payload folder
};

/** `throwIn`: a git read run in a folder that ends with `dir` throws an error with this code (spawnSync: ETIMEDOUT on the timeout, ENOENT for a missing folder). */
interface World { scanLeft?: () => number; throwIn?: { dir: string; code: string } }
function deps(w: World = {}): Deps {
  const config = JSON.stringify({ decisions: { enforce: true } });
  return {
    env: { ...process.env, CCV3_DECISIONS_FILE: join(dir, 'decisions.json') },
    home: '/home/nobody',
    ...(w.scanLeft ? { scanLeft: w.scanLeft } : {}),
    readFile: (p: string) => (p.replace(/\\/g, '/').endsWith('/review-router.config.json') ? config : null),
    git: (cwd: string, args: string[]) => {
      const a = args.join(' ');
      if (a === 'remote -v') return { status: 0, stdout: `fork\thttps://github.com/${REPO}.git (push)\n` };
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
      if (a === 'branch --show-current') return { status: 0, stdout: 'feat/x\n' };
      if (a === 'rev-parse --abbrev-ref @{push}') return { status: 128, stdout: '' };
      const gu = /^remote get-url (--push --all )?(\S+)$/.exec(a);
      if (gu) {
        lookups.push(a);
        // Only the push-URL read throws: the shape judge reads the fetch URL of each push remote too (another call site, not under test here).
        if (w.throwIn && gu[1] && cwd.replace(/\\/g, '/').endsWith(w.throwIn.dir)) {
          if (w.throwIn.code === 'MISSING-CWD') throw new gate.MissingCwdError(cwd); // what makeGit throws for a folder that does not exist
          throw Object.assign(new Error(`git ${a}`), { code: w.throwIn.code });
        }
        const row = REMOTES[gu[2]];
        if (!row) return { status: 2, stdout: '' };
        const [fetchUrl, pushUrls] = row(cwd.replace(/\\/g, '/').endsWith('/sub'));
        return { status: 0, stdout: `${gu[1] ? pushUrls : fetchUrl}\n` };
      }
      if (/^rev-parse (.+)\^\{commit\}$/.test(a)) return { status: 0, stdout: `${HEAD}\n` };
      if (/^rev-parse (.+)\^\{tree\}$/.test(a)) return { status: 0, stdout: `${TREE}\n` };
      if (a === 'write-tree') return { status: 0, stdout: `${'i'.repeat(40)}\n` };
      if (a === 'rev-parse --path-format=absolute --show-toplevel') return { status: 0, stdout: '/repo\n' };
      return { status: 1, stdout: '' };
    },
    tapScope: {
      registry: () => ({ state: 'ok', file: '/reg.json', entries: [{ key: 'continuous-claude', root: '/repo', status: 'active', tapGate: null, github: null }] }),
      realpath: (p: string) => p,
      readFile: () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }); },
    },
  } as unknown as Deps;
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo', session_id: 'c1' });
const pwsh = (command: string) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: '/repo', session_id: 'c1' });
function shipTap(): void {
  const key = decisionKey({ branch: 'feat/x' });
  expect(offerWrite({ step: 'ship', key, head: HEAD, tree: TREE, spec: { header: 'T', question: 'Q?', options: [{ label: 'Commit and push (Recommended)' }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step: 'ship', key, head: HEAD, label: 'Commit and push (Recommended)' })).toEqual({ ok: true });
}
function landTap(n: number): void {
  const key = `${REPO}#${n}`;
  expect(offerWrite({ step: 'land', key, head: HEAD, spec: { header: 'T', question: 'Q?', options: [{ label: 'Land now (Recommended)' }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step: 'land', key, head: HEAD, label: 'Land now (Recommended)' })).toEqual({ ok: true });
}
/** The pattern of a deny, `warn` for a soft deny that comes back as a warning, else allow. The text is parsed first, as the hook does. */
async function patIn(input: object, w: World = {}): Promise<string> {
  const d = decide(input, await withParsed(JSON.stringify(input), deps(w)));
  if (d.action === 'deny') return d.pattern;
  return 'warn' in d && typeof d.warn === 'string' ? 'warn' : 'allow';
}

const PUSH = 'git push fork feat/x';
const MERGE = `gh pr merge 5 --squash --match-head-commit ${HEAD}`;

describe('F1: a text that does not parse and holds a guarded call is denied', () => {
  it('F1-1 (bash): a tapped push or merge in a text with a parse error is parse-error (main allows each)', async () => {
    shipTap();
    landTap(5);
    for (const c of [`{ ${PUSH}`, `${PUSH} )`, `&& ${MERGE}`, `${MERGE} ;;`]) {
      expect(await patIn(bash(c)), c).toBe('parse-error');
    }
  });
  it('F1-1b (PowerShell): a tapped push in a text with a stray brace is parse-error (main allows it)', async () => {
    shipTap();
    expect(await patIn(pwsh(`${PUSH} }`))).toBe('parse-error');
  });
  it('F1-2 (control): a parse error with no guarded call is not parse-error', async () => {
    for (const c of ['git status )', 'echo "unclosed', 'ls ;;']) expect(await patIn(bash(c)), c).not.toBe('parse-error');
  });
  it('F1-3 (control): a tapped push and merge that parse stay allowed', async () => {
    shipTap();
    landTap(5);
    expect(await patIn(bash(PUSH))).toBe('allow');
    expect(await patIn(bash(MERGE))).toBe('allow');
    expect(await patIn(pwsh(PUSH))).toBe('allow');
  });
  it('F1-4 (bash -c): the inner text does not parse and holds a push or a merge: parse-error (main denies it with another pattern)', async () => {
    shipTap();
    landTap(5);
    for (const c of [`bash -c '{ ${PUSH}'`, `bash -c '${PUSH} )'`, `bash -c '&& ${MERGE}'`, `sh -c '${PUSH} )'`]) {
      expect(await patIn(bash(c)), c).toBe('parse-error');
    }
  });
  it('F1-5 (pwsh -Command): the inner text does not parse and holds a push or a merge: parse-error', async () => {
    shipTap();
    landTap(5);
    for (const c of [`pwsh -Command "${PUSH} }"`, `pwsh -c "${MERGE} }"`, `powershell -Command "${PUSH} }"`]) {
      expect(await patIn(pwsh(c)), c).toBe('parse-error');
    }
  });
  it('F1-6 (control): an inner text that parses stays with the parser (a tapped push in bash -c is not parse-error)', async () => {
    shipTap();
    expect(await patIn(bash(`bash -c '${PUSH}'`))).not.toBe('parse-error');
    expect(await patIn(bash(`bash -c 'git status )'`))).not.toBe('parse-error');
  });
});

describe('B1: inline code of a script runner that names a guarded call is denied on the raw text', () => {
  const CODE = `require('child_process').execSync('${PUSH}')`;
  async function runnerDenies(command: string, tool = 'Bash'): Promise<string[]> {
    const d = await withParsed(JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: '/repo' }), deps());
    return scriptRunnerDenies(d.parsed).map((x) => x.pattern); // a text with no trigger word is not parsed: no deny
  }
  it('B1-1: an option with an equals sign or a joined short option still denies (main reads only a lone -e, -c, -p, --eval, --print)', async () => {
    for (const c of [`node --eval="${CODE}"`, `node --print="${CODE}"`, `node -pe "${CODE}"`, `node --input-type=module --eval="${CODE}"`]) {
      expect(await runnerDenies(c), c).toEqual(['script-runner']);
    }
  });
  it('B1-2: the added runners tsx, ts-node and php deny with any option spelling', async () => {
    for (const c of [`tsx -e "${CODE}"`, `ts-node --eval="${CODE}"`, `ts-node -e "${CODE}"`, `php -r "system('${PUSH}');"`, `php -r 'system("${PUSH}");'`]) {
      expect(await runnerDenies(c), c).toEqual(['script-runner']);
    }
  });
  it('B1-3: deno eval and a text with the code after other options deny', async () => {
    for (const c of [`deno eval "${CODE}"`, `python3 -u -c "import os; os.system('${PUSH}')"`, `perl -wle "system('${PUSH}')"`]) {
      expect(await runnerDenies(c), c).toEqual(['script-runner']);
    }
  });
  it('B1-4 (control): a runner with a script file and no guarded text, a lone guarded call, and bash -c have no script-runner deny', async () => {
    for (const c of ['node scripts/x.mjs --flag value', 'python tools/y.py', `${PUSH}`, `bash -c '${PUSH}'`, `node -e "console.log(1)"`]) {
      expect(await runnerDenies(c), c).toEqual([]);
    }
  });
  it('B1-5: the runner list is one exported constant that holds the eight Ask B runners and tsx, ts-node, php', () => {
    const list = (gate as Record<string, unknown>).SCRIPT_RUNNERS;
    expect(list, 'SCRIPT_RUNNERS must be exported').toBeDefined();
    const names = new Set(list as Iterable<string>);
    for (const n of ['node', 'nodejs', 'python', 'python3', 'py', 'deno', 'bun', 'ruby', 'perl', 'tsx', 'ts-node', 'php']) expect(names.has(n), n).toBe(true);
  });
});

describe('B2: when the parse is late, the raw text of a script runner call still gets the deny', () => {
  const hang = (w: World = {}): Deps => ({ ...deps(w), parseBudgetMs: 50, parseOpts: { bashProvider: () => new Promise(() => {}) } } as unknown as Deps);
  it('B2-1: node -e with a guarded call and a hung parse is script-runner (main allows it)', async () => {
    shipTap();
    const input = bash(`node -e "require('child_process').execSync('${PUSH}')"`);
    const w = await withParsed(JSON.stringify(input), hang());
    expect(w.parsed, 'the parse must be late').toBeUndefined();
    const d = decide(input, w);
    expect(d.action === 'deny' ? d.pattern : 'allow').toBe('script-runner');
  });
  it('B2-2 (control): a hung parse and a plain tapped push is still allowed (the hand reader decides)', async () => {
    shipTap();
    const input = bash(PUSH);
    const w = await withParsed(JSON.stringify(input), hang());
    expect(w.parsed).toBeUndefined();
    expect(decide(input, w).action).toBe('allow');
  });
  it('B2-3 (control): a hung parse and a runner call with no guarded text is allowed', async () => {
    const input = bash('node -e "console.log(1)"');
    const w = await withParsed(JSON.stringify(input), hang());
    expect(w.parsed).toBeUndefined();
    expect(decide(input, w).action).toBe('allow');
  });
});

describe('A1-U: a remote is local when its fetch URL or any push URL is local', () => {
  it('A1-U1: a network fetch URL with a local push URL is push-state-unknown (main allows it with a tap; live finding 79-a1-2-verdict.txt)', async () => {
    shipTap();
    expect(await patIn(bash(`git push cacheb feat/x && ${PUSH}`))).toBe('push-state-unknown');
    expect(lookups).toContain('remote get-url --push --all cacheb');
  });
  it('A1-U2: one local URL among several push URLs is push-state-unknown', async () => {
    shipTap();
    expect(await patIn(bash(`git push multi feat/x && ${PUSH}`))).toBe('push-state-unknown');
  });
  it('A1-U3 (control, main denies it): a local fetch URL with a network push URL stays push-state-unknown', async () => {
    shipTap();
    expect(await patIn(bash(`git push cachel feat/x && ${PUSH}`))).toBe('push-state-unknown');
  });
  it('A1-U4 (control): a remote with only network URLs stays allowed', async () => {
    shipTap();
    expect(await patIn(bash(`git push plain feat/x && ${PUSH}`))).toBe('allow');
  });
});

describe('A3-U: a remote name is local when it is local in the payload folder or in the folder of the earlier push', () => {
  it('A3-U1: a name that is local only in the folder of a -C push is push-state-unknown (main allows it with a tap)', async () => {
    shipTap();
    expect(await patIn(bash(`git -C sub push cachesub feat/x && ${PUSH}`))).toBe('push-state-unknown');
  });
  it('A3-U2: the same with a cd before the earlier push', async () => {
    shipTap();
    expect(await patIn(bash(`cd sub && git push cachesub feat/x && cd .. && ${PUSH}`))).toBe('push-state-unknown');
  });
  it('A3-U3 (control, main denies it): a name that is local only in the payload folder stays push-state-unknown', async () => {
    shipTap();
    expect(await patIn(bash(`git -C sub push cachecwd feat/x && ${PUSH}`))).toBe('push-state-unknown');
    expect(await patIn(bash(`git push cachecwd feat/x && ${PUSH}`))).toBe('push-state-unknown');
  });
  it('A3-U5: a read that times out in the folder of the earlier push is unknown, so the remote counts as local (push-state-unknown); main never reads that folder', async () => {
    shipTap();
    const w: World = { throwIn: { dir: '/sub', code: 'ETIMEDOUT' } };
    expect(await patIn(bash(`git -C sub push plain feat/x && ${PUSH}`), w)).toBe('push-state-unknown');
    expect(await patIn(bash(`cd sub && git push plain feat/x && cd .. && ${PUSH}`), w)).toBe('push-state-unknown');
    expect(await patIn(bash(`git -C sub push plain feat/x && ${PUSH}`), { throwIn: { dir: '/sub', code: 'ENOBUFS' } })).toBe('push-state-unknown');
  });
  it('A3-U6 (control): a folder that does not exist (ENOENT) has no remote, so the remote is not local there and the push stays allowed', async () => {
    shipTap();
    expect(await patIn(bash(`git -C sub push plain feat/x && ${PUSH}`), { throwIn: { dir: '/sub', code: 'ENOENT' } })).toBe('allow');
  });
  it('A3-U6b (control): makeGit throws MissingCwdError for a folder that does not exist: the same, not local there', async () => {
    shipTap();
    expect(await patIn(bash(`git -C sub push plain feat/x && ${PUSH}`), { throwIn: { dir: '/sub', code: 'MISSING-CWD' } })).toBe('allow');
  });
  it('A3-U7 (control, as main): a throw in the payload folder itself counts as local, whatever the code', async () => {
    shipTap();
    expect(await patIn(bash(`git push plain feat/x && ${PUSH}`), { throwIn: { dir: '/repo', code: 'ENOENT' } })).toBe('push-state-unknown');
  });
  it('A3-U4 (control): a name that is network in both folders stays allowed', async () => {
    shipTap();
    expect(await patIn(bash(`git -C sub push plain feat/x && ${PUSH}`))).toBe('allow');
    expect(await patIn(bash(`git push cachesub feat/x && ${PUSH}`))).toBe('allow');
  });
});

describe('A2: the remote lookups stop when the hook time is nearly gone', () => {
  const clockDenies = ['holdout-scan-unavailable', 'push-state-unknown'];
  it('A2-1: with 900 ms left no lookup runs and the push is denied on the clock (main runs the lookups)', async () => {
    shipTap();
    // The shape judge of each push also reads `git remote get-url <name>` once (what URL a remote points at). It is not a PB-5 lookup: the clock rows compare
    // the counts of one text under a full budget and under 900 ms, so only the PB-5 reads (names times folders times two) make the difference.
    const text = `git push plain feat/x && ${PUSH}`;
    await patIn(bash(text), { scanLeft: () => 7000 });
    const full = lookups.length;
    lookups = [];
    const p = await patIn(bash(text), { scanLeft: () => 900 });
    expect(lookups.length, 'fewer reads under 900 ms than under a full budget').toBeLessThan(full);
    expect(lookups.filter((l) => l.includes('--push --all')), 'no push-URL read may run').toEqual([]);
    expect(clockDenies).toContain(p);
  });
  it('A2-2: each lookup uses up time; the lookups end when the time left drops under the reserve, and the push is denied', async () => {
    shipTap();
    let left = 4000;
    const w: World = { scanLeft: () => { left -= 1200; return left; } };
    const p = await patIn(bash(`git push plain feat/x && git push cachel2 feat/x && git push plain2 feat/x && ${PUSH}`), w);
    expect(lookups.filter((l) => l.includes('--push --all')).length, 'fewer push-URL reads than names').toBeLessThan(3);
    expect(clockDenies).toContain(p);
  });
  it('A2-3 (control): with the full budget the same text runs its lookups and is allowed', async () => {
    shipTap();
    expect(await patIn(bash(`git push plain feat/x && ${PUSH}`), { scanLeft: () => 7000 })).toBe('allow');
    expect(lookups.length).toBeGreaterThan(0);
  });
});
