/**
 * Card coord-guard-deny-floor, true floor round (Dave 11-27 "True floor, one round"; seat ruling 10:01 and 10:03). The head's verdict is the stricter of its own and main's own.
 * Main's gate runs as a proved copy (src/main-floor, see main-floor-copy.test.ts) on the raw payload with main's parser; nothing of this head's parse reaches it.
 *
 * The fixture (fixtures/deny-floor-main-denies.json) holds every text of the C2 review passes that main's BUILT hook (6c3e71a5) denies in at least one world, from the fixed probe
 * (.claudedocs/e2e-coord-guard-deny-floor/20-probe-json.cjs): the tap is keyed on the REAL branch and head, and a row's sha and branch are the tokens @HEAD@ and @BR@, put back here.
 * Review pass 1 of the first floor head found that the old probe and this test keyed the tap on another branch and used fake heads, so a create or merge row in the tap world never matched
 * a tap. Here the taps are the real ones: open-pr for the branch at the head, land 5 and 6, ship.
 *   F1 no tap     every text that main denies with no tap is denied here
 *   F2 with taps  every text that main still denies with the taps set is denied here
 *   P1 the four forms of pass 1 and the 28 aegis rows (wrapper before gh, a create title with <<, a later tapped land number, a doc append with a malformed land number)
 *   P2 purity: the floor consumes no tap and writes no file
 *   P3 a floor that throws or answers late denies a gated call that the head allows, and allows an ungated one
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionRecord, offerWrite, type Step } from '../shared/decisions-store.js';
import { decide, FLOOR_IMPL, handle, realDeps, withParsed, type Deps, type FloorImpl } from '../decision-gate.js';
import { MissingCwdError } from '../main-floor/decision-gate.js';

vi.setConfig({ testTimeout: 120000 });
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const BRANCH = 'coord/deny-floor';
const HEAD = '3a1f531338f81d99f849818f0ee4d2369fa93790';
type Row = { tool: 'Bash' | 'PowerShell'; text: string; worlds: string[]; name: string; from: string };
const ROWS: Row[] = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'deny-floor-main-denies.json'), 'utf8')) as Row[];
const real = (t: string): string => t.replace(/@HEAD@/g, HEAD).replace(/@BR@/g, BRANCH);
let dir = '';
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deny-floor-'));
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = join(dir, 'decisions.json');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

function deps(extra: Partial<Deps> = {}): Deps {
  const config = JSON.stringify({ decisions: { enforce: true } });
  return {
    env: { ...process.env, CCV3_DECISIONS_FILE: join(dir, 'decisions.json') },
    home: '/home/nobody',
    readFile: (p: string) => (p.replace(/\\/g, '/').endsWith('/review-router.config.json') ? config : null),
    git: (_cwd: string, args: string[]) => {
      const a = args.join(' ');
      if (a === 'remote -v') return { status: 0, stdout: `fork\thttps://github.com/${REPO}.git (push)\n` };
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
      if (a === 'branch --show-current') return { status: 0, stdout: `${BRANCH}\n` };
      if (a.startsWith('rev-parse ')) return { status: 0, stdout: `${HEAD}\n` };
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
function tap(step: Step, key: string, label: string): void {
  expect(offerWrite({ step, key, head: HEAD, spec: { header: 'T', question: 'Q?', options: [{ label }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step, key, head: HEAD, label })).toEqual({ ok: true });
}
/** The taps of the probe (20-probe-json.cjs): the REAL branch at the REAL head. */
function setTaps(): void {
  tap('open-pr', `${REPO}@${BRANCH}`, 'Open draft PR (Recommended)');
  tap('land', `${REPO}#5`, 'Land now (Recommended)');
  tap('land', `${REPO}#6`, 'Land now (Recommended)');
  tap('ship', `${REPO}@${BRANCH}`, 'Commit and push (Recommended)');
}
async function verdict(tool: string, text: string, extra: Partial<Deps> = {}): Promise<string> {
  const inp = { tool_name: tool, tool_input: { command: text }, cwd: '/repo', session_id: 'deny-floor' };
  const d = decide(inp, await withParsed(JSON.stringify(inp), deps(extra)));
  return d.action === 'deny' ? `deny:${d.pattern}` : 'allow';
}

describe('deny floor F1: no tap, every text that main denies is denied', () => {
  const rows = ROWS.filter((r) => r.worlds.includes('NO TAP'));
  it('the fixture is not empty', () => { expect(rows.length).toBeGreaterThan(300); });
  it.each(rows.map((r) => [r.tool, r.name, r] as const))('%s %s', async (_t, _n, row) => {
    expect(await verdict(row.tool, real(row.text)), row.text).toMatch(/^deny:/);
  });
});

