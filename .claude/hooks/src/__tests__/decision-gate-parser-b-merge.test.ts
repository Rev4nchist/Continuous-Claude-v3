/**
 * decision-gate PR B port step 2 (card coord-guard-shell-parser, note 63): the merge PR and head are read from the parser's words.
 * Each row runs one command twice: the old path (no parse) and the new path (withParsed, as main does). Failure modes, one row each:
 *   M1 a clean merge with a tapped head                  same verdict both ways (control)
 *   M2 heads the reader cannot know                      deny both ways: two heads, a head in --body, a variable, an unknown flag, no head, an api field in another field
 *   M3 a redirect after the call                         old: deny (the allowlist refuses a redirect). new: the head is read, the tap covers it (named cost removal)
 *   M4 a merge inside $( ) in a harmless command         old: allow (the cutter blanks it). new: deny, no tap for PR 9 (hole closed)
 *   M5 a merge inside a bash -c payload                  old and new deny
 *   M6 text that only names a merge                      allow both ways (echo, commit message)
 *   M7 a parse with errors                               verdict of the old path (nothing changes until rule F1 is ported)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionRecord, offerWrite, type Step } from '../shared/decisions-store.js';
import { astMerges, decide, withParsed, type Deps } from '../decision-gate.js';

vi.setConfig({ testTimeout: 60000 });
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
let dir = '';
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-gate-pb-merge-'));
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
function tap(step: Step, key: string, head: string, label: string): void {
  expect(offerWrite({ step, key, head, spec: { header: 'T', question: 'Q?', options: [{ label }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step, key, head, label })).toEqual({ ok: true });
}
const landTap = (n: number) => tap('land', `${REPO}#${n}`, HEAD, 'Land now (Recommended)');
const input = (command: string, tool = 'Bash') => ({ tool_name: tool, tool_input: { command }, cwd: '/repo', session_id: 'pb-merge' });
const patternOf = (d: ReturnType<typeof decide>): string => (d.action === 'deny' ? d.pattern : 'allow');
/** The verdict of the old path and of the new path for one command. */
async function both(command: string, tool = 'Bash'): Promise<{ oldP: string; newP: string; parsed: boolean }> {
  const inp = input(command, tool);
  const oldP = patternOf(decide(inp, deps()));
  const withP = await withParsed(JSON.stringify(inp), deps());
  return { oldP, newP: patternOf(decide(inp, withP)), parsed: withP.parsed !== undefined };
}
const M = 'gh pr merge';

describe('port step 2: merge PR and head from the parser words', () => {
  it('M1: a merge with the tapped head gives the same verdict both ways', async () => {
    landTap(5);
    for (const c of [`${M} 5 --squash --match-head-commit ${HEAD}`, `${M} 5 --squash --match-head-commit=${HEAD}`, `gh api repos/${REPO}/pulls/5/merge -X PUT -f sha=${HEAD} -f merge_method=squash`]) {
      const r = await both(c);
      expect(r.parsed, c).toBe(true);
      expect(r.newP, c).toBe(r.oldP);
      expect(r.newP, c).toBe('allow');
    }
  });
  it('M2: a head the reader cannot know denies merge-no-head both ways', async () => {
    landTap(5);
    const rows = [
      `${M} 5 --squash --match-head-commit ${HEAD} --match-head-commit ${OTHER}`,
      `${M} 5 --squash --body "sha=${HEAD}"`,
      `${M} 5 --squash --match-head-commit $H`,
      `${M} 5 --squash --match-head-commit ${HEAD} --weird x`,
      `${M} 5 --squash`,
      `gh api repos/${REPO}/pulls/5/merge -X PUT -f commit_message="sha=${HEAD}" -f merge_method=squash`,
    ];
    for (const c of rows) {
      const r = await both(c);
      expect(r.oldP, `old ${c}`).toBe('merge-no-head');
      expect(r.newP, `new ${c}`).toBe('merge-no-head');
    }
  });
  it('M3: a redirect after the call no longer hides the head (named cost removal: the allowlist refused every redirect)', async () => {
    landTap(5);
    const r = await both(`${M} 5 --squash --match-head-commit ${HEAD} 2>&1`);
    expect(r.oldP).toBe('merge-no-head');
    expect(r.newP).toBe('allow');
  });
  it('M3b: a redirect does not make a wrong head right: another head still denies', async () => {
    landTap(5);
    const r = await both(`${M} 5 --squash --match-head-commit ${OTHER} 2>&1`);
    expect(r.newP).not.toBe('allow');
  });
  it('M4: a merge inside $( ) of a harmless command is denied both ways (no tap for PR 9); the parser lists it as a call', async () => {
    const c = `echo "$(${M} 9 --squash --match-head-commit ${HEAD})"`;
    const r = await both(c);
    expect(r.parsed).toBe(true);
    expect(r.oldP).not.toBe('allow');
    expect(r.newP).not.toBe('allow');
    const p = await withParsed(JSON.stringify(input(c)), deps());
    expect(astMerges(p.parsed).map((m) => m.pr)).toEqual(['9']);
  });
  it('M5: a merge inside a bash -c payload denies both ways', async () => {
    const r = await both(`bash -c '${M} 9 --squash --match-head-commit ${HEAD}'`);
    expect(r.oldP).not.toBe('allow');
    expect(r.newP).not.toBe('allow');
  });
  it('M6: text that only names a merge stays allowed both ways', async () => {
    for (const c of [`echo "${M} 9"`, `git commit -m "run ${M} 9 later"`]) {
      const r = await both(c);
      expect(r.newP, c).toBe(r.oldP);
      expect(r.newP, c).toBe('allow');
    }
  });
  it('M6b (known leftover): a grep that names a merge is still denied (no-pr) until the hand reader is deleted; the parser sees no gh call in it', async () => {
    const c = `grep -n "${M}" notes.md`;
    const r = await both(c);
    expect(r.newP).toBe(r.oldP);
    expect(r.newP).toBe('no-pr');
    const p = await withParsed(JSON.stringify(input(c)), deps());
    expect(astMerges(p.parsed)).toEqual([]);
  });
  it('M7: a text the parser cannot read is a deny on both paths; the old path names merge-no-head, the new path parse-error (C1, F1)', async () => {
    const c = `${M} 5 --squash --match-head-commit ${HEAD} --body "open`;
    const r = await both(c);
    expect(r.oldP).toBe('merge-no-head');
    expect(r.newP).toBe('parse-error');
  });
  it('M8: PowerShell: the same head read, the same verdicts', async () => {
    landTap(5);
    const ok = await both(`${M} 5 --squash --match-head-commit ${HEAD}`, 'PowerShell');
    expect(ok.parsed).toBe(true);
    expect(ok.newP).toBe(ok.oldP);
    expect(ok.newP).toBe('allow');
    const bad = await both(`${M} 5 --squash --match-head-commit ${HEAD} --match-head-commit ${OTHER}`, 'PowerShell');
    expect(bad.newP).toBe('merge-no-head');
  });
  it('M9: astMerges lists the call words: PR, head, and a head that is not literal', async () => {
    const p = await withParsed(JSON.stringify(input(`${M} 7 --match-head-commit ${HEAD}; ${M} 8 --match-head-commit $H`)), deps());
    const found = astMerges(p.parsed);
    expect(found.map((m) => [m.pr, m.sha, m.shaBad === true])).toEqual([['7', HEAD, false], ['8', null, true]]);
  });
});
