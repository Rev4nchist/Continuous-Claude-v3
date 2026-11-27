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
import { decide, FLOOR_IMPL, withParsed, type Deps, type FloorImpl } from '../decision-gate.js';

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
  it.each([['decide throws', THROWS], ['the parse throws', PARSE_THROWS], ['the parse is late', LATE]] as const)('%s: the tapped merge is denied (main-floor-error)', async (_n, impl) => {
    setTaps();
    expect(await verdict('Bash', TAPPED, { floorImpl: impl })).toBe('deny:main-floor-error');
  });
  it.each([['decide throws', THROWS], ['the parse is late', LATE]] as const)('%s: an ungated call is allowed', async (_n, impl) => {
    expect(await verdict('Bash', 'ls -la', { floorImpl: impl })).toBe('allow');
  });
  it('control: the same tapped merge with the real floor is allowed', async () => {
    setTaps();
    expect(await verdict('Bash', TAPPED)).toBe('allow');
  });
});
