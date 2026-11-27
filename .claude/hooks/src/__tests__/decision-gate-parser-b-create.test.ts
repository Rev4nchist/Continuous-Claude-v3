/**
 * decision-gate PR B port step 3 (card coord-guard-shell-parser, note 63): the head and base of a create are read from the parser's words.
 * Each row runs one command twice: the old path (no parse) and the new path (withParsed, as main does). Failure modes, one row each:
 *   C1 a clean create, tapped head                     allow both ways (control, CLI and api)
 *   C2 a create the reader cannot read whole           deny both ways: two heads, an unknown flag, a head from a variable, a variable outside a value
 *   C3 an untapped create                              open-pr deny both ways
 *   C4 a title or body made by $( ) in double quotes    old: head-unresolved (the allowlist refuses $). new: allowed (named cost removal)
 *   C5 a redirect after the call                       old: head-unresolved. new: the head is read
 *   C6 text that only names a create                   allow both ways
 *   C7 two creates in one command                      each needs its own tap, both ways
 *   C8 a parse with errors                             verdict of the old path
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionKey, decisionRecord, offerWrite } from '../shared/decisions-store.js';
import { astCreates, decide, withParsed, type Deps } from '../decision-gate.js';
import { decideParsed } from './helpers/parse-first.js';

vi.setConfig({ testTimeout: 60000 });
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
let dir = '';
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-gate-pb-create-'));
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
      if (/^rev-parse (.+)\^\{commit\}$/.test(a)) return { status: 0, stdout: `${HEAD}\n` };
      return { status: 1, stdout: '' };
    },
    tapScope: {
      registry: () => ({ state: 'ok', file: '/reg.json', entries: [{ key: 'continuous-claude', root: '/repo', status: 'active', tapGate: null, github: null }] }),
      realpath: (p: string) => p,
      readFile: () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }); },
    },
  } as unknown as Deps;
}
function openTap(branch: string): void {
  const key = decisionKey({ branch });
  expect(offerWrite({ step: 'open-pr', key, head: HEAD, spec: { header: 'T', question: 'Q?', options: [{ label: 'Open draft PR (Recommended)' }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step: 'open-pr', key, head: HEAD, label: 'Open draft PR (Recommended)' })).toEqual({ ok: true });
}
const input = (command: string, tool = 'Bash') => ({ tool_name: tool, tool_input: { command }, cwd: '/repo', session_id: 'pb-create' });
const patternOf = (d: ReturnType<typeof decide>): string => (d.action === 'deny' ? d.pattern : 'allow');
async function both(command: string, tool = 'Bash'): Promise<{ oldP: string; newP: string; parsed: boolean }> {
  const inp = input(command, tool);
  const oldP = patternOf(await decideParsed(inp, deps()));
  const withP = await withParsed(JSON.stringify(inp), deps());
  return { oldP, newP: patternOf(await decideParsed(inp, withP)), parsed: withP.parsed !== undefined };
}
const C = 'gh pr create';

describe('port step 3: create head and base from the parser words', () => {
  it('C1: a tapped create gives the same verdict both ways, CLI and api', async () => {
    openTap('feat/x');
    for (const c of [`${C} --head feat/x --base main --title t --body b`, `${C} --draft --head=feat/x`, `gh api repos/${REPO}/pulls -X POST -f head=feat/x -f base=main -f title=t`]) {
      const r = await both(c);
      expect(r.parsed, c).toBe(true);
      expect(r.newP, c).toBe(r.oldP);
      expect(r.newP, c).toBe('allow');
    }
  });
  it('C2: a create the reader cannot read whole denies head-unresolved both ways', async () => {
    openTap('feat/x');
    const rows = [
      `${C} --head feat/x --head feat/y`,
      `${C} --head feat/x --weird v`,
      `${C} --head $B --title t`,
      `${C} --head "$(git branch --show-current)"`,
      `${C} --title t --head feat/x $EXTRA`,
      `gh api repos/${REPO}/pulls -X POST -f head=$B -f base=main`,
    ];
    for (const c of rows) {
      const r = await both(c);
      expect(r.oldP, `old ${c}`).toBe('head-unresolved');
      expect(r.newP, `new ${c}`).toBe('head-unresolved');
    }
  });
  it('C3: an untapped create denies open-pr both ways', async () => {
    const r = await both(`${C} --head feat/x --base main --title t`);
    expect(r.oldP).toBe('open-pr');
    expect(r.newP).toBe('open-pr');
  });
  it('C4: a title or body made by $( ) in double quotes no longer hides the head (named cost removal)', async () => {
    openTap('feat/x');
    for (const c of [`${C} --head feat/x --base main --title t --body "$(cat notes.md)"`, `${C} --head feat/x --body="$(cat notes.md)"`]) {
      const r = await both(c);
      // C2b (class B): the old side now reads with a parse too; main with a parse gives this answer, the hand reader is retired.
      expect(r.oldP, `old ${c}`).toBe('allow');
      expect(r.newP, `new ${c}`).toBe('allow');
    }
  });
  it('C4c (named cost of the C2d raw-text backstop, seat replan 11-27 07:31): a gh api create with a $( ) body is an unread head, even with the tap', async () => {
    openTap('feat/x');
    // The raw text names a pulls segment and the body word has no literal: the call fails closed at the create rank. gh pr create keeps its safe title and body values (C4).
    const r = await both(`gh api repos/${REPO}/pulls -X POST -f head=feat/x -f base=main -f body="$(cat notes.md)"`);
    expect(r.newP).toBe('head-unresolved');
  });
  it('C4b: a $( ) body does not hide an untapped head: the head still decides', async () => {
    const r = await both(`${C} --head feat/z --body "$(cat notes.md)"`);
    expect(r.newP).toBe('open-pr');
  });
  it('C5: a redirect after the call no longer hides the head (named cost removal)', async () => {
    openTap('feat/x');
    const r = await both(`${C} --head feat/x --base main 2>&1`);
    // C2b (class B): the old side now reads with a parse too; main with a parse gives this answer, the hand reader is retired.
    expect(r.oldP).toBe('allow');
    expect(r.newP).toBe('allow');
    const untapped = await both(`${C} --head feat/z --base main 2>&1`);
    expect(untapped.newP, 'paired: no tap for feat/z').toBe('open-pr');
  });
  it('C6: text that only names a create stays allowed both ways', async () => {
    for (const c of [`echo "${C} --head feat/x"`, `git commit -m "then ${C}"`]) {
      const r = await both(c);
      expect(r.newP, c).toBe(r.oldP);
      expect(r.newP, c).toBe('allow');
    }
  });
  it('C7: two creates in one command each need their own tap, both ways', async () => {
    openTap('feat/x');
    const r = await both(`${C} --head feat/x --title a; ${C} --head feat/y --title b`);
    expect(r.oldP).toBe('open-pr');
    expect(r.newP).toBe('open-pr');
  });
  it('C8: a text the parser cannot read is a deny on both paths; the old path names head-unresolved, the new path parse-error (C1, F1)', async () => {
    openTap('feat/x');
    const r = await both(`${C} --head feat/x --title "open`);
    // C2b (class C): the old side now reads with a parse too, so both sides name parse-error.
    expect(r.oldP).toBe('parse-error');
    expect(r.newP).toBe('parse-error');
  });
  it("C8b (PB-2 shape, with the parse passed in): a PowerShell doubled single quote head='it''s' is the branch it's, not its", async () => {
    openTap('its');
    const c = `gh api repos/${REPO}/pulls -X POST -f head='it''s' -f base=main -f title=t`;
    const r = await both(c, 'PowerShell');
    expect(r.parsed).toBe(true);
    expect(r.newP).toBe('open-pr');
    const p = await withParsed(JSON.stringify(input(c, 'PowerShell')), deps());
    expect(astCreates(p.parsed).map((f) => f.read.heads)).toEqual([["it's"]]);
  });
  it('C9: astCreates lists the call reads: heads, bases, and a bad word', async () => {
    const p = await withParsed(JSON.stringify(input(`${C} --head feat/x --base main; ${C} --head $B`)), deps());
    const found = astCreates(p.parsed);
    expect(found.map((f) => [f.read.bad === null, f.read.heads, f.read.bases])).toEqual([[true, ['feat/x'], ['main']], [false, [], []]]);
  });
});
