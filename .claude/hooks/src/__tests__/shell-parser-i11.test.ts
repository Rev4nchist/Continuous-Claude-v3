/**
 * Plan item 11 of card coord-guard-shell-parser (seat word 15:13 CST 11-25): RED rows.
 * GUARDED_TEXT misses a git global option that takes no value (`git --no-pager push`, `git --git-dir=x push`) and a mix of
 * options (`git --no-pager -C x push`). The F1 deny, the nested parse and the script-runner deny skip such a text.
 * Fail closed: any words between `git` and `push` count as options.
 * RED rows: texts that main (51ae4d6e) allows or denies under another name. Controls: texts that already work stay as they are.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionKey, decisionRecord, offerWrite } from '../shared/decisions-store.js';
import { decide, withParsed, type Deps } from '../decision-gate.js';

vi.setConfig({ testTimeout: 20000 });
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const TREE = 't'.repeat(40);
let dir = '';
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shell-parser-i11-'));
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
      if (a === 'rev-parse --abbrev-ref @{push}') return { status: 128, stdout: '' };
      const gu = /^remote get-url (--push --all )?(\S+)$/.exec(a);
      if (gu) return { status: 0, stdout: `https://github.com/${REPO}.git\n` };
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

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo', session_id: 'i11' });
const pwsh = (command: string) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: '/repo', session_id: 'i11' });
function shipTap(): void {
  const key = decisionKey({ branch: 'feat/x' });
  expect(offerWrite({ step: 'ship', key, head: HEAD, tree: TREE, spec: { header: 'T', question: 'Q?', options: [{ label: 'Commit and push (Recommended)' }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step: 'ship', key, head: HEAD, label: 'Commit and push (Recommended)' })).toEqual({ ok: true });
}
async function patIn(input: object): Promise<string> {
  const d = decide(input, await withParsed(JSON.stringify(input), deps()));
  if (d.action === 'deny') return d.pattern;
  return 'warn' in d && typeof d.warn === 'string' ? 'warn' : 'allow';
}

/** Global options between git and push, as a text that does not parse (a leading `{`) would carry them. */
const NOVALUE = ['--no-pager', '--git-dir=x', '--no-pager --bare', '-P'];
const MIXED = ['--no-pager -C x', '-C x --no-pager', '--no-pager -c k=v', '-c k=v --no-pager', '--git-dir=x -C y -c k=v', '--no-pager --git-dir=x'];
const VALUED = ['-C x', '-c k=v', '-C x -c k=v'];

describe('I11: a git global option with no value hides a push from the guarded-call test', () => {
  it('I11-1 (bash): a text that does not parse, with a no-value option before push, is parse-error', async () => {
    shipTap();
    for (const o of NOVALUE) expect(await patIn(bash(`{ git ${o} push fork feat/x`)), o).toBe('parse-error');
  });
  it('I11-2 (bash): mixed options (no-value and valued) before push are parse-error', async () => {
    shipTap();
    for (const o of MIXED) expect(await patIn(bash(`{ git ${o} push fork feat/x`)), o).toBe('parse-error');
  });
  it('I11-3 (PowerShell): a stray brace after a push with a no-value option is parse-error', async () => {
    shipTap();
    for (const o of ['--no-pager', '--git-dir=x', '--no-pager -C x']) expect(await patIn(pwsh(`git ${o} push fork feat/x }`)), o).toBe('parse-error');
  });
  it('I11-4 (bash -c): the inner text does not parse and holds a push with a no-value option: parse-error', async () => {
    shipTap();
    for (const c of [`bash -c '{ git --no-pager push fork feat/x'`, `sh -c 'git --git-dir=x push fork feat/x )'`, `bash -c '{ git --no-pager -C x push fork feat/x'`]) {
      expect(await patIn(bash(c)), c).toBe('parse-error');
    }
  });
  it('I11-5 (script runner): inline code that names a push with a no-value option is script-runner', async () => {
    shipTap();
    for (const c of [`node -e "git --no-pager push fork feat/x"`, `python -c "git --git-dir=x push fork feat/x"`, `node -e "git --no-pager -C x push fork feat/x"`]) {
      expect(await patIn(bash(c)), c).toBe('script-runner');
    }
  });
  it('I11-6 (control): valued options before push still count (main already matches them)', async () => {
    shipTap();
    for (const o of VALUED) expect(await patIn(bash(`{ git ${o} push fork feat/x`)), o).toBe('parse-error');
  });
  it('I11-7 (control): a text that does not parse and has no push is not parse-error, also with options', async () => {
    for (const c of ['{ git --no-pager status', 'git --git-dir=x log )', '{ git --no-pager -C x diff', 'git -c k=v status ;;']) {
      expect(await patIn(bash(c)), c).not.toBe('parse-error');
    }
  });
  it('I11-8 (control): a text that parses, with a no-value option, keeps the answer it has today', async () => {
    shipTap();
    for (const o of ['--no-pager', '--git-dir=x']) {
      const a = await patIn(bash(`git ${o} push fork feat/x`));
      expect(a, o).not.toBe('parse-error');
      expect(a, o).not.toBe('script-runner');
    }
  });
  it('I11-9 (control): the word push as a quoted argument of another call is not a parse-error', async () => {
    for (const c of [`{ echo "git --no-pager push"`, `{ git --no-pager commit -m "push notes"`]) {
      expect(await patIn(bash(c)), c).not.toBe('parse-error');
    }
  });
});
