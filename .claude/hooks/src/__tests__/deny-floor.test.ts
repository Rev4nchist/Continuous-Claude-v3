/**
 * Card coord-guard-deny-floor (Dave's tap 11-27 08:47, seat plan GO). The parser line must never allow a call that main denies.
 * A call is denied when main's raw reader OR the parser denies it, so deny to allow against main is impossible by construction.
 *
 * The fixture (fixtures/deny-floor-main-denies.json) holds every text that main's BUILT hook (58a81f4a) denied in the probes of the C2 review passes:
 * the critic and aegis rows of pass 1 and 2, the seat rows of both passes, the critic candidates and the aegis rows of pass 3 (the five forms of
 * .claudedocs/e2e-coord-guard-shell-parser/180). Each row says in which worlds main denied it: no tap, and a tap for the head of the text.
 *   F1 no tap     every fixture text that main denied with no tap is denied here
 *   F2 with taps  every fixture text that main denied with the taps set (open-pr for the heads of the rows, land 5 and 6, ship) is denied here
 * A row that fails is a HOLE: main denies it and the branch allows it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionRecord, offerWrite, type Step } from '../shared/decisions-store.js';
import { decide, withParsed, type Deps } from '../decision-gate.js';

vi.setConfig({ testTimeout: 120000 });
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
type Row = { tool: 'Bash' | 'PowerShell'; text: string; worlds: string[]; name: string; from: string };
const ROWS: Row[] = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'deny-floor-main-denies.json'), 'utf8')) as Row[];
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
      if (a === 'branch --show-current') return { status: 0, stdout: 'coord/shell-parser-c2c\n' };
      if (a.startsWith('rev-parse ')) return { status: 0, stdout: `${HEAD}\n` };
      return { status: 1, stdout: '' };
    },
    tapScope: {
      registry: () => ({ state: 'ok', file: '/reg.json', entries: [{ key: 'continuous-claude', root: '/repo', status: 'active', tapGate: null, github: null }] }),
      realpath: (p: string) => p,
      readFile: () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }); },
    },
  } as unknown as Deps;
}
function tap(step: Step, key: string, label: string): void {
  expect(offerWrite({ step, key, head: HEAD, spec: { header: 'T', question: 'Q?', options: [{ label }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step, key, head: HEAD, label })).toEqual({ ok: true });
}
/** The taps of the probe harness (204), no more: open-pr for coord/shell-parser-c2c only (a row with another head stays untapped), land 5 and 6, ship. */
function setTaps(): void {
  tap('open-pr', `${REPO}@coord/shell-parser-c2c`, 'Open draft PR (Recommended)');
  tap('land', `${REPO}#5`, 'Land now (Recommended)');
  tap('land', `${REPO}#6`, 'Land now (Recommended)');
  tap('ship', `${REPO}@coord/shell-parser-c2c`, 'Commit and push (Recommended)');
}
async function verdict(row: Row): Promise<string> {
  const inp = { tool_name: row.tool, tool_input: { command: row.text }, cwd: '/repo', session_id: 'deny-floor' };
  const d = decide(inp, { ...(await withParsed(JSON.stringify(inp), deps())) } as Deps);
  return d.action === 'deny' ? `deny:${d.pattern}` : 'allow';
}

describe('deny floor F1: no tap, every text that main denies is denied', () => {
  const rows = ROWS.filter((r) => r.worlds.includes('NO TAP'));
  it('the fixture is not empty', () => { expect(rows.length).toBeGreaterThan(100); });
  it.each(rows.map((r) => [r.tool, r.name, r] as const))('%s %s', async (_t, _n, row) => {
    expect(await verdict(row), row.text).toMatch(/^deny:/);
  });
});

describe('deny floor F2: with the taps set, every text that main still denies is denied', () => {
  const rows = ROWS.filter((r) => r.worlds.includes('TAP'));
  it('the fixture has tap rows', () => { expect(rows.length).toBeGreaterThan(50); });
  it.each(rows.map((r) => [r.tool, r.name, r] as const))('%s %s', async (_t, _n, row) => {
    setTaps();
    expect(await verdict(row), row.text).toMatch(/^deny:/);
  });
});