describe('deny floor F2: with the real taps set, every text that main still denies is denied', () => {
  const rows = ROWS.filter((r) => r.worlds.includes('TAP'));
  it('the fixture has tap rows, among them create and merge rows that a matching tap would let through', () => {
    expect(rows.length).toBeGreaterThan(200);
    expect(rows.some((r) => /gh pr merge/.test(r.text) && /@HEAD@/.test(r.text))).toBe(true);
    expect(rows.some((r) => /gh pr create/.test(r.text) && /@BR@|coord\/deny-floor/.test(r.text))).toBe(true);
  });
  it('control: the plain tapped merge of PR 6 at the head is allowed, so a tap here does match', async () => {
    setTaps();
    expect(await verdict('Bash', `gh pr merge 6 --squash --match-head-commit ${HEAD}`)).toBe('allow');
  });
  it.each(rows.map((r) => [r.tool, r.name, r] as const))('%s %s', async (_t, _n, row) => {
    setTaps();
    expect(await verdict(row.tool, real(row.text)), row.text).toMatch(/^deny:/);
  });
});

describe('P1 the four forms of review pass 1 stay denied, in the world where main denies them', () => {
  const FORMS: Array<[string, RegExp]> = [
    ['wrapper before gh (env, timeout, nice, nohup, command, exec, builtin, stdbuf)', /^(?:env|timeout|nice|nohup|command|exec|builtin|stdbuf)\b.*gh (?:pr (?:merge|create)|api)/],
    ['a create title that holds << and no heredoc', /gh pr create .*--title ["'][^"']*<</],
    ['a later tapped land number after a malformed first one', /land-pr\.ps1 -Pr 9`5 /],
    ['a doc append naming the land script with a malformed number', /^Add-Content .*land-pr\.ps1 -P"r" 5`6/],
  ];
  for (const [name, re] of FORMS) {
    const rows = ROWS.filter((r) => re.test(real(r.text)));
    it(`${name}: the fixture holds rows and each is denied in each world main denies it`, async () => {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        for (const world of row.worlds) {
          if (world === 'TAP') setTaps();
          expect(await verdict(row.tool, real(row.text)), `${world}: ${row.text}`).toMatch(/^deny:/);
          if (world === 'TAP') rmSync(join(dir, 'decisions.json'), { force: true });
        }
      }
    });
  }
});

describe('P2 purity: the floor consumes no tap and writes nothing', () => {
  const sum = (): string => (existsSync(join(dir, 'decisions.json')) ? createHash('sha256').update(readFileSync(join(dir, 'decisions.json'))).digest('hex') : 'none');
  it('a tapped merge is allowed twice in a row and the decision file is the same bytes after', async () => {
    setTaps();
    const before = sum();
    const text = `gh pr merge 6 --squash --match-head-commit ${HEAD}`;
    expect(await verdict('Bash', text)).toBe('allow');
    expect(sum()).toBe(before);
    expect(await verdict('Bash', text)).toBe('allow');
    expect(sum()).toBe(before);
  });
  it('the floor alone gives the same verdict as main on the tapped merge, and the file is unchanged', async () => {
    setTaps();
    const before = sum();
    const inp = { tool_name: 'Bash', tool_input: { command: `gh pr merge 6 --squash --match-head-commit ${HEAD}` }, cwd: '/repo', session_id: 'deny-floor' };
    const fd = await FLOOR_IMPL.withParsed(JSON.stringify(inp), deps() as never);
    expect(FLOOR_IMPL.decide(inp as never, fd).action).toBe('allow');
    expect(sum()).toBe(before);
  });
});

describe('P3 a floor that throws or answers late denies a gated call that the head allows', () => {
  const TAPPED = `gh pr merge 6 --squash --match-head-commit ${HEAD}`;
  const THROWS: FloorImpl = { ...FLOOR_IMPL, decide: () => { throw new Error('boom'); } };
  const PARSE_THROWS: FloorImpl = { ...FLOOR_IMPL, withParsed: () => Promise.reject(new Error('parse boom')) };
  const LATE: FloorImpl = { ...FLOOR_IMPL, withParsed: async (_raw, d) => ({ ...d, parseLate: 'x' }) };
  // Fix round (seat GO 12:36): a floor failure is judged by MAIN's own reading of the call (main's handle in the copy), never by the head's shapes. A stub that throws leaves main's own handle
  // to answer; main's handle runs the same decide, which for the stub's real deps does not throw, so a tapped merge is allowed by main and by the head. Rows below use real failures.
  it.each([['decide throws', THROWS], ['the parse throws', PARSE_THROWS], ['the parse is late', LATE]] as const)('%s: an ungated call is allowed', async (_n, impl) => {
    expect(await verdict('Bash', 'ls -la', { floorImpl: impl })).toBe('allow');
  });
  it('control: the same tapped merge with the real floor is allowed', async () => {
    setTaps();
    expect(await verdict('Bash', TAPPED)).toBe('allow');
  });
});

/**
 * Fix round of review pass 2 (aegis 34, critic 33; seat GO 12:36, Dave "One fix round, error paths"). Cause: when the floor failed, withFloor asked the HEAD's shapes whether the call was gated.
 * Now a floor failure is decided by main's own reading (main's handle in the copy, with its own unjudgeable path); if that throws too, the call is denied.
 *   E1 aegis R1 to R4 and control C1: the floor's git throws (a missing folder, a folder that is not a repo): every text main denies is denied here
 *   E2 a stub floor deny over a head allow (critic 4)
 *   E3 a throw in the head's judgment still runs the floor (critic 2)
 *   E4 a late floor parse keeps main's own late denies (critic 1)
 *   E5 the real entry: handle + withParsed + realDeps, a missing folder (critic 5)
 *   E6 one deadline for both git runners (aegis 2)
 *   E7 the floor's own walker equals this head's walker (critic 9)
 */
describe('E error paths of the floor (fix round of review pass 2)', () => {
  const API_CREATE = 'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X=POST -f head=feat/x -f base=main -f title=t';
  const gone = (): never => { throw new MissingCwdError('/no/such/folder'); };
  const remoteFails = (): never => { throw new Error('git remote -v failed'); };
  const floorWith = (git: Deps['git']): Partial<Deps> => ({ floorBase: deps({ git }) as never });
  const raw = (tool: string, text: string): string => JSON.stringify({ tool_name: tool, tool_input: { command: text }, cwd: '/repo', session_id: 'deny-floor' });

  describe('E1 the floor git throws', () => {
    it.each([
      ['R1 Bash -X=POST create, folder missing', 'Bash', API_CREATE, gone],
      ['R2 PowerShell -X=POST create, folder missing', 'PowerShell', API_CREATE, gone],
      ['R3 Bash create with -H "-X: 1", folder missing', 'Bash', `${API_CREATE} -H "-X: 1"`, gone],
      ['R4 echo of a merge text, git remote -v failed', 'Bash', 'echo gh pr merge 12 --squash', remoteFails],
      ['R4b grep of a merge text, git remote -v failed', 'Bash', 'grep -n "gh pr merge" scripts/x.md', remoteFails],
      ['R5 create with --input and {owner}/{repo}, git remote -v failed', 'Bash', "gh api --input b.json 'repos/{owner}/{repo}/pulls'", remoteFails],
    ] as const)('%s: denied', async (_n, tool, text, git) => {
      expect(await verdict(tool, text, floorWith(git as Deps['git'])), text).toMatch(/^deny:/);
    });
    it('C1 control: the same create with a healthy floor is denied too (no tap)', async () => {
      expect(await verdict('Bash', API_CREATE)).toMatch(/^deny:/);
    });
    it('a floor whose git throws on an ungated call allows it, as main does', async () => {
      expect(await verdict('Bash', 'ls -la', floorWith(gone))).toBe('allow');
    });
    it('if main\'s own reading of the failed call throws too, a gated call is denied (main-floor-error)', async () => {
      const dead: FloorImpl = { ...FLOOR_IMPL, decide: () => { throw new Error('boom'); }, handle: () => { throw new Error('handle boom'); } };
      expect(await verdict('Bash', API_CREATE, { floorImpl: dead })).toBe('deny:main-floor-error');
    });
  });

  describe('E2 a floor deny over a head allow', () => {
    it('a stub floor that denies ls -la makes the verdict a deny', async () => {
      const stub: FloorImpl = { ...FLOOR_IMPL, decide: () => ({ action: 'deny', pattern: 'stub-floor', scope: 'other', reason: 'stub' }) };
      expect(await verdict('Bash', 'ls -la', { floorImpl: stub })).toBe('deny:stub-floor');
    });
  });

  describe('E3 a throw in the head judgment still runs the floor', () => {
    it('the head git throws, the floor answers: the floor\'s deny is the one shown (a stub floor with its own reason)', async () => {
      const inp = raw('Bash', API_CREATE);
      const stub: FloorImpl = { ...FLOOR_IMPL, decide: () => ({ action: 'deny', pattern: 'stub-floor', scope: 'other', reason: 'BLOCKED (decision-gate): stub-floor-reason' }) };
      const d = deps({ git: remoteFails as Deps['git'], floorBase: deps() as never, floorImpl: stub });
      const out = handle(inp, await withParsed(inp, d));
      expect(out).toMatch(/"permissionDecision":"deny"/);
      expect(out).toMatch(/stub-floor-reason/);
    });
    it('the head git throws on an ungated call and the floor allows: the call is allowed', async () => {
      const inp = raw('Bash', 'ls -la');
      const out = handle(inp, await withParsed(inp, deps({ git: remoteFails as Deps['git'], floorBase: deps() as never })));
      expect(out).toBe('{}');
    });
  });

  describe('E4 a late floor parse keeps main\'s own late denies', () => {
    it('a text main denies by its late-parse reading is denied when the floor parse is late', async () => {
      const text = 'echo "node" "git push origin main"';
      const late: FloorImpl = { ...FLOOR_IMPL, withParsed: async (_r, d) => ({ ...d, parseLate: text }) };
      const viaMain = FLOOR_IMPL.decide(JSON.parse(raw('Bash', text)) as never, ({ ...deps(), parseLate: text }) as never);
      expect(viaMain.action, 'premise: main denies this text when its parse is late').toBe('deny');
      expect(await verdict('Bash', text, { floorImpl: late })).toMatch(/^deny:/);
    });
  });

  describe('E5 the real entry: handle + withParsed + realDeps', () => {
    it('a create in a folder that does not exist is denied (main denies it; the head sees no shape)', async () => {
      const missing = join(dir, 'no-such-folder');
      const inp = JSON.stringify({ tool_name: 'Bash', tool_input: { command: API_CREATE }, cwd: missing, session_id: 'deny-floor' });
      const out = handle(inp, await withParsed(inp, realDeps()));
      expect(out).toMatch(/"permissionDecision":"deny"/);
    });
    it('realDeps carries the floor base', () => { expect(realDeps().floorBase).toBeDefined(); });
  });

  describe('E6 one deadline for both git runners', () => {
    it('after the hook budget, the head git and the floor git both throw a deadline error', () => {
      const d = realDeps({ start: 0, now: () => 8000, exists: () => true });
      expect(() => d.git(dir, ['status'])).toThrow(/time limit|deadline/i);
      expect(() => (d.floorBase as unknown as { git: Deps['git'] }).git(dir, ['status'])).toThrow(/time limit|deadline/i);
    });
  });

  describe('E8 a very large text is answered by the floor first (aegis 2: the head cannot judge 5000 pipes inside the hook time)', () => {
    const stub = (calls: string[]): FloorImpl => ({ ...FLOOR_IMPL, decide: () => { calls.push('floor'); return { action: 'deny', pattern: 'stub-floor', scope: 'other', reason: 'stub' }; } });
    it('a text over 16000 chars: the floor deny is the verdict and the head judgment never runs (its git is never read)', async () => {
      const calls: string[] = [];
      const big = `gh pr merge 6 --admin; ${'echo a | '.repeat(2500)}echo a`;
      const git: Deps['git'] = () => { calls.push('head-git'); return { status: 1, stdout: '' }; };
      expect(await verdict('Bash', big, { floorImpl: stub(calls), git })).toBe('deny:stub-floor');
      expect(calls).toEqual(['floor']);
    });
    it('a small text: the head judges first and the floor is asked once, after the head allows', async () => {
      const calls: string[] = [];
      expect(await verdict('Bash', 'ls -la', { floorImpl: stub(calls) })).toBe('deny:stub-floor');
      expect(calls).toEqual(['floor']);
    });
  });

  describe('E7 the floor walker is the head walker', () => {
    const lf = (p: string): string => createHash('sha256').update(readFileSync(p, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    it('src/shell-ast-walk.ps1 equals src/main-floor/shell-ast-walk.ps1 (LF text), so the built floor reads main\'s walker', () => {
      const src = join(dirname(fileURLToPath(import.meta.url)), '..');
      expect(lf(join(src, 'shell-ast-walk.ps1'))).toBe(lf(join(src, 'main-floor', 'shell-ast-walk.ps1')));
    });
  });
});
