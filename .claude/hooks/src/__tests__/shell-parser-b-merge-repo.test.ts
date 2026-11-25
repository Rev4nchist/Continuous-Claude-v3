/**
 * PR B, CodeRabbit CLI run 2 finding C (seat word 11:37 CST 11-25, Dave: fix C only). The read-only differential 76 showed PR B weaker than main on it:
 * a merge inside `bash -c '...'` that names another repo with -R, and a recorded local land tap for that number. Main denied it (the head cannot be
 * read inside a quote). PR B reads the head from the parsed inner call, but the hand shape keeps its outer text, so the foreign repo flag was never judged.
 *   MR1 the quoted merge with -R foreign/repo and a local land tap DENIES with repo-foreign (the same as the unwrapped form)
 *   MR2 the same without -R keeps the local tap check (control: allowed with the tap, denied without it)
 *   MR3 the same with -R naming CCv3 is judged as a CCv3 merge (control)
 *   MR4 the unwrapped form with -R foreign/repo still denies repo-foreign (control, already green)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionRecord, offerWrite } from '../shared/decisions-store.js';
import { decide, withParsed, type Deps } from '../decision-gate.js';

vi.setConfig({ testTimeout: 60000 });
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
let dir = '';
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-gate-pb-mergerepo-'));
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
      return { status: 1, stdout: '' };
    },
    tapScope: {
      registry: () => ({ state: 'ok', file: '/reg.json', entries: [{ key: 'continuous-claude', root: '/repo', status: 'active', tapGate: null, github: null }] }),
      realpath: (p: string) => p,
      readFile: () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }); },
    },
  } as unknown as Deps;
}
function landTap(n: number): void {
  expect(offerWrite({ step: 'land', key: `${REPO}#${n}`, head: HEAD, spec: { header: 'T', question: 'Q?', options: [{ label: 'Land now (Recommended)' }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step: 'land', key: `${REPO}#${n}`, head: HEAD, label: 'Land now (Recommended)' })).toEqual({ ok: true });
}
const input = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo', session_id: 'pb-mergerepo' });
const patternOf = (d: ReturnType<typeof decide>): string => (d.action === 'deny' ? d.pattern : 'allow');
const verdict = async (command: string): Promise<string> => {
  const inp = input(command);
  return patternOf(decide(inp, await withParsed(JSON.stringify(inp), deps())));
};
const M = 'gh pr merge 12';

describe('finding C: a parsed merge that replaces a hand-read head keeps the repository of the parsed call', () => {
  it('MR1: a merge inside bash -c with -R foreign/repo and a local land tap for 12 is repo-foreign', async () => {
    landTap(12);
    expect(await verdict(`bash -c '${M} -R foreign/repo --match-head-commit ${HEAD}'`)).toBe('repo-foreign');
  });
  it('MR1b: the same with a double-quoted payload', async () => {
    landTap(12);
    expect(await verdict(`bash -c "${M} --repo foreign/repo --match-head-commit ${HEAD}"`)).toBe('repo-foreign');
  });
  it('MR2 (control): the same without -R keeps the local tap check: allowed with the tap', async () => {
    landTap(12);
    expect(await verdict(`bash -c '${M} --match-head-commit ${HEAD}'`)).toBe('allow');
  });
  it('MR2b (control): the same without -R and without a tap is denied', async () => {
    expect(await verdict(`bash -c '${M} --match-head-commit ${HEAD}'`)).not.toBe('allow');
  });
  it('MR3 (control): -R naming CCv3 is judged as a CCv3 merge: allowed with the tap', async () => {
    landTap(12);
    expect(await verdict(`bash -c '${M} -R ${REPO} --match-head-commit ${HEAD}'`)).toBe('allow');
  });
  it('MR4 (control): the unwrapped form with -R foreign/repo is repo-foreign', async () => {
    landTap(12);
    expect(await verdict(`${M} -R foreign/repo --match-head-commit ${HEAD}`)).toBe('repo-foreign');
  });
});
